#!/usr/bin/env node
/**
 * Process entry (plan §5, §10): validate the environment, build Warden, and
 * serve MCP over stdio.
 *
 * stdout belongs to JSON-RPC; everything this file reports goes to stderr
 * through the logger (config failures included — `loadConfigOrExit` prints a
 * redacted, human-readable list of problems and exits 1).
 *
 * Shutdown (plan §5) has three triggers and one rule: close the MCP side
 * first, then the gateway, then flush, then exit. The stdin listener is not
 * redundant — the stdio transport closes itself when the client ends stdin,
 * but the Discord gateway socket keeps the event loop alive, so without an
 * explicit exit the process would outlive its client as a zombie.
 *
 * The trigger rules themselves live in `shutdown.ts`, where they are unit
 * tested; this file only wires them to the process.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadConfigOrExit } from "./config.js";
import { createLogger } from "./logger.js";
import { createWarden } from "./server.js";
import { createShutdownController, flushStderr } from "./shutdown.js";

/**
 * Sink for a broken stdout/stderr pipe.
 *
 * A client that closes its captured-stderr (or stdout) reader turns every
 * subsequent write into EPIPE. Without a listener that throws into the
 * uncaughtException handler below — whose *first act* is writing a log line
 * to the very stream that just failed — re-arming the error forever: the
 * process never reaches the exit in the shutdown chain. So reader-gone
 * errors are absorbed (dropping the bytes is exactly right for a client that
 * is no longer listening), while anything else — a full disk, a bad fd — is
 * reported **once**, because swallowing `ENOSPC` silently would leave an
 * operator with no clue why the diagnostics stopped.
 */
function streamErrorSink(stream: "stdout" | "stderr", onGone?: () => void) {
  let reported = false;
  return (error: NodeJS.ErrnoException): void => {
    const code = error?.code;
    if (
      code === "EPIPE" ||
      code === "ERR_STREAM_DESTROYED" ||
      code === "ERR_STREAM_WRITE_AFTER_END"
    ) {
      onGone?.();
      return;
    }
    if (reported) return; // a persistently broken stream must not re-arm us
    reported = true;
    process.stderr.write(
      `warden: ${stream} is broken (${code ?? String(error)}) — output after this point is lost\n`,
    );
  };
}

// Installed before `loadConfigOrExit`, which can write to stderr itself —
// no window may be left uncovered.
process.stderr.on("error", streamErrorSink("stderr"));

const config = loadConfigOrExit(process.env);
const logger = createLogger(config.WARDEN_LOG_LEVEL).child({
  component: "main",
});

const warden = createWarden(config, logger);

// One *fresh* server per connection phase: the SDK may probe, discard and
// rebuild the instance (a 2025-era opening can be re-served through the
// legacy path), and `Server.connect` requires a separate instance per
// connection — see `Warden.createServer`. Everything stateful is shared
// through `createWarden`, only the MCP server is per connection.
const handle = serveStdio(() => warden.createServer(), {
  onerror: (error) => logger.error("MCP transport error", { error }),
});

const shutdownController = createShutdownController({
  logger,
  closeTransport: () => handle.close(),
  disconnectGateway: (reason) => warden.shutdown(reason),
  flush: () => flushStderr(),
  exit: (code) => process.exit(code),
});

// stdout is the JSON-RPC channel: if the client's reader is gone, the
// session is over even if stdin is still open, so route it through the same
// deduplicated "client gone" trigger as stdin EOF (`stdinGone` collapses the
// two into one shutdown).
process.stdout.on(
  "error",
  streamErrorSink("stdout", () =>
    shutdownController.stdinGone("stdout closed by the client"),
  ),
);

process.on("SIGINT", () => void shutdownController.shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdownController.shutdown("SIGTERM"));

// The client is gone — no further tool call can arrive, so leave promptly.
// (`handle.close()` is a no-op on this path: the SDK's own stdin handler has
// already closed the transport before ours runs.) Node emits `end` *and*
// `close` for that one disconnect: `stdinGone` collapses them, so the second
// event cannot be mistaken for a repeat signal and force a non-zero exit.
const STDIN_CLOSED = "stdin closed by the client";
process.stdin.on("end", () => shutdownController.stdinGone(STDIN_CLOSED));
process.stdin.on("close", () => shutdownController.stdinGone(STDIN_CLOSED));

// Last-resort handlers: log (redacted, structured) and leave with a non-zero
// code rather than dumping a raw stack onto stderr — exit 1 even when the
// crash arrives mid-shutdown, so the failure is never reported as success.
process.on("uncaughtException", (error) => {
  logger.error("uncaught exception", { error });
  void shutdownController.shutdown("uncaught exception", 1);
});
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection", { error: reason });
  void shutdownController.shutdown("unhandled rejection", 1);
});
