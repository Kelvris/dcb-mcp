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
 * The shared one-guild world these suites run against (ids, raw payloads,
 * `makeContext`, `expectOk`/`expectFailure`, `registeredNames`) lives in
 * `fixtures.ts` — Phase 6 gave `read-tools.test.ts` the same world, and two
 * suites duplicating a role-position matrix would drift apart silently.
 */

import type { OmitPartialGroupDMChannel } from "discord.js";
import { Events, Message } from "discord.js";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createWarden } from "../src/server.js";
import { getServer } from "../src/tools/guild.js";
import type { ServerOverview } from "../src/tools/guild.js";
import { getBotStatus } from "../src/tools/observe.js";
import {
  createWatch,
  getEvents,
  listWatches,
  readWatch,
  removeWatch,
  waitForEvent,
} from "../src/tools/observe.js";
import type { BotStatusData } from "../src/tools/observe.js";
import { scrubText, toCallToolResult } from "../src/tools/context.js";
import type { ToolContext } from "../src/tools/context.js";
import { fail, ok } from "../src/shared/result.js";

import {
  BOT_ID,
  GENERAL,
  GUILD_ID,
  MEMBER_ID,
  MOD_ROLE,
  OTHER_GUILD_ID,
  OWNER_ID,
  VOICE,
  WARDEN_ROLE,
  construct,
  expectFailure,
  expectOk,
  makeContext,
  newServer,
  registeredNames,
} from "./fixtures.js";

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

