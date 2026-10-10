/**
 * serializers/ is the contract between discord.js and every payload the agent
 * ever sees, so these tests deliberately feed it **real constructed discord.js
 * objects** rather than only hand-written fixtures: that is what pins each
 * field name to the library instead of to whatever a fixture happens to
 * repeat. A smaller plain-fixture block at the end proves the structural
 * `*Like` inputs really do accept hand-written data too.
 *
 * The expected values below were captured from discord.js itself, so a
 * discord.js rename (or a Warden-side key typo) fails loudly here rather than
 * silently changing the MCP surface.
 */

import type {
  ForumChannel,
  TextChannel,
  ThreadChannel,
  VoiceChannel,
} from "discord.js";
import {
  Client,
  Embed,
  Guild,
  GuildBan,
  Invite,
  Message,
  PermissionsBitField,
  Presence,
  Role,
  SystemChannelFlagsBitField,
  User,
  VoiceState,
  Webhook,
} from "discord.js";
import { describe, expect, it } from "vitest";
import {
  compact,
  idList,
  serializeBan,
  serializeBitField,
  serializeChannel,
  serializeEmbed,
  serializeEmoji,
  serializeGuild,
  serializeInvite,
  serializeMember,
  serializeMessage,
  serializePermissions,
  serializePresence,
  serializeRole,
  serializeUser,
  serializeVoiceState,
  serializeWebhook,
} from "../src/discord/serializers/index.js";

const ALICE = "100000000000000001";
const GUILD_ID = "100000000000000002";
const MODS_ROLE = "100000000000000020";
const TEXT_CHANNEL = "100000000000000004";
const VOICE_CHANNEL = "100000000000000005";
const FORUM_CHANNEL = "100000000000000006";
const THREAD_ID = "100000000000000007";
/** Snowflake that decodes to 2026-01-01T00:00:00.000Z. */
const MESSAGE_ID = "1456074443980812345";

const rawGuild = {
  id: GUILD_ID,
  name: "Test Guild",
  icon: "0123456789abcdef",
  description: "a guild",
  owner_id: ALICE,
  preferred_locale: "en-US",
  afk_channel_id: "100000000000000006",
  afk_timeout: 300,
  verification_level: 1,
  default_message_notifications: 1,
  explicit_content_filter: 2,
  roles: [
    {
      id: GUILD_ID,
      name: "@everyone",
      color: 0,
      colors: { primary_color: 0, secondary_color: null, tertiary_color: null },
      hoist: false,
      position: 0,
      permissions: "104320577",
      mentionable: false,
    },
    {
      id: MODS_ROLE,
      name: "Mods",
      color: 3447003,
      colors: {
        primary_color: 3447003,
        secondary_color: null,
        tertiary_color: null,
      },
      hoist: true,
      icon: null,
      unicode_emoji: null,
      position: 5,
      permissions: "1099511627775",
      managed: false,
      mentionable: true,
      tags: { bot_id: ALICE },
    },
  ],
  channels: [
    {
      id: TEXT_CHANNEL,
      type: 0,
      name: "general",
      position: 0,
      topic: "talk here",
      nsfw: false,
      rate_limit_per_user: 0,
      parent_id: null,
      permission_overwrites: [
        { id: MODS_ROLE, type: 0, allow: "1024", deny: "0" },
      ],
      last_message_id: "1456074443980812340",
    },
    {
      id: VOICE_CHANNEL,
      type: 2,
      name: "Voice",
      position: 1,
      bitrate: 64000,
      user_limit: 10,
      rtc_region: "us-central",
      video_quality_mode: 1,
      parent_id: null,
      permission_overwrites: [],
    },
    {
      id: FORUM_CHANNEL,
      type: 15,
      name: "forum",
      position: 2,
      topic: "post here",
      nsfw: false,
      rate_limit_per_user: null,
      parent_id: null,
      permission_overwrites: [],
      last_message_id: "1456074443980812342",
      default_sort_order: 0,
      default_forum_layout: 1,
      default_auto_archive_duration: 10080,
      default_reaction_emoji: {
        emoji_id: "100000000000000050",
        emoji_name: "warden",
      },
      available_tags: [
        {
          id: "100000000000000060",
          name: "bug",
          emoji_id: "100000000000000050",
          emoji_name: "bug",
          moderated: true,
          sort_order: 0,
        },
      ],
    },
  ],
  // Threads are seeded into `guild.channels` by discord.js — see `channelCount`.
  threads: [
    {
      id: THREAD_ID,
      type: 11,
      name: "thread",
      owner_id: ALICE,
      parent_id: FORUM_CHANNEL,
      message_count: 3,
      total_message_sent: 2,
      flags: 0,
      member_count: 2,
      applied_tags: ["100000000000000060"],
      last_message_id: "1456074443980812341",
      thread_metadata: {
        archived: false,
        auto_archive_duration: 1440,
        create_timestamp: "2024-01-01T00:00:00.000Z",
      },
    },
  ],
  members: [
    {
      user: {
        id: ALICE,
        username: "alice",
        discriminator: "0",
        global_name: "Alice",
        avatar: "0123456789abcdef0123456789abcdef",
        bot: true,
      },
      nick: "Ali",
      roles: [MODS_ROLE],
      joined_at: "2024-02-01T00:00:00.000Z",
      communication_disabled_until: "2026-12-01T00:00:00.000Z",
      avatar: "abcdef0123456789abcdef0123456789",
      premium_since: "2024-03-01T00:00:00.000Z",
      pending: false,
    },
  ],
  presences: [
    {
      user: { id: ALICE, username: "alice", discriminator: "0" },
      status: "dnd",
      activities: [
        {
          name: "Visual Studio Code",
          type: 0,
          state: "editing warden",
          details: "serializers/",
          application_id: "357940114668354560",
          timestamps: { start: 1700000000000 },
          id: "custom",
        },
      ],
      client_status: { desktop: "idle", mobile: "online" },
    },
  ],
  emojis: [
    {
      id: "100000000000000050",
      name: "warden",
      roles: [MODS_ROLE],
      require_colons: true,
      managed: false,
      animated: true,
      available: true,
      guild_id: GUILD_ID,
    },
  ],
  stickers: [],
  stage_instances: [],
  guild_scheduled_events: [],
  voice_states: [],
  features: ["BANNER", "INVITE_SPLASH"],
  mfa_level: 1,
  application_id: "100000000000000014",
  system_channel_id: "100000000000000031",
  system_channel_flags: 1,
  rules_channel_id: "100000000000000012",
  public_updates_channel_id: "100000000000000013",
  safety_alerts_channel_id: "100000000000000015",
  premium_subscription_count: 3,
  premium_tier: 1,
  premium_progress_bar_enabled: true,
  vanity_url_code: "warden",
  banner: "abcdef1234567890",
  splash: "1234567890abcdef",
  discovery_splash: "fedcba9876543210",
  nsfw_level: 0,
  widget_enabled: true,
  widget_channel_id: "100000000000000006",
  unavailable: false,
  member_count: 5,
  approximate_member_count: 5,
  approximate_presence_count: 2,
  joined_at: "2024-01-01T00:00:00.000Z",
};

