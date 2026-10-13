/**
 * Phase 5 — the event normalizer (plan §7.2–§7.3; §11's `normalize.test.ts`
 * row): one fixture per §7.2 event, the payload-trimming rules, and the
 * name/filter canonicalization the tools expose.
 *
 * Fixture strategy, deliberately split:
 *
 * - **Real discord.js objects** for the events whose extractors read library
 *   class fields (message, member, role, channel/thread, ban, voice state,
 *   ready) — constructed from raw payloads the same way `guards.test.ts`,
 *   `serialize.test.ts` and `tools.test.ts` do, so field names here are
 *   pinned to the library, not to our assumptions.
 * - **Raw-shaped plain objects** for the rest — including the eight `wire`
 *   events, whose *input* genuinely is a raw gateway payload. Their shape is
 *   pinned against `discord-api-types` (0.38) at development time.
 *
 * The serializers themselves are pinned in `serialize.test.ts`; this suite
 * pins which fields each extractor *projects* and where the arg tuples sit.
 */

import {
  Client as DiscordClient,
  ClientUser,
  Guild,
  GuildBan,
  Message,
  VoiceState,
} from "discord.js";
import type { GuildMember } from "discord.js";
import { describe, expect, it } from "vitest";

import {
  EVENT_SPECS,
  KNOWN_TYPES,
  canonicalType,
  normalizeFilter,
} from "../src/events/normalize.js";
import { isWardenError } from "../src/discord/errors.js";

// ---------------------------------------------------------------------------
// ids & fixtures
// ---------------------------------------------------------------------------

const ALICE = "100000000000000001";
const BOB = "100000000000000002";
const BOT_ID = "200000000000000001";
const GUILD_ID = "300000000000000001";
const MOD_ROLE = "300000000000000013";
const TEXT_CH = "400000000000000001";
const VOICE_CH = "400000000000000004";
const THREAD_ID = "400000000000000005";
const STAGE_CH = "400000000000000006";
const MESSAGE_ID = "500000000000000001";
const EMOJI_ID = "600000000000000001";
const STICKER_ID = "600000000000000002";
const SCHEDULED_ID = "700000000000000001";
const RULE_ID = "700000000000000002";
const AUDIT_ID = "700000000000000003";
const APP_CMD_ID = "700000000000000004";
const INTEGRATION_ID = "700000000000000005";
const INTERACTION_ID = "700000000000000006";

const SNOWFLAKE = /^\d{17,20}$/;

/** discord.js marks structure constructors `private`/`protected`. */
function construct<T>(Ctor: unknown, ...args: readonly unknown[]): T {
  return new (Ctor as new (...args: unknown[]) => T)(...args);
}

function rawGuild() {
  return {
    id: GUILD_ID,
    name: "Test Guild",
    owner_id: ALICE,
    verification_level: 1,
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
        id: MOD_ROLE,
        name: "Mods",
        position: 1,
        permissions: "1024",
        color: 0,
        hoist: false,
        mentionable: false,
        managed: false,
      },
    ],
    channels: [
      {
        id: TEXT_CH,
        type: 0,
        name: "general",
        position: 0,
        permission_overwrites: [],
      },
      {
        id: VOICE_CH,
        type: 2,
        name: "voice",
        position: 1,
        bitrate: 64000,
        user_limit: 10,
        permission_overwrites: [],
      },
      {
        id: THREAD_ID,
        type: 11,
        name: "thread",
        owner_id: ALICE,
        parent_id: TEXT_CH,
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
        roles: [],
        joined_at: "2024-01-01T00:00:00.000Z",
      },
      {
        user: { id: ALICE, username: "alice", discriminator: "0" },
        roles: [MOD_ROLE],
        joined_at: "2024-01-01T00:00:00.000Z",
      },
    ],
    member_count: 2,
    unavailable: false,
  };
}

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