describe("registerAll — the phase-4/5/6 registry", () => {
  it("registers exactly the tools this phase ships", () => {
    // A deliberate canary, not a complete-catalog assertion: each later phase
    // adds its domain here (the plan expects ~59–63 tools by Phase 10), and a
    // failure is the prompt to update this list, not to "fix" the test.
    expect(registeredNames(newServer())).toEqual([
      "bulk_delete_messages",
      "crosspost_message",
      "delete_message",
      "edit_message",
      "get_audit_log",
      "get_bot_status",
      "get_events",
      "get_member",
      "get_messages",
      "get_poll_results",
      "get_server",
      "get_user",
      "list_members",
      "list_watches",
      "manage_channel",
      "manage_pins",
      "manage_reactions",
      "manage_role",
      "manage_thread",
      "read_watch",
      "search_messages",
      "send_message",
      "unwatch",
      "wait_for_event",
      "watch",
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
    let withGuildId = 0;
    for (const name of registeredNames(server)) {
      const schema = server.toolInputSchemaJson(name) as {
        type?: string;
        properties?: Record<
          string,
          {
            pattern?: string;
            description?: string;
            properties?: Record<string, { pattern?: string; description?: string }>;
          }
        >;
      };
      expect(schema.type, `${name} must take an object`).toBe("object");
      // `guild_id` appears either directly (get_bot_status, get_server) or
      // nested in the event filter (get_events, watch, wait_for_event) —
      // the snowflake pattern must guard both shapes. list_watches /
      // read_watch / unwatch scope by watch_id, not guild, and take none.
      const guildId =
        schema.properties?.["guild_id"] ??
        schema.properties?.["filter"]?.properties?.["guild_id"];
      if (guildId === undefined) continue;
      withGuildId += 1;
      expect(guildId.pattern, name).toBe("^\\d{17,20}$");
      expect(guildId.description, name).toBeTruthy();
    }
    expect(withGuildId).toBeGreaterThanOrEqual(5);
  });

  it("marks every tool read-only except the mutations", () => {
    const server = newServer();
    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { annotations?: { readOnlyHint?: boolean } }
        >;
      }
    )._registeredTools;
    // The write half: `unwatch` (🔴*, a state change that never touches
    // Discord) plus Phase 7's message mutations. `get_poll_results` and
    // `manage_pins`/`manage_reactions`' `list`/`get_reaction_users` actions
    // are reads *inside* a mutating tool — the annotation is per tool, so a
    // tool that can write anywhere says so.
    const mutations = new Set([
      "unwatch",
      "send_message",
      "edit_message",
      "delete_message",
      "bulk_delete_messages",
      "crosspost_message",
      "manage_pins",
      "manage_reactions",
    ]);
    for (const name of registeredNames(server)) {
      const expected = !mutations.has(name);
      expect(tools[name]?.annotations?.readOnlyHint, name).toBe(expected);
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
    // Same registry contents as the registration canary above — the factory
    // must register the full set once per fresh server.
    expect(registeredNames(first)).toEqual(registeredNames(newServer()));
    expect(registeredNames(second)).toEqual(registeredNames(newServer()));
  });
});

// ---------------------------------------------------------------------------
// event tools (plan §7/§8.1) — driven through the runtime + real discord.js
// objects, i.e. the same dispatch path a live gateway uses
// ---------------------------------------------------------------------------

describe("event tools", () => {
  /** A real discord.js Message on the fixture's `#general`, as discord.js would deliver it. */
  function makeMessage(
    ctx: ToolContext,
    overrides: { content?: string; channel?: string } = {},
  ): Message {
    const guild = ctx.discord.client.guilds.cache.get(GUILD_ID)!;
    const channel = guild.channels.cache.get(overrides.channel ?? GENERAL)!;
    return construct<Message>(
      Message,
      ctx.discord.client,
      {
        id: `${500000000000000000 + Math.floor(Math.random() * 10 ** 12)}`,
        channel_id: channel.id,
        guild_id: GUILD_ID,
        type: 0,
        author: { id: MEMBER_ID, username: "bob", discriminator: "0" },
        content: overrides.content ?? "hello from the test",
        timestamp: "2026-01-01T00:00:00.000Z",
        edited_timestamp: null,
        tts: false,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
      },
      channel,
    );
  }

  /**
   * `client.emit` for message events demands `OmitPartialGroupDMChannel<Message>`
   * (discord.js excludes group-DM channels from dispatch); a guild-channel
   * fixture message satisfies that at runtime, so the cast localizes the
   * typing quirk instead of repeating it at every call site.
   */
  function emitMessage(ctx: ToolContext, message: Message): void {
    ctx.discord.client.emit(
      Events.MessageCreate,
      message as OmitPartialGroupDMChannel<Message>,
    );
  }

  it("delivers a live message to a watch exactly once (plan §12 done-when)", async () => {
    const ctx = makeContext();
    const created = createWatch(ctx, { name: "live" });
    expect(created.ok).toBe(true);

    emitMessage(ctx, makeMessage(ctx));

    const first = expectOk(await readWatch(ctx, { watch_id: "live" })) as {
      events: { type: string; channelId: string; authorId: string }[];
      cursor: number;
      idle: boolean;
    };
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({
      type: "messageCreate",
      channelId: GENERAL,
      authorId: MEMBER_ID,
    });
    expect(first.idle).toBe(false);

    const second = expectOk(await readWatch(ctx, { watch_id: "live" })) as {
      events: unknown[];
      idle: boolean;
    };
    expect(second.events).toEqual([]);
    expect(second.idle).toBe(true);
  });

  it("get_events pulls the tail and pages forward with since_seq", async () => {
    const ctx = makeContext();
    for (let i = 0; i < 5; i++) {
      emitMessage(ctx, makeMessage(ctx));
    }

    const tail = expectOk(await getEvents(ctx, { limit: 2 })) as {
      events: { seq: number }[];
      cursor: number;
    };
    // A bounded pull is the tail: newest `limit`, oldest-first.
    expect(tail.events.map((event) => event.seq)).toEqual([4, 5]);
    expect(tail.cursor).toBe(5);

    const page = expectOk(
      await getEvents(ctx, { since_seq: 1, limit: 2 }),
    ) as { events: { seq: number }[]; cursor: number };
    expect(page.events.map((event) => event.seq)).toEqual([2, 3]);
    expect(page.cursor).toBe(3);
  });

  it("filters by channel and accepts wire type names end-to-end", async () => {
    const ctx = makeContext();
    emitMessage(ctx, makeMessage(ctx));
    // GUILD_ROLE_CREATE arrives library-named (roleCreate); the wire name
    // in the filter must canonicalize to it (§7.2).
    ctx.discord.client.emit(
      Events.GuildRoleCreate,
      ctx.discord.client.guilds.cache.get(GUILD_ID)!.roles.cache.get(MOD_ROLE)!,
    );

    const roles = expectOk(
      await getEvents(ctx, { filter: { types: ["GUILD_ROLE_CREATE"] } }),
    ) as { events: { type: string; targetId: string }[] };
    expect(roles.events).toHaveLength(1);
    expect(roles.events[0]).toMatchObject({
      type: "roleCreate",
      targetId: MOD_ROLE,
    });

    const generalOnly = expectOk(
      await getEvents(ctx, { filter: { channel_id: GENERAL } }),
    ) as { events: { type: string }[] };
    expect(generalOnly.events.map((event) => event.type)).toEqual(["messageCreate"]);
  });

  it("rejects unknown types and mixed cursors with the standard envelope", async () => {
    const ctx = makeContext();
    const unknown = expectFailure(
      await getEvents(ctx, { filter: { types: ["messageCreated"] } }),
    );
    expect(unknown.error).toBe("invalid_input");
    expect(unknown.remediation).toContain("message*");

    const mixed = expectFailure(
      await getEvents(ctx, { since_seq: 1, since: "2026-10-01T00:00:00.000Z" }),
    );
    expect(mixed.error).toBe("invalid_input");
    expect(mixed.message).toContain("not both");
  });

  it("answers not_found for unknown watches and removes known ones", async () => {
    const ctx = makeContext();
    expectFailure(await readWatch(ctx, { watch_id: "ghost" }));

    createWatch(ctx, { name: "mod-log" });
    const listed = expectOk(listWatches(ctx)) as {
      watches: { watch_id: string; cursor: number }[];
      count: number;
    };
    expect(listed.watches.map((watch) => watch.watch_id)).toEqual(["mod-log"]);

    expectOk(removeWatch(ctx, "mod-log"));
    expectFailure(await readWatch(ctx, { watch_id: "mod-log" }));
    expect((expectOk(listWatches(ctx)) as { count: number }).count).toBe(0);
  });

  it("rejects a duplicate watch name and enforces WARDEN_MAX_WATCHES", async () => {
    const ctx = makeContext();
    expectOk(createWatch(ctx, { name: "dup" }));
    const duplicate = expectFailure(createWatch(ctx, { name: "dup" }));
    expect(duplicate.error).toBe("invalid_input");

    const capped = makeContext({
      config: loadConfig({
        DISCORD_BOT_TOKEN: "unit-test-token",
        WARDEN_MAX_WATCHES: "1",
      }),
    });
    expectOk(createWatch(capped, { name: "first" }));
    const full = expectFailure(createWatch(capped, { name: "second" }));
    expect(full.remediation).toContain("WARDEN_MAX_WATCHES");
  });

  it("wait_for_event matches only future events", async () => {
    const ctx = makeContext();
    // History must not satisfy the wait — that is get_events' job.
    emitMessage(ctx, makeMessage(ctx));
    const stale = expectOk(await waitForEvent(ctx, { timeout_ms: 20 })) as {
      timeout: boolean;
      event: unknown;
    };
    expect(stale).toEqual({ timeout: true, event: null });

    const pending = waitForEvent(ctx, {
      filter: { channel_id: GENERAL },
      timeout_ms: 5_000,
    });
    setTimeout(() => {
      emitMessage(ctx, makeMessage(ctx));
    }, 15);
    const matched = expectOk(await pending) as {
      timeout: boolean;
      event: { type: string; channelId: string };
    };
    expect(matched.timeout).toBe(false);
    expect(matched.event).toMatchObject({
      type: "messageCreate",
      channelId: GENERAL,
    });
  });

  it("keeps answering while the gateway is down, with a note instead of not_ready", async () => {
    const ctx = makeContext({ ready: false });
    const data = expectOk(await getEvents(ctx, {})) as { events: unknown[] };
    expect(data.events).toEqual([]);
    const result = await getEvents(ctx, {});
    expect(result.ok).toBe(true);
    expect(result.ok && result.notes?.[0]).toMatch(/gateway is not connected/);
  });

  it("scrubs a token-shaped message body at ingest (plan §4)", async () => {
    const ctx = makeContext();
    emitMessage(
      ctx,
      makeMessage(ctx, {
        content:
          "deploy ABCDEFGHIJKLMNOPQRSTUVWXYZabcd.12345678." +
          "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF now",
      }),
    );
    const data = expectOk(await getEvents(ctx, {})) as {
      events: { data: { content: string } }[];
    };
    expect(data.events[0]?.data.content).toBe("deploy [redacted-token] now");
  });

  it("captures the wire events discord.js does not emit (raw backstop)", async () => {
    const ctx = makeContext();
    ctx.discord.client.emit(Events.Raw, {
      t: "VOICE_CHANNEL_STATUS_UPDATE",
      d: { id: VOICE, guild_id: GUILD_ID, status: "quiet hours" },
    });
    const data = expectOk(await getEvents(ctx, {})) as {
      events: { type: string; channelId: string; data: { status: string } }[];
    };
    expect(data.events[0]).toMatchObject({
      type: "voiceChannelStatusUpdate",
      channelId: VOICE,
      data: { status: "quiet hours" },
    });
  });

  it("block_ms long-polls until the next matching event", async () => {
    const ctx = makeContext();
    createWatch(ctx, { name: "live" });
    const pending = readWatch(ctx, { watch_id: "live", block_ms: 5_000 });
    setTimeout(() => {
      emitMessage(ctx, makeMessage(ctx));
    }, 15);
    const data = expectOk(await pending) as { events: { type: string }[]; idle: boolean };
    expect(data.events).toHaveLength(1);
    expect(data.idle).toBe(false);
  });

  it("pages forward from a wall-clock since (tool level)", async () => {
    const ctx = makeContext();
    for (let i = 0; i < 3; i++) emitMessage(ctx, makeMessage(ctx));

    const past = expectOk(await getEvents(ctx, { since: "2000-01-01T00:00:00.000Z" })) as {
      events: { seq: number }[];
    };
    expect(past.events.map((event) => event.seq)).toEqual([1, 2, 3]);

    // A `since` after everything buffered reads as an empty, honest tail.
    const future = expectOk(await getEvents(ctx, { since: "2099-01-01T00:00:00.000Z" })) as {
      events: unknown[];
    };
    expect(future.events).toEqual([]);
  });

  it("echoes filters in the input's snake_case shape for round-tripping", async () => {
    const ctx = makeContext();
    const created = expectOk(
      createWatch(ctx, {
        name: "w",
        filter: { guild_id: GUILD_ID, channel_id: GENERAL },
        since_seq: 3,
      }),
    ) as { filter: Record<string, unknown>; since_seq: number };
    // `filter` mirrors the filter argument; the since bounds travel as
    // top-level siblings — both exactly where the input schemas take them,
    // so the whole echo can be pasted back verbatim.
    expect(created.filter).toEqual({
      guild_id: GUILD_ID,
      channel_id: GENERAL,
    });
    expect(created.since_seq).toBe(3);

    const listed = expectOk(listWatches(ctx)) as {
      watches: { filter: Record<string, unknown>; since_seq: number }[];
    };
    expect(listed.watches[0]?.filter).toEqual({
      guild_id: GUILD_ID,
      channel_id: GENERAL,
    });
    expect(listed.watches[0]?.since_seq).toBe(3);

    // The wall-clock sibling round-trips the same way.
    const sinceWatch = expectOk(
      createWatch(ctx, { name: "since-w", since: "2026-10-01T00:00:00.000Z" }),
    ) as { filter: Record<string, unknown>; since: string };
    expect(sinceWatch.filter).toEqual({});
    expect(sinceWatch.since).toBe("2026-10-01T00:00:00.000Z");
  });

  it("flags ring eviction in read_watch instead of truncating silently", async () => {
    const ctx = makeContext({
      config: loadConfig({
        DISCORD_BOT_TOKEN: "unit-test-token",
        WARDEN_MAX_EVENTS: "3",
      }),
    });
    createWatch(ctx, { name: "w" });
    emitMessage(ctx, makeMessage(ctx));
    expectOk(await readWatch(ctx, { watch_id: "w" })); // cursor at seq 1

    // The ring holds only the newest 3 — seq 2 was evicted unseen.
    for (let i = 0; i < 4; i++) emitMessage(ctx, makeMessage(ctx));
    const result = await readWatch(ctx, { watch_id: "w" });
    const data = expectOk(result) as { events: unknown[] };
    expect(data.events).toHaveLength(3);
    expect(result.ok && result.notes?.[0]).toMatch(/evicted from the ring/);
  });
});
