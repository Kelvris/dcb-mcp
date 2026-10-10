/**
 * Capability preflight (plan §6) — every mutating tool runs this **before**
 * touching Discord, so an agent is told *"role 'Moderator' (position 12) is
 * above Warden's top role 'Warden' (position 8)"* instead of discovering it as
 * a 50013 after the request has already gone out.
 *
 * ## Conventions
 *
 * * **Checks** return `WardenError | null` — `null` means passed.
 * * **Resolvers** return `T | WardenError` — narrow with `isWardenError()`.
 * * {@link preflight} runs the whole stack in plan order (connection →
 *   permission → hierarchy → limits) and returns the first failure.
 *
 * Every error is built with `fail()` from `shared/result.ts`, so it is
 * redacted like everything else that leaves the process.
 *
 * ## Three discord.js behaviours this module exists to contain
 *
 * All measured against the installed discord.js 14.27 rather than assumed —
 * each one would otherwise make the preflight lie:
 *
 * 1. **`guild.members.me` throws before READY.** Its getter dereferences
 *    `client.user.id` with no null check (`TypeError: Cannot read properties
 *    of null`), and `member.kickable`/`.bannable`/`.manageable` throw
 *    `GuildUncachedMe` on top of that. Worse, `Partials.GuildMember` *is* one
 *    of Warden's ten partials, so when the real member is uncached `me`
 *    fabricates a member with **no roles** — which would make every hierarchy
 *    check compare the bot's `@everyone` against the target. Hence
 *    {@link checkConnection} first, then an explicit cache read in
 *    {@link resolveBotMember}.
 *
 * 2. **`PermissionsBitField.has()`/`missing()` default `checkAdmin = true`.**
 *    A bot holding Administrator therefore reports *every* permission as
 *    present — correct, and what Discord will allow — but it also means
 *    `.has()` on such a bot's channel permissions hides the effect of a
 *    channel overwrite entirely. Permission answers are taken from
 *    `permissionsFor()` with that default kept, so the preflight's "yes" and
 *    Discord's "yes" agree.
 *
 * 3. **`Role#position` is recomputed, not read.** discord.js re-derives it
 *    from the cache (raw payload positions are only a sort hint), and
 *    `comparePositionTo()` returns the position *difference* rather than a
 *    sign. Hierarchy is therefore always tested as
 *    `comparePositionTo(x) > 0`, which survives that normalisation.
 *
 * `Role#editable` is deliberately **not** used. It has no `@everyone` case at
 * all — its only checks are `managed`, a `ManageRoles` test, and position —
 * so it reports `true` for `@everyone`, and `false` for a role Warden could
 * legitimately touch while it happens to lack `ManageRoles`. Both halves
 * matter: Warden needs the `@everyone` refusal and must not inherit a
 * permission requirement that belongs to a different rule.
 */

import type {
  Client,
  Guild,
  GuildBasedChannel,
  GuildMember,
  PermissionResolvable,
  Role,
} from "discord.js";
import {
  Constants,
  PermissionFlagsBits,
  PermissionsBitField,
  SnowflakeUtil,
} from "discord.js";
import { fail } from "../shared/result.js";
import { isWardenError, scrub } from "./errors.js";
import type { WardenError } from "./errors.js";

// ---------------------------------------------------------------------------
// Layer 1 — connection & resolution
// ---------------------------------------------------------------------------

/** The minimum guards need from the connection; `WardenDiscord` satisfies it. */
export interface GuardConnection {
  readonly client: Client;
  isReady(): boolean;
}

/**
 * Anything Discord can answer a permission question about.
 *
 * Structurally typed because discord.js' hierarchy is split in a way the type
 * system does not paper over: `GuildChannel` covers channels but **not**
 * threads — `ThreadChannel extends BaseChannel` and ships its own
 * `permissionsFor` that delegates to `this.parent`, returning `null` when the
 * parent is not cached (an orphaned/archived thread). Both must be acceptable
 * here, so the signature is written against what they share.
 */
export interface PermissionScope {
  readonly id: string;
  readonly name: string;
  readonly guild: Guild;
  permissionsFor(
    member: GuildMember,
    checkAdmin?: boolean,
  ): Readonly<PermissionsBitField> | null;
}

const NOT_READY_MESSAGE = "The Discord gateway is not connected yet.";
const NOT_READY_REMEDIATION =
  "Wait a few seconds and retry — get_bot_status reports live connection state, and a rejected login shows its reason there.";

/**
 * Layer 1a. Gateway up and `client.user` populated.
 *
 * The second half is not redundant: `client.user` is what identifies Warden's
 * own member, and discord.js dereferences it unguarded (see file header).
 */
export function checkConnection(conn: GuardConnection): WardenError | null {
  if (!conn.isReady()) {
    return fail({
      error: "not_ready",
      message: NOT_READY_MESSAGE,
      remediation: NOT_READY_REMEDIATION,
    });
  }
  if (!conn.client.user) {
    return fail({
      error: "not_ready",
      message:
        "The gateway is up but Warden's own user is not populated, so it cannot tell which member it is.",
      remediation: NOT_READY_REMEDIATION,
    });
  }
  return null;
}