const alice = guild.members.cache.get(ALICE) as GuildMember;
const modRole = guild.roles.cache.get(MOD_ROLE)!;
const textChannel = guild.channels.cache.get(TEXT_CH)!;
// Threads land in `guild.channels` too — the same seam `get_server` counts.
const thread = guild.channels.cache.get(THREAD_ID)!;

const message = construct<Message>(
  Message,
  client,
  {
    id: MESSAGE_ID,
    channel_id: TEXT_CH,
    guild_id: GUILD_ID,
    type: 0,
    author: { id: ALICE, username: "alice", discriminator: "0" },
    content: "hello world",
    timestamp: "2026-01-01T00:00:00.000Z",
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
  },
  textChannel,
);

/** A delete for a message we never cached: id + channel, nothing else. */
const partialMessage = construct<Message>(
  Message,
  client,
  { id: "500000000000000009", channel_id: TEXT_CH },
  textChannel,
);

const ban = construct<GuildBan>(
  GuildBan,
  client,
  { user: { id: BOB, username: "bob", discriminator: "0" }, reason: "spam" },
  guild,
);

const voiceState = construct<VoiceState>(VoiceState, guild, {
  channel_id: VOICE_CH,
  user_id: ALICE,
  session_id: "abc123session",
  deaf: false,
  mute: false,
  self_deaf: false,
  self_mute: false,
  suppress: false,
});

const aliceUser = { id: ALICE, username: "alice", discriminator: "0" };

// Raw-shaped plain fixtures (see the file header for why these are plain).
const rawCommand = {
  id: APP_CMD_ID,
  application_id: BOT_ID,
  guild_id: GUILD_ID,
  name: "ping",
  description: "pong",
  type: 1,
  version: "1",
};
const rawIntegration = {
  id: INTEGRATION_ID,
  guild_id: GUILD_ID,
  type: "twitch",
  name: "Twitch",
  enabled: true,
  user: { id: ALICE },
};
const voiceStatus = { id: VOICE_CH, guild_id: GUILD_ID, status: "quiet hours" };
const voiceStartTime = {
  id: VOICE_CH,
  guild_id: GUILD_ID,
  // discord-api-types: unix **seconds**.
  voice_start_time: 1767225600,
};
const threadMember = {
  id: ALICE,
  thread,
  joinedTimestamp: Date.parse("2026-01-01T00:00:00.000Z"),
  flags: 1,
};
const stageInstance = {
  id: STAGE_CH,
  guildId: GUILD_ID,
  channelId: STAGE_CH,
  topic: "demo",
  privacyLevel: 2,
  guildScheduledEventId: null,
};
const emoji = { id: EMOJI_ID, name: "party", guildId: GUILD_ID, animated: false };
const sticker = {
  id: STICKER_ID,
  name: "shrug",
  description: null,
  tags: "\\_°ω°_/",
  format: 1,
  available: true,
  guildId: GUILD_ID,
};
const sound = {
  soundId: "sound-1",
  name: "quack",
  volume: 1,
  available: true,
  guildId: GUILD_ID,
  emoji: { id: null, name: "duck" },
};
const invite = {
  code: "abc123",
  guild: { id: GUILD_ID, name: "Test Guild" },
  channel: { id: TEXT_CH, name: "general", type: 0 },
};
const effect = {
  guild: { id: GUILD_ID },
  channelId: VOICE_CH,
  userId: ALICE,
  emoji: null,
  animationType: 0,
  animationId: null,
  soundId: null,
  soundVolume: null,
};
const presence = {
  userId: ALICE,
  status: "online",
  guild: { id: GUILD_ID },
  user: aliceUser,
  clientStatus: { desktop: "online" },
  activities: new Map(),
};
const reaction = { message, emoji: { id: null, name: "thumbsup" }, count: 3 };
const typing = {
  channel: textChannel,
  user: { id: ALICE },
  guild: { id: GUILD_ID },
  startedAt: new Date("2026-01-01T00:00:00.000Z"),
};
const scheduledEvent = {
  id: SCHEDULED_ID,
  guildId: GUILD_ID,
  channelId: VOICE_CH,
  creatorId: ALICE,
  name: "Game night",
  description: "fun",
  scheduledStartTimestamp: Date.parse("2026-02-01T00:00:00.000Z"),
  scheduledEndTimestamp: null,
  status: 2,
  entityType: 2,
  userCount: 5,
  entityMetadata: { location: "stage 1" },
};
const automodRule = {
  id: RULE_ID,
  name: "no-slurs",
  enabled: true,
  triggerType: 1,
  eventType: 1,
  actions: [{ type: 1, metadata: {} }],
  // discord.js rules carry their guild — the extractor must project it, or
  // the family is invisible to `filter.guild_id`.
  guild: { id: GUILD_ID },
};
const automodExecution = {
  ruleId: RULE_ID,
  ruleTriggerType: 1,
  action: { type: 1, metadata: { duration_seconds: 60 } },
  userId: ALICE,
  channelId: TEXT_CH,
  guildId: GUILD_ID,
  messageId: MESSAGE_ID,
  alertSystemMessageId: null,
  content: "x".repeat(2000),
  matchedKeyword: "x",
  matchedContent: "x",
};
const pollAnswer = {
  id: 1,
  text: "yes",
  poll: { messageId: MESSAGE_ID, channelId: TEXT_CH, channel: { guildId: GUILD_ID } },
};
const interaction = {
  id: INTERACTION_ID,
  type: 2,
  applicationId: BOT_ID,
  guildId: GUILD_ID,
  channelId: TEXT_CH,
  user: { id: ALICE },
  commandName: "ping",
  // The interaction token must never reach `data` — plan §7.2 observes
  // interactions, it never responds to them.
  token: "INTERACTION.TOKEN.SECRET",
};

