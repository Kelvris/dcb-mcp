/**
 * Phase 4 — the MCP skeleton (plan §5, §8.1, §8.2, §11 "tool schema tests").
 *
 * Two layers are pinned here:
 *
 *  - **Registration**: every tool carries an agent-facing description and an
 *    object input schema with the snowflake pattern, and read-only tools say
 *    so through annotations. This is the seed of the introspection suite the
 *    plan assigns to Phase 6 — it grows with the catalog.
 *  - **Behaviour** of `get_bot_status` and `get_server`, driven against real
 *    discord.js objects built from raw payloads (the same deliberate escape
 *    hatch `guards.test.ts` and `serialize.test.ts` use): the point of these
 *    tools is to agree with what discord.js reports, so doubles that merely
 *    repeat our own assumptions would test nothing.
 *
 * The fixtures here are intentionally smaller than `guards.test.ts`'s — that
 * suite needs the full hierarchy matrix; this one needs one bot, one role
 * above it, two channels and a thread.
 */

import type { Client } from "discord.js";
import {
  Client as DiscordClient,
  ClientUser,
  Guild,
} from "discord.js";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import { WardenNotReadyError } from "../src/discord/errors.js";
import type { WardenError } from "../src/discord/errors.js";
import { createLogger } from "../src/logger.js";
import { registerAll } from "../src/tools/index.js";
import { createWarden } from "../src/server.js";
import { getServer } from "../src/tools/guild.js";
import type { ServerOverview } from "../src/tools/guild.js";
import { getBotStatus } from "../src/tools/observe.js";
import type { BotStatusData } from "../src/tools/observe.js";
import { scrubText, toCallToolResult } from "../src/tools/context.js";
import type { ToolContext } from "../src/tools/context.js";
import type { WardenDiscord } from "../src/discord/client.js";
import { fail, ok } from "../src/shared/result.js";
import type { ToolResult } from "../src/shared/result.js";

// ---------------------------------------------------------------------------
// ids & fixture
// ---------------------------------------------------------------------------

const BOT_ID = "200000000000000001";
const OWNER_ID = "100000000000000001";
const MEMBER_ID = "100000000000000002";
const GUILD_ID = "300000000000000001";
const OTHER_GUILD_ID = "300000000000000002";
const WARDEN_ROLE = "300000000000000012";
const MOD_ROLE = "300000000000000013";
const GENERAL = "400000000000000001";
const VOICE = "400000000000000004";
const THREAD = "400000000000000005";

/** discord.js marks structure constructors `private`/`protected`. */
function construct<T>(Ctor: unknown, ...args: readonly unknown[]): T {
  return new (Ctor as new (...args: unknown[]) => T)(...args);
}

