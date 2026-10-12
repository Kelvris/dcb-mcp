/**
 * `shutdown.ts` — the trigger rules behind plan §5's "destroy client → flush
 * → exit".
 *
 * These rules are extracted precisely because they were the regression site:
 * `stdin end` and `stdin close` are ONE disconnect (emitted a few
 * milliseconds apart), and mistaking the second for a repeat signal made a
 * *clean* disconnect force a non-zero exit whenever teardown outlasted that
 * gap — which, with a healthy gateway, it always does. The tests below pin
 * both directions: the pair is one trigger, while a genuinely repeated
 * signal — or a crash arriving mid-teardown — must still leave immediately
 * and non-zero.
 *
 * Every hook is injectable, so no test here spawns a process or touches real
 * I/O; `process.test.ts` covers the wiring of the real one.
 */

import { describe, expect, it } from "vitest";

import { createLogger } from "../src/logger.js";
import {
  createShutdownController,
  flushStderr,
} from "../src/shutdown.js";
import type {
  ShutdownHooks,
  StderrLike,
} from "../src/shutdown.js";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Calls {
  close: number;
  disconnect: string[];
  exit: number[];
  logs: string[];
}

/** Hooks whose teardown is *slow* (30 ms) — the condition that exposed the bug. */
function makeHooks(
  overrides: Partial<ShutdownHooks> = {},
): { hooks: ShutdownHooks; calls: Calls } {
  const calls: Calls = { close: 0, disconnect: [], exit: [], logs: [] };
  // "info": the controller logs the non-escalation path at info, and the
  // assertions below read it out of the same capture as the warns.
  const logger = createLogger("info", (line) => calls.logs.push(line));
  const hooks: ShutdownHooks = {
    logger,
    closeTransport: () => {
      calls.close += 1;
      return Promise.resolve();
    },
    disconnectGateway: (reason) => {
      calls.disconnect.push(reason);
      return delay(30);
    },
    flush: () => Promise.resolve(),
    exit: (code) => {
      calls.exit.push(code);
    },
    ...overrides,
  };
  return { hooks, calls };
}

