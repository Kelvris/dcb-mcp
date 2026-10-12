/**
 * Process-level smoke for the shutdown path — the wiring the unit tests in
 * `shutdown.test.ts` cannot see: `index.ts` binding real process events to
 * the controller, and the process actually exiting.
 *
 * Three scenarios, all about a *clean* disconnect (what every MCP client does
 * when it stops):
 *
 *  1. Ending stdin must exit 0. Node emits `end` then `close` a few ms
 *     apart; treating the second as a repeat signal turns "client closed the
 *     session" into exit 1, which orchestrators read as a crash.
 *  2. The same, with the stderr *reader* gone first — the EPIPE guard. A
 *     client that closes its captured-stderr pipe must not turn every log
 *     line into an uncaught error loop that never reaches the exit.
 *  3. The same, with the stdout *reader* gone and stdin left open — the
 *     zombie guard. Nothing else would ever trigger a shutdown there (the
 *     gateway socket keeps the event loop alive), so the next JSON-RPC reply
 *     must be what ends the process.
 *
 * The suite does attempt a real `discord.login()` against discord.com (a
 * deliberately bogus token): `createWarden` has no offline mode by design —
 * `WardenOptions.connect` is code-only, never environment-driven. Offline the
 * login fails fast and is caught, so both scenarios still exercise the
 * connected-teardown shape without flaking on network availability.
 *
 * The built `dist/index.js` is rebuilt here through the package's own
 * `npm run build` when stale, because these tests assert on the real entry
 * point rather than re-importing `src/index.ts` (which runs on import).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = path.join(ROOT, "dist", "index.js");

function newestMtimeIn(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestMtimeIn(full) : statSync(full).mtimeMs,
    );
  }
  return newest;
}

/**
 * Run the package's own build when `dist/` is missing or older than its
 * inputs. Shelling out to `npm run build` (rather than invoking `tsc`
 * directly) keeps this test in lockstep with the artifact that ships: the
 * script also clears `dist/`, so a renamed or deleted source cannot leave an
 * orphaned `.js` behind for the test to "pass" against.
 */
function ensureDist(): void {
  const inputs = [
    newestMtimeIn(path.join(ROOT, "src")),
    statSync(path.join(ROOT, "tsconfig.build.json")).mtimeMs,
    statSync(path.join(ROOT, "package.json")).mtimeMs,
  ];
  const built = existsSync(ENTRY) ? statSync(ENTRY).mtimeMs : 0;
  if (built >= Math.max(...inputs)) return;
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["run", "build"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`npm run build failed:\n${result.stderr}`);
  }
  expect(existsSync(ENTRY)).toBe(true);
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Child {
  proc: ReturnType<typeof spawn>;
  /** Combined stdout + stderr — for diagnostics and the token-leak check. */
  output: () => string;
  /** stdout alone — the handshake reply must come from the JSON-RPC channel. */
  stdout: () => string;
  exited: Promise<number | null>;
}

const started: ReturnType<typeof spawn>[] = [];

/** Spawn the built server with a bogus token; killed automatically on failure. */
function startServer(): Child {
  ensureDist();
  const proc = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      DISCORD_BOT_TOKEN: "process-smoke.token",
      WARDEN_LOG_LEVEL: "info",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  started.push(proc);
  let out = "";
  let outStdout = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString();
    outStdout += chunk.toString();
  });
  proc.stderr?.on("data", (chunk: Buffer) => (out += chunk.toString()));
  const exited = new Promise<number | null>((resolve) =>
    proc.on("exit", (code) => resolve(code)),
  );
  return {
    proc,
    output: () => out,
    stdout: () => outStdout,
    exited,
  };
}

/** Perform the MCP initialize handshake and wait for the server's reply. */
async function handshake(child: Child): Promise<void> {
  child.proc.stdin?.write(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"process-test","version":"0.0.0"}}}\n',
  );
  // Await the actual reply on *stdout* rather than sleeping a fixed interval:
  // on a loaded machine a sleep can expire before the transport ever
  // connected, quietly testing a different scenario than the one documented
  // here — and matching stdout alone keeps a stray log line on stderr from
  // satisfying the wait. A dead child fails fast instead of burning the
  // deadline.
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.stdout().includes('"id":1')) return;
    if (child.proc.exitCode !== null || child.proc.signalCode !== null) {
      throw new Error(`server exited before the handshake completed:\n${child.output()}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`no initialize reply within 15s:\n${child.output()}`);
    }
    await delay(25);
  }
}

afterEach(() => {
  // A hung child would otherwise outlive a failing test as an orphan still
  // trying to reach the gateway.
  for (const proc of started.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }
});

describe("dist/index.js — process lifecycle", () => {
  it("exits 0 when the client ends stdin (end/close is one disconnect)", async () => {
    const child = startServer();
    await handshake(child);

    child.proc.stdin?.end(); // → 'end', then 'close', a few ms apart
    const exitCode = await child.exited;

    expect(exitCode).toBe(0);
    expect(child.output()).not.toMatch(/forcing exit during shutdown/);
    // Plan §4 end to end: the token appears in no stream.
    expect(child.output()).not.toMatch(/process-smoke\.token/);
  }, 60_000);

  it("exits 0 when the client's stderr reader is gone before stdin (EPIPE)", async () => {
    const child = startServer();
    await handshake(child);

    // The client abandoned its captured-stderr pipe: every subsequent log
    // line raises EPIPE. Without the stream-error sink in index.ts this
    // throws into uncaughtException, whose handler logs *again* to the same
    // broken stream — a self-sustaining loop that never reaches exit.
    child.proc.stderr?.destroy();
    await delay(100); // let the failure mode, if any, arm itself
    child.proc.stdin?.end();

    expect(await child.exited).toBe(0);
  }, 60_000);

  it("exits 0 when the client's stdout reader is gone before stdin (zombie guard)", async () => {
    const child = startServer();
    await handshake(child);

    // The client abandoned its JSON-RPC pipe but left stdin open — the
    // worst-case shape: without the stdout sink in index.ts nothing would
    // ever trigger a shutdown (the gateway socket keeps the event loop
    // alive) and the process would sit as a zombie until a signal. The next
    // tools/list reply hits the closed read end, raises EPIPE, and the sink
    // routes it through the deduplicated client-gone trigger.
    child.proc.stdout?.destroy();
    await delay(50); // let the failure mode, if any, arm itself
    child.proc.stdin?.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');

    expect(await child.exited).toBe(0);
  }, 60_000);
});