function rawGuild() {
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

function makeClient(): Client {
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
function fakeDiscord(
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

function makeContext(
  options: {
    ready?: boolean;
    config?: Config;
    fatal?: { reason: string; remediation: string } | null;
  } = {},
): ToolContext {
  const client = makeClient();
  return {
    config:
      options.config ?? loadConfig({ DISCORD_BOT_TOKEN: "unit-test-token" }),
    logger: createLogger("error", () => {}),
    discord: fakeDiscord(client, options.ready ?? true, options.fatal ?? null),
  };
}

// ---------------------------------------------------------------------------
// result helpers
// ---------------------------------------------------------------------------

function expectOk(result: ToolResult): Record<string, unknown> {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error}: ${result.message}`);
  }
  return result.data as Record<string, unknown>;
}

function expectFailure(result: ToolResult): WardenError {
  if (result.ok) throw new Error(`expected a failure, got ${result.performed}`);
  return result;
}

/**
 * White-box read of the SDK's registry: the SDK exposes no public accessor
 * for registered tools (only `toolInputSchemaJson`), so this is the only
 * introspection seam — and it fails *loudly* if the SDK renames the field.
 * Driving a full client over InMemoryTransport would test the SDK's dispatch,
 * not this module's wiring.
 */
function registeredNames(server: McpServer): string[] {
  const tools = (
    server as unknown as {
      _registeredTools: Record<string, unknown>;
    }
  )._registeredTools;
  return Object.keys(tools).sort();
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

describe("registerAll — the phase-4 registry", () => {
  function newServer(): McpServer {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerAll(server, makeContext());
    return server;
  }

  it("registers exactly the tools this phase ships", () => {
    // A deliberate canary, not a complete-catalog assertion: each later phase
    // adds its domain here (the plan expects ~59–63 tools by Phase 10), and a
    // failure is the prompt to update this list, not to "fix" the test.
    expect(registeredNames(newServer())).toEqual([
      "get_bot_status",
      "get_server",
    ]);
  });

  it("gives every tool a title and an agent-facing description", () => {
    const server = newServer();
    for (const name of registeredNames(server)) {
      const tool = (
        server as unknown as {
          _registeredTools: Record<
            string,
            { title?: string; description?: string }
          >;
        }
      )._registeredTools[name];
      expect(tool?.title, `${name} needs a title`).toBeTruthy();
      // Short enough to read, long enough to say what it needs and how it
      // fails — the plan's rule for agent-facing descriptions.
      expect(tool?.description?.length ?? 0).toBeGreaterThan(80);
    }
  });

  it("advertises object input schemas carrying the snowflake pattern", () => {
    const server = newServer();
    for (const name of registeredNames(server)) {
      const schema = server.toolInputSchemaJson(name) as {
        type?: string;
        properties?: Record<string, { pattern?: string; description?: string }>;
      };
      expect(schema.type, `${name} must take an object`).toBe("object");
      const guildId = schema.properties?.["guild_id"];
      expect(guildId?.pattern).toBe("^\\d{17,20}$");
      expect(guildId?.description).toBeTruthy();
    }
  });

  it("marks both tools read-only", () => {
    const server = newServer();
    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { annotations?: { readOnlyHint?: boolean } }
        >;
      }
    )._registeredTools;
    for (const name of registeredNames(server)) {
      expect(tools[name]?.annotations?.readOnlyHint, name).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// envelope
// ---------------------------------------------------------------------------

describe("toCallToolResult — the uniform envelope (plan §5)", () => {
  it("carries a success payload as text and structured content", () => {
    const payload = ok("bot.status", { ready: true });
    const result = toCallToolResult(payload);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(payload);
    const [block] = result.content;
    expect(block?.type).toBe("text");
    expect(JSON.parse((block as { text: string }).text)).toEqual(payload);
  });

  it("marks a failure with isError and keeps the payload intact", () => {
    const payload = fail({
      error: "not_found",
      message: "Guild 123 is not in Warden's cache.",
      remediation: "Check the id.",
    });
    const result = toCallToolResult(payload);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(payload);
    const [block] = result.content;
    expect(JSON.parse((block as { text: string }).text)).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });
});

// ---------------------------------------------------------------------------
// get_bot_status
// ---------------------------------------------------------------------------

describe("get_bot_status", () => {
  it("answers ready:false with a note while the gateway is down", async () => {
    const ctx = makeContext({ ready: false });
    const result = await getBotStatus(ctx, {});
    expect(result.ok).toBe(true);
    const data = expectOk(result) as unknown as BotStatusData;
    expect(data.ready).toBe(false);
    expect(data.guilds).toEqual([]);
    // Deliberately a success, not a not_ready failure: this is the tool an
    // agent calls to learn that the others will answer not_ready.
    expect(result.ok && result.notes?.[0]).toMatch(
      /gateway is not connected yet/i,
    );
  });

  it("reports a fatal connection with its remediation instead of 'retry'", async () => {
    const ctx = makeContext({
      ready: false,
      fatal: {
        reason: "Discord login failed — the client never reached the ready state.",
        remediation: "DISCORD_BOT_TOKEN is invalid or was reset.",
      },
    });
    const result = await getBotStatus(ctx, {});
    expect(result.ok).toBe(true);
    const data = expectOk(result) as unknown as BotStatusData;
    expect(data.gateway.fatal?.remediation).toContain("DISCORD_BOT_TOKEN");
    const note = result.ok ? (result.notes?.[0] ?? "") : "";
    // A dead connection must never send the agent back for a retry loop.
    expect(note).toMatch(/can never become ready/);
    expect(note).toMatch(/DISCORD_BOT_TOKEN is invalid/);
    expect(note).not.toMatch(/a few seconds/);
  });

  it("says the guild_id filter was dropped while the gateway is down", async () => {
    const ctx = makeContext({ ready: false });
    const result = await getBotStatus(ctx, { guild_id: GUILD_ID });
    expect(result.ok).toBe(true);
    const note = result.ok ? (result.notes ?? []).join(" ") : "";
    expect(note).toMatch(/guild_id filter was not applied/);
  });

  it("scrubs token-shaped names in the capability report (plan §4)", async () => {
    const ctx = makeContext();
    const guild = ctx.discord.client.guilds.cache.first();
    expect(guild).toBeDefined();
    // Guild names are operator-authored free text — same obligation as
    // get_server's, applied where `ok()` deliberately does not scrub.
    (guild as unknown as { name: string }).name =
      "leak ABCDEFGHIJKLMNOPQRSTUVWXYZabcd.12345678." +
      "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
    const data = expectOk(
      await getBotStatus(ctx, {}),
    ) as unknown as BotStatusData;
    expect(data.guilds[0]?.name).toBe("leak [redacted-token]");
    expect(JSON.stringify(data.guilds)).not.toMatch(
      /[A-Za-z0-9_-]{18,48}\.[A-Za-z0-9_-]{4,16}\.[A-Za-z0-9_-]{20,64}/,
    );
  });

  it("reports the bot, the gateway, and every guild capability", async () => {
    const ctx = makeContext();
    const result = await getBotStatus(ctx, {});
    const data = expectOk(result) as unknown as BotStatusData;

    expect(data.ready).toBe(true);
    expect(data.bot).toEqual({
      id: BOT_ID,
      username: "warden",
      discriminator: "0",
    });
    expect(data.gateway).toMatchObject({ status: "Ready", pingMs: 42 });
    expect(data.intents.count).toBe(data.intents.names.length);
    expect(data.intents.privileged).toContain("MessageContent");
    // The config slice must never carry the token — it isn't even a key here.
    expect(Object.keys(data.config)).not.toContain("DISCORD_BOT_TOKEN");

    const [guild] = data.guilds;
    expect(guild).toMatchObject({
      id: GUILD_ID,
      name: "Test Guild",
      available: true,
      counts: { members: 3, channels: 2, roles: 3 },
      topRole: { id: WARDEN_ROLE, name: "Warden", position: 1 },
    });
    // The role above Warden is named, with positions on both sides…
    expect(guild?.blockers).toContain(
      "role 'Moderator' (position 2) is above " +
        "Warden's top role 'Warden' (position 1)",
    );
    // …and the missing key permissions are listed too.
    expect(
      guild?.blockers.some((line) => line.startsWith("missing ")),
    ).toBe(true);
  });

  it("narrows the report to one guild when asked", async () => {
    const ctx = makeContext();
    const data = expectOk(
      await getBotStatus(ctx, { guild_id: GUILD_ID }),
    ) as unknown as BotStatusData;
    expect(data.guilds.map((guild) => guild.id)).toEqual([GUILD_ID]);
  });

  it("fails with not_found for a guild Warden is not in", async () => {
    const ctx = makeContext();
    const error = expectFailure(
      await getBotStatus(ctx, { guild_id: OTHER_GUILD_ID }),
    );
    expect(error.error).toBe("not_found");
    expect(error.remediation).toMatch(/get_bot_status/i);
  });
});

// ---------------------------------------------------------------------------
// get_server
// ---------------------------------------------------------------------------

describe("get_server", () => {
  it("summarises the server and its postable channels", async () => {
    const ctx = makeContext();
    const data = expectOk(
      await getServer(ctx, { guild_id: GUILD_ID }),
    ) as unknown as ServerOverview;

    expect(data).toMatchObject({
      id: GUILD_ID,
      name: "Test Guild",
      ownerId: OWNER_ID,
      memberCount: 3,
      roleCount: 3,
      channelCount: 2,
      threadCount: 1,
      verificationLevel: 1,
    });

    // Channels sorted by position; threads excluded (they are reachable via
    // manage_thread, not the overview).
    expect(data.channels.map((channel) => channel.id)).toEqual([
      GENERAL,
      VOICE,
    ]);
    expect(data.channels.map((channel) => channel.name)).toEqual([
      "general",
      "voice",
    ]);
    expect(data.channels[0]).toMatchObject({
      type: 0,
      topic: "talk here",
      parentId: null,
    });
    // Voice-only fields appear on the voice channel and are absent from the
    // text one — the serializer's "not applicable → dropped" rule.
    expect(data.channels[1]).toMatchObject({ bitrate: 64000, userLimit: 10 });
    expect(data.channels[0]).not.toHaveProperty("bitrate");
    // Overwrites stay out of the overview (they are the largest channel field).
    expect(data.channels[0]).not.toHaveProperty("permissionOverwrites");
  });

  it("falls back to WARDEN_GUILD_ID when no guild_id is given", async () => {
    const config = loadConfig({
      DISCORD_BOT_TOKEN: "unit-test-token",
      WARDEN_GUILD_ID: GUILD_ID,
    });
    const ctx = makeContext({ config });
    const data = expectOk(await getServer(ctx, {})) as unknown as ServerOverview;
    expect(data.id).toBe(GUILD_ID);
  });

  it("explains the missing guild_id when neither source names a guild", async () => {
    const ctx = makeContext();
    const error = expectFailure(await getServer(ctx, {}));
    expect(error.error).toBe("invalid_input");
    expect(error.remediation).toMatch(/WARDEN_GUILD_ID/);
  });

  it("fails with not_found for a guild Warden is not in", async () => {
    const ctx = makeContext();
    const error = expectFailure(
      await getServer(ctx, { guild_id: OTHER_GUILD_ID }),
    );
    expect(error.error).toBe("not_found");
    expect(error.message).toContain(OTHER_GUILD_ID);
  });

  it("redacts secret-shaped free text before it reaches the result (plan §4)", async () => {
    const ctx = makeContext();
    const data = expectOk(
      await getServer(ctx, { guild_id: GUILD_ID }),
    ) as unknown as ServerOverview;
    // The fixture's description is token-shaped on purpose: `ok()` does not
    // scrub, so `get_server` must — this is the guard for every raw-text
    // field in a success payload.
    expect(data.description).toBe("deploy with [redacted-token] now");
    expect(JSON.stringify(data)).not.toMatch(
      /[A-Za-z0-9_-]{18,48}\.[A-Za-z0-9_-]{4,16}\.[A-Za-z0-9_-]{20,64}/,
    );
  });
});

// ---------------------------------------------------------------------------
// scrubText — the free-text guard shared by every tool payload
// ---------------------------------------------------------------------------

describe("scrubText", () => {
  it("masks token-shaped and webhook-path secrets, leaves plain text alone", () => {
    expect(
      scrubText("key ABCDEFGHIJKLMNOPQRSTUVWXYZabcd.12345678." +
        "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF leaked"),
    ).toBe("key [redacted-token] leaked");
    expect(
      scrubText("POST /webhooks/123456789012345678/super-secret-plain"),
    ).toBe("POST /webhooks/123456789012345678/[redacted-secret]");
    expect(scrubText("general")).toBe("general");
  });

  it("preserves null and undefined — 'none' vs 'not applicable'", () => {
    expect(scrubText(null)).toBeNull();
    expect(scrubText(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createWarden — the per-connection server factory
// ---------------------------------------------------------------------------

describe("createWarden", () => {
  it("hands every connection its own server, each with its own registry", () => {
    // The Blocker this pins: the SDK may build, discard and rebuild instances
    // within one stdio process (probe → legacy), so a shared singleton would
    // be re-served after being closed. Two calls must yield two independent
    // servers — and each must carry the full tool set (registering on a
    // shared instance a second time would throw).
    const warden = createWarden(
      loadConfig({ DISCORD_BOT_TOKEN: "unit-test-token" }),
      createLogger("error", () => {}),
      { connect: false },
    );
    const first = warden.createServer();
    const second = warden.createServer();
    expect(first).not.toBe(second);
    expect(registeredNames(first)).toEqual(["get_bot_status", "get_server"]);
    expect(registeredNames(second)).toEqual(["get_bot_status", "get_server"]);
  });
});
