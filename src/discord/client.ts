/**
 * Gateway connection wrapper — plan §7.1: ALL intents, ready-wait, reconnect
 * tracking, ws ping, honest status reporting.
 *
 * Why a wrapper instead of handing out a raw discord.js Client:
 * - the intent set is fixed and derivable for tests/README (`WARDEN_INTENTS`
 *   vs `WARDEN_INTENT_NAMES` — no hand-maintained duplicate lists);
 * - `waitForReady()` gives startup a bounded wait instead of an unbounded
 *   hang (a wrong token stalls the gateway, it doesn't throw at login());
 * - unrecoverable shard closes (4004, 4010–4014) log operator-facing
 *   remediation immediately — these are config failures (token reset,
 *   privileged intents not enabled), not code failures;
 * - status() is the data behind `get_bot_status` and never reports "connected"
 *   while discord.js says otherwise.
 *
 * Token hygiene: this module receives the token only as `login(token)` and
 * passes it straight to discord.js — it is never stored on the wrapper, never
 * logged (the logger redacts token-shaped strings as a second line of defense).
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  Status,
} from "discord.js";
import type { ClientOptions } from "discord.js";

import type { Logger } from "../logger.js";
import { WardenNotReadyError } from "./errors.js";

/**
 * Every non-deprecated GatewayIntentBits value (plan §7.1 lists all 21 by
 * name; GuildBans/GuildEmojisAndStickers are deprecated aliases of
 * GuildModeration/GuildExpressions and are intentionally not repeated — the
 * gateway rejects duplicate intent bits).
 */
export const WARDEN_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildExpressions,
  GatewayIntentBits.GuildIntegrations,
  GatewayIntentBits.GuildWebhooks,
  GatewayIntentBits.GuildInvites,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildPresences,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildMessageTyping,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.DirectMessageReactions,
  GatewayIntentBits.DirectMessageTyping,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildScheduledEvents,
  GatewayIntentBits.AutoModerationConfiguration,
  GatewayIntentBits.AutoModerationExecution,
  GatewayIntentBits.GuildMessagePolls,
  GatewayIntentBits.DirectMessagePolls,
] as const;

/**
 * Partials fill in objects discord.js didn't have cached (e.g. a reaction on
 * a message from before startup). The event pipeline (Phase 5) must treat
 * partials as "id + whatever Discord gave us" — never assume presence of
 * fields beyond the id.
 */
export const WARDEN_PARTIALS = [
  Partials.User,
  Partials.Channel,
  Partials.GuildMember,
  Partials.Message,
  Partials.Reaction,
  Partials.GuildScheduledEvent,
  Partials.ThreadMember,
  Partials.SoundboardSound,
  Partials.Poll,
  Partials.PollAnswer,
] as const;

/** Intents that must be toggled in the developer portal (plan §7.1/README). */
export const PRIVILEGED_INTENTS = [
  "GuildMembers",
  "GuildPresences",
  "MessageContent",
] as const;

/**
 * Bit → canonical name. Insertion order keeps the canonical name first for
 * aliases (GuildModeration before GuildBans), and `Map` first-wins dedupes.
 */
const INTENT_NAMES = new Map<number, string>();
for (const [name, bit] of Object.entries(GatewayIntentBits)) {
  if (typeof bit === "number" && !INTENT_NAMES.has(bit))
    INTENT_NAMES.set(bit, name);
}

/** Canonical names of {@link WARDEN_INTENTS}, for status output & the README. */
export const WARDEN_INTENT_NAMES: readonly string[] = WARDEN_INTENTS.map(
  (bit) => INTENT_NAMES.get(bit) ?? `unknown(${bit})`,
);

/**
 * Gateway close codes discord.js does NOT retry (it emits `shardDisconnect`
 * only for these) — each one is an operator-actionable configuration failure,
 * so the log line carries the fix, not just the number.
 */