const auditChanges = Array.from({ length: 30 }, (_, index) => ({
  key: `field_${index}`,
  type: "ROLE_UPDATE",
  oldValue: index === 0 ? "a".repeat(1000) : "old",
  newValue: "new",
}));
const auditEntry = {
  id: AUDIT_ID,
  action: 14,
  actionType: "update",
  reason: "cleanup",
  executorId: BOB,
  targetId: MOD_ROLE,
  targetType: "Role",
  changes: auditChanges,
};

// ---------------------------------------------------------------------------
// one fixture per §7.2 event
// ---------------------------------------------------------------------------

const FIXTURES: Record<string, readonly unknown[]> = {
  // Meta
  clientReady: [client],
  shardResume: [3, 12],
  interactionCreate: [interaction],
  applicationCommandCreate: [rawCommand],
  applicationCommandUpdate: [rawCommand],
  applicationCommandDelete: [rawCommand],
  // GUILDS
  guildCreate: [guild],
  guildUpdate: [guild, guild],
  guildDelete: [guild],
  roleCreate: [modRole],
  roleUpdate: [modRole, modRole],
  roleDelete: [modRole],
  channelCreate: [textChannel],
  channelUpdate: [textChannel, textChannel],
  channelDelete: [textChannel],
  channelPinsUpdate: [textChannel, new Date("2026-01-02T00:00:00.000Z")],
  threadCreate: [thread, true],
  threadUpdate: [thread, thread],
  threadDelete: [thread],
  threadListSync: [new Map([[THREAD_ID, thread]]), guild],
  threadMemberUpdate: [threadMember, threadMember],
  threadMembersUpdate: [new Map([[ALICE, threadMember]]), new Map(), thread],
  stageInstanceCreate: [stageInstance],
  stageInstanceUpdate: [stageInstance, stageInstance],
  stageInstanceDelete: [stageInstance],
  voiceChannelStatusUpdate: [voiceStatus],
  voiceChannelStartTimeUpdate: [voiceStartTime],
  // GUILD_MEMBERS
  guildMemberAdd: [alice],
  guildMemberUpdate: [alice, alice],
  guildMemberRemove: [alice],
  // GUILD_MODERATION
  guildAuditLogEntryCreate: [auditEntry, guild],
  guildBanAdd: [ban],
  guildBanRemove: [ban],
  // GUILD_EXPRESSIONS
  emojiUpdate: [emoji, emoji],
  stickerUpdate: [sticker, sticker],
  guildSoundboardSoundCreate: [sound],
  guildSoundboardSoundUpdate: [sound, sound],
  guildSoundboardSoundDelete: [sound],
  guildSoundboardSoundsUpdate: [new Map([[sound.soundId, sound]]), guild],
  // GUILD_INTEGRATIONS
  guildIntegrationsUpdate: [guild],
  integrationCreate: [rawIntegration],
  integrationUpdate: [rawIntegration],
  integrationDelete: [rawIntegration],
  // GUILD_WEBHOOKS / GUILD_INVITES
  webhooksUpdate: [textChannel],
  inviteCreate: [invite],
  inviteDelete: [invite],
  // GUILD_VOICE_STATES / GUILD_PRESENCES
  voiceStateUpdate: [voiceState, voiceState],
  voiceChannelEffectSend: [effect],
  presenceUpdate: [presence, presence],
  // GUILD_MESSAGES
  messageCreate: [message],
  messageUpdate: [message, message],
  messageDelete: [message],
  messageDeleteBulk: [new Map([[MESSAGE_ID, message]]), textChannel],
  // GUILD_MESSAGE_REACTIONS
  messageReactionAdd: [reaction, aliceUser, {}],
  messageReactionRemove: [reaction, aliceUser, {}],
  messageReactionRemoveAll: [message, new Map()],
  messageReactionRemoveEmoji: [reaction],
  // GUILD_MESSAGE_TYPING
  typingStart: [typing],
  // GUILD_SCHEDULED_EVENTS
  guildScheduledEventCreate: [scheduledEvent],
  guildScheduledEventUpdate: [scheduledEvent, scheduledEvent],
  guildScheduledEventDelete: [scheduledEvent],
  guildScheduledEventUserAdd: [scheduledEvent, aliceUser],
  guildScheduledEventUserRemove: [scheduledEvent, aliceUser],
  // AUTO_MODERATION_*
  autoModerationRuleCreate: [automodRule],
  autoModerationRuleUpdate: [automodRule, automodRule],
  autoModerationRuleDelete: [automodRule],
  autoModerationActionExecution: [automodExecution],
  // POLLS
  messagePollVoteAdd: [pollAnswer, ALICE],
  messagePollVoteRemove: [pollAnswer, ALICE],
};