/** Resolve `guild_id` (already defaulted by the tool layer) against the cache. */
export function resolveGuild(
  conn: GuardConnection,
  guildId?: string,
): Guild | WardenError {
  const connectionError = checkConnection(conn);
  if (connectionError) return connectionError;

  const id = guildId?.trim();
  if (!id) {
    return fail({
      error: "invalid_input",
      message: "No guild id was supplied and WARDEN_GUILD_ID is not set.",
      remediation:
        "Pass guild_id, or set WARDEN_GUILD_ID in the MCP server's environment for a single-server setup.",
    });
  }

  const guild = conn.client.guilds.cache.get(id);
  if (!guild) {
    return fail({
      error: "not_found",
      message: `Guild ${id} is not in Warden's cache.`,
      remediation:
        "Check the id and confirm the bot was invited to that guild — get_bot_status lists every cached guild.",
      details: { guildId: id, cachedGuilds: conn.client.guilds.cache.size },
    });
  }
  return guild;
}

/**
 * Resolve a channel **inside** a known guild.
 *
 * Threads share the channel id space, so a thread id resolves here too — no
 * special casing needed at the call site.
 */
export function resolveChannel(
  guild: Guild,
  channelId: string,
): GuildBasedChannel | WardenError {
  const id = channelId.trim();
  if (!id) {
    return fail({
      error: "invalid_input",
      message: "channel_id is empty.",
      remediation:
        "Pass a numeric channel id — threads use the same id space as channels.",
    });
  }

  const channel = guild.channels.cache.get(id);
  if (!channel) {
    return fail({
      error: "not_found",
      message: `Channel ${id} is not in guild '${guild.name}'.`,
      remediation:
        "Check the id — get_channels lists what this guild actually contains, including threads.",
      details: { guildId: guild.id, channelId: id },
    });
  }
  return channel;
}

/**
 * Layer 1b. Warden's own member.
 *
 * Reads the cache directly instead of using `guild.members.me`, because the
 * latter both throws before READY and fabricates a role-less partial when the
 * real member is missing (see file header).
 */
export function resolveBotMember(
  conn: GuardConnection,
  guild: Guild,
): GuildMember | WardenError {
  const connectionError = checkConnection(conn);
  if (connectionError) return connectionError;

  const userId = conn.client.user?.id;
  if (!userId) {
    // Unreachable: checkConnection() above already rejects a missing
    // `client.user`, and nothing between the two touches it. Kept because a
    // guard should fail closed to the same `not_ready` error rather than
    // assert non-null with `!` — the cost is one branch, and the alternative
    // is a throw escaping into a tool call should the two ever drift apart.
    return fail({
      error: "not_ready",
      message: NOT_READY_MESSAGE,
      remediation: NOT_READY_REMEDIATION,
    });
  }

  const me = guild.members.cache.get(userId);
  if (!me) {
    return fail({
      error: "not_ready",
      message: `Warden's own member is not cached in guild '${guild.name}'.`,
      remediation:
        "The guild is still syncing — retry shortly; get_bot_status shows whether the guild finished loading.",
      details: { guildId: guild.id, botId: userId },
    });
  }
  return me;
}

// ---------------------------------------------------------------------------
// Layer 2 — permission
// ---------------------------------------------------------------------------

/** `["a", "b", "c"]` → `"a, b and c"`; keeps messages readable. */
function formatList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  const head = values.slice(0, -1).join(", ");
  return `${head} and ${values.at(-1) ?? ""}`;
}

/**
 * Turn a permission constant discord.js cannot use into a structured error.
 *
 * Two distinct failures collapse into one branch, and the first is the
 * important one. Measured on the installed discord.js:
 *
 * 1. **A plain number throws.** `PermissionsBitField.DefaultBit` is `0n`, so
 *    `resolve()` compares against `typeof 0n` and rejects a `number`
 *    outright — `new PermissionsBitField(1024)`, `p.missing([1024])` and
 *    `p.has(1024)` all throw `Invalid bitfield flag or number: 1024`.
 *    Without this guard that exception would escape `preflight()` and take
 *    the tool call down with it instead of coming back as an answer.
 * 2. **A raw bit outside the flag table passes silently.** `missing()`
 *    reports by walking the *known* flags, so an unnameable bit drops out of
 *    the result: `new PermissionsBitField(9007199254740991n).missing(
 *    9007199254740991n)` returns `[]` — a guard answering "you have it" to
 *    nonsense.
 *
 * `PermissionsBitField.All` is derived from the same `Flags` table the
 * iteration walks, so it covers every declared flag by construction and a
 * named permission can never trip this.
 */
function findUnknownPermissions(
  required: readonly PermissionResolvable[],
): WardenError | null {
  if (required.length === 0) return null;

  let bits = 0n;
  for (const entry of required) {
    // The `try` guards `resolve()`, which throws for anything it cannot map:
    // a plain number (DefaultBit is `0n`, so `typeof 0n !== typeof 1024`), a
    // lowercase or unknown name, `null`, `undefined`, a boolean, a plain
    // object, a negative bigint. It is *not* guarding the `|=` — `resolve()`
    // unwraps a BitField to `bit.bitfield`, so the OR itself cannot throw.
    // Confirmed against the installed discord.js rather than inferred.
    try {
      bits |= PermissionsBitField.resolve(entry);
    } catch {
      return fail({
        error: "invalid_input",
        message: `${String(entry)} is not a usable Discord permission.`,
        remediation:
          "Pass a name from PermissionFlagsBits (e.g. 'ManageMessages') or its bigint — discord.js rejects plain numbers for permissions.",
        details: { value: String(entry) },
      });
    }
  }

  const unknown = bits & ~PermissionsBitField.All;
  if (unknown !== 0n) {
    return fail({
      error: "invalid_input",
      message: `Permission bits ${unknown} do not correspond to any Discord permission.`,
      remediation:
        "Pass permission names from PermissionFlagsBits rather than raw bit values.",
      details: { unknownBits: String(unknown) },
    });
  }

  return null;
}