const UNRECOVERABLE_CLOSE_REMEDIATION: Record<number, string> = {
  4004: "Authentication failed — DISCORD_BOT_TOKEN is invalid or was reset. Copy a fresh token from the developer portal into your MCP client config and restart Warden.",
  4010: "Discord rejected the shard allocation — restart Warden; if it repeats, another process is sharding the same bot with a conflicting count.",
  4011: "Sharding required — this bot is in more servers than one gateway connection allows. Re-run Warden; if it persists, the bot token is being used by a sharded app elsewhere.",
  4012: "Discord rejected the gateway API version — update discord.js (`npm i discord.js@latest`) and restart Warden.",
  4013: "Discord rejected the intent set — an intent is invalid for this application. Update discord.js; if you edited WARDEN_INTENTS, restore the defaults.",
  4014: "A privileged intent is not enabled for this application — toggle Server Members, Presence, and Message Content Intents in the developer portal (Bot tab), then restart Warden.",
};

export interface WardenDiscordStatus {
  ready: boolean;
  /** discord.js connection state name: Ready/Connecting/Reconnecting/… */
  wsStatus: string;
  /** Round-trip ping in ms; null while no shard has connected yet. */
  wsPingMs: number | null;
  /** ISO timestamp of the last successful READY, null before first connect. */
  readyAt: string | null;
  /** Guilds currently in the cache (0 before READY, all after). */
  guildCount: number;
  user: { id: string; username: string; discriminator: string } | null;
  /** Gateway reconnect attempts observed since startup. */
  reconnects: number;
  /** Unrecoverable disconnects observed since startup (0 while healthy). */
  disconnects: number;
  /** Last unrecoverable close code, if any. */
  lastCloseCode: number | null;
}

export interface WardenDiscord {
  readonly client: Client;
  isReady(): boolean;
  /**
   * Resolves once the gateway reports ready; rejects with
   * {@link WardenNotReadyError} on timeout or if the connection is torn down
   * first (both map to the `not_ready` error kind).
   */
  waitForReady(timeoutMs?: number): Promise<void>;
  status(): WardenDiscordStatus;
  login(token: string): Promise<void>;
  destroy(): Promise<void>;
}

interface PendingWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;

