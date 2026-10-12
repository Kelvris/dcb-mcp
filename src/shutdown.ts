/**
 * Process shutdown orchestration — plan §5's "destroy client → flush → exit",
 * with the trigger rules that make it correct.
 *
 * Extracted from `index.ts` because the rules are where the bugs are, and
 * they were not testable inside a module that runs on import:
 *
 * - **`stdin end` and `stdin close` are ONE disconnect.** Node emits both for
 *   a client closing its end of the pipe, a few milliseconds apart. Treating
 *   the second as a *repeat* trigger made a clean disconnect exit 1 whenever
 *   teardown took longer than that gap — which, on a healthy gateway, it
 *   always does (`Client.destroy()` awaits the WebSocket close event). The
 *   dedupe in {@link ShutdownController.stdinGone} is what keeps "force a
 *   wedged shutdown" reserved for genuinely second triggers.
 * - **A repeat signal or a crash during teardown is a real second trigger.**
 *   It must leave immediately and non-zero: an operator hitting Ctrl-C twice
 *   is telling us the first pass is stuck, and a crash during shutdown must
 *   never be reported as a clean exit. **At most one absorption** per
 *   teardown is granted, in either trigger order: the first signal during a
 *   **client-initiated** (stdin) teardown (the client is already gone, the
 *   pass is legitimately running), or a client disconnect arriving during a
 *   signal teardown (`docker stop` and `systemd KillMode=mixed` signal first
 *   and close stdin right after) — whichever comes first. Everything after
 *   that escalates, so the wedged-teardown escape hatch survives the
 *   absorption.
 *
 * The hooks are injectable so every rule is unit-tested without spawning a
 * process or waiting on real I/O.
 */

import type { Logger } from "./logger.js";

export interface ShutdownHooks {
  logger: Logger;
  /** Close the MCP transport. Must be idempotent (the SDK may have closed it). */
  closeTransport(): Promise<void>;
  /** Destroy the Discord gateway connection. */
  disconnectGateway(reason: string): Promise<void>;
  /** Drain captured stderr before the process disappears. */
  flush(): Promise<void>;
  /**
   * Final exit. Injectable so tests can observe the code instead of dying:
   * in production this is `process.exit`, which terminates synchronously —
   * so after a force-exit the normal path below never actually runs.
   */
  exit(code: number): void;
}

export interface ShutdownController {
  /**
   * Idempotent start, or — if a shutdown is already in flight — an escalation
   * (see the rules in {@link createShutdownController}) unless noted below.
   */
  shutdown(reason: string, exitCode?: number): Promise<void>;
  /**
   * One stdin disconnect (`end`, then `close`) — deduplicated to a single
   * {@link shutdown} call so the second event cannot be mistaken for a repeat
   * signal.
   */
  stdinGone(reason: string): void;
  isShuttingDown(): boolean;
}

export interface ShutdownOptions {
  /**
   * Bound on closing the MCP transport, in milliseconds. The SDK's `close()`
   * resolves promptly in practice, but a transport wedged on a half-dead pipe
   * must not strand the gateway teardown (or the exit) behind it — the same
   * "never hang forever" rule the flush bound applies.
   * @default 5_000
   */
  transportCloseTimeoutMs?: number;
}