describe("createShutdownController — trigger rules", () => {
  it("treats stdin `end` + `close` as one disconnect: exit 0, exactly once", async () => {
    // The blocker this pins: with a teardown slower than the few-ms gap
    // between the two stdin events, a naive second `shutdown()` hits the
    // force-exit branch and a clean client disconnect exits 1.
    const { hooks, calls } = makeHooks();
    const controller = createShutdownController(hooks);

    controller.stdinGone("stdin closed by the client"); // 'end'
    await delay(5); // the gateway disconnect is still in flight…
    controller.stdinGone("stdin closed by the client"); // 'close'
    await delay(80);

    expect(calls.close).toBe(1);
    expect(calls.disconnect).toEqual(["stdin closed by the client"]);
    expect(calls.exit).toEqual([0]);
    expect(calls.logs.join("\n")).not.toMatch(/forcing exit/);
  });

  it("honours whichever stdin event arrives first and ignores the rest", async () => {
    const { hooks, calls } = makeHooks();
    const controller = createShutdownController(hooks);

    controller.stdinGone("stdin closed by the client"); // 'close' without 'end'
    controller.stdinGone("stdin closed by the client");
    controller.stdinGone("stdin closed by the client");
    await delay(80);

    expect(calls.disconnect).toEqual(["stdin closed by the client"]);
    expect(calls.exit).toEqual([0]);
  });

  it("forces a non-zero exit on a repeated signal during teardown", async () => {
    const { hooks, calls } = makeHooks();
    const controller = createShutdownController(hooks);

    void controller.shutdown("SIGINT");
    await delay(10); // teardown in flight (disconnect takes 30 ms)
    void controller.shutdown("SIGINT"); // operator hitting Ctrl-C again
    await delay(80);

    expect(calls.exit[0]).toBe(1);
    expect(calls.logs.join("\n")).toMatch(/forcing exit during shutdown/);
  });

  it("a stdin disconnect followed by a crash still exits non-zero", async () => {
    const { hooks, calls } = makeHooks();
    const controller = createShutdownController(hooks);

    controller.stdinGone("stdin closed by the client");
    await delay(10);
    void controller.shutdown("uncaught exception", 1);
    await delay(80);

    expect(calls.exit[0]).toBe(1);
  });

  it("reports in-flight state so embedders can react", () => {
    const { hooks } = makeHooks();
    const controller = createShutdownController(hooks);
    expect(controller.isShuttingDown()).toBe(false);
    void controller.shutdown("SIGTERM");
    expect(controller.isShuttingDown()).toBe(true);
  });

  it("lets a transport that refuses to close get past teardown anyway", async () => {
    const { hooks, calls } = makeHooks({
      closeTransport: () => Promise.reject(new Error("transport wedged")),
    });
    const controller = createShutdownController(hooks);

    await controller.shutdown("SIGTERM");

    expect(calls.disconnect).toEqual(["SIGTERM"]); // not stranded
    expect(calls.exit).toEqual([0]);
    expect(calls.logs.join("\n")).toMatch(/error closing the MCP transport/);
  });

  it("lets a transport that never settles get past teardown anyway", async () => {
    const { hooks, calls } = makeHooks({
      closeTransport: () => new Promise<never>(() => {}),
    });
    const controller = createShutdownController(hooks, {
      transportCloseTimeoutMs: 30,
    });

    await controller.shutdown("SIGTERM");

    expect(calls.disconnect).toEqual(["SIGTERM"]); // not stranded
    expect(calls.exit).toEqual([0]);
  });

  it("does not escalate a signal during a client-initiated teardown", async () => {
    // A host that ends stdin and *then* kills the child is a normal shape —
    // the kill must not rebrand an already-clean disconnect as a failure.
    const { hooks, calls } = makeHooks();
    const controller = createShutdownController(hooks);

    controller.stdinGone("stdin closed by the client");
    await delay(10); // gateway disconnect in flight (30 ms)
    void controller.shutdown("SIGTERM");
    await delay(80);

    expect(calls.exit).toEqual([0]);
    expect(calls.logs.join("\n")).not.toMatch(/forcing exit/);
    expect(calls.logs.join("\n")).toMatch(/letting it finish/);
  });

  it("escalates from the *second* signal during a client-initiated teardown", async () => {
    // Absorbing signals must not cost the operator their escape hatch: if
    // the teardown genuinely wedges, the second Ctrl-C still leaves now.
    const { hooks, calls } = makeHooks({
      // Wedged gateway close, so the teardown never finishes on its own.
      disconnectGateway: () => new Promise<never>(() => {}),
    });
    const controller = createShutdownController(hooks);

    controller.stdinGone("stdin closed by the client");
    await delay(5);
    void controller.shutdown("SIGTERM"); // absorbed
    void controller.shutdown("SIGTERM"); // escalated
    await delay(20);

    expect(calls.exit[0]).toBe(1);
    expect(calls.logs.join("\n")).toMatch(/forcing exit during shutdown/);
  });

  it("absorbs a client disconnect arriving during a signal teardown", async () => {
    // The same defect class in the other order: `docker stop` and systemd
    // `KillMode=mixed` signal first and close the child's stdin right after.
    // The stdin EOF is not evidence the pass is stuck, so it must not turn a
    // clean teardown into exit 1.
    const { hooks, calls } = makeHooks();
    const controller = createShutdownController(hooks);

    void controller.shutdown("SIGTERM");
    await delay(10); // teardown in flight
    controller.stdinGone("stdin closed by the client");
    await delay(80);

    expect(calls.exit).toEqual([0]);
    expect(calls.logs.join("\n")).not.toMatch(/forcing exit/);
  });
});

// ---------------------------------------------------------------------------
// flushStderr — bounded drain of captured stderr
// ---------------------------------------------------------------------------

function fakeStderr(
  drain: "sync" | "async" | "never" | "throw",
): StderrLike & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    write(chunk, cb) {
      // A fully destroyed stream can throw synchronously instead of calling
      // back with an error.
      if (drain === "throw") throw new Error("write after destroy");
      chunks.push(chunk);
      if (drain === "sync") cb(null);
      if (drain === "async") setTimeout(() => cb(null), 5);
      // "never": the reader stopped reading and the pipe buffer stays full —
      // its drain callback never fires.
      return true;
    },
  };
}

describe("flushStderr", () => {
  it("writes the barrier even on an idle stream", async () => {
    // No fast path that skips the write when the stream looks idle: a write
    // already handed to the OS leaves the queue empty while its bytes are
    // still in flight, so only the barrier write proves they landed.
    const stream = fakeStderr("sync");
    await expect(flushStderr(stream)).resolves.toBeUndefined();
    expect(stream.chunks).toEqual([""]);
  });

  it("waits for a queued write to drain before resolving", async () => {
    let drained = false;
    const stream = fakeStderr("async");
    await flushStderr(stream, 200).then(() => {
      drained = true;
    });
    expect(drained).toBe(true);
    expect(stream.chunks).toEqual([""]); // the empty write is the barrier
  });

  it("gives up after the bound instead of becoming a zombie", async () => {
    // A full pipe with a dead reader: without the bound this promise never
    // settles and the process would never exit — the failure the stdin
    // trigger exists to prevent.
    const started = Date.now();
    await expect(flushStderr(fakeStderr("never"), 30)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it("resolves rather than rejects when write throws synchronously", async () => {
    // A rejection here would surface as an unhandled rejection in index.ts
    // (which fires shutdown with `void`) and force exit 1 on a clean
    // disconnect — the flush must never be able to fail the teardown.
    await expect(flushStderr(fakeStderr("throw"))).resolves.toBeUndefined();
  });
});