const client = new Client({ intents: [] });

/**
 * discord.js marks every structure constructor `private`/`protected` — the
 * supported route is through a manager. These tests build structures straight
 * from raw API payloads instead, because that is what pins each field name to
 * what the library *actually reads* rather than to whatever a manager
 * normalises first, so this is the single deliberate escape hatch.
 */
function construct<T>(Ctor: unknown, ...args: readonly unknown[]): T {
  return new (Ctor as new (...args: unknown[]) => T)(...args);
}

const guild = construct<Guild>(Guild, client, rawGuild);
const text = guild.channels.cache.get(TEXT_CHANNEL) as TextChannel;
const voice = guild.channels.cache.get(VOICE_CHANNEL) as VoiceChannel;
const alice = guild.members.cache.get(ALICE) as NonNullable<
  ReturnType<Guild["members"]["cache"]["get"]>
>;
const presence = guild.presences.cache.get(ALICE) as Presence;
const emoji = guild.emojis.cache.first() as NonNullable<
  ReturnType<Guild["emojis"]["cache"]["get"]>
>;

const user = construct<User>(User, client, {
  id: ALICE,
  username: "alice",
  discriminator: "0",
  global_name: "Alice",
  avatar: "0123456789abcdef0123456789abcdef",
  bot: true,
  system: false,
  public_flags: 64,
});

const invite = construct<Invite>(Invite, client, {
  code: "AbCdEf123",
  guild: {
    id: GUILD_ID,
    name: "Test Guild",
    icon: null,
    splash: null,
    banner: null,
    description: null,
    features: ["BANNER"],
    vanity_url_code: null,
  },
  channel: { id: TEXT_CHANNEL, name: "general", type: 0 },
  inviter: { id: ALICE, username: "alice", discriminator: "0" },
  target_type: 1,
  expires_at: "2026-11-01T00:00:00.000Z",
  max_age: 86400,
  max_uses: 10,
  temporary: false,
  uses: 3,
  approximate_presence_count: 2,
  approximate_member_count: 5,
});

const WEBHOOK_TOKEN = "SUPERSECRETTOKENVALUE";
const webhook = construct<Webhook>(Webhook, client, {
  id: "100000000000000030",
  type: 1,
  channel_id: TEXT_CHANNEL,
  guild_id: GUILD_ID,
  name: "Warden Hook",
  application_id: null,
  avatar: null,
  token: WEBHOOK_TOKEN,
});

const ban = construct<GuildBan>(
  GuildBan,
  client,
  {
    user: { id: "100000000000000040", username: "mallory", discriminator: "0" },
    reason: "spam",
  },
  guild,
);

const voiceState = construct<VoiceState>(VoiceState, guild, {
  channel_id: VOICE_CHANNEL,
  user_id: ALICE,
  session_id: "abc123session",
  deaf: true,
  mute: false,
  self_deaf: true,
  self_mute: false,
  self_stream: true,
  self_video: false,
  suppress: false,
  request_to_speak_timestamp: "2024-05-01T00:00:00.000Z",
  flags: 2,
});