/**
 * Layer 2a. Guild-wide flags (kick, ban, ManageGuild, …).
 *
 * `missing()` keeps its `checkAdmin = true` default so a bot holding
 * Administrator reports nothing missing — which is what Discord allows.
 */
export function checkGuildPermissions(
  botMember: GuildMember,
  required: readonly PermissionResolvable[],
): WardenError | null {
  if (required.length === 0) return null;

  const unknown = findUnknownPermissions(required);
  if (unknown) return unknown;

  const missing = botMember.permissions.missing([...required]);
  if (missing.length === 0) return null;

  const list = formatList(missing);
  return fail({
    error: "missing_permission",
    message: `Warden is missing ${list} in guild '${botMember.guild.name}'.`,
    missingPermissions: missing,
    remediation: `Grant ${list} to the Warden role in Server Settings → Roles.`,
  });
}

/**
 * Layer 2b. Channel-scoped flags, overwrite-aware.
 *
 * This is the check Discord itself performs for channel-scoped actions: a
 * `deny` on the channel's `@everyone`, on any of Warden's roles, or on Warden
 * directly all reduce the result, so "the role has it" is not enough.
 */
export function checkChannelPermissions(
  channel: PermissionScope,
  botMember: GuildMember,
  required: readonly PermissionResolvable[],
): WardenError | null {
  // Guild identity comes first — ahead of the empty-`required` shortcut as
  // well, so `guildMismatch`'s promise that every exported check validates it
  // holds for an empty request too. Within permissions, the wrong guild is
  // also the more fundamental mistake: answering "1024 is not a usable
  // permission" for a request about the wrong guild would send the agent
  // fixing the second problem first.
  if (channel.guild.id !== botMember.guild.id) {
    return guildMismatch("channel", channel.guild.id, botMember.guild.id);
  }

  if (required.length === 0) return null;

  const unknown = findUnknownPermissions(required);
  if (unknown) return unknown;

  // `permissionsFor()` can answer `null`, and not only for threads: it is
  // `this.parent?.permissionsFor(...) ?? null`, so *any* channel whose
  // permission source discord.js cannot resolve yields it. Claiming a
  // specific cause here would be a guess dressed as a diagnosis — the
  // message says only that Warden does not know yet, which is the part
  // that is actually established.
  const permissions = channel.permissionsFor(botMember);
  if (!permissions) {
    return fail({
      error: "not_ready",
      message: `Cannot determine Warden's permissions in #${channel.name} yet.`,
      remediation:
        "Discord has not resolved this channel's permissions — retry shortly; if this is a thread, its parent channel may still be syncing.",
      details: { channelId: channel.id },
    });
  }

  const missing = permissions.missing([...required]);
  if (missing.length === 0) return null;

  const list = formatList(missing);
  return fail({
    error: "missing_permission",
    message: `Warden is missing ${list} in #${channel.name}.`,
    missingPermissions: missing,
    remediation: `Grant ${list} in Server Settings → Roles, or check #${channel.name}'s overwrites — a deny there beats the role grant.`,
  });
}

// ---------------------------------------------------------------------------
// Layer 3 — hierarchy & protected targets
// ---------------------------------------------------------------------------

export interface MemberHierarchyOptions {
  /** Verb phrase used in the message, e.g. `"kick"` or `"time out"`. */
  action?: string;
  /**
   * Refuse an Administrator target.
   *
   * Opt-in because the grounding differs per action, and Warden will not
   * claim a rule it cannot cite:
   *
   * * **timeout** — Discord's own rule. `GuildMember#moderatable` is
   *   `!Administrator && manageable && ModerateMembers`, and the docs for
   *   `communication_disabled_until` state that it 403s for a target
   *   holding Administrator. Enabling this for a timeout is a true
   *   capability statement.
   * * **ban** — *not* a Discord rule. `GuildMember#bannable` is
   *   `manageable && BanMembers` with no Administrator test, so the API
   *   would allow it. Enabling this for a ban is Warden policy, stricter
   *   than Discord — the same relationship the `@everyone` refusal has to
   *   `Modify Guild Role`.
   *
   * **Kick must not pass this.** `kickable` is hierarchy-only as well, so
   * turning it on there would invent a restriction Discord does not have
   * (see the `does not invent an Administrator protection for kick` test).
   *
   * The emitted message deliberately states the refusal without
   * attributing it, because `action` is a free verb phrase: the same
   * sentence would be true for one action and false for the other, and
   * inferring which from a human-readable string would be a guess dressed
   * as a citation. The attribution lives here, where it can name the
   * getter.
   */
  protectAdministrator?: boolean;
}

