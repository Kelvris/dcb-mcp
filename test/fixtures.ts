/**
 * Shared fixtures for the tool-layer suites (Phase 6 onwards).
 *
 * These started life inside `tools.test.ts` and moved out here when Phase 6
 * added `read-tools.test.ts` — two suites that both drive tools against the
 * same one-guild world would otherwise have to agree by copy-paste, and
 * drift silently the first time someone edits a role position.
 *
 * The shape of every fixture is deliberate and inherited from
 * `guards.test.ts`/`serialize.test.ts`: **real discord.js objects built from
 * raw payloads** via {@link construct}. The tools' whole job is to agree with
 * what discord.js reports, so doubles that merely restate our own
 * assumptions would test nothing. `construct` is the documented escape hatch
 * for the `private`/`protected` constructors discord.js marks.
 *
 * The world is one guild with:
 *  - three members (the bot, the owner `alice`, a plain member `bob`),
 *  - three roles (`@everyone` @0, `Warden` @1, `Moderator` @2 — the last sits
 *    above Warden, which is what makes hierarchy verdicts observable),
 *  - two channels (`#general` text, `voice`) and one active thread,
 *  - a deliberately token-shaped guild description, so a scrubbing regression
 *    fails a test instead of leaking.
 */

import type { Client } from "discord.js";
import { Client as DiscordClient, ClientUser, Guild } from "discord.js";
import { McpServer } from "@modelcontextprotocol/server";

import { loadConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import { WardenNotReadyError } from "../src/discord/errors.js";
import type { WardenError } from "../src/discord/errors.js";
import type { WardenDiscord } from "../src/discord/client.js";
import { createEventRuntime } from "../src/events/index.js";
import { createLogger } from "../src/logger.js";
import { registerAll } from "../src/tools/index.js";
import type { ToolContext } from "../src/tools/context.js";
import type { ToolResult } from "../src/shared/result.js";

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

export const BOT_ID = "200000000000000001";
export const OWNER_ID = "100000000000000001";
export const MEMBER_ID = "100000000000000002";
export const GUILD_ID = "300000000000000001";
export const OTHER_GUILD_ID = "300000000000000002";
export const WARDEN_ROLE = "300000000000000012";
export const MOD_ROLE = "300000000000000013";
export const GENERAL = "400000000000000001";
export const VOICE = "400000000000000004";
export const THREAD = "400000000000000005";

// ---------------------------------------------------------------------------
// raw payloads
// ---------------------------------------------------------------------------

/** discord.js marks structure constructors `private`/`protected`. */
export function construct<T>(Ctor: unknown, ...args: readonly unknown[]): T {
  return new (Ctor as new (...args: unknown[]) => T)(...args);
}

export function rawGuild() {
  return {
    id: GUILD_ID,
    name: "Test Guild",
    owner_id: OWNER_ID,
    verification_level: 1,
    // Deliberately token-shaped (plan §4): `get_server` must not pass this
    // through — free text is exactly where an operator pastes a secret.
    description:
      "deploy with ABCDEFGHIJKLMNOPQRSTUVWXYZabcd.12345678." +
      "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF now",
    // Same default @everyone bitfield guards.test.ts uses: it deliberately
    // lacks ManageGuild/ManageRoles/ManageMessages/Kick/Ban/ModerateMembers,
    // which is what makes the "missing …" blockers observable.
    roles: [
      {
        id: GUILD_ID,
        name: "@everyone",
        position: 0,
        permissions: "104320577",
        color: 0,
        hoist: false,
        mentionable: false,
      },
      {
        id: WARDEN_ROLE,
        name: "Warden",
        position: 1,
        permissions: "0",
        color: 0,
        hoist: false,
        mentionable: false,
        managed: false,
      },
      {
        // Sits above Warden — the one role a mutation cannot touch, and the
        // blocker `get_bot_status` must surface up front.
        id: MOD_ROLE,
        name: "Moderator",
        position: 2,
        permissions: "0",
        color: 0,
        hoist: false,
        mentionable: false,
        managed: false,
      },
    ],
    channels: [
      {
        id: GENERAL,
        type: 0,
        name: "general",
        position: 0,
        topic: "talk here",
        permission_overwrites: [],
      },
      {
        id: VOICE,
        type: 2,
        name: "voice",
        position: 1,
        bitrate: 64000,
        user_limit: 10,
        permission_overwrites: [],
      },
    ],
    // discord.js puts these in `guild.channels.cache` (Guild.js `_patch` adds
    // `data.threads` through `client.channels._add`), not a `guild.threads`
    // that does not exist — `cachedThreads()` in manage_thread relies on it.
    threads: [
      {
        id: THREAD,
        type: 11,
        name: "thread",
        owner_id: OWNER_ID,
        parent_id: GENERAL,
        message_count: 0,
        total_message_sent: 0,
        flags: 0,
        member_count: 1,
        thread_metadata: { archived: false, auto_archive_duration: 1440 },
        last_message_id: null,
      },
    ],
    members: [
      {
        user: { id: BOT_ID, username: "warden", discriminator: "0", bot: true },
        roles: [WARDEN_ROLE],
        joined_at: "2024-01-01T00:00:00.000Z",
      },
      {
        user: { id: OWNER_ID, username: "alice", discriminator: "0" },
        roles: [],
        joined_at: "2024-01-01T00:00:00.000Z",
      },
      {
        user: { id: MEMBER_ID, username: "bob", discriminator: "0" },
        roles: [],
        joined_at: "2024-01-01T00:00:00.000Z",
      },
    ],
    member_count: 3,
    unavailable: false,
  };
}

// ---------------------------------------------------------------------------
// client & context
// ---------------------------------------------------------------------------

export function makeClient(): Client {
  const client = new DiscordClient({ intents: [] });
  (client as unknown as { user: ClientUser | null }).user =
    construct<ClientUser>(ClientUser, client, {
      id: BOT_ID,
      username: "warden",
      discriminator: "0",
      bot: true,
    });
  const guild = construct<Guild>(Guild, client, rawGuild());
  client.guilds.cache.set(guild.id, guild);
  return client;
}

/** Minimal `WardenDiscord` over a fixed client — status reflects `ready`. */
export function fakeDiscord(
  client: Client,
  ready: boolean,
  fatal: { reason: string; remediation: string } | null = null,
): WardenDiscord {
  return {
    client,
    isReady: () => ready,
    waitForReady: () =>
      ready
        ? Promise.resolve()
        : Promise.reject(new WardenNotReadyError("not ready")),
    status: () => ({
      ready,
      wsStatus: ready ? "Ready" : "Connecting",
      wsPingMs: ready ? 42 : null,
      readyAt: ready ? "2026-01-01T00:00:00.000Z" : null,
      guildCount: client.guilds.cache.size,
      user: client.user
        ? {
            id: client.user.id,
            username: client.user.username,
            discriminator: client.user.discriminator,
          }
        : null,
      reconnects: 0,
      disconnects: 0,
      lastCloseCode: null,
      fatal,
    }),
    login: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
}

export function makeContext(
  options: {
    ready?: boolean;
    config?: Config;
    fatal?: { reason: string; remediation: string } | null;
  } = {},
): ToolContext {
  const client = makeClient();
  const config =
    options.config ?? loadConfig({ DISCORD_BOT_TOKEN: "unit-test-token" });
  const logger = createLogger("error", () => {});
  return {
    config,
    logger,
    discord: fakeDiscord(client, options.ready ?? true, options.fatal ?? null),
    // Phase 5: the event runtime over the same client — tests drive it with
    // `client.emit(...)` exactly as discord.js would dispatch.
    events: createEventRuntime(
      client,
      { maxEvents: config.WARDEN_MAX_EVENTS, maxWatches: config.WARDEN_MAX_WATCHES },
      logger,
    ),
  };
}

// ---------------------------------------------------------------------------
// result helpers
// ---------------------------------------------------------------------------

export function expectOk(result: ToolResult): Record<string, unknown> {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error}: ${result.message}`);
  }
  return result.data as Record<string, unknown>;
}

export function expectFailure(result: ToolResult): WardenError {
  if (result.ok) throw new Error(`expected a failure, got ${result.performed}`);
  return result;
}

/** The notes of a success result, or `[]` when it carries none. */
export function expectNotes(result: ToolResult): string[] {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error}: ${result.message}`);
  }
  return result.notes ?? [];
}

/**
 * White-box read of the SDK's registry: the SDK exposes no public accessor
 * for registered tools (only `toolInputSchemaJson`), so this is the only
 * introspection seam — and it fails *loudly* if the SDK renames the field.
 * Driving a full client over InMemoryTransport would test the SDK's dispatch,
 * not this module's wiring.
 */
export function registeredNames(server: McpServer): string[] {
  const tools = (
    server as unknown as {
      _registeredTools: Record<string, unknown>;
    }
  )._registeredTools;
  return Object.keys(tools).sort();
}

/** A server with every registered tool wired to a fixture context. */
export function newServer(ctx: ToolContext = makeContext()): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerAll(server, ctx);
  return server;
}