export function createShutdownController(
  hooks: ShutdownHooks,
  options: ShutdownOptions = {},
): ShutdownController {
  const transportCloseTimeoutMs = options.transportCloseTimeoutMs ?? 5_000;

  let closing = false;
  /** Which trigger started the in-flight shutdown; null while none has. */
  let closingKind: "stdin" | "signal" | null = null;
  /** Signals absorbed so far during a client-initiated teardown. */
  let absorbedSignals = 0;
  let stdinSeen = false;

  async function shutdown(
    reason: string,
    exitCode = 0,
    kind: "stdin" | "signal" = "signal",
  ): Promise<void> {
    if (closing) {
      // A client disconnect arriving mid-teardown is never evidence that the
      // first pass is stuck — a supervisor that signals and *then* closes the
      // child's stdin (`systemd KillMode=mixed`, `docker stop`) delivers
      // exactly that sequence — so it never escalates. It also cannot repeat:
      // `stdinGone` dedupes it before it gets here.
      if (kind === "stdin") return;
      // One signal during a **client-initiated** teardown is not a repeat
      // either: the client is already gone and the pass is legitimately still
      // running (the gateway close can take a while), and escalating the
      // first would rebrand a clean disconnect as exit 1. The *second* one
      // does escalate — an operator watching a wedged teardown keeps their
      // double-Ctrl-C escape hatch (the gateway's `destroy()` is the one
      // unbounded await in the chain). A crash (exitCode ≠ 0) always
      // escalates; it must never be reported as a clean exit.
      const absorbable =
        exitCode === 0 && closingKind === "stdin" && absorbedSignals < 1;
      if (absorbable) {
        absorbedSignals += 1;
        hooks.logger.info(
          "signal during a client-initiated shutdown — letting it finish",
          { reason },
        );
        return;
      }
      hooks.logger.warn("forcing exit during shutdown", { reason, exitCode });
      await hooks.flush();
      hooks.exit(exitCode === 0 ? 1 : exitCode);
      return;
    }
    closing = true;
    closingKind = kind;

    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Raced against a bound: a transport that never settles must not
      // strand the rest of the teardown (only a genuinely wedged pipe can
      // even reach this, and the operator will not thank us for hanging on
      // the one component that failed).
      await Promise.race([
        hooks.closeTransport(),
        new Promise<void>((resolve) => {
          closeTimer = setTimeout(resolve, transportCloseTimeoutMs);
          // Unref'd: if nothing else is pending, the loop may drain and the
          // process exits on its own — which is also a fine outcome here.
          closeTimer.unref?.();
        }),
      ]);
    } catch (error) {
      // Never let a transport that refuses to close strand the gateway
      // teardown (or the exit) behind it.
      hooks.logger.error("error closing the MCP transport", { error });
    } finally {
      // The bound must not outlive the thing it bounds.
      clearTimeout(closeTimer);
    }
    await hooks.disconnectGateway(reason);
    await hooks.flush();
    hooks.exit(exitCode);
  }

  return {
    shutdown: (reason: string, exitCode = 0) => shutdown(reason, exitCode),
    stdinGone(reason: string): void {
      if (stdinSeen) return;
      stdinSeen = true;
      void shutdown(reason, 0, "stdin");
    },
    isShuttingDown: () => closing,
  };
}

/** The minimal shape of a Node writable used by {@link flushStderr}. */
export interface StderrLike {
  write(chunk: string, cb: (err?: Error | null) => void): boolean;
}

/**
 * Wait for queued stderr writes to reach the OS — bounded.
 *
 * An MCP client captures our stderr over a pipe, and Node treats pipe writes
 * as *asynchronous* on macOS (sync only on Windows/Linux), so `process.exit()`
 * can drop the very lines that explain a crash. The bound matters as much as
 * the flush: if the reader stops reading with the 64 KB pipe buffer full, the
 * drain callback never fires, and an unbounded await would turn "flush before
 * exit" into a zombie that never exits — the exact failure the stdin trigger
 * exists to prevent.
 *
 * A pending write's callback fires only after everything queued before it has
 * drained, which is what makes the empty-string write a barrier. There is
 * deliberately **no** fast path that skips the write when the stream looks
 * idle: a write already handed to the OS leaves the queue empty while its
 * bytes are still in flight, so only the barrier write proves they landed —
 * and on an idle stream the barrier costs nothing anyway.
 */
export function flushStderr(
  stream: StderrLike = process.stderr,
  timeoutMs = 500,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    try {
      stream.write("", () => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      // A synchronous throw (a fully destroyed stream, a closed fd) leaves
      // nothing worth waiting for — resolve rather than reject: a rejected
      // `flush` would surface as an unhandled rejection in `index.ts` (which
      // fires shutdown with `void`) and force exit 1 on a clean disconnect.
      clearTimeout(timer);
      resolve();
    }
  });
}