/**
 * Layer 3a. May Warden act on this member at all?
 *
 * Order matters because it decides *which* reason an agent hears when several
 * apply: self → owner → Administrator → top-role position.
 *
 * The last step is the whole point of the preflight. Discord reports a
 * hierarchy violation as plain 50013 Missing Permissions — there is no
 * distinct hierarchy error code — so without this the agent would be told it
 * "lacks permissions" it demonstrably has.
 */
export function checkMemberHierarchy(
  botMember: GuildMember,
  targetMember: GuildMember,
  options: MemberHierarchyOptions = {},
): WardenError | null {
  const guild = botMember.guild;
  const action = options.action ?? "act on";
  const target = targetMember.user.tag;

  if (targetMember.guild.id !== guild.id) {
    return guildMismatch("member", targetMember.guild.id, guild.id);
  }

  if (targetMember.id === botMember.id) {
    return fail({
      error: "target_protected",
      message: `Cannot ${action} ${target}: that is Warden itself.`,
      target: { user: target, protected: "self" },
      remediation:
        "Warden acts as the bot account, so it cannot target its own member — pick a different member.",
    });
  }

  if (targetMember.id === guild.ownerId) {
    return fail({
      error: "target_protected",
      message: `Cannot ${action} ${target}: they own '${guild.name}'.`,
      target: { user: target, protected: "owner" },
      remediation:
        "The guild owner is untouchable by design — ownership would have to be transferred first.",
    });
  }

  // Opt-in Administrator guard. The message names the refusal and the
  // remediation but never says *why* — for a timeout the reason is
  // Discord's own (`moderatable` is false), for a ban it is only Warden
  // policy, and `action` is a free verb phrase, so attributing it from
  // that string would guess. The grounding is in the option's doc. It runs
  // before the position test so a tool that wants the protection gets it
  // whatever the roles say.
  if (
    options.protectAdministrator &&
    targetMember.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return fail({
      error: "target_protected",
      message: `Cannot ${action} ${target}: they hold Administrator.`,
      target: { user: target, protected: "administrator" },
      remediation:
        "Remove Administrator from them in Server Settings → Roles first, then retry.",
    });
  }

  // No guild-owner exemption from the position rule, deliberately — and the
  // divergence from discord.js is worth naming, because the library *would*
  // let this pass: `GuildMember#manageable` returns `true` as soon as
  // `this.client.user.id === this.guild.ownerId`, skipping the position
  // comparison entirely. Warden declines to model that. Discord's Permission
  // Hierarchy docs state the bot rules with no owner carve-out ("A bot can
  // only kick, ban, and edit nicknames for users whose highest role is lower
  // than the bot's highest role"), so the strict reading is the documented
  // one — and over-refusing costs an actionable message while under-refusing
  // is the raw 50013 this module exists to pre-empt.
  const botTop = botMember.roles.highest;
  const targetTop = targetMember.roles.highest;
  if (botTop.comparePositionTo(targetTop) > 0) return null;

  return fail({
    error: "role_hierarchy",
    message:
      `Cannot ${action} ${target}: their top role '${targetTop.name}' ` +
      `(position ${targetTop.position}) is not below Warden's top role ` +
      `'${botTop.name}' (position ${botTop.position}).`,
    bot: { role: botTop.name, position: botTop.position },
    target: { role: targetTop.name, position: targetTop.position },
    remediation:
      `Move the '${botTop.name}' role above '${targetTop.name}' in ` +
      `Server Settings → Roles, or act on a member whose top role sits below ${botTop.position}.`,
  });
}

export interface RoleHierarchyOptions {
  /** Verb phrase used in the message, e.g. `"edit"` or `"assign"`. */
  action?: string;
}

/**
 * Layer 3b. May Warden edit/assign this role?
 *
 * Two refusals precede any position math, and they are different *kinds* of
 * rule — the distinction matters when reasoning about the edge cases:
 *
 * * **`@everyone` is Warden policy** (plan §6), not an API limit. Discord's
 *   `Modify Guild Role` endpoint requires only `MANAGE_ROLES`, and because
 *   `@everyone` sits at the bottom of the role list every bot with a real top
 *   role is above it, so the API would permit the edit. Warden refuses it
 *   regardless of who owns the guild, so an agent's plan never has to
 *   branch on ownership. This is deliberately stricter than the API.
 * * **Managed/integration roles are refused because Discord refuses them** —
 *   their permissions belong to the integration that created them, and no
 *   amount of hierarchy changes that.
 *
 * There is no guild-owner exemption from the position rule either, and here
 * the library agrees with Warden rather than diverging: `Role#editable` is
 * `managed → false`, then a `ManageRoles` test, then
 * `clientMember.roles.highest.comparePositionTo(this) > 0` — no owner branch
 * anywhere in it. Discord's Permission Hierarchy docs match ("A bot can edit
 * roles of a lower position than its highest role"). Staying strict is the
 * right side to err on: over-refusing hands the agent an actionable message,
 * while under-refusing is the raw 50013 this module exists to pre-empt.
 */
