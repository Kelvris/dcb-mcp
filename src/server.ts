/**
 * Server assembly (plan §5) — a per-connection `McpServer` factory, the
 * (single) Discord connection, the tool registry, and the lifecycle that ties
 * them together.
 *
 * The order at startup is the plan's, not an accident: **tools register
 * immediately and the gateway connects in parallel**. A client that calls a
 * tool while the gateway is still connecting gets the structured `not_ready`
 * answer (with remediation) instead of a hang — and `get_bot_status` answers
 * truthfully all along. Nothing here waits for `ready`, because a wrong token
 * stalls the gateway rather than throwing at `login()`, and an MCP server
 * that never answers is worse than one that answers "not yet".
 */

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "./config.js";
import { createWardenDiscord } from "./discord/client.js";
import type { WardenDiscord } from "./discord/client.js";
import { toWardenError } from "./discord/errors.js";
import { createEventRuntime } from "./events/index.js";
import type { Logger } from "./logger.js";
import { registerAll } from "./tools/index.js";
import type { ToolContext } from "./tools/index.js";

export const SERVER_NAME = "warden-discord-mcp";

/**
 * Package version, read from the installed `package.json` at startup.
 *
 * `dist/server.js` (and `src/server.ts` under vitest) both sit one directory
 * below the package root, so one relative URL resolves in development, in the
 * published tarball, and under `npx`. Reading it instead of hardcoding keeps
 * the version the MCP handshake reports in step with `npm version` — and a
 * missing or unreadable file degrades to a placeholder rather than taking the
 * server down over a cosmetic field.
 */
function readVersion(): string {
  try {
    const raw = readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string" && version.length > 0) return version;
    }
  } catch {
    // Cosmetic field only — see the doc comment above.
  }
  return "0.0.0";
}

/**
 * Options for {@link createWarden}.
 *
 * `connect: false` builds everything except the gateway connection — the MCP
 * side (server factory, tool registry, context) is fully usable without it,
 * which is what lets tests exercise `createWarden()` without a token or a
 * network call. It is a test seam, not a mode: a process that serves clients
 * must always connect (the default), or every tool would answer `not_ready`
 * forever while looking healthy. Nothing reads it from the environment —
 * reaching it requires passing the argument in code.
 */
export interface WardenOptions {
  /** Skip `discord.login()` — test seam only; never for a serving process. @default true */
  connect?: boolean;
}

export interface Warden {
  /**
   * Build a **fresh** MCP server for a new connection.
   *
   * The SDK's stdio entry calls its factory on every connection phase, not
   * once: a 2025-era opening probe can be discarded (`instance.close()`) and
   * re-served through the legacy path — which calls the factory again — and
   * `Server.connect` documents "use a separate Server instance per
   * connection". Returning one shared instance would hand back the instance
   * the SDK just closed, still carrying its negotiated-era state. So the MCP
   * server is per connection while everything it reads — the Discord client,
   * config, logger, event state in later phases — is created once in
   * `createWarden()` and shared through the context.
   */
  createServer(): McpServer;
  readonly discord: WardenDiscord;
  readonly logger: Logger;
  /**
   * Idempotent teardown of the **gateway** side only: destroy the Discord
   * client. Closing the MCP transport, flushing stderr and exiting are owned
   * by `shutdown.ts` (wired in `index.ts`), which calls this between those
   * steps — `shutdown(reason)` here just means "disconnect Discord".
   *
   * Returns the same promise to every caller, so concurrent shutdown paths
   * (a signal plus stdin EOF) cannot race a second teardown.
   */
  shutdown(reason: string): Promise<void>;
}

export function createWarden(
  config: Config,
  logger: Logger,
  options: WardenOptions = {},
): Warden {
  const log = logger.child({ component: "server" });
  const discord = createWardenDiscord(logger);
  const version = readVersion();

  log.info("starting", {
    server: SERVER_NAME,
    version,
    defaultGuildId: config.WARDEN_GUILD_ID ?? null,
    dryRun: config.WARDEN_DRY_RUN,
    logLevel: config.WARDEN_LOG_LEVEL,
  });

  // Built once, shared by every server instance. The token is destructured
  // out here: `ToolContext.config` is `Omit<Config, "DISCORD_BOT_TOKEN">`, so
  // from this point down the tool layer physically cannot reach the secret
  // (plan §4) — while `discord.login()` below still gets it.
  const { DISCORD_BOT_TOKEN: _token, ...toolConfig } = config;
  // Attached before login (plan §5): the bus must be listening when READY
  // arrives, and event tools must answer from the buffer immediately.
  const events = createEventRuntime(
    discord.client,
    {
      maxEvents: config.WARDEN_MAX_EVENTS,
      maxWatches: config.WARDEN_MAX_WATCHES,
    },
    logger,
  );
  const ctx: ToolContext = { config: toolConfig, logger, discord, events };

  const createServer = (): McpServer => {
    const server = new McpServer({ name: SERVER_NAME, version });
    registerAll(server, ctx);
    return server;
  };

  // Declared before the login block below so its catch can tell "login failed"
  // apart from "shutdown cancelled the login" without a second flag.
  let shutdownPromise: Promise<void> | null = null;

  // Fire-and-forget on purpose: tools are already registered, and a failed
  // login must not take down the MCP session — it surfaces as `not_ready`
  // (with the operator-facing remediation in the log *and* in get_bot_status'
  // `gateway.fatal`) instead of a dead pipe.
  if (options.connect !== false) {
    void discord.login(config.DISCORD_BOT_TOKEN).catch((error: unknown) => {
      const mapped = toWardenError(error);
      if (shutdownPromise !== null) {
        // The teardown aborted the connect — expected, not a fault. Logged at
        // info so a clean shutdown doesn't end with a red error line that
        // looks like a bad token.
        log.info("Discord login did not complete — Warden is shutting down", {
          discordMessage: mapped.message,
        });
        return;
      }
      log.error("Discord login failed — tools will answer not_ready", {
        discordCode: mapped.discordCode ?? null,
        discordMessage: mapped.message,
        remediation: mapped.remediation,
      });
    });
  }

  const shutdown = (reason: string): Promise<void> => {
    shutdownPromise ??= (async () => {
      log.info("shutting down", { reason });
      try {
        await discord.destroy();
      } catch (error) {
        log.error("error while destroying the Discord client", { error });
      }
    })();
    return shutdownPromise;
  };

  return { createServer, discord, logger, shutdown };
}
