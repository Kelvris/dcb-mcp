/**
 * The preflight matrix (plan §6 / §11).
 *
 * Fixtures are **real discord.js objects** built from raw API payloads — the
 * same deliberate escape hatch `serialize.test.ts` uses — because the whole
 * point of a preflight is to agree with what discord.js and Discord will
 * actually do. Hand-written doubles would let this suite pass while the
 * shipped guard disagrees with reality.
 *
 * Three properties are pinned here on purpose, each one measured against the
 * installed discord.js 14.27 before being written down:
 *
 *  * `Role#position` is *recomputed* from the cache, so the raw payload's
 *    positions below are only a sort hint — the numbers asserted in messages
 *    are what discord.js derives from them.
 *  * `PermissionsBitField.missing()` returns names in
 *    `Object.keys(PermissionFlagsBits)` order, not in the order the caller
 *    asked for them, and short-circuits to `[]` when the bot holds
 *    Administrator.
 *  * `User#tag` collapses to the bare username for the modern
 *    `discriminator === "0"` accounts, so messages say `bob`, not `bob#0`.
 */

import type {
  Client,
  GuildBasedChannel,
  GuildMember,
  PermissionResolvable,
  Role,
} from "discord.js";
import {
  Client as DiscordClient,
  ClientUser,
  Guild,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import { describe, expect, it } from "vitest";
import {
  LIMITS,
  THREAD_ARCHIVE_MINUTES,
  blockersFor,
  checkAppliedTags,
  checkBulkDelete,
  checkChannelPermissions,
  checkConnection,
  checkFileSize,
  checkGrantablePermissions,
  checkGuildPermissions,
  checkLimit,
  checkMemberHierarchy,
  checkRoleHierarchy,
  preflight,
  resolveBotMember,
  resolveChannel,
  resolveGuild,
} from "../src/discord/guards.js";
import type {
  GuardConnection,
  PermissionScope,
  PreflightPass,
} from "../src/discord/guards.js";
import { isWardenError } from "../src/discord/errors.js";
import type { WardenError } from "../src/discord/errors.js";
import { fail, ok } from "../src/shared/result.js";

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

const BOT_ID = "200000000000000001";
const OWNER_ID = "100000000000000001";
const TARGET_ID = "100000000000000002";
const ADMIN_ID = "100000000000000003";
const MOD_MEMBER_ID = "100000000000000004";

const GUILD_ID = "300000000000000001";
const OTHER_GUILD_ID = "300000000000000002";

const JUNIOR_ROLE = "300000000000000010";
const ADMIN_ROLE = "300000000000000011";
const WARDEN_ROLE = "300000000000000012";
const MOD_ROLE = "300000000000000013";
const MANAGED_ROLE = "300000000000000014";

const GENERAL = "400000000000000001";
const LOCKED = "400000000000000002";
const ALLOWED = "400000000000000003";
const VOICE = "400000000000000004";
const THREAD = "400000000000000005";

const MANAGE_MESSAGES = String(PermissionFlagsBits.ManageMessages);

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** discord.js marks structure constructors `private`/`protected` — see serialize.test.ts. */
function construct<T>(Ctor: unknown, ...args: readonly unknown[]): T {
  return new (Ctor as new (...args: unknown[]) => T)(...args);
}

/**
 * Step around `PermissionResolvable` on purpose.
 *
 * discord.js' type already excludes plain numbers and unknown names, and its
 * runtime rejects both — so the guard in guards.ts is unreachable from typed
 * code that trusts the compiler. It still has to hold for the callers the
 * type system never sees: plain JS, a zod schema written a little too
 * loosely, or an `as unknown as` cast. These tests are that case.
 */
function unsafePermission(value: unknown): PermissionResolvable {
  return value as PermissionResolvable;
}

interface FixtureOptions {
  /** Permission bitfield handed to Warden's own role. */
  wardenPermissions?: string;
  /** Guild owner; defaults to alice. */
  ownerId?: string;
  /** Leave `client.user` unpopulated (simulates a half-open gateway). */
  withoutUser?: boolean;
}

interface Fixture {
  client: Client;
  conn: GuardConnection;
  guild: Guild;
  bot: GuildMember;
  owner: GuildMember;
  target: GuildMember;
  admin: GuildMember;
  mod: GuildMember;
  everyone: Role;
  juniorRole: Role;
  wardenRole: Role;
  modRole: Role;
  managedRole: Role;
  general: GuildBasedChannel;
  locked: GuildBasedChannel;
  allowed: GuildBasedChannel;
  thread: GuildBasedChannel;
}

function rawGuild(options: FixtureOptions) {
  return {
    id: GUILD_ID,
    name: "Test Guild",
    owner_id: options.ownerId ?? OWNER_ID,
    roles: [
      // Discord's default guild permission set — notably *without*
      // ManageGuild/ManageRoles/ManageMessages/Kick/Ban/ModerateMembers,
      // which is what makes the "missing permission" cases meaningful.
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
        id: JUNIOR_ROLE,
        name: "Junior",
        position: 1,
        permissions: "0",
        color: 0,
        hoist: false,
        mentionable: false,
        managed: false,
      },
      {
        id: ADMIN_ROLE,
        name: "Adminish",
        position: 2,
        permissions: "8",
        color: 0,
        hoist: false,
        mentionable: false,
        managed: false,
      },
      {
        id: WARDEN_ROLE,
        name: "Warden",
        position: 3,
        permissions: options.wardenPermissions ?? "0",
        color: 0,
        hoist: false,
        mentionable: false,
        managed: false,
      },
      {
        id: MOD_ROLE,
        name: "Moderator",
        position: 4,
        permissions: "0",
        color: 0,
        hoist: false,
        mentionable: false,
        managed: false,
      },
      {
        id: MANAGED_ROLE,
        name: "Integration",
        position: 5,
        permissions: "0",
        color: 0,
        hoist: false,
        mentionable: false,
        managed: true,
        tags: { integration_id: "500000000000000001" },
      },
    ],
    channels: [
      {
        id: GENERAL,
        type: 0,
        name: "general",
        position: 0,
        permission_overwrites: [],
      },
      {
        id: LOCKED,
        type: 0,
        name: "locked",
        position: 1,
        permission_overwrites: [
          { id: WARDEN_ROLE, type: 0, allow: "0", deny: MANAGE_MESSAGES },
        ],
      },
      {
        id: ALLOWED,
        type: 0,
        name: "allowed",
        position: 2,
        permission_overwrites: [
          { id: WARDEN_ROLE, type: 0, allow: MANAGE_MESSAGES, deny: "0" },
        ],
      },
      {
        id: VOICE,
        type: 2,
        name: "voice",
        position: 3,
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
        roles: [MOD_ROLE],
        joined_at: "2024-01-01T00:00:00.000Z",
      },
      {
        user: { id: TARGET_ID, username: "bob", discriminator: "0" },
        roles: [],
        joined_at: "2024-01-01T00:00:00.000Z",
      },
      {
        user: { id: ADMIN_ID, username: "carol", discriminator: "0" },
        roles: [ADMIN_ROLE],
        joined_at: "2024-01-01T00:00:00.000Z",
      },
      // A moderator who does *not* own the guild — the only shape that can
      // reach the hierarchy branch, since an owner target is caught first.
      {
        user: { id: MOD_MEMBER_ID, username: "dave", discriminator: "0" },
        roles: [MOD_ROLE],
        joined_at: "2024-01-01T00:00:00.000Z",
      },
    ],
    member_count: 5,
    unavailable: false,
  };
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const client = new DiscordClient({ intents: [] });
  if (!options.withoutUser) {
    (client as unknown as { user: ClientUser | null }).user =
      construct<ClientUser>(ClientUser, client, {
        id: BOT_ID,
        username: "warden",
        discriminator: "0",
        bot: true,
      });
  }

  const guild = construct<Guild>(Guild, client, rawGuild(options));
  client.guilds.cache.set(guild.id, guild);

  const getMember = (id: string) => guild.members.cache.get(id) as GuildMember;
  const getRole = (id: string) => guild.roles.cache.get(id) as Role;
  const getChannel = (id: string) =>
    guild.channels.cache.get(id) as GuildBasedChannel;

  return {
    client,
    conn: { client, isReady: () => true },
    guild,
    bot: getMember(BOT_ID),
    owner: getMember(OWNER_ID),
    target: getMember(TARGET_ID),
    admin: getMember(ADMIN_ID),
    mod: getMember(MOD_MEMBER_ID),
    everyone: getRole(GUILD_ID),
    juniorRole: getRole(JUNIOR_ROLE),
    wardenRole: getRole(WARDEN_ROLE),
    modRole: getRole(MOD_ROLE),
    managedRole: getRole(MANAGED_ROLE),
    general: getChannel(GENERAL),
    locked: getChannel(LOCKED),
    allowed: getChannel(ALLOWED),
    thread: getChannel(THREAD),
  };
}