function extract(key: string): ReturnType<NonNullable<(typeof EVENT_SPECS)[string]>["extract"]> {
  const spec = EVENT_SPECS[key];
  if (!spec) throw new Error(`no spec registered for "${key}"`);
  return spec.extract(FIXTURES[key] ?? []);
}

describe("EVENT_SPECS — plan §7.2's inventory", () => {
  it("has one spec per inventory event (count canary)", () => {
    // 69 = §7.2's table: 6 Meta + 21 GUILDS + 3 Members + 3 Moderation +
    // 6 Expressions + 4 Integrations + 1 Webhooks + 2 Invites + 2 Voice
    // States + 1 Presences + 4 Messages + 4 Reactions + 1 Typing +
    // 5 Scheduled + 4 AutoModeration + 2 Polls. Changing this number means
    // §7.2 changed too — update the plan first.
    expect(Object.keys(EVENT_SPECS).length).toBe(69);
  });

  it("has a fixture for every spec, and a spec for every fixture", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(Object.keys(EVENT_SPECS).sort());
  });

  for (const key of Object.keys(FIXTURES)) {
    it(`extracts ${key} into a canonical draft without throwing`, () => {
      const spec = EVENT_SPECS[key]!;
      const draft = extract(key);
      expect(draft.type).toBe(spec.type ?? key);
      expect(KNOWN_TYPES.has(draft.type)).toBe(true);
      expect(typeof draft.data).toBe("object");
      expect(draft.data).not.toBeNull();
      // Every extractor promises the §7.3 shape: the three always-present id
      // fields are `string | null`, and a string is always a snowflake.
      for (const field of ["guildId", "channelId", "authorId"] as const) {
        const value = draft[field];
        expect(
          value === null || (typeof value === "string" && SNOWFLAKE.test(value)),
          `${key}.${field} must be a snowflake or null, got ${JSON.stringify(value)}`,
        ).toBe(true);
      }
    });
  }
});