export function checkRoleHierarchy(
  botMember: GuildMember,
  targetRole: Role,
  options: RoleHierarchyOptions = {},
): WardenError | null {
  const guild = botMember.guild;
  const action = options.action ?? "edit";

  if (targetRole.guild.id !== guild.id) {
    return guildMismatch("role", targetRole.guild.id, guild.id);
  }

  if (targetRole.id === guild.id) {
    return fail({
      error: "target_protected",
      message: `Cannot ${action} the @everyone role.`,
      target: { role: targetRole.name, position: targetRole.position },
      remediation:
        "The @everyone role's permissions are set when the guild is created and Warden will not change them — edit a normal role instead.",
      details: { protected: "everyone" },
    });
  }

  // Tested once, before any position math: a managed role stays uneditable
  // no matter where the roles sit, so there is no second copy to keep in sync.
  if (targetRole.managed) {
    return fail({
      error: "target_protected",
      message: `Cannot ${action} role '${targetRole.name}': it is managed by an integration.`,
      target: { role: targetRole.name, position: targetRole.position },
      remediation:
        "Managed roles are owned by the integration or bot that created them — change it from that integration's settings.",
      details: { protected: "managed" },
    });
  }

  const botTop = botMember.roles.highest;
  if (botTop.comparePositionTo(targetRole) > 0) return null;

  return fail({
    error: "role_hierarchy",
    message:
      `Cannot ${action} role '${targetRole.name}': it sits at position ` +
      `${targetRole.position}, which is not below Warden's top role ` +
      `'${botTop.name}' (position ${botTop.position}).`,
    bot: { role: botTop.name, position: botTop.position },
    target: { role: targetRole.name, position: targetRole.position },
    remediation:
      `Move the '${botTop.name}' role above '${targetRole.name}' in ` +
      `Server Settings → Roles, then retry.`,
  });
}

/**
 * Layer 3c. Role **assignment** additionally cannot hand out a permission
 * Warden does not hold itself — Discord enforces this per permission, so a
 * partial overlap must be reported exactly rather than as a blanket refusal.
 *
 * The reported names arrive in `Object.keys(PermissionFlagsBits)` order, not
 * the order the caller asked for them, because `missing()` walks the flag
 * table rather than the input. Messages are therefore built from the returned
 * list, never from `granted`.
 */
export function checkGrantablePermissions(
  botMember: GuildMember,
  granted: readonly PermissionResolvable[],
): WardenError | null {
  if (granted.length === 0) return null;

  const unknown = findUnknownPermissions(granted);
  if (unknown) return unknown;

  const missing = botMember.permissions.missing([...granted]);
  if (missing.length === 0) return null;

  const list = formatList(missing);
  return fail({
    error: "missing_permission",
    message: `Warden cannot grant ${list}: it does not hold ${missing.length === 1 ? "that permission" : "those permissions"} itself.`,
    missingPermissions: missing,
    remediation: `Give ${list} to the Warden role first, then retry the assignment.`,
  });
}

// ---------------------------------------------------------------------------
// Layer 4 — structural limits
// ---------------------------------------------------------------------------

/** Discord-side limits, each taken from the API docs or discord.js itself. */
export const LIMITS = {
  /** `rate_limit_per_user` — 6 hours, the maximum Discord accepts. */
  slowmodeSeconds: { min: 0, max: 21_600 },
  /** Bulk delete accepts 2–100 ids per call. */
  bulkDeleteCount: { min: 2, max: 100 },
  /** discord.js `Constants.MaxBulkDeletableMessageAge` (exactly 14 days). */
  bulkDeleteAgeMs: Constants.MaxBulkDeletableMessageAge,
  /** Timeouts cannot exceed 28 days. */
  timeoutMs: { min: 0, max: 28 * 24 * 60 * 60 * 1000 },
  /** Emoji uploads — api docs: "maximum file size of 256 KiB". */
  emojiBytes: 256 * 1024,
  /** Sticker uploads — api docs: "max 512 KiB". */
  stickerBytes: 512 * 1024,
  /** Soundboard uploads — api docs: "max file size 512kb, max duration 5.2 seconds". */
  soundboardBytes: 512 * 1024,
  soundboardDurationMs: 5200,
} as const;

/**
 * `ThreadAutoArchiveDuration` from `discord-api-types` (1h/1d/3d/1w).
 *
 * A frozen array rather than a `ReadonlySet`: `Object.freeze` does not touch
 * a Set's internal slots, so `THREAD_ARCHIVE_MINUTES.add(5)` would still
 * mutate it at runtime while type-checking. Freezing a real array makes the
 * immutability hold at runtime too, and `checkLimit` only ever spreads it.
 */
export const THREAD_ARCHIVE_MINUTES: readonly number[] = Object.freeze([
  60, 1440, 4320, 10_080,
]);

export interface StructuralLimit {
  /** Field name exactly as the agent supplied it, e.g. `"slowmode"`. */
  name: string;
  value: number;
  /** Inclusive lower bound. */
  min?: number;
  /** Inclusive upper bound. */
  max?: number;
  /** Exclusive of `min`/`max`: an allowed value set instead of a range. */
  allowed?: Iterable<number>;
  /** Unit appended to the bounds, e.g. `"seconds"`. */
  unit?: string;
}

function boundText(limit: StructuralLimit, value: number): string {
  const unit = limit.unit ? ` ${limit.unit}` : "";
  if (limit.min !== undefined && limit.max !== undefined) {
    return `between ${limit.min} and ${limit.max}${unit}`;
  }
  if (limit.min !== undefined) return `at least ${limit.min}${unit}`;
  if (limit.max !== undefined) return `at most ${limit.max}${unit}`;
  return String(value);
}