export function createWardenDiscord(logger: Logger): WardenDiscord {
  const log = logger.child({ component: "discord" });

  const options: ClientOptions = {
    intents: [...WARDEN_INTENTS],
    partials: [...WARDEN_PARTIALS],
  };
  const client = new Client(options);

  let reconnects = 0;
  let disconnects = 0;
  let lastCloseCode: number | null = null;
  /**
   * Non-null once Warden knows this client can *never* become ready — it was
   * destroyed, or `login()` failed. discord.js calls `destroy()` internally
   * when a login fails, but that never touches our state, so without this a
   * `waitForReady()` issued after a bad token would block for its full timeout
   * instead of failing at once — the unbounded hang the header promises away.
   */
  let fatal: string | null = null;
  const pending = new Set<PendingWaiter>();

  function rejectPending(reason: Error): void {
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    pending.clear();
  }

  /**
   * Readiness as Warden reports it, not merely as discord.js sees it: both
   * must agree. After an unrecoverable close (4004/4010–4014) discord.js leaves
   * `ws.status` at Ready, so `client.isReady()` keeps answering "yes" for a
   * connection that already died — and a `fatal` latch set by `login()` failure
   * must win even while `ws.status` still says Connecting.
   */
  function ready(): boolean {
    return fatal === null && client.isReady();
  }

  client.on(Events.ClientReady, () => {
    fatal = null;
    log.info("gateway ready", {
      user: client.user?.tag ?? null,
      guildCount: client.guilds.cache.size,
      wsPingMs: Number.isFinite(client.ws.ping)
        ? Math.round(client.ws.ping)
        : null,
      intents: WARDEN_INTENT_NAMES.length,
    });
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    pending.clear();
  });

  client.on(Events.ShardReconnecting, (id) => {
    reconnects += 1;
    log.warn("gateway reconnecting", { shardId: id, reconnects });
  });

  client.on(Events.ShardDisconnect, (event, id) => {
    disconnects += 1;
    lastCloseCode = event.code;
    log.error("gateway disconnected unrecoverably", {
      shardId: id,
      closeCode: event.code,
      remediation:
        UNRECOVERABLE_CLOSE_REMEDIATION[event.code] ??
        "Check the WARDEN_LOG_LEVEL=debug stderr output for context.",
    });
    // Waiters would otherwise sit until their timeout — fail them now so the
    // startup error names the real cause. `fatal` is set too: discord.js only
    // emits this event for the six unrecoverable close codes, so without a
    // latch a later `waitForReady()` would burn its whole timeout and then
    // report "did not become ready", hiding the close code we already know.
    const reason = `Discord gateway closed with code ${event.code} before ready.`;
    fatal = reason;
    rejectPending(new WardenNotReadyError(reason));
  });

  client.on(Events.ShardError, (error, id) => {
    log.error("shard error", { shardId: id, error });
  });

  client.on(Events.ShardResume, (id, replayedEvents) => {
    log.info("gateway resumed", { shardId: id, replayedEvents, reconnects });
  });

  // discord.js' own diagnostics — useful behind WARDEN_LOG_LEVEL=debug, and
  // the logger redacts token-shaped strings regardless of what discord.js says.
  client.on(Events.Debug, (message) => {
    log.debug("discord.js", { detail: message });
  });
  client.on(Events.Warn, (message) => {
    log.warn("discord.js", { detail: message });
  });

  return {
    client,

    isReady: ready,

    waitForReady(timeoutMs = DEFAULT_READY_TIMEOUT_MS): Promise<void> {
      // Checked before `ready()`, which already carries the latch — so the two
      // orders behave identically. It stays first because a *permanent*
      // failure should be reported ahead of a transient "not ready yet": a
      // reader of this function sees why it can never succeed before seeing
      // the path where it still might.
      if (fatal !== null) return Promise.reject(new WardenNotReadyError(fatal));
      if (ready()) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const waiter: PendingWaiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            pending.delete(waiter);
            reject(
              new WardenNotReadyError(
                `The Discord gateway did not become ready within ${timeoutMs} ms.`,
              ),
            );
          }, timeoutMs),
        };
        pending.add(waiter);
      });
    },

    status(): WardenDiscordStatus {
      const user = client.user;
      const ping = client.ws.ping;
      return {
        ready: ready(),
        wsStatus: Status[client.ws.status] ?? String(client.ws.status),
        wsPingMs: Number.isFinite(ping) ? Math.round(ping) : null,
        readyAt: client.readyAt?.toISOString() ?? null,
        guildCount: client.guilds.cache.size,
        user: user
          ? {
              id: user.id,
              username: user.username,
              discriminator: user.discriminator,
            }
          : null,
        reconnects,
        disconnects,
        lastCloseCode,
      };
    },

    async login(token: string): Promise<void> {
      log.info("connecting to Discord", {
        intents: WARDEN_INTENT_NAMES.length,
        privilegedIntents: [...PRIVILEGED_INTENTS],
      });
      try {
        await client.login(token);
      } catch (error) {
        // The error itself carries no token; toWardenError() maps
        // TokenInvalid (discord.js) and 401 (REST) to the token remediation.
        fatal =
          "Discord login failed — the client never reached the ready state.";
        rejectPending(new WardenNotReadyError(fatal));
        log.error("Discord login failed", { error });
        throw error;
      }
    },

    async destroy(): Promise<void> {
      fatal = "The Discord client was destroyed before ready.";
      rejectPending(new WardenNotReadyError(fatal));
      await client.destroy();
      log.info("Discord client destroyed");
    },
  };
}