describe("normalize — field projections", () => {
  it("projects message events onto every filter field", () => {
    const draft = extract("messageCreate");
    expect(draft).toMatchObject({
      type: "messageCreate",
      guildId: GUILD_ID,
      channelId: TEXT_CH,
      authorId: ALICE,
      messageId: MESSAGE_ID,
    });
    expect(draft.data).toMatchObject({ id: MESSAGE_ID, content: "hello world" });
  });

  it("treats a partial message delete as id + whatever Discord sent (§7.4)", () => {
    const spec = EVENT_SPECS.messageDelete!;
    const draft = spec.extract([partialMessage]);
    expect(draft.messageId).toBe("500000000000000009");
    expect(draft.authorId).toBeNull();
    // serializeMessage reports "Discord says none" as null, never invented.
    expect(draft.data.author).toBeNull();
  });

  it("counts a bulk delete by ids, not by entries", () => {
    const draft = extract("messageDeleteBulk");
    expect(draft.data).toMatchObject({ ids: [MESSAGE_ID], count: 1 });
    expect(draft.channelId).toBe(TEXT_CH);
  });

  it("marks the subject of member/role/ban/voice events as targetId", () => {
    expect(extract("guildMemberRemove")).toMatchObject({
      targetId: ALICE,
      authorId: null,
      guildId: GUILD_ID,
    });
    expect(extract("roleUpdate")).toMatchObject({
      targetId: MOD_ROLE,
      guildId: GUILD_ID,
    });
    expect(extract("guildBanAdd")).toMatchObject({ targetId: BOB });
    expect(extract("voiceStateUpdate")).toMatchObject({
      targetId: ALICE,
      channelId: VOICE_CH,
    });
  });

  it("captures READY and RESUMED as meta events with renamed types", () => {
    const ready = extract("clientReady");
    expect(ready.type).toBe("ready");
    expect(ready.data).toMatchObject({ guildCount: 1 });
    expect((ready.data.user as { id: string }).id).toBe(BOT_ID);

    const resumed = extract("shardResume");
    expect(resumed.type).toBe("resumed");
    expect(resumed.data).toEqual({ shardId: 3, replayedEvents: 12 });
  });

  it("never carries an interaction token into data (plan §4/§7.2)", () => {
    const draft = extract("interactionCreate");
    expect(draft.data).not.toHaveProperty("token");
    expect(JSON.stringify(draft.data)).not.toContain("SECRET");
    expect(draft.authorId).toBe(ALICE);
  });

  it("follows threads as their own channel", () => {
    const created = extract("threadCreate");
    expect(created).toMatchObject({ channelId: THREAD_ID, data: { newlyCreated: true } });
    const members = extract("threadMembersUpdate");
    expect(members.data).toMatchObject({
      threadId: THREAD_ID,
      addedCount: 1,
      removedCount: 0,
    });
  });

  it("reads scheduled events with creator, subject and timing", () => {
    const draft = extract("guildScheduledEventCreate");
    expect(draft).toMatchObject({
      guildId: GUILD_ID,
      channelId: VOICE_CH,
      authorId: ALICE,
      targetId: SCHEDULED_ID,
    });
    expect(draft.data.scheduledStartAt).toBe("2026-02-01T00:00:00.000Z");
    const guest = extract("guildScheduledEventUserAdd");
    expect(guest).toMatchObject({ authorId: ALICE, targetId: SCHEDULED_ID });
  });

  it("maps audit entries to executor/target and caps the diff", () => {
    const draft = extract("guildAuditLogEntryCreate");
    expect(draft).toMatchObject({ authorId: BOB, targetId: MOD_ROLE, guildId: GUILD_ID });
    const changes = draft.data.changes as unknown[];
    expect(changes).toHaveLength(25);
    expect(draft.data.changesTruncated).toBe(true);
    // The first change's 1000-char value is trimmed (§7.3: no raw blobs).
    const first = changes[0] as { oldValue: string };
    expect(first.oldValue.length).toBeLessThanOrEqual(300);
  });

  it("trims automod execution content and names rule + author", () => {
    const draft = extract("autoModerationActionExecution");
    expect(draft).toMatchObject({
      authorId: ALICE,
      targetId: RULE_ID,
      guildId: GUILD_ID,
      messageId: MESSAGE_ID,
    });
    expect((draft.data.content as string).length).toBeLessThanOrEqual(1001);
  });

  it("scopes automod rule events to their guild", () => {
    const draft = extract("autoModerationRuleCreate");
    expect(draft.guildId).toBe(GUILD_ID);
    expect(draft.targetId).toBe(RULE_ID);
  });

  it("keeps a message-less partial reaction usable by messageId (§7.4)", () => {
    const spec = EVENT_SPECS.messageReactionRemoveEmoji!;
    const draft = spec.extract([
      { messageId: MESSAGE_ID, emoji: { id: null, name: "thumbsup" } },
    ]);
    expect(draft.messageId).toBe(MESSAGE_ID);
    // Nothing else survived — honest nulls, not invented values.
    expect(draft.channelId).toBeNull();
    expect(draft.guildId).toBeNull();
  });

  it("links a poll vote to its message through the poll", () => {
    const draft = extract("messagePollVoteAdd");
    expect(draft).toMatchObject({
      messageId: MESSAGE_ID,
      channelId: TEXT_CH,
      guildId: GUILD_ID,
      authorId: ALICE,
    });
    expect(draft.data).toMatchObject({ answerId: 1, answerText: "yes" });
  });

  it("counts reactions by reacting user, not by message author", () => {
    const draft = extract("messageReactionAdd");
    expect(draft).toMatchObject({ authorId: ALICE, messageId: MESSAGE_ID });
    expect(draft.data).toMatchObject({ userId: ALICE, count: 3 });
  });
});