/** discord.js re-derives positions from the payload's ordering — assert them. */
function positions(f: Fixture) {
  return {
    everyone: f.everyone.position,
    junior: f.juniorRole.position,
    warden: f.wardenRole.position,
    mod: f.modRole.position,
    managed: f.managedRole.position,
  };
}

function expectPass(result: PreflightPass | WardenError): PreflightPass {
  if (!result.ok) {
    throw new Error(`expected a pass, got ${result.error}: ${result.message}`);
  }
  return result;
}

function expectFailure(result: PreflightPass | WardenError): WardenError {
  if (result.ok) {
    throw new Error("expected a failure, but the preflight passed");
  }
  return result;
}

const SNOWFLAKE_EPOCH = 1_420_070_400_000;
/** A snowflake whose embedded timestamp is exactly `timestampMs`. */
function idAt(timestampMs: number): string {
  return ((BigInt(timestampMs - SNOWFLAKE_EPOCH) << 22n) | 0n).toString();
}

// ---------------------------------------------------------------------------
// shared/result.ts — the envelope every guard failure is built with
// ---------------------------------------------------------------------------

describe("shared/result", () => {
  it("builds a success payload", () => {
    expect(ok("member.kick", { id: TARGET_ID })).toEqual({
      ok: true,
      performed: "member.kick",
      data: { id: TARGET_ID },
    });
  });

  it("drops empty notes instead of emitting []", () => {
    expect(ok("member.kick", {}, [])).not.toHaveProperty("notes");
    expect(ok("member.kick", {}, ["a"])).toEqual({
      ok: true,
      performed: "member.kick",
      data: {},
      notes: ["a"],
    });
  });

  it("never leaks the caller's array identity into the payload", () => {
    const notes = ["one"];
    const result = ok("x", {}, notes);
    notes.push("mutated");
    expect(result.notes).toEqual(["one"]);
  });

  it("forces ok:false on failures", () => {
    const result = fail({
      error: "invalid_input",
      message: "nope",
      remediation: "do better",
    });
    expect(result).toEqual({
      ok: false,
      error: "invalid_input",
      message: "nope",
      remediation: "do better",
    });
  });

  it("redacts a token-shaped string carried in a failure", () => {
    const token = `${Buffer.from("999999999999999998", "utf8").toString(
      "base64url",
    )}.GhIkLm.NpQrStUvWxYz0123456789abcdef`;
    const result = fail({
      error: "invalid_input",
      message: `role named ${token} is unusable`,
      remediation: "rename it",
      details: { reason: token },
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.message).toContain("[redacted-token]");
    expect(result.details?.reason).toBe("[redacted-token]");
  });

  it("redacts a webhook path carried in a failure", () => {
    const result = fail({
      error: "discord_api",
      message:
        "POST https://discord.com/api/webhooks/1052345678901234562/abcDEF123ghiJKL456_mno failed",
      remediation: "check the webhook",
    });
    expect(result.message).toContain(
      "/webhooks/1052345678901234562/[redacted-secret]",
    );
    expect(result.message).not.toContain("abcDEF123ghiJKL456_mno");
  });
});

// ---------------------------------------------------------------------------
// Layer 1 — connection & resolution
// ---------------------------------------------------------------------------

describe("guards / connection", () => {
  it("reports not_ready before the gateway is up", () => {
    const f = makeFixture({ withoutUser: true });
    const conn: GuardConnection = { client: f.client, isReady: () => false };
    expect(checkConnection(conn)).toEqual({
      ok: false,
      error: "not_ready",
      message: "The Discord gateway is not connected yet.",
      remediation:
        "Wait a few seconds and retry — get_bot_status reports live connection state, and a rejected login shows its reason there.",
    });
  });

  it("reports not_ready when client.user is missing even though isReady() is true", () => {
    const f = makeFixture({ withoutUser: true });
    expect(checkConnection(f.conn)).toMatchObject({
      error: "not_ready",
      message: expect.stringContaining("own user is not populated"),
    });
  });

  it("passes once the gateway and user are both present", () => {
    expect(checkConnection(makeFixture().conn)).toBeNull();
  });

  it("refuses a call with no guild id at all", () => {
    expect(resolveGuild(makeFixture().conn)).toMatchObject({
      error: "invalid_input",
      message: "No guild id was supplied and WARDEN_GUILD_ID is not set.",
    });
  });

  it("reports an uncached guild as not_found with the cache size", () => {
    expect(resolveGuild(makeFixture().conn, OTHER_GUILD_ID)).toMatchObject({
      error: "not_found",
      details: { guildId: OTHER_GUILD_ID, cachedGuilds: 1 },
    });
  });

  it("resolves a cached guild", () => {
    expect(resolveGuild(makeFixture().conn, GUILD_ID)).toBeInstanceOf(Guild);
  });

  it("propagates not_ready instead of claiming the guild is missing", () => {
    const f = makeFixture({ withoutUser: true });
    const conn: GuardConnection = { client: f.client, isReady: () => false };
    expect(resolveGuild(conn, OTHER_GUILD_ID)).toMatchObject({
      error: "not_ready",
    });
  });

  it("rejects an empty channel id", () => {
    expect(resolveChannel(makeFixture().guild, "   ")).toMatchObject({
      error: "invalid_input",
      message: "channel_id is empty.",
    });
  });

  it("reports an unknown channel as not_found", () => {
    expect(
      resolveChannel(makeFixture().guild, "400000000000000999"),
    ).toMatchObject({
      error: "not_found",
      message: "Channel 400000000000000999 is not in guild 'Test Guild'.",
    });
  });

  it("resolves a thread through the channel id space", () => {
    const channel = resolveChannel(makeFixture().guild, THREAD);
    if (isWardenError(channel)) throw new Error(channel.message);
    expect(channel.id).toBe(THREAD);
    expect(channel.name).toBe("thread");
  });

  it("reads Warden's own member out of the cache, not guild.members.me", () => {
    const f = makeFixture();
    const me = resolveBotMember(f.conn, f.guild);
    if (isWardenError(me)) throw new Error(me.message);
    expect(me.id).toBe(BOT_ID);
  });

  it("reports not_ready when Warden's member has not been cached yet", () => {
    const f = makeFixture();
    const other = construct<Guild>(Guild, f.client, {
      ...rawGuild({}),
      id: OTHER_GUILD_ID,
      members: [],
      member_count: 0,
    });
    expect(resolveBotMember(f.conn, other)).toMatchObject({
      error: "not_ready",
      message: "Warden's own member is not cached in guild 'Test Guild'.",
      details: { botId: BOT_ID },
    });
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — permission
// ---------------------------------------------------------------------------

describe("guards / permissions", () => {
  it("passes when nothing is required", () => {
    const f = makeFixture();
    expect(checkGuildPermissions(f.bot, [])).toBeNull();
    expect(checkChannelPermissions(f.general, f.bot, [])).toBeNull();
  });

  it("passes for a permission the default role set grants", () => {
    const f = makeFixture();
    expect(
      checkGuildPermissions(f.bot, [PermissionFlagsBits.SendMessages]),
    ).toBeNull();
  });

  it("names every missing guild permission in discord.js' own order", () => {
    const f = makeFixture();
    const error = checkGuildPermissions(f.bot, [
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.KickMembers,
      PermissionFlagsBits.ManageGuild,
    ]);
    expect(error).toMatchObject({
      ok: false,
      error: "missing_permission",
      // missing() iterates Object.keys(PermissionFlagsBits), not our order.
      missingPermissions: ["KickMembers", "ManageGuild", "ManageRoles"],
      message:
        "Warden is missing KickMembers, ManageGuild and ManageRoles in guild 'Test Guild'.",
      remediation:
        "Grant KickMembers, ManageGuild and ManageRoles to the Warden role in Server Settings → Roles.",
    });
  });

  it("reports nothing missing when the bot holds Administrator", () => {
    const f = makeFixture({ wardenPermissions: "8" });
    expect(
      checkGuildPermissions(f.bot, [
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.BanMembers,
      ]),
    ).toBeNull();
  });

  it("applies channel overwrites: a deny beats the role grant", () => {
    const f = makeFixture();
    expect(
      checkChannelPermissions(f.locked, f.bot, [
        PermissionFlagsBits.ManageMessages,
      ]),
    ).toMatchObject({
      error: "missing_permission",
      missingPermissions: ["ManageMessages"],
      message: "Warden is missing ManageMessages in #locked.",
      remediation:
        "Grant ManageMessages in Server Settings → Roles, or check #locked's overwrites — a deny there beats the role grant.",
    });
  });

  it("applies channel overwrites: an allow lifts a permission the role lacks", () => {
    const f = makeFixture();
    expect(
      checkChannelPermissions(f.allowed, f.bot, [
        PermissionFlagsBits.ManageMessages,
      ]),
    ).toBeNull();
  });

  it("lets Administrator override a channel deny, matching Discord", () => {
    const f = makeFixture({ wardenPermissions: "8" });
    expect(
      checkChannelPermissions(f.locked, f.bot, [
        PermissionFlagsBits.ManageMessages,
      ]),
    ).toBeNull();
  });

  it("checks a thread through its parent channel", () => {
    const f = makeFixture();
    expect(
      checkChannelPermissions(f.thread, f.bot, [
        PermissionFlagsBits.SendMessages,
      ]),
    ).toBeNull();
    expect(
      checkChannelPermissions(f.thread, f.bot, [
        PermissionFlagsBits.ManageGuild,
      ]),
    ).toMatchObject({ error: "missing_permission" });
  });

  it("answers 'not yet known' rather than 'missing' for an orphaned thread", () => {
    const f = makeFixture();
    const orphan: PermissionScope = {
      id: THREAD,
      name: "thread",
      guild: f.guild,
      permissionsFor: () => null,
    };
    expect(
      checkChannelPermissions(orphan, f.bot, [
        PermissionFlagsBits.SendMessages,
      ]),
    ).toMatchObject({
      error: "not_ready",
      // Only the establishment claim: the message deliberately does not name
      // *why* permissions could not be resolved, because this branch does
      // not know which channel shapes reach it.
      message: "Cannot determine Warden's permissions in #thread yet.",
      remediation: expect.stringContaining("retry shortly"),
    });
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — hierarchy & protected targets
// ---------------------------------------------------------------------------

describe("guards / member hierarchy", () => {
  it("pins the recomputed role positions discord.js derives from the payload", () => {
    expect(positions(makeFixture())).toEqual({
      everyone: 0,
      junior: 1,
      warden: 3,
      mod: 4,
      managed: 5,
    });
  });

  it("refuses to act on itself", () => {
    const f = makeFixture();
    expect(checkMemberHierarchy(f.bot, f.bot, { action: "kick" })).toEqual({
      ok: false,
      error: "target_protected",
      message: "Cannot kick warden: that is Warden itself.",
      target: { user: "warden", protected: "self" },
      remediation:
        "Warden acts as the bot account, so it cannot target its own member — pick a different member.",
    });
  });

  it("refuses the guild owner", () => {
    const f = makeFixture();
    expect(checkMemberHierarchy(f.bot, f.owner, { action: "kick" })).toEqual({
      ok: false,
      error: "target_protected",
      message: "Cannot kick alice: they own 'Test Guild'.",
      target: { user: "alice", protected: "owner" },
      remediation:
        "The guild owner is untouchable by design — ownership would have to be transferred first.",
    });
  });

  it("refuses an Administrator target for ban/timeout", () => {
    const f = makeFixture();
    expect(
      checkMemberHierarchy(f.bot, f.admin, {
        action: "time out",
        protectAdministrator: true,
      }),
    ).toMatchObject({
      error: "target_protected",
      message: "Cannot time out carol: they hold Administrator.",
      target: { user: "carol", protected: "administrator" },
      remediation:
        "Remove Administrator from them in Server Settings → Roles first, then retry.",
    });
  });

  it("does not invent an Administrator protection for kick", () => {
    const f = makeFixture();
    // carol's top role sits below Warden's, so this proves the protection
    // (not hierarchy) was the thing that would have blocked it.
    expect(
      checkMemberHierarchy(f.bot, f.admin, {
        action: "kick",
        protectAdministrator: false,
      }),
    ).toBeNull();
  });

  it("reports a hierarchy violation with both roles and their positions", () => {
    const f = makeFixture();
    // dave is a moderator, not the owner — an owner target would be caught
    // by target_protected before the position rule is ever reached.
    expect(checkMemberHierarchy(f.bot, f.mod, { action: "nickname" })).toEqual({
      ok: false,
      error: "role_hierarchy",
      message:
        "Cannot nickname dave: their top role 'Moderator' (position 4) is " +
        "not below Warden's top role 'Warden' (position 3).",
      bot: { role: "Warden", position: 3 },
      target: { role: "Moderator", position: 4 },
      remediation:
        "Move the 'Warden' role above 'Moderator' in Server Settings → Roles, " +
        "or act on a member whose top role sits below 3.",
    });
  });

  it("treats comparePositionTo as a signed delta, which every guard relies on", () => {
    const f = makeFixture();
    const botTop = f.bot.roles.highest;
    const above = f.modRole;
    const forward = botTop.comparePositionTo(above);
    const backward = above.comparePositionTo(botTop);
    expect(typeof forward).toBe("number");
    expect(forward).toBeLessThan(0);
    expect(backward).toBeGreaterThan(0);
    // Guards test `> 0`, so a bigint here would not merely be mistyped —
    // JSON.stringify throws on one, and this value reaches error payloads.
    expect(JSON.stringify({ forward })).toBe(`{"forward":${forward}}`);
  });

  it("allows acting on a member whose top role is below Warden's", () => {
    const f = makeFixture();
    expect(
      checkMemberHierarchy(f.bot, f.target, { action: "kick" }),
    ).toBeNull();
  });

  it("applies the position rule to a guild-owner bot too", () => {
    // Discord's Permission Hierarchy docs state these rules for bots with no
    // owner carve-out, so Warden does not invent one. Over-refusing costs an
    // actionable message; under-refusing is the raw 50013 this module exists
    // to pre-empt.
    const f = makeFixture({ ownerId: BOT_ID });
    expect(
      checkMemberHierarchy(f.bot, f.mod, { action: "kick" }),
    ).toMatchObject({
      error: "role_hierarchy",
      bot: { role: "Warden", position: 3 },
      target: { role: "Moderator", position: 4 },
    });
    // A member below Warden still passes, so this is hierarchy firing rather
    // than ownership breaking the check entirely.
    expect(
      checkMemberHierarchy(f.bot, f.target, { action: "kick" }),
    ).toBeNull();
  });
});

describe("guards / role hierarchy", () => {
  it("refuses @everyone", () => {
    const f = makeFixture();
    expect(checkRoleHierarchy(f.bot, f.everyone, { action: "edit" })).toEqual({
      ok: false,
      error: "target_protected",
      message: "Cannot edit the @everyone role.",
      target: { role: "@everyone", position: 0 },
      remediation:
        "The @everyone role's permissions are set when the guild is created and Warden will not change them — edit a normal role instead.",
      details: { protected: "everyone" },
    });
  });

  it("refuses a managed/integration role", () => {
    const f = makeFixture();
    expect(checkRoleHierarchy(f.bot, f.managedRole)).toEqual({
      ok: false,
      error: "target_protected",
      message:
        "Cannot edit role 'Integration': it is managed by an integration.",
      target: { role: "Integration", position: 5 },
      remediation:
        "Managed roles are owned by the integration or bot that created them — change it from that integration's settings.",
      details: { protected: "managed" },
    });
  });

  it("reports a role above Warden as a hierarchy violation", () => {
    const f = makeFixture();
    expect(checkRoleHierarchy(f.bot, f.modRole)).toEqual({
      ok: false,
      error: "role_hierarchy",
      message:
        "Cannot edit role 'Moderator': it sits at position 4, which is not " +
        "below Warden's top role 'Warden' (position 3).",
      bot: { role: "Warden", position: 3 },
      target: { role: "Moderator", position: 4 },
      remediation:
        "Move the 'Warden' role above 'Moderator' in Server Settings → Roles, then retry.",
    });
  });

  it("allows editing a role below Warden", () => {
    const f = makeFixture();
    expect(checkRoleHierarchy(f.bot, f.juniorRole)).toBeNull();
  });

  it("still refuses managed roles even for a guild owner", () => {
    const f = makeFixture({ ownerId: BOT_ID });
    expect(checkRoleHierarchy(f.bot, f.managedRole)).toMatchObject({
      error: "target_protected",
      details: { protected: "managed" },
    });
  });

  it("refuses @everyone even for a guild-owner bot, as plan §6 requires", () => {
    // The API would allow this — `Modify Guild Role` needs only
    // MANAGE_ROLES — so the refusal is Warden policy, not a mirror of Discord.
    const f = makeFixture({ ownerId: BOT_ID });
    expect(checkRoleHierarchy(f.bot, f.everyone)).toMatchObject({
      error: "target_protected",
      details: { protected: "everyone" },
    });
    // Ownership exempts nothing: the position rule applies to an owner bot
    // exactly as it does to everyone else.
    expect(checkRoleHierarchy(f.bot, f.modRole)).toMatchObject({
      error: "role_hierarchy",
    });
    // ...and a role below Warden still passes, proving the @everyone refusal
    // above came from the policy rule rather than from hierarchy catching
    // everything in this fixture.
    expect(checkRoleHierarchy(f.bot, f.juniorRole)).toBeNull();
  });
});

describe("guards / grantable permissions", () => {
  it("refuses to grant a permission Warden lacks", () => {
    const f = makeFixture();
    expect(
      checkGrantablePermissions(f.bot, [
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.BanMembers,
      ]),
    ).toMatchObject({
      error: "missing_permission",
      missingPermissions: ["BanMembers", "ManageGuild"],
      message:
        "Warden cannot grant BanMembers and ManageGuild: it does not hold those permissions itself.",
      remediation:
        "Give BanMembers and ManageGuild to the Warden role first, then retry the assignment.",
    });
  });

  it("phrases a single missing grant in the singular", () => {
    const f = makeFixture();
    expect(
      checkGrantablePermissions(f.bot, [PermissionFlagsBits.ManageRoles]),
    ).toMatchObject({
      message:
        "Warden cannot grant ManageRoles: it does not hold that permission itself.",
    });
  });

  it("allows granting what Warden holds", () => {
    const f = makeFixture();
    expect(
      checkGrantablePermissions(f.bot, [PermissionFlagsBits.SendMessages]),
    ).toBeNull();
    expect(
      checkGrantablePermissions(makeFixture({ wardenPermissions: "8" }).bot, [
        PermissionFlagsBits.BanMembers,
      ]),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Defence in depth: the exported checks guard themselves rather than
// trusting preflight() to have filtered their inputs first. Two of the three
// sit in layer 3; checkChannelPermissions is layer 2 and belongs here for the
// same reason — the rule is "every exported check that takes an outside
// target validates its guild", not "every layer-3 check".
// ---------------------------------------------------------------------------

describe("guards / cross-guild inputs on exported checks", () => {
  function foreignGuild(f: Fixture): Guild {
    return construct<Guild>(Guild, f.client, {
      ...rawGuild({}),
      id: OTHER_GUILD_ID,
    });
  }

  it("refuses a member from another guild", () => {
    const f = makeFixture();
    const stranger = foreignGuild(f).members.cache.get(OWNER_ID) as GuildMember;
    expect(checkMemberHierarchy(f.bot, stranger, { action: "kick" })).toEqual({
      ok: false,
      error: "invalid_input",
      message: `This member belongs to guild ${OTHER_GUILD_ID}, but Warden is acting in guild ${GUILD_ID}.`,
      remediation:
        "Only act on members belonging to the guild this call names — check the id you passed.",
      details: { targetGuildId: OTHER_GUILD_ID, guildId: GUILD_ID },
    });
  });

  it("refuses a role from another guild", () => {
    const f = makeFixture();
    const stranger = foreignGuild(f).roles.cache.get(MOD_ROLE) as Role;
    expect(checkRoleHierarchy(f.bot, stranger)).toMatchObject({
      error: "invalid_input",
      message: `This role belongs to guild ${OTHER_GUILD_ID}, but Warden is acting in guild ${GUILD_ID}.`,
      details: { targetGuildId: OTHER_GUILD_ID, guildId: GUILD_ID },
    });
  });

  it("refuses a channel from another guild", () => {
    const f = makeFixture();
    const foreign: PermissionScope = {
      id: f.general.id,
      name: f.general.name,
      guild: foreignGuild(f),
      permissionsFor: () =>
        new PermissionsBitField(PermissionFlagsBits.SendMessages),
    };
    expect(
      checkChannelPermissions(foreign, f.bot, [
        PermissionFlagsBits.SendMessages,
      ]),
    ).toMatchObject({
      error: "invalid_input",
      // Reaching invalid_input at all proves the guild check ran first —
      // the channel would otherwise have passed this permission cleanly.
      message: `This channel belongs to guild ${OTHER_GUILD_ID}, but Warden is acting in guild ${GUILD_ID}.`,
    });

    // ...and the guild check still runs when there is nothing to check,
    // because it sits above the empty-`required` shortcut. Otherwise an
    // empty request would return null and quietly bypass the very guard
    // `guildMismatch` promises every exported check runs.
    expect(checkChannelPermissions(foreign, f.bot, [])).toMatchObject({
      error: "invalid_input",
    });
  });
});

describe("guards / unusable permission constants", () => {
  it("returns a structured error where discord.js would throw", () => {
    // `new PermissionsBitField(1024)` throws in discord.js 14.27 because
    // DefaultBit is 0n; without this branch the exception would escape
    // preflight() and take the tool call down with it.
    const f = makeFixture();
    expect(checkGuildPermissions(f.bot, [unsafePermission(1024)])).toEqual({
      ok: false,
      error: "invalid_input",
      message: "1024 is not a usable Discord permission.",
      remediation:
        "Pass a name from PermissionFlagsBits (e.g. 'ManageMessages') or its bigint — discord.js rejects plain numbers for permissions.",
      details: { value: "1024" },
    });
    expect(() =>
      checkChannelPermissions(f.general, f.bot, [unsafePermission(1024)]),
    ).not.toThrow();
    expect(
      checkGrantablePermissions(f.bot, [unsafePermission(1024)]),
    ).toMatchObject({
      error: "invalid_input",
    });
  });

  it("rejects an unrecognised permission name", () => {
    const f = makeFixture();
    expect(
      checkGuildPermissions(f.bot, [unsafePermission("NotARealPermission")]),
    ).toMatchObject({
      error: "invalid_input",
      message: "NotARealPermission is not a usable Discord permission.",
    });
  });

  it("rejects raw bits outside the flag table instead of passing silently", () => {
    // discord.js' missing() iterates only known flags, so this bit would
    // vanish from the result and the guard would report nothing missing.
    const f = makeFixture();
    const bogus = 9007199254740991n;
    const failure = checkGuildPermissions(f.bot, [bogus]);
    expect(failure).toMatchObject({ error: "invalid_input" });

    // Asserted as properties rather than a literal: what survives the mask
    // depends on which bit numbers the flag table happens to skip, and
    // pinning that literal would test discord.js' numbering, not this guard.
    const reported = BigInt(String(failure?.details?.unknownBits));
    expect(reported).toBeGreaterThan(0n);
    expect(reported & ~bogus).toBe(0n);
    expect(reported & PermissionsBitField.All).toBe(0n);

    expect(checkChannelPermissions(f.general, f.bot, [bogus])).toMatchObject({
      error: "invalid_input",
    });
    expect(checkGrantablePermissions(f.bot, [bogus])).toMatchObject({
      error: "invalid_input",
    });
  });

  it("still accepts both a name and a bigint, which is how tools supply them", () => {
    const f = makeFixture();
    expect(checkGuildPermissions(f.bot, ["SendMessages"])).toBeNull();
    expect(
      checkGuildPermissions(f.bot, [PermissionFlagsBits.SendMessages]),
    ).toBeNull();
    expect(
      checkGuildPermissions(f.bot, ["SendMessages", "ViewChannel"]),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — structural limits
// ---------------------------------------------------------------------------

describe("guards / limits", () => {
  it("accepts a value inside the range", () => {
    expect(
      checkLimit({
        name: "slowmode",
        value: 30,
        min: 0,
        max: 21_600,
        unit: "seconds",
      }),
    ).toBeNull();
  });

  it("rejects a value above the range with exact wording", () => {
    expect(
      checkLimit({
        name: "slowmode",
        value: 30_000,
        min: 0,
        max: LIMITS.slowmodeSeconds.max,
        unit: "seconds",
      }),
    ).toEqual({
      ok: false,
      error: "invalid_input",
      message: "slowmode must be between 0 and 21600 seconds, got 30000.",
      remediation: "Set slowmode to a value between 0 and 21600 seconds.",
      details: { field: "slowmode", value: 30_000 },
    });
  });

  it("handles an open-ended lower bound", () => {
    expect(checkLimit({ name: "limit", value: -1, min: 0 })).toMatchObject({
      message: "limit must be at least 0, got -1.",
      remediation: "Set limit to a value at least 0.",
    });
  });

  it("rejects a non-finite value", () => {
    expect(checkLimit({ name: "volume", value: Number.NaN })).toMatchObject({
      error: "invalid_input",
      message: "volume must be a finite number, got NaN.",
    });
  });

  it("validates against an allowed set", () => {
    expect(
      checkLimit({
        name: "auto_archive_duration",
        value: 90,
        allowed: THREAD_ARCHIVE_MINUTES,
        unit: "minutes",
      }),
    ).toMatchObject({
      error: "invalid_input",
      message:
        "auto_archive_duration must be one of 60, 1440, 4320, 10080 minutes, got 90.",
      remediation:
        "Set auto_archive_duration to one of 60, 1440, 4320, 10080 minutes.",
      details: { allowed: [60, 1440, 4320, 10_080] },
    });
    expect(
      checkLimit({
        name: "auto_archive_duration",
        value: 10_080,
        allowed: THREAD_ARCHIVE_MINUTES,
      }),
    ).toBeNull();
  });

  it("enforces the bulk-delete id count at both ends", () => {
    expect(checkBulkDelete(["1"])).toMatchObject({
      error: "invalid_input",
      message: "Bulk delete needs at least 2 message ids, got 1.",
      remediation:
        "Pass 2–100 ids, or delete a single message with delete_message.",
    });

    const many = Array.from({ length: 101 }, (_, i) => String(i + 1));
    expect(checkBulkDelete(many)).toMatchObject({
      error: "invalid_input",
      message: "Bulk delete accepts at most 100 message ids, got 101.",
      remediation: "Split the request into batches of 100 or fewer.",
    });
  });

  it("rejects an id that is not a snowflake", () => {
    expect(checkBulkDelete(["nope", "12345"])).toMatchObject({
      error: "invalid_input",
      message: "'nope' is not a valid message id.",
      remediation:
        "Message ids are numeric snowflakes — copy them from get_messages rather than composing them.",
    });
  });

  it("names a too-short id as invalid rather than as ancient", () => {
    // Without the length floor this parses to the snowflake epoch and gets
    // reported as a 4300-day-old message — a correct rejection carrying a
    // reason that would send the agent looking for a real message.
    const now = Date.UTC(2026, 0, 20);
    expect(
      checkBulkDelete(["1234567890123", idAt(now - 60_000)], now),
    ).toMatchObject({
      error: "invalid_input",
      message: "'1234567890123' is not a valid message id.",
    });
    // 14 digits is the floor, and a genuine id inside the window is 19 —
    // the floor cannot reject anything that was deletable in the first place.
    expect(idAt(now - 60_000).length).toBeGreaterThanOrEqual(14);
  });

  it("trims whitespace around an id instead of rejecting it", () => {
    const now = Date.UTC(2026, 0, 20);
    const a = idAt(now - 60_000);
    const b = idAt(now - 120_000);
    expect(checkBulkDelete([`  ${a}  `, `\t${b}\n`], now)).toBeNull();
  });

  it("rejects messages older than two weeks", () => {
    const now = Date.UTC(2026, 0, 20);
    const stale = idAt(now - 15 * 86_400_000);
    const recent = idAt(now - 1000);
    expect(checkBulkDelete([recent, stale], now)).toMatchObject({
      error: "invalid_input",
      message: `Message ${stale} is 15 days old; Discord only bulk-deletes messages up to 14 days old.`,
      details: { messageId: stale },
    });
  });

  it("accepts a batch just inside the age window", () => {
    const now = Date.UTC(2026, 0, 20);
    const ids = [idAt(now - 13 * 86_400_000), idAt(now - 60_000)];
    expect(checkBulkDelete(ids, now)).toBeNull();
  });

  it("rejects a snowflake dated in the future rather than calling it valid", () => {
    // A future id parses cleanly and its age is *negative*, so `age > 14 days`
    // is false and the batch would sail through as acceptable.
    const now = Date.UTC(2026, 0, 20);
    const recent = idAt(now - 60_000);
    const future = idAt(Date.UTC(2090, 0, 1));
    expect(checkBulkDelete([recent, future], now)).toMatchObject({
      error: "invalid_input",
      message: `Message ${future} is dated after the current time, so it cannot be a real message id.`,
    });
    expect(checkBulkDelete([future, recent], now)).toMatchObject({
      error: "invalid_input",
    });
  });

  it("enforces upload byte limits", () => {
    expect(
      checkFileSize("emoji file", 300_000, LIMITS.emojiBytes),
    ).toMatchObject({
      error: "invalid_input",
      message: "emoji file must be between 0 and 262144 bytes, got 300000.",
    });
    expect(
      checkFileSize("emoji file", LIMITS.emojiBytes, LIMITS.emojiBytes),
    ).toBeNull();
    expect(LIMITS.stickerBytes).toBe(524_288);
    expect(LIMITS.soundboardDurationMs).toBe(5200);
  });

  it("only accepts tags the forum actually has", () => {
    const available = [
      { id: "600000000000000001", name: "bug" },
      { id: "600000000000000002", name: "feature" },
    ];
    expect(
      checkAppliedTags(["600000000000000009"], available, "forum"),
    ).toEqual({
      ok: false,
      error: "invalid_input",
      message: "Forum tag '600000000000000009' is not available on 'forum'.",
      remediation: "Use tags this forum actually has: bug and feature.",
      details: { field: "applied_tags", unknown: ["600000000000000009"] },
    });
    expect(
      checkAppliedTags(["600000000000000001"], available, "forum"),
    ).toBeNull();
    expect(checkAppliedTags([], available, "forum")).toBeNull();
  });

  it("explains a forum with no tags instead of listing none", () => {
    expect(checkAppliedTags(["1"], [], "empty forum")).toMatchObject({
      remediation: "'empty forum' has no available tags to apply.",
    });
  });
});

// ---------------------------------------------------------------------------
// Capability report
// ---------------------------------------------------------------------------

describe("guards / blockersFor", () => {
  it("reports no permission blockers for an Administrator bot", () => {
    const f = makeFixture({ wardenPermissions: "8" });
    // Administrator does *not* lift role hierarchy — Discord still refuses
    // to let this bot touch anything above it, so those blockers stay.
    expect(blockersFor(f.bot)).toEqual([
      "role 'Moderator' (position 4) is above Warden's top role 'Warden' (position 3)",
      "role 'Integration' (position 5) is above Warden's top role 'Warden' (position 3)",
    ]);
    expect(blockersFor(f.bot).some((line) => line.startsWith("missing "))).toBe(
      false,
    );
  });

  it("lists roles above Warden and every key permission it lacks", () => {
    const f = makeFixture();
    expect(blockersFor(f.bot)).toEqual([
      "role 'Moderator' (position 4) is above Warden's top role 'Warden' (position 3)",
      "role 'Integration' (position 5) is above Warden's top role 'Warden' (position 3)",
      "missing KickMembers",
      "missing BanMembers",
      "missing ManageChannels",
      "missing ManageGuild",
      "missing ManageMessages",
      "missing ManageRoles",
      "missing ModerateMembers",
    ]);
  });

  it("identifies exactly the two roles sitting above Warden", () => {
    const f = makeFixture();
    const roleBlocks = blockersFor(f.bot).filter((line) =>
      line.startsWith("role "),
    );
    expect(roleBlocks).toHaveLength(2);
    expect(roleBlocks[0]).toContain("'Moderator'");
    expect(roleBlocks[1]).toContain("'Integration'");
  });

  it("reports role blockers for a guild-owner bot too, matching the guards", () => {
    // The guards grant no owner exemption from the position rule, so the
    // capability report must not either — if these two ever disagree, an
    // agent is told a blocker exists the preflight will not raise, or vice
    // versa.
    const f = makeFixture({ ownerId: BOT_ID });
    expect(
      blockersFor(f.bot).filter((line) => line.startsWith("role ")),
    ).toHaveLength(2);
    // Administrator does not lift the position rule either, so an admin bot
    // reports the same two — only the *permission* blockers vanish.
    const admin = makeFixture({ wardenPermissions: "8" });
    expect(
      blockersFor(admin.bot).filter((line) => line.startsWith("role ")),
    ).toHaveLength(2);
    expect(
      blockersFor(admin.bot).some((line) => line.startsWith("missing ")),
    ).toBe(false);
  });

  it("masks a token-shaped secret in a role name before it reaches the report", () => {
    // `blockersFor` output lands in a *success* payload, which `ok()` does
    // not scrub — so this is the one guard that must scrub itself. The
    // secret is assembled from parts: GitHub push protection forbids a
    // token-shaped literal anywhere in the tree.
    const f = makeFixture();
    const head = Buffer.from("999999999999999998", "utf8").toString(
      "base64url",
    );
    const token = `${head}.GhIkLm.NpQrStUvWxYz0123456789abcdef`;
    (f.modRole as { name: string }).name = `ops ${token}`;

    const lines = blockersFor(f.bot);
    expect(JSON.stringify(lines)).not.toContain(token);
    expect(JSON.stringify(lines)).not.toContain("NpQrStUvWxYz0123456789abcdef");
    expect(lines.join("\n")).toContain("[redacted-token]");
  });

  it("masks a webhook URL in a role name, which redact() alone would miss", () => {
    // A webhook path is not bot-token shaped: TOKEN_LIKE needs three dot
    // segments and never matches it. Only `scrub()`'s path-shape mask does.
    const f = makeFixture();
    const secret = "abcDEF123ghiJKL456_mno";
    (f.modRole as { name: string }).name =
      `hooks /api/webhooks/1052345678901234562/${secret}`;

    const lines = blockersFor(f.bot).join("\n");
    expect(lines).not.toContain(secret);
    expect(lines).toContain("/webhooks/1052345678901234562/[redacted-secret]");
  });
});

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

describe("guards / preflight", () => {
  it("passes and hands back everything a tool needs", () => {
    const f = makeFixture();
    const pass = expectPass(
      preflight(f.conn, {
        tool: "member.kick",
        guildId: GUILD_ID,
        channelId: GENERAL,
        guildPermissions: [PermissionFlagsBits.SendMessages],
        channelPermissions: [PermissionFlagsBits.SendMessages],
        targetMember: f.target,
        targetRole: null,
        action: "kick",
        limits: [{ name: "slowmode", value: 5, min: 0, max: 21_600 }],
      }),
    );
    expect(pass.tool).toBe("member.kick");
    expect(pass.guild.id).toBe(GUILD_ID);
    expect(pass.channel?.id).toBe(GENERAL);
    expect(pass.botMember.id).toBe(BOT_ID);
    expect(pass.botTopRole.name).toBe("Warden");
    expect(pass.botGuildPermissions.has(PermissionFlagsBits.SendMessages)).toBe(
      true,
    );
    expect(
      pass.botChannelPermissions?.has(PermissionFlagsBits.SendMessages),
    ).toBe(true);
  });

  it("returns null channel state for a guild-scoped tool", () => {
    const f = makeFixture();
    const pass = expectPass(
      preflight(f.conn, {
        tool: "guild.update",
        guildId: GUILD_ID,
        targetMember: null,
        targetRole: null,
      }),
    );
    expect(pass.channel).toBeNull();
    expect(pass.botChannelPermissions).toBeNull();
  });

  it("reports connection problems before anything else", () => {
    const f = makeFixture({ withoutUser: true });
    const conn: GuardConnection = { client: f.client, isReady: () => false };
    expect(
      expectFailure(
        preflight(conn, {
          tool: "member.kick",
          guildId: OTHER_GUILD_ID,
          targetMember: f.owner,
          targetRole: null,
          action: "kick",
        }),
      ),
    ).toMatchObject({ error: "not_ready" });
  });

  it("reports a missing guild before hierarchy", () => {
    const f = makeFixture();
    expect(
      expectFailure(
        preflight(f.conn, {
          tool: "member.kick",
          guildId: OTHER_GUILD_ID,
          targetMember: f.owner,
          targetRole: null,
          action: "kick",
        }),
      ),
    ).toMatchObject({ error: "not_found" });
  });

  it("reports permissions before hierarchy, so the actionable blocker wins", () => {
    const f = makeFixture();
    const failure = expectFailure(
      preflight(f.conn, {
        tool: "member.kick",
        guildId: GUILD_ID,
        guildPermissions: [PermissionFlagsBits.KickMembers],
        targetMember: f.owner,
        targetRole: null,
        action: "kick",
      }),
    );
    expect(failure).toMatchObject({ error: "missing_permission" });
    expect(failure.message).toContain("KickMembers");
  });

  it("reports structural limits last, after permissions and hierarchy", () => {
    const f = makeFixture();
    const failure = expectFailure(
      preflight(f.conn, {
        tool: "channel.update",
        guildId: GUILD_ID,
        guildPermissions: [PermissionFlagsBits.KickMembers],
        targetMember: null,
        targetRole: null,
        limits: [{ name: "slowmode", value: 99_999, min: 0, max: 21_600 }],
      }),
    );
    expect(failure).toMatchObject({ error: "missing_permission" });
  });

  it("refuses channel permissions without a channel to check them against", () => {
    const f = makeFixture();
    expect(
      expectFailure(
        preflight(f.conn, {
          tool: "message.send",
          guildId: GUILD_ID,
          targetMember: null,
          targetRole: null,
          channelPermissions: [PermissionFlagsBits.SendMessages],
        }),
      ),
    ).toEqual({
      ok: false,
      error: "invalid_input",
      message:
        "message.send needs channel permissions but was given no channel_id.",
      remediation:
        "Pass channel_id for this tool — its permissions are checked per channel.",
      details: { tool: "message.send" },
    });
  });

  it("refuses a target member from a different guild", () => {
    const f = makeFixture();
    const other = construct<Guild>(Guild, f.client, {
      ...rawGuild({}),
      id: OTHER_GUILD_ID,
    });
    const stranger = other.members.cache.get(OWNER_ID) as GuildMember;
    expect(stranger.guild.id).toBe(OTHER_GUILD_ID);

    const failure = expectFailure(
      preflight(f.conn, {
        tool: "member.kick",
        guildId: GUILD_ID,
        targetMember: stranger,
        targetRole: null,
        action: "kick",
        // Proves the mismatch is caught before the limits layer runs.
        limits: [{ name: "nonsense", value: 1 }],
      }),
    );
    expect(failure).toMatchObject({
      error: "invalid_input",
      message:
        `member.kick was given a member from guild ${OTHER_GUILD_ID}, ` +
        `but the target guild is ${GUILD_ID}.`,
      details: { targetGuildId: OTHER_GUILD_ID, guildId: GUILD_ID },
    });
    expect(failure.message).not.toContain("nonsense");
  });

  it("fails when the channel permission is denied by an overwrite", () => {
    const f = makeFixture();
    expect(
      expectFailure(
        preflight(f.conn, {
          tool: "message.pin",
          guildId: GUILD_ID,
          channelId: LOCKED,
          targetMember: null,
          targetRole: null,
          channelPermissions: [PermissionFlagsBits.ManageMessages],
        }),
      ),
    ).toMatchObject({
      error: "missing_permission",
      message: "Warden is missing ManageMessages in #locked.",
    });
  });

  it("surfaces the hierarchy failure with exact wording", () => {
    const f = makeFixture();
    const failure = expectFailure(
      preflight(f.conn, {
        tool: "member.update",
        guildId: GUILD_ID,
        action: "nickname",
        targetMember: f.mod,
        targetRole: null,
        // Warden holds SendMessages, so the failure that surfaces must be the
        // hierarchy one — not a permission it happens to be missing too.
        guildPermissions: [PermissionFlagsBits.SendMessages],
      }),
    );
    expect(failure).toMatchObject({
      error: "role_hierarchy",
      bot: { role: "Warden", position: 3 },
      target: { role: "Moderator", position: 4 },
    });
  });

  // The next four pin the *orchestrator boundary*: that `preflight` actually
  // wires each optional target, permission and verb field through to the
  // layer that enforces it. The checks themselves are already tested
  // directly, so deleting any of the four call sites — the two hierarchy
  // calls, the grantable call, or `preflight`'s own tool-naming
  // `guildMismatch` — passes the whole suite otherwise: the logic stays
  // covered while the wiring goes dead, which is exactly how a field can
  // ship exported, documented and inert.

  it("forwards targetRole into the role-hierarchy layer", () => {
    const f = makeFixture();
    const failure = expectFailure(
      preflight(f.conn, {
        tool: "role.update",
        guildId: GUILD_ID,
        action: "delete",
        targetMember: null,
        targetRole: f.modRole,
      }),
    );
    expect(failure).toMatchObject({
      error: "role_hierarchy",
      target: { role: "Moderator", position: 4 },
    });
    // Pins `action` forwarding. A non-default verb is required here: the
    // default is "edit", so asserting on that would pass whether or not the
    // field reaches the check at all.
    expect(failure.message).toContain("Cannot delete role 'Moderator'");
  });

  it("names the calling tool when targetRole comes from another guild", () => {
    const f = makeFixture();
    const other = construct<Guild>(Guild, f.client, {
      ...rawGuild({}),
      id: OTHER_GUILD_ID,
    });
    const failure = expectFailure(
      preflight(f.conn, {
        tool: "role.update",
        guildId: GUILD_ID,
        action: "edit",
        targetMember: null,
        targetRole: other.roles.cache.get(MOD_ROLE) as Role,
      }),
    );
    expect(failure).toMatchObject({
      error: "invalid_input",
      message: `role.update was given a role from guild ${OTHER_GUILD_ID}, but the target guild is ${GUILD_ID}.`,
      details: {
        tool: "role.update",
        targetGuildId: OTHER_GUILD_ID,
        guildId: GUILD_ID,
      },
    });
  });

  it("forwards grantPermissions into the grantable layer", () => {
    const f = makeFixture();
    // `juniorRole` sits below Warden's top, so role hierarchy is satisfied
    // and the grant rule is what must surface.
    const failure = expectFailure(
      preflight(f.conn, {
        tool: "role.update",
        guildId: GUILD_ID,
        action: "permission",
        targetMember: null,
        targetRole: f.juniorRole,
        grantPermissions: [PermissionFlagsBits.ManageGuild],
      }),
    );
    expect(failure).toMatchObject({
      error: "missing_permission",
      missingPermissions: ["ManageGuild"],
    });
  });

  it("forwards protectAdministratorTarget into the member-hierarchy layer", () => {
    const f = makeFixture();
    // carol's top role sits below Warden's, so hierarchy is satisfied and
    // the Administrator protection is the only thing that can stop this.
    // Omitting the flag would let it through — see the option's doc.
    const failure = expectFailure(
      preflight(f.conn, {
        tool: "member.ban",
        guildId: GUILD_ID,
        action: "ban",
        targetMember: f.admin,
        targetRole: null,
        protectAdministratorTarget: true,
      }),
    );
    expect(failure).toMatchObject({
      error: "target_protected",
      target: { user: "carol", protected: "administrator" },
    });
    // Pins `action` forwarding on the member side. This verb deliberately
    // differs from the role test's: two distinct verbs mean no single
    // hardcoded constant can satisfy both assertions.
    expect(failure.message).toContain("Cannot ban carol");
  });
});