const message = construct<Message>(
  Message,
  client,
  {
    id: MESSAGE_ID,
    channel_id: TEXT_CHANNEL,
    guild_id: GUILD_ID,
    type: 0,
    author: {
      id: ALICE,
      username: "alice",
      discriminator: "0",
      global_name: "Alice",
      avatar: "0123456789abcdef0123456789abcdef",
      bot: true,
    },
    content: `hello <@100000000000000041> <@&${MODS_ROLE}> <#${TEXT_CHANNEL}>`,
    timestamp: "2026-01-01T00:00:00.000Z",
    edited_timestamp: "2026-01-01T01:00:00.000Z",
    tts: false,
    mention_everyone: true,
    mentions: [
      { id: "100000000000000041", username: "bob", discriminator: "0" },
    ],
    mention_roles: [MODS_ROLE],
    mention_channels: [
      { id: TEXT_CHANNEL, guild_id: GUILD_ID, name: "general", type: 0 },
    ],
    attachments: [
      {
        id: "120000000000000001",
        filename: "shot.png",
        size: 2048,
        url: `https://cdn.discordapp.com/attachments/${TEXT_CHANNEL}/120000000000000001/shot.png`,
        proxy_url: `https://media.discordapp.net/attachments/${TEXT_CHANNEL}/120000000000000001/shot.png`,
        width: 100,
        height: 50,
        content_type: "image/png",
      },
    ],
    embeds: [
      {
        title: "Hello",
        description: "world",
        url: "https://example.com",
        color: 3447003,
        timestamp: "2026-01-01T00:00:00.000Z",
        author: {
          name: "auth",
          url: "https://a.example",
          icon_url: "https://i.example/x.png",
        },
        footer: { text: "foot", icon_url: "https://i.example/f.png" },
        image: { url: "https://i.example/img.png", width: 10, height: 20 },
        thumbnail: { url: "https://i.example/th.png", width: 30, height: 40 },
        provider: { name: "prov", url: "https://p.example" },
        fields: [{ name: "f1", value: "v1", inline: true }],
      },
    ],
    pinned: false,
    flags: 4, // MessageFlags.SuppressEmbeds
    message_reference: {
      message_id: "1456074443980812340",
      channel_id: TEXT_CHANNEL,
      guild_id: GUILD_ID,
      type: 0,
    },
    sticker_items: [],
    poll: {
      question: { text: "Best?" },
      answers: [
        { answer_id: 1, poll_media: { text: "A" } },
        { answer_id: 2, poll_media: { text: "B" } },
      ],
      expiry: "2026-02-01T00:00:00.000Z",
      allow_multiselect: true,
      layout_type: 1,
      results: {
        is_finalized: true,
        answer_counts: [
          { id: 1, count: 3 },
          { id: 2, count: 1 },
        ],
      },
    },
    components: [],
  },
  text,
);