describe("normalize — the raw (wire) capture set", () => {
  it("reads voice-channel status and start time from raw payloads", () => {
    const status = extract("voiceChannelStatusUpdate");
    expect(status).toMatchObject({
      guildId: GUILD_ID,
      channelId: VOICE_CH,
      data: { channelId: VOICE_CH, status: "quiet hours" },
    });

    const start = extract("voiceChannelStartTimeUpdate");
    // `voice_start_time` is unix seconds (discord-api-types) → ISO output.
    expect(start.data.startedAt).toBe(
      new Date(1767225600 * 1000).toISOString(),
    );
  });

  it("reads application commands and integrations from raw payloads", () => {
    const command = extract("applicationCommandCreate");
    expect(command).toMatchObject({
      guildId: GUILD_ID,
      targetId: APP_CMD_ID,
      data: { id: APP_CMD_ID, name: "ping", applicationId: BOT_ID },
    });

    const integration = extract("integrationCreate");
    expect(integration).toMatchObject({
      guildId: GUILD_ID,
      targetId: INTEGRATION_ID,
      authorId: ALICE,
      data: { type: "twitch", name: "Twitch", enabled: true },
    });
  });

  it("marks exactly the eight events discord.js does not emit as wire specs", () => {
    const wireKeys = Object.entries(EVENT_SPECS)
      .filter(([, spec]) => spec.wire !== undefined)
      .map(([key]) => key)
      .sort();
    expect(wireKeys).toEqual([
      "applicationCommandCreate",
      "applicationCommandDelete",
      "applicationCommandUpdate",
      "integrationCreate",
      "integrationDelete",
      "integrationUpdate",
      "voiceChannelStartTimeUpdate",
      "voiceChannelStatusUpdate",
    ]);
  });
});

// ---------------------------------------------------------------------------
// names & filters
// ---------------------------------------------------------------------------