/**
 * Layer 4a. Numeric range / membership.
 *
 * Runs *after* the permission and hierarchy layers on purpose: an agent that
 * is missing `ManageRoles` should hear about that, not about its formatting
 * mistake, because one is actionable by an operator and the other is not.
 */
export function checkLimit(limit: StructuralLimit): WardenError | null {
  const { name, value } = limit;

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail({
      error: "invalid_input",
      message: `${name} must be a finite number, got ${String(value)}.`,
      remediation: `Pass a finite number for ${name}.`,
      details: { field: name },
    });
  }

  if (limit.allowed) {
    const allowed = [...limit.allowed];
    if (!allowed.includes(value)) {
      const unit = limit.unit ? ` ${limit.unit}` : "";
      return fail({
        error: "invalid_input",
        message: `${name} must be one of ${allowed.join(", ")}${unit}, got ${value}.`,
        remediation: `Set ${name} to one of ${allowed.join(", ")}${unit}.`,
        details: { field: name, allowed },
      });
    }
    return null;
  }

  if (
    (limit.min !== undefined && value < limit.min) ||
    (limit.max !== undefined && value > limit.max)
  ) {
    return fail({
      error: "invalid_input",
      message: `${name} must be ${boundText(limit, value)}, got ${value}.`,
      remediation: `Set ${name} to a value ${boundText(limit, value)}.`,
      details: { field: name, value },
    });
  }

  return null;
}

/**
 * Embedded creation timestamp of a snowflake, or `null` when it is not one.
 *
 * Both halves of the shape check earn their place, and neither is
 * belt-and-braces:
 *
 * * `SnowflakeUtil.timestampFrom()` yields `NaN` for a non-numeric id
 *   instead of throwing, and `NaN` loses every comparison — so a typo would
 *   fall through to the age rule and be reported as *"message 12345 is 4300
 *   days old"* rather than named as the mistake it is.
 * * The 14-digit floor is safe here specifically because of the age limit
 *   below: an id embeds `(timestamp − 2015-01-15) << 22`, so anything
 *   inside Discord's 14-day bulk-delete window is 19 digits today and
 *   cannot be shorter than 14 for roughly a century of guild history. The
 *   floor therefore only ever rejects ids that the age rule would have
 *   rejected anyway — it changes the *reason*, never the outcome.
 */