const partialMessage = construct<Message>(
  Message,
  client,
  { id: "1456074443980812399", channel_id: TEXT_CHANNEL },
  text,
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

describe("compact", () => {
  it("drops undefined keys but keeps explicit null", () => {
    const result = compact({
      present: null,
      absent: undefined,
      zero: 0,
      no: false,
      empty: "",
    });
    expect(Object.keys(result)).toEqual(["present", "zero", "no", "empty"]);
    expect(result.present).toBeNull();
    expect(result.zero).toBe(0);
    expect(result.no).toBe(false);
  });
});

describe("idList", () => {
  it("accepts objects, raw ids and Collections alike", () => {
    expect(idList([{ id: "1" }, "2", { id: 3 }, null, { nope: true }])).toEqual(
      ["1", "2", "3"],
    );
    expect(idList(null)).toEqual([]);
    expect(idList(undefined)).toEqual([]);
    expect(idList([])).toEqual([]);
  });
});

describe("serializePermissions", () => {
  it("collapses the ManageEmojisAndStickers alias onto its canonical name", () => {
    const field = new PermissionsBitField(1_073_741_824n); // 1 << 30
    // discord.js returns BOTH names for that one bit; Discord renamed the
    // permission, so the agent must only ever see the current one.
    expect(field.toArray()).toContain("ManageEmojisAndStickers");
    expect(serializePermissions(field)).toEqual(["ManageGuildExpressions"]);
  });

  it("leaves a single permission untouched", () => {
    expect(serializePermissions(new PermissionsBitField(8n))).toEqual([
      "Administrator",
    ]);
  });

  it("treats null/undefined as no permissions", () => {
    expect(serializePermissions(null)).toEqual([]);
    expect(serializePermissions(undefined)).toEqual([]);
  });

  it("passes a plain name list through with aliases collapsed", () => {
    expect(
      serializePermissions([
        "ManageEmojisAndStickers",
        "ManageGuildExpressions",
        "KickMembers",
      ]),
    ).toEqual(["ManageGuildExpressions", "KickMembers"]);
  });
});

describe("serializeBitField", () => {
  it("names system-channel flags", () => {
    expect(serializeBitField(new SystemChannelFlagsBitField(1))).toEqual([
      "SuppressJoinNotifications",
    ]);
    expect(serializeBitField([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// users & members
// ---------------------------------------------------------------------------

describe("serializeUser — real discord.js User", () => {
  it("matches discord.js field-for-field", () => {
    expect(serializeUser(user)).toEqual({
      id: ALICE,
      username: "alice",
      globalName: "Alice",
      discriminator: "0",
      avatar: "0123456789abcdef0123456789abcdef",
      avatarUrl:
        "https://cdn.discordapp.com/avatars/100000000000000001/0123456789abcdef0123456789abcdef.webp",
      bot: true,
      system: false,
      flags: ["HypeSquadOnlineHouse1"],
      createdAt: "2015-10-03T22:44:17.910Z",
    });
  });
});

describe("serializeMember — real discord.js GuildMember", () => {
  it("keeps the trimmed member shape (plan §7.3)", () => {
    const result = serializeMember(alice);
    expect(Object.keys(result)).toEqual([
      "id",
      "user",
      "roles",
      "nickname",
      "displayName",
      "joinedAt",
      "communicationDisabledUntil",
      "premiumSince",
      "avatar",
    ]);
    expect(result.id).toBe(ALICE);
    expect(result.nickname).toBe("Ali");
    expect(result.displayName).toBe("Ali");
    expect(result.joinedAt).toBe("2024-02-01T00:00:00.000Z");
    expect(result.communicationDisabledUntil).toBe("2026-12-01T00:00:00.000Z");
    expect(result.premiumSince).toBe("2024-03-01T00:00:00.000Z");
    expect(result.avatar).toBe("abcdef0123456789abcdef0123456789");
    expect(result.user).not.toBeNull();
  });

  it("drops the implicit @everyone role discord.js seeds into the cache", () => {
    // discord.js' GuildMemberRoleManager.cache unconditionally seeds
    // `@everyone` (whose role id IS the guild id) ahead of the member's own
    // roles; Discord's `member.roles` never lists it, and surfacing it would
    // invite `remove_role(guildId)`.
    expect([...alice.roles.cache.keys()]).toEqual([GUILD_ID, MODS_ROLE]);
    expect(serializeMember(alice).roles).toEqual([MODS_ROLE]);
  });
});

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

describe("serializeRole — real discord.js Role", () => {
  it("reads colour from the modern `colors` object and position from rawPosition", () => {
    const mods = guild.roles.cache.get(MODS_ROLE) as Role;
    const result = serializeRole(mods);
    expect(result).toEqual({
      id: MODS_ROLE,
      name: "Mods",
      color: 3447003,
      hexColor: "#3498db",
      position: 5, // rawPosition — `position` recomputes from cache and would read 0
      permissions: expect.arrayContaining([
        "Administrator",
        "ManageGuildExpressions",
      ]),
      hoist: true,
      mentionable: true,
      managed: false,
      icon: null,
      iconUrl: null,
      unicodeEmoji: null,
      tags: { botId: ALICE },
      createdAt: "2015-10-03T22:44:17.910Z",
    });
    // Bit 1<<30 is returned by discord.js under BOTH its old and new names.
    expect(result.permissions).toContain("ManageGuildExpressions");
    expect(result.permissions).not.toContain("ManageEmojisAndStickers");
    // A copy, never discord.js' own cached `RoleTags` object.
    expect(result.tags).not.toBe(mods.tags);
    expect(result.tags).toEqual({ botId: ALICE });
  });

  it('renders a zero colour as #000000 rather than as "no colour"', () => {
    const everyone = guild.roles.cache.get(GUILD_ID) as Role;
    expect(serializeRole(everyone).hexColor).toBe("#000000");
    expect(serializeRole(everyone).color).toBe(0);
  });

  it("never calls Role.hexColor, which throws when a role has no colours", () => {
    const bare = construct<Role>(
      Role,
      client,
      {
        id: "100000000000000021",
        name: "NoColor",
        position: 1,
        permissions: "0",
        hoist: false,
        managed: false,
        mentionable: false,
      },
      guild,
    );
    // discord.js' own getter blows up on this input ("Cannot read properties of
    // undefined (reading 'primaryColor')") — the serializer must not.
    expect(() => bare.hexColor).toThrow();
    expect(serializeRole(bare)).toEqual({
      id: "100000000000000021",
      name: "NoColor",
      color: null,
      hexColor: null,
      position: 1,
      permissions: [],
      hoist: false,
      mentionable: false,
      managed: false,
      icon: null,
      iconUrl: null,
      unicodeEmoji: null,
      tags: null,
      createdAt: "2015-10-03T22:44:17.910Z",
    });
  });
});

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

describe("serializeChannel — real discord.js channels", () => {
  it("emits the text-only keys on a guild text channel", () => {
    expect(serializeChannel(text)).toEqual({
      id: TEXT_CHANNEL,
      type: 0,
      name: "general",
      parentId: null,
      position: 0,
      createdAt: "2015-10-03T22:44:17.910Z",
      topic: "talk here",
      nsfw: false,
      rateLimitPerUser: 0,
      lastMessageId: "1456074443980812340",
      permissionOverwrites: [
        { id: MODS_ROLE, type: 0, allow: ["ViewChannel"], deny: [] },
      ],
    });
  });

  it("drops text-only keys on a voice channel instead of reporting null", () => {
    const result = serializeChannel(voice);
    expect(result.id).toBe(VOICE_CHANNEL);
    expect(result.type).toBe(2);
    expect(result.bitrate).toBe(64000);
    expect(result.userLimit).toBe(10);
    expect(result.rtcRegion).toBe("us-central");
    expect(result.videoQualityMode).toBe(1);
    expect(result.permissionOverwrites).toEqual([]);
    // Absent keys are dropped entirely — `topic` on a voice channel is not
    // "no topic", it is "not a field this kind of channel has".
    expect(Object.keys(result)).not.toContain("topic");
    expect(Object.keys(result)).not.toContain("rateLimitPerUser");
    expect(Object.keys(result)).not.toContain("lastMessageId");
  });

  it("emits the forum-only keys discord.js transforms for us", () => {
    const forum = guild.channels.cache.get(FORUM_CHANNEL) as ForumChannel;
    const result = serializeChannel(forum);
    expect(result.type).toBe(15);
    expect(result.topic).toBe("post here");
    expect(result.nsfw).toBe(false);
    // `lastMessageId` is a BaseGuildTextChannel-only prop — a forum channel
    // doesn't carry it at all, so the key is dropped rather than nulled.
    expect(Object.keys(result)).not.toContain("lastMessageId");
    expect(result.defaultSortOrder).toBe(0);
    expect(result.defaultForumLayout).toBe(1);
    expect(result.defaultAutoArchiveDuration).toBe(10080);
    // discord.js maps the wire pair `emoji_id`/`emoji_name` onto
    // `{id, name}` (util/Channels.js) — an untransformed fixture would pass a
    // serializer that skipped the transform.
    expect(result.defaultReactionEmoji).toEqual({
      id: "100000000000000050",
      name: "warden",
    });
    expect(result.availableTags).toEqual([
      {
        id: "100000000000000060",
        name: "bug",
        emoji: { id: "100000000000000050", name: "bug" },
        moderated: true,
      },
    ]);
    // A copy, not the library's own cached emoji object.
    expect(result.defaultReactionEmoji).not.toBe(forum.defaultReactionEmoji);
    expect(result.availableTags?.[0]?.emoji).not.toBe(
      forum.availableTags[0]?.emoji,
    );
    // Text/voice-only keys are absent, not null.
    expect(Object.keys(result)).not.toContain("bitrate");
    expect(Object.keys(result)).not.toContain("archived");
  });

  it("emits the thread-only keys (plan §8.4 manage_thread)", () => {
    const thread = guild.channels.cache.get(THREAD_ID) as ThreadChannel;
    const result = serializeChannel(thread);
    expect(result.type).toBe(11);
    expect(result.parentId).toBe(FORUM_CHANNEL);
    expect(result).toEqual({
      id: THREAD_ID,
      type: 11,
      name: "thread",
      parentId: FORUM_CHANNEL,
      position: null, // threads have no guild position of their own
      // discord.js takes a thread's creation date from thread_metadata, not
      // from a snowflake — so this is NOT the snowflake-derived date.
      createdAt: "2024-01-01T00:00:00.000Z",
      lastMessageId: "1456074443980812341",
      rateLimitPerUser: null,
      archived: false,
      locked: false,
      autoArchiveDuration: 1440,
      archiveTimestamp: null,
      ownerId: ALICE,
      invitable: null,
      memberCount: 2,
      messageCount: 3,
      totalMessageSent: 2,
      appliedTags: ["100000000000000060"],
    });
    expect(Object.keys(result)).not.toContain("nsfw");
    expect(Object.keys(result)).not.toContain("bitrate");
    // Threads expose no overwrite manager of their own.
    expect(Object.keys(result)).not.toContain("permissionOverwrites");
  });
});

// ---------------------------------------------------------------------------
// guild
// ---------------------------------------------------------------------------

describe("serializeGuild — real discord.js Guild", () => {
  it("reports the settings overview with derived counts", () => {
    expect(serializeGuild(guild)).toEqual({
      id: GUILD_ID,
      name: "Test Guild",
      description: "a guild",
      ownerId: ALICE,
      available: true,
      features: ["BANNER", "INVITE_SPLASH"],
      icon: "0123456789abcdef",
      iconUrl:
        "https://cdn.discordapp.com/icons/100000000000000002/0123456789abcdef.webp",
      banner: "abcdef1234567890",
      bannerUrl:
        "https://cdn.discordapp.com/banners/100000000000000002/abcdef1234567890.webp",
      splash: "1234567890abcdef",
      splashUrl:
        "https://cdn.discordapp.com/splashes/100000000000000002/1234567890abcdef.webp",
      discoverySplash: "fedcba9876543210",
      discoverySplashUrl:
        "https://cdn.discordapp.com/discovery-splashes/100000000000000002/fedcba9876543210.webp",
      vanityURLCode: "warden",
      // Filled only by Guild#fetchVanityData(), never by a gateway payload.
      vanityURLUses: null,
      verificationLevel: 1,
      mfaLevel: 1,
      nsfwLevel: 0,
      explicitContentFilter: 2,
      defaultMessageNotifications: 1,
      preferredLocale: "en-US",
      afkTimeout: 300,
      afkChannelId: "100000000000000006",
      systemChannelId: "100000000000000031",
      systemChannelFlags: ["SuppressJoinNotifications"],
      rulesChannelId: "100000000000000012",
      publicUpdatesChannelId: "100000000000000013",
      safetyAlertsChannelId: "100000000000000015",
      widgetEnabled: true,
      widgetChannelId: "100000000000000006",
      premiumTier: 1,
      premiumSubscriptionCount: 3,
      premiumProgressBarEnabled: true,
      memberCount: 5,
      approximateMemberCount: 5,
      approximatePresenceCount: 2,
      onlineCount: 1, // alice is "dnd"
      // 3 real channels — the forum — plus a thread that discord.js parks in
      // the same manager; `channelCount` must not count it.
      channelCount: 3,
      threadCount: 1,
      roleCount: 2,
      emojiCount: 1,
      stickerCount: 0,
      createdAt: "2015-10-03T22:44:17.910Z",
      joinedAt: "2024-01-01T00:00:00.000Z",
    });
  });
});

// ---------------------------------------------------------------------------
// invites, webhooks, bans
// ---------------------------------------------------------------------------

describe("serializeInvite — real discord.js Invite", () => {
  it("derives guildId from the embedded guild object", () => {
    // Invite has no direct guildId property — only `guild.id`.
    const result = serializeInvite(invite);
    expect(result.guildId).toBe(GUILD_ID);
    expect(result.guildName).toBe("Test Guild");
    expect(result).toEqual({
      code: "AbCdEf123",
      url: "https://discord.gg/AbCdEf123",
      guildId: GUILD_ID,
      guildName: "Test Guild",
      channelId: TEXT_CHANNEL,
      channel: { id: TEXT_CHANNEL, name: "general", type: 0 },
      inviter: expect.anything(),
      inviterId: ALICE,
      maxAge: 86400,
      maxUses: 10,
      uses: 3,
      temporary: false,
      type: null,
      targetType: 1,
      targetUserId: null,
      targetApplicationId: null,
      expiresAt: "2026-11-01T00:00:00.000Z",
      memberCount: 5,
      presenceCount: 2,
      createdAt: null,
    });
  });
});

describe("serializeWebhook — real discord.js Webhook", () => {
  it("omits the token AND the url that embeds it", () => {
    const result = serializeWebhook(webhook);
    // Both keys must be structurally absent, not merely null.
    expect(Object.keys(result)).not.toContain("token");
    expect(Object.keys(result)).not.toContain("url");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(WEBHOOK_TOKEN);
    expect(serialized).not.toContain("SUPERSECRET");
    // …while still carrying the guild id the rest of the surface depends on.
    expect(result.guildId).toBe(GUILD_ID);
    expect(result).toEqual({
      id: "100000000000000030",
      name: "Warden Hook",
      type: 1,
      channelId: TEXT_CHANNEL,
      guildId: GUILD_ID,
      applicationId: null,
      avatar: null,
      avatarUrl: null,
      owner: null,
      createdAt: "2015-10-03T22:44:17.910Z",
    });
  });
});

describe("serializeBan — real discord.js GuildBan", () => {
  it("takes guildId from ban.guild and keeps the reason", () => {
    expect(serializeBan(ban)).toEqual({
      user: {
        id: "100000000000000040",
        username: "mallory",
        globalName: null,
        discriminator: "0",
        avatar: null,
        avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
        bot: false,
        system: false,
        flags: [],
        createdAt: "2015-10-03T22:44:17.910Z",
      },
      reason: "spam",
      guildId: GUILD_ID,
    });
  });
});

// ---------------------------------------------------------------------------
// expressions
// ---------------------------------------------------------------------------

describe("serializeEmoji — real discord.js GuildEmoji", () => {
  it("spells it requireColons and uses imageURL(), not the deprecated .url", () => {
    const result = serializeEmoji(emoji);
    expect(result.requireColons).toBe(true);
    expect(result.url).toBe(
      "https://cdn.discordapp.com/emojis/100000000000000050.webp",
    );
    expect(result.roles).toEqual([MODS_ROLE]);
    expect(result).toEqual({
      id: "100000000000000050",
      name: "warden",
      animated: true,
      available: true,
      managed: false,
      requireColons: true,
      roles: [MODS_ROLE],
      url: "https://cdn.discordapp.com/emojis/100000000000000050.webp",
      createdAt: "2015-10-03T22:44:17.910Z",
    });
  });
});

// ---------------------------------------------------------------------------
// voice state
// ---------------------------------------------------------------------------

describe("serializeVoiceState — real discord.js VoiceState", () => {
  it("outputs userId even though discord.js names the input field `id`", () => {
    expect(voiceState.id).toBe(ALICE);
    const result = serializeVoiceState(voiceState);
    expect(result.userId).toBe(ALICE);
    expect(Object.keys(result)).not.toContain("id");
    expect(result).toEqual({
      userId: ALICE,
      channelId: VOICE_CHANNEL,
      sessionId: "abc123session",
      serverDeaf: true,
      serverMute: false,
      selfDeaf: true,
      selfMute: false,
      streaming: true,
      selfVideo: false,
      suppress: false,
      requestToSpeakTimestamp: "2024-05-01T00:00:00.000Z",
      member: expect.objectContaining({ id: ALICE, roles: [MODS_ROLE] }),
    });
  });

  it("reports null member when the guild hasn't cached one", () => {
    const orphan = construct<VoiceState>(VoiceState, guild, {
      channel_id: VOICE_CHANNEL,
      user_id: "100000000000000099",
    });
    expect(serializeVoiceState(orphan).member).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

describe("serializeMessage — real discord.js Message", () => {
  it("keeps the trimmed message shape (plan §7.3)", () => {
    const result = serializeMessage(message);
    expect(Object.keys(result)).toEqual([
      "id",
      "channelId",
      "guildId",
      "type",
      "timestamp",
      "editedTimestamp",
      "author",
      "content",
      "pinned",
      "tts",
      "webhookId",
      "flags",
      "attachments",
      "embeds",
      "mentions",
      "stickers",
      "reference",
      "poll",
    ]);
    expect(result).toEqual({
      id: MESSAGE_ID,
      channelId: TEXT_CHANNEL,
      guildId: GUILD_ID,
      type: 0,
      // discord.js derives this from the snowflake, not from `data.timestamp`.
      timestamp: "2026-01-01T00:00:00.000Z",
      editedTimestamp: "2026-01-01T01:00:00.000Z",
      author: expect.objectContaining({ id: ALICE, username: "alice" }),
      content: `hello <@100000000000000041> <@&${MODS_ROLE}> <#${TEXT_CHANNEL}>`,
      pinned: false,
      tts: false,
      webhookId: null,
      flags: ["SuppressEmbeds"],
      attachments: [
        {
          id: "120000000000000001",
          filename: "shot.png", // discord.js calls it `name`; Discord calls it `filename`
          size: 2048,
          url: `https://cdn.discordapp.com/attachments/${TEXT_CHANNEL}/120000000000000001/shot.png`,
          proxyUrl: `https://media.discordapp.net/attachments/${TEXT_CHANNEL}/120000000000000001/shot.png`,
          contentType: "image/png",
          width: 100,
          height: 50,
          description: null,
          ephemeral: false,
          duration: null,
        },
      ],
      embeds: [expect.anything()],
      mentions: {
        everyone: true,
        users: ["100000000000000041"],
        roles: [MODS_ROLE],
        channels: [TEXT_CHANNEL],
        repliedUserId: null,
      },
      stickers: [],
      reference: {
        messageId: "1456074443980812340",
        channelId: TEXT_CHANNEL,
        guildId: GUILD_ID,
      },
      poll: {
        question: "Best?",
        answers: [
          { id: 1, text: "A", votes: 3 },
          { id: 2, text: "B", votes: 1 },
        ],
        expiresAt: "2026-02-01T00:00:00.000Z",
        allowMultiselect: true,
        layoutType: 1,
        finalized: true,
      },
    });
  });

  it("renders a partial message as nulls, not as invented content", () => {
    // This is the payload behind `messageDelete` for an uncached message.
    expect(serializeMessage(partialMessage)).toEqual({
      id: "1456074443980812399",
      channelId: TEXT_CHANNEL,
      guildId: GUILD_ID,
      type: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      editedTimestamp: null,
      author: null,
      content: null,
      pinned: null,
      tts: null,
      webhookId: null,
      flags: [],
      attachments: [],
      embeds: [],
      mentions: {
        everyone: false,
        users: [],
        roles: [],
        channels: [],
        repliedUserId: null,
      },
      stickers: [],
      reference: null,
      poll: null,
    });
  });
});

describe("serializeEmbed — real discord.js Embed", () => {
  it("normalises the author/footer/icon key spellings", () => {
    expect(serializeEmbed(message.embeds[0] as never)).toEqual({
      title: "Hello",
      description: "world",
      url: "https://example.com",
      color: 3447003,
      hexColor: "#3498db",
      timestamp: "2026-01-01T00:00:00.000Z",
      author: {
        name: "auth",
        url: "https://a.example",
        iconUrl: "https://i.example/x.png",
      },
      footer: { text: "foot", iconUrl: "https://i.example/f.png" },
      image: { url: "https://i.example/img.png", width: 10, height: 20 },
      thumbnail: { url: "https://i.example/th.png", width: 30, height: 40 },
      video: null,
      provider: { name: "prov", url: "https://p.example" },
      fields: [{ name: "f1", value: "v1", inline: true }],
    });
  });

  it("pads an embed that only carries a title", () => {
    expect(
      serializeEmbed(construct<Embed>(Embed, { title: "only-title" })),
    ).toEqual({
      title: "only-title",
      description: null,
      url: null,
      color: null,
      hexColor: null,
      timestamp: null,
      author: null,
      footer: null,
      image: null,
      thumbnail: null,
      video: null,
      provider: null,
      fields: [],
    });
  });
});

// ---------------------------------------------------------------------------
// presences
// ---------------------------------------------------------------------------

describe("serializePresence — real discord.js Presence", () => {
  it("takes guildId from presence.guild (set by the guild's own patching)", () => {
    expect(presence.guild?.id).toBe(GUILD_ID);
    const result = serializePresence(presence);
    // A copy, not discord.js' own cached `clientStatus`.
    expect(result.clientStatus).not.toBe(presence.clientStatus);
    expect(result).toEqual({
      userId: ALICE,
      guildId: GUILD_ID,
      status: "dnd",
      user: expect.objectContaining({ id: ALICE }),
      clientStatus: { desktop: "idle", mobile: "online" },
      activities: [
        {
          name: "Visual Studio Code",
          type: 0,
          state: "editing warden",
          details: "serializers/",
          url: null,
          applicationId: "357940114668354560",
          startedAt: "2023-11-14T22:13:20.000Z",
          endedAt: null,
          emoji: null,
        },
      ],
    });
  });

  it("falls back to a null guildId when the guild isn't cached", () => {
    // `Presence.guild` is only ever assigned by Guild's own patching — a
    // presence that arrived from anywhere else carries no guild, even when the
    // user is known.
    const orphan = construct<Presence>(Presence, client, {
      user: { id: ALICE, username: "alice", discriminator: "0" },
      status: "offline",
      activities: [],
      client_status: {},
    });
    expect(orphan.guild).toBeNull();
    expect(serializePresence(orphan)).toEqual({
      userId: ALICE,
      guildId: null,
      status: "offline",
      user: expect.objectContaining({ id: ALICE }),
      clientStatus: {},
      activities: [],
    });
  });
});

// ---------------------------------------------------------------------------
// plain fixtures — the structural `*Like` contract
// ---------------------------------------------------------------------------

describe("plain fixtures", () => {
  it("accepts hand-written data shaped like discord.js", () => {
    expect(
      serializeUser({
        id: "1",
        username: "bob",
        globalName: null,
        avatar: null,
        bot: false,
        createdTimestamp: 1_443_912_257_910,
      }),
    ).toEqual({
      id: "1",
      username: "bob",
      globalName: null,
      discriminator: null,
      avatar: null,
      // No displayAvatarURL()/avatarURL() on the fixture → null, not a crash.
      avatarUrl: null,
      bot: false,
      system: null,
      flags: [],
      createdAt: "2015-10-03T22:44:17.910Z",
    });
  });

  it("accepts a hand-written voice state whose member carries its own role cache", () => {
    expect(
      serializeVoiceState({
        id: "42",
        channelId: null,
        serverMute: true,
        member: { id: "42", roles: { cache: [{ id: "7" }] } },
      }),
    ).toEqual({
      userId: "42",
      channelId: null,
      sessionId: null,
      serverDeaf: null,
      serverMute: true,
      selfDeaf: null,
      selfMute: null,
      streaming: null,
      selfVideo: null,
      suppress: null,
      requestToSpeakTimestamp: null,
      member: {
        id: "42",
        user: null,
        roles: ["7"],
        nickname: null,
        displayName: null,
        joinedAt: null,
        communicationDisabledUntil: null,
        premiumSince: null,
        avatar: null,
      },
    });
  });

  it("reports no named flags for a raw APIUser integer", () => {
    // `Webhook.owner` is declared `User | APIUser`, and a raw `APIUser` carries
    // a bare `UserFlags` integer rather than a bit-field object. Naming it
    // would mean duplicating discord-api-types' enum in the serializers, so the
    // honest answer is "none I can name" rather than a guessed label.
    expect(serializeUser({ id: "1", username: "u", flags: 64 }).flags).toEqual(
      [],
    );
    // …while the normal bit-field form still resolves.
    expect(serializeUser(user).flags).toEqual(["HypeSquadOnlineHouse1"]);
  });

  it("treats a fixture without a guild as having no @everyone role to drop", () => {
    expect(
      serializeMember({ id: "9", roles: { cache: [{ id: "1" }, { id: "9" }] } })
        .roles,
    ).toEqual(["1", "9"]);
  });

  it("accepts a thread archive timestamp as epoch ms or as an ISO string", () => {
    // discord.js supplies epoch ms (`Date.parse(thread_metadata…)`) while a
    // raw Discord payload supplies the ISO string. `ChannelLike` was widened to
    // `string | number | null` when the `ThreadChannel` cast surfaced the
    // mismatch — but only the `null` member was exercised by the real fixture.
    const base = {
      id: "9",
      type: 11,
      name: "thread",
      parentId: "8",
      archived: true,
      autoArchiveDuration: 1440,
    };
    const iso = "2024-05-06T12:53:20.000Z";
    expect(
      serializeChannel({ ...base, archiveTimestamp: 1_715_000_000_000 })
        .archiveTimestamp,
    ).toBe(iso);
    expect(
      serializeChannel({ ...base, archiveTimestamp: iso }).archiveTimestamp,
    ).toBe(iso);
    expect(
      serializeChannel({ ...base, archiveTimestamp: null }).archiveTimestamp,
    ).toBeNull();
    // Absent stays absent rather than becoming null — `iso(undefined)` → undefined.
    expect(Object.keys(serializeChannel({ ...base }))).not.toContain(
      "archiveTimestamp",
    );
  });

  it("survives missing optional managers on a bare guild fixture", () => {
    const bare = serializeGuild({ id: "1", name: "n" });
    expect(bare.channelCount).toBeUndefined();
    expect(bare.roleCount).toBeUndefined();
    expect(bare.onlineCount).toBeUndefined();
    expect(bare.memberCount).toBeNull();
    expect(bare.features).toEqual([]);
    expect(bare.systemChannelFlags).toEqual([]);
  });
});