describe("canonicalType — wire names and library names agree (§7.2)", () => {
  it("resolves wire names to the canonical type", () => {
    expect(canonicalType("MESSAGE_CREATE")).toBe("messageCreate");
    expect(canonicalType("MESSAGE_DELETE_BULK")).toBe("messageDeleteBulk");
    expect(canonicalType("GUILD_MEMBER_ADD")).toBe("guildMemberAdd");
    expect(canonicalType("READY")).toBe("ready");
    expect(canonicalType("RESUMED")).toBe("resumed");
  });

  it("applies the wire aliases where discord.js renamed the event", () => {
    expect(canonicalType("GUILD_ROLE_CREATE")).toBe("roleCreate");
    expect(canonicalType("GUILD_EMOJIS_UPDATE")).toBe("emojiUpdate");
    expect(canonicalType("GUILD_STICKERS_UPDATE")).toBe("stickerUpdate");
    // Soundboard events keep the wire prefix — no alias needed.
    expect(canonicalType("GUILD_SOUNDBOARD_SOUND_CREATE")).toBe(
      "guildSoundboardSoundCreate",
    );
  });

  it("passes library names and renames through", () => {
    expect(canonicalType("messageCreate")).toBe("messageCreate");
    expect(canonicalType("clientReady")).toBe("ready");
    expect(canonicalType("shardResume")).toBe("resumed");
  });
});

describe("normalizeFilter — tool-boundary validation", () => {
  it("canonicalizes type entries and keeps wildcard prefixes", () => {
    const filter = normalizeFilter({
      types: ["MESSAGE_CREATE", "GUILD_ROLE_CREATE", "message*"],
      guild_id: GUILD_ID,
      since_seq: 10,
    });
    expect(isWardenError(filter)).toBe(false);
    if (isWardenError(filter)) return;
    expect(filter.types).toEqual(["messageCreate", "roleCreate", "message*"]);
    expect(filter.guildId).toBe(GUILD_ID);
    expect(filter.sinceSeq).toBe(10);
  });

  it("rejects unknown type names instead of matching nothing forever", () => {
    const result = normalizeFilter({ types: ["messageCreated"] });
    expect(isWardenError(result)).toBe(true);
    if (!isWardenError(result)) return;
    expect(result.error).toBe("invalid_input");
    expect(result.message).toContain("messageCreated");
    expect(result.remediation).toContain("message*");
  });

  it("rejects wildcards whose prefix matches no known type", () => {
    expect(isWardenError(normalizeFilter({ types: ["xyz*"] }))).toBe(true);
    // A prefix that legitimately starts many types is fine.
    expect(isWardenError(normalizeFilter({ types: ["guild*"] }))).toBe(false);
  });

  it("expands wire-prefixed wildcards the whole-event aliases hide", () => {
    // `GUILD_ROLE*` camel-cases to "guildRole", which starts no canonical
    // type — but the wire names under it are the plan's own spellings, so
    // the pattern expands to those exact canonical types.
    const filter = normalizeFilter({ types: ["GUILD_ROLE*", "GUILD_EMOJIS*"] });
    expect(isWardenError(filter)).toBe(false);
    if (isWardenError(filter)) return;
    expect(filter.types).toEqual([
      "roleCreate",
      "roleUpdate",
      "roleDelete",
      "emojiUpdate",
    ]);
  });

  it("accepts the match-everything pattern", () => {
    const filter = normalizeFilter({ types: ["*"] });
    expect(isWardenError(filter)).toBe(false);
    if (isWardenError(filter)) return;
    expect(filter.types).toEqual(["*"]);
  });

  it("validates the since timestamp", () => {
    expect(isWardenError(normalizeFilter({ since: "yesterday" }))).toBe(true);
    const okFilter = normalizeFilter({ since: "2026-10-01T00:00:00.000Z" });
    expect(isWardenError(okFilter)).toBe(false);
    if (isWardenError(okFilter)) return;
    expect(okFilter.since).toBe("2026-10-01T00:00:00.000Z");
  });
});