function snowflakeTimestamp(id: string): number | null {
  if (!/^\d{14,20}$/.test(id)) return null;
  try {
    const at = SnowflakeUtil.timestampFrom(id);
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

/**
 * Layer 4b. Bulk delete: 2–100 ids, none older than 14 days, all real snowflakes.
 *
 * `now` drives two rules — the 14-day age window and the refusal of ids
 * dated after the present. It defaults to `Date.now()`, which is correct;
 * a caller that captures it once at operation start and reuses it across a
 * batch of calls will make ids minted during that window look future-dated.
 * Pass `Date.now()` per invocation unless the caller genuinely needs a
 * fixed reference point.
 */
export function checkBulkDelete(
  messageIds: readonly string[],
  now: number = Date.now(),
): WardenError | null {
  const { min, max } = LIMITS.bulkDeleteCount;
  // Trimmed once here rather than at each use: whitespace around an id is
  // not a different id, and rejecting `" 123 "` as malformed would teach the
  // agent the wrong lesson about what Discord rejects.
  const ids = messageIds.map((id) => id.trim());

  if (ids.length < min) {
    return fail({
      error: "invalid_input",
      message: `Bulk delete needs at least ${min} message ids, got ${ids.length}.`,
      remediation: `Pass ${min}–${max} ids, or delete a single message with delete_message.`,
      details: { count: ids.length },
    });
  }

  if (ids.length > max) {
    return fail({
      error: "invalid_input",
      message: `Bulk delete accepts at most ${max} message ids, got ${ids.length}.`,
      remediation: `Split the request into batches of ${max} or fewer.`,
      details: { count: ids.length },
    });
  }

  let oldestId = ids[0] ?? "";
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const at = snowflakeTimestamp(id);
    if (at === null) {
      return fail({
        error: "invalid_input",
        message: `'${id}' is not a valid message id.`,
        remediation:
          "Message ids are numeric snowflakes — copy them from get_messages rather than composing them.",
        details: { value: id },
      });
    }
    // A snowflake carries the moment it was minted, so one dated after "now"
    // cannot be a message that exists — it parses cleanly, sails past the age
    // rule (a negative age is not > 14 days), and would be reported as valid.
    if (at > now) {
      return fail({
        error: "invalid_input",
        message: `Message ${id} is dated after the current time, so it cannot be a real message id.`,
        remediation:
          "Message ids embed when they were sent — copy the id from get_messages rather than composing one.",
        details: { value: id, decodedAt: at, now },
      });
    }
    if (at < oldestAt) {
      oldestAt = at;
      oldestId = id;
    }
  }

  const age = now - oldestAt;
  if (age > LIMITS.bulkDeleteAgeMs) {
    const days = Math.floor(LIMITS.bulkDeleteAgeMs / 86_400_000);
    return fail({
      error: "invalid_input",
      message: `Message ${oldestId} is ${Math.floor(age / 86_400_000)} days old; Discord only bulk-deletes messages up to ${days} days old.`,
      remediation: `Drop the older ids and delete those individually with delete_message, which has no age limit.`,
      details: { messageId: oldestId, ageMs: age },
    });
  }

  return null;
}

/** Layer 4c. Upload byte-size guard (emoji / sticker / soundboard). */
export function checkFileSize(
  name: string,
  bytes: number,
  maxBytes: number,
): WardenError | null {
  return checkLimit({
    name,
    value: bytes,
    min: 0,
    max: maxBytes,
    unit: "bytes",
  });
}

/** Layer 4d. Forum: only the forum's own tags may be applied. */
export function checkAppliedTags(
  applied: readonly string[],
  available: readonly { id: string; name: string }[],
  forumName: string,
): WardenError | null {
  if (applied.length === 0) return null;

  const known = new Map(available.map((tag) => [tag.id, tag.name]));
  const unknown = applied.filter((id) => !known.has(id));
  if (unknown.length === 0) return null;

  return fail({
    error: "invalid_input",
    message:
      `Forum tag ${unknown.map((id) => `'${id}'`).join(", ")} ` +
      `${unknown.length === 1 ? "is" : "are"} not available on '${forumName}'.`,
    remediation:
      available.length > 0
        ? `Use tags this forum actually has: ${formatList(available.map((tag) => tag.name))}.`
        : `'${forumName}' has no available tags to apply.`,
    details: { field: "applied_tags", unknown },
  });
}

// ---------------------------------------------------------------------------
// Capability reporting (feeds get_bot_status, plan §8.1)
// ---------------------------------------------------------------------------

/** Permission flags whose absence blocks a whole tool group. */
const KEY_PERMISSIONS: readonly bigint[] = [
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageGuild,
];

/**
 * Known reasons a mutation would fail — the "role X above you" half of
 * `get_bot_status`'s capability report.
 *
 * Returns an empty array when nothing is known to be in the way, so callers
 * can print `[]` as "no blockers found" rather than an invented all-clear.
 *
 * Deliberately partial, and the boundary is worth stating because `[]` is
 * what an agent reads. This reports the **position** half of the guards'
 * output plus the key-permission half. It cannot report the *protected
 * target* half — `@everyone`, a managed role, the guild owner, Warden itself
 * — because those refusals have no position footprint: they would still be
 * refused even though no role sits above Warden. So `[]` means "no role sits
 * above Warden and no key permission is missing", **not** "every target is
 * editable". Only `preflight` can answer the latter, and callers wanting the
 * full truth should run it rather than read this as a green light.
 */
export function blockersFor(botMember: GuildMember): string[] {
  const blockers: string[] = [];
  const top = botMember.roles.highest;
  const guild = botMember.guild;

  // Every role above Warden's top is a genuine obstacle: neither guard
  // exempts anyone from the position rule — including a guild-owner bot,
  // which Discord's docs do not exempt either. That claim is scoped to this
  // half only: a managed role or `@everyone` *below* Warden's top is refused
  // by `checkRoleHierarchy` yet contributes no line here, so this list can
  // never be read as "everything the guards would say" (see the doc above).
  for (const role of guild.roles.cache.values()) {
    if (role.comparePositionTo(top) > 0) {
      blockers.push(
        `role '${role.name}' (position ${role.position}) is above ` +
          `Warden's top role '${top.name}' (position ${top.position})`,
      );
    }
  }

  // `missing()` keeps the Administrator short-circuit, so an admin bot
  // reports no blockers here — correct, because Discord allows it everything.
  // Administrator does *not* lift the position rule (discord.js's guide puts
  // it plainly: "Granting the Administrator permission does not skip any
  // hierarchical check"), which is why the loop above has no escape of its own.
  const missing = botMember.permissions.missing([...KEY_PERMISSIONS]);
  for (const name of missing) blockers.push(`missing ${name}`);

  // Role names are raw Discord text and can contain anything a human typed,
  // including a token-shaped string or a webhook URL. This is the one guard
  // whose output is destined for a *success* payload, which `ok()` does not
  // scrub (see shared/result.ts) — so it applies the same `scrub()` every
  // failure gets. `redact()` alone would not do: a webhook path is not
  // bot-token shaped and TOKEN_LIKE never matches it.
  return blockers.map((line) => scrub(line));
}

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

export interface PreflightRequest {
  /** Tool name, surfaced in the error so the agent knows which call failed. */
  tool: string;
  guildId?: string;
  channelId?: string;
  /** Guild-wide flags (kick, ban, ManageGuild…). */
  guildPermissions?: readonly PermissionResolvable[];
  /** Channel-scoped flags; requires `channelId`. */
  channelPermissions?: readonly PermissionResolvable[];
  /**
   * Member Warden wants to act on — enables hierarchy + protection checks.
   *
   * **Required, and `null` means "this tool has no member target."** It is
   * not optional because an omitted field is indistinguishable from a
   * misspelled or forgotten one, and either would silently disable the
   * entire hierarchy and protected-target layer — the checks this module
   * exists to run. Forcing the caller to write `null` turns an invisible
   * failure into a visible decision.
   */
  targetMember: GuildMember | null;
  /** Role Warden wants to edit/assign — enables role hierarchy checks. Same rationale as {@link PreflightRequest.targetMember}. */
  targetRole: Role | null;
  /** Verb phrase for messages, e.g. `"kick"`. */
  action?: string;
  /** Ban/timeout only — see {@link MemberHierarchyOptions}. */
  protectAdministratorTarget?: boolean;
  /** Permissions that would be granted by an assignment. */
  grantPermissions?: readonly PermissionResolvable[];
  /** Structural limits, evaluated in the order given. */
  limits?: readonly StructuralLimit[];
}

/** What a passing preflight hands back so the tool can execute without re-resolving. */
export interface PreflightPass {
  ok: true;
  tool: string;
  guild: Guild;
  /** `null` when the tool is guild-scoped and supplied no `channelId`. */
  channel: GuildBasedChannel | null;
  botMember: GuildMember;
  botTopRole: Role;
  botGuildPermissions: Readonly<PermissionsBitField>;
  botChannelPermissions: Readonly<PermissionsBitField> | null;
}

/**
 * Run the full preflight (plan §6) in layered order and return either
 * everything the tool needs to execute, or the first reason it must not.
 *
 * The order is deliberate and matches the plan: connection → permission →
 * hierarchy → limits. Hierarchy expands to role position → member position →
 * grantable permissions, which is the order plan §6 lists those three in.
 * Each layer only speaks once, so an agent gets the most fundamental problem
 * first instead of a list where the real blocker is last.
 *
 * The ordering holds *within* each exported check too, since all three are
 * reachable directly rather than only through `preflight`:
 * `checkRoleHierarchy` (layer 3) runs guild → `@everyone` → managed →
 * position; `checkMemberHierarchy` (layer 3) runs guild → self → owner →
 * Administrator → position; `checkChannelPermissions` (layer 2) runs guild →
 * unknown constant → resolved permissions.
 */
export function preflight(
  conn: GuardConnection,
  request: PreflightRequest,
): PreflightPass | WardenError {
  const guild = resolveGuild(conn, request.guildId);
  if (isWardenError(guild)) return guild;

  const botMember = resolveBotMember(conn, guild);
  if (isWardenError(botMember)) return botMember;

  let channel: GuildBasedChannel | null = null;
  if (request.channelId !== undefined) {
    const resolved = resolveChannel(guild, request.channelId);
    if (isWardenError(resolved)) return resolved;
    channel = resolved;
  }

  if (request.channelPermissions?.length && !channel) {
    return fail({
      error: "invalid_input",
      message: `${request.tool} needs channel permissions but was given no channel_id.`,
      remediation:
        "Pass channel_id for this tool — its permissions are checked per channel.",
      details: { tool: request.tool },
    });
  }

  const guildPermissionError = checkGuildPermissions(
    botMember,
    request.guildPermissions ?? [],
  );
  if (guildPermissionError) return guildPermissionError;

  const channelPermissionError = channel
    ? checkChannelPermissions(
        channel,
        botMember,
        request.channelPermissions ?? [],
      )
    : null;
  if (channelPermissionError) return channelPermissionError;

  if (request.targetRole) {
    if (request.targetRole.guild.id !== guild.id) {
      return guildMismatch(
        "role",
        request.targetRole.guild.id,
        guild.id,
        request.tool,
      );
    }
    const roleError = checkRoleHierarchy(botMember, request.targetRole, {
      action: request.action,
    });
    if (roleError) return roleError;
  }

  if (request.targetMember) {
    if (request.targetMember.guild.id !== guild.id) {
      return guildMismatch(
        "member",
        request.targetMember.guild.id,
        guild.id,
        request.tool,
      );
    }
    const memberError = checkMemberHierarchy(botMember, request.targetMember, {
      action: request.action,
      protectAdministrator: request.protectAdministratorTarget,
    });
    if (memberError) return memberError;
  }

  const grantError = checkGrantablePermissions(
    botMember,
    request.grantPermissions ?? [],
  );
  if (grantError) return grantError;

  for (const limit of request.limits ?? []) {
    const limitError = checkLimit(limit);
    if (limitError) return limitError;
  }

  return {
    ok: true,
    tool: request.tool,
    guild,
    channel,
    botMember,
    botTopRole: botMember.roles.highest,
    botGuildPermissions: botMember.permissions,
    botChannelPermissions: channel ? channel.permissionsFor(botMember) : null,
  };
}

/**
 * A target from a different guild would be compared against roles Warden's
 * own guild has never heard of — silently passing or failing at random.
 *
 * Called from three kinds of caller on purpose. `preflight()` runs it first
 * so the error can name the tool that was called; the exported checks each
 * run it again because they are reachable directly, where an unprotected
 * comparison would reintroduce exactly the bug this exists to prevent. That
 * includes `checkChannelPermissions`, which sits in layer **2** as well as
 * the layer-3 `checkMemberHierarchy`/`checkRoleHierarchy` — every exported
 * check that takes an outside target. `tool` is therefore optional rather
 * than the checks duplicating the message-building.
 */
function guildMismatch(
  kind: "role" | "member" | "channel",
  targetGuildId: string,
  guildId: string,
  tool?: string,
): WardenError {
  return fail({
    error: "invalid_input",
    message: tool
      ? `${tool} was given a ${kind} from guild ${targetGuildId}, but the target guild is ${guildId}.`
      : `This ${kind} belongs to guild ${targetGuildId}, but Warden is acting in guild ${guildId}.`,
    remediation: `Only act on ${kind}s belonging to the guild this call names — check the id you passed.`,
    details: {
      ...(tool !== undefined ? { tool } : {}),
      targetGuildId,
      guildId,
    },
  });
}
