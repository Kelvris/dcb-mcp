/**
 * discord.js objects → compact JSON (plan §7.3): full objects for the small
 * entities (role, emoji, invite), trimmed ones for the big ones (message keeps
 * id/content/author/attachments/embeds/mentions, member keeps
 * id/user/roles/nick/joinedAt, voice state keeps its full triple).
 *
 * Two contracts keep this module honest *and* testable without a gateway:
 *
 * - Inputs are structural `*Like` shapes rather than discord.js classes, so a
 *   freshly constructed discord.js instance and a hand-written fixture both
 *   satisfy them. The tests deliberately pass real discord.js objects: that
 *   is what pins every field name here to the library instead of to whatever
 *   the fixtures happen to repeat.
 * - Output keys are Discord-API camelCase. `null` means "Discord says none"
 *   (discord.js itself reports missing message fields as `null`, so a partial
 *   delete and a real empty field are not confused), while a key that does
 *   not apply to the object at all — a `topic` on a voice channel — is
 *   dropped by {@link compact} instead of being reported as a value.
 *
 * Secrets never leave this module: webhook `token` and `url` are omitted,
 * and the URL would be just as bad because it embeds the token.
 */

/** Anything Discord stores as a bit field: a discord.js BitField or plain names. */
export type BitFieldSource =
  { toArray(): string[] } | readonly string[] | null | undefined;

/**
 * A discord.js Collection (or a plain array fixture): iterable, and `size` is
 * optional because arrays expose `length` instead.
 */
export type CacheLike = Iterable<unknown> & { readonly size?: number };

/** Deprecated permission name → the canonical name sharing its bit. */
const PERMISSION_NAME_ALIASES: Readonly<Record<string, string>> = {
  // Discord renamed ManageEmojisAndStickers → ManageGuildExpressions; both
  // entries carry bit 1<<30, so PermissionsBitField.toArray() returns both.
  ManageEmojisAndStickers: "ManageGuildExpressions",
};

/**
 * Drop keys whose value is `undefined` (not applicable / not cached) while
 * keeping `null` (Discord explicitly reported "none").
 *
 * The record is an object literal so the inferred type keeps its keys; only
 * the undefined-valued ones disappear at runtime, which is exactly the JSON
 * `JSON.stringify` would produce anyway.
 */
export function compact<T extends Record<string, unknown>>(record: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/** Date/epoch → ISO string; preserves the input's presence (undefined stays undefined). */
function iso(
  value: Date | number | string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Role/embed colour int → `#rrggbb`; never throws on malformed input. */
function toHexColor(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `#${(Math.trunc(value) & 0xffffff).toString(16).padStart(6, "0")}`;
}

/**
 * Collection / array / manager cache → its values.
 *
 * discord.js Collections (and every array) expose `values()`; going through
 * it means a Map-like never has to be destructured as `[key, value]` pairs.
 */
function valuesOf(source: CacheLike | null | undefined): unknown[] {
  if (source === null || source === undefined) return [];
  if (Array.isArray(source)) return [...source];
  const maybe = source as { values?: () => Iterable<unknown> };
  if (typeof maybe.values === "function") return [...maybe.values()];
  return [...source];
}

function idOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string") return id;
    if (typeof id === "number") return String(id);
  }
  return null;
}

/** Collection/array of id-bearing objects (or raw ids) → the id list. */
export function idList(source: CacheLike | null | undefined): string[] {
  const out: string[] = [];
  for (const value of valuesOf(source)) {
    const id = idOf(value);
    if (id !== null) out.push(id);
  }
  return out;
}

function countOf(source: CacheLike): number {
  if (Array.isArray(source)) return source.length;
  return typeof source.size === "number" ? source.size : [...source].length;
}

/** Manager → its cache size; `undefined` (key omitted) when the fixture has no manager. */
function cacheCount(
  manager: { readonly cache: CacheLike } | undefined,
): number | undefined {
  return manager === undefined ? undefined : countOf(manager.cache);
}

/**
 * discord.js lands **threads** in `guild.channels` as well — `ChannelManager`'s
 * `_add` accepts types 10/11/12 — so a bare cache size would report every forum
 * post as a channel. The values are discord-api-types' `ChannelType`
 * (AnnouncementThread / PublicThread / PrivateThread), inlined so this module
 * keeps its structural, no-discord.js-import contract.
 */
const THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);

function isThreadChannel(value: unknown): boolean {
  const type = (value as { type?: unknown }).type;
  return typeof type === "number" && THREAD_CHANNEL_TYPES.has(type);
}

/**
 * Splits `guild.channels.cache` into "channels" and "threads". Both come from
 * the same manager, so `channelCount` and `threadCount` always add up to the
 * total and neither double-counts.
 */
function channelCounts(manager: { readonly cache: CacheLike } | undefined): {
  channels: number | undefined;
  threads: number | undefined;
} {
  if (manager === undefined) return { channels: undefined, threads: undefined };
  let channels = 0;
  let threads = 0;
  for (const value of valuesOf(manager.cache)) {
    if (isThreadChannel(value)) threads += 1;
    else channels += 1;
  }
  return { channels, threads };
}

function bitFieldNames(value: BitFieldSource): readonly string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  const maybe = value as { toArray?: () => string[] };
  return typeof maybe.toArray === "function" ? maybe.toArray() : [];
}

function dedupe(
  names: readonly string[],
  aliases?: Readonly<Record<string, string>>,
): string[] {
  const out: string[] = [];
  for (const name of names) {
    const canonical = aliases?.[name] ?? name;
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/** Permission names, alias-collapsed and deduplicated. */
export function serializePermissions(value: BitFieldSource): string[] {
  return dedupe(bitFieldNames(value), PERMISSION_NAME_ALIASES);
}

/** Any other bit field (message/user/system-channel flags …) → names. */
export function serializeBitField(value: BitFieldSource): string[] {
  return dedupe(bitFieldNames(value));
}

// ---------------------------------------------------------------------------
// users & members
// ---------------------------------------------------------------------------

export interface UserLike {
  id: string;
  username: string;
  globalName?: string | null;
  discriminator?: string;
  avatar?: string | null;
  bot?: boolean;
  system?: boolean;
  /**
   * `number` is the raw-`APIUser` form: discord.js declares `Webhook.owner` as
   * `User | APIUser`, and `APIUser.flags` is a bare `UserFlags` integer.
   */
  flags?: BitFieldSource | number;
  createdTimestamp?: number | null;
  avatarURL?(options?: unknown): string | null;
  displayAvatarURL?(options?: unknown): string | null;
}

export interface SerializedUser {
  id: string;
  username: string;
  globalName: string | null;
  discriminator: string | null;
  avatar: string | null;
  avatarUrl: string | null;
  bot: boolean | null;
  system: boolean | null;
  flags: string[];
  createdAt: string | null;
}

export function serializeUser(user: UserLike): SerializedUser {
  return {
    id: user.id,
    username: user.username,
    globalName: user.globalName ?? null,
    discriminator: user.discriminator ?? null,
    avatar: user.avatar ?? null,
    // displayAvatarURL() always resolves (default avatar when no custom one),
    // avatarURL() is the fallback for fixtures that only ship the latter.
    avatarUrl: user.displayAvatarURL?.() ?? user.avatarURL?.() ?? null,
    bot: user.bot ?? null,
    system: user.system ?? null,
    // A bare `UserFlags` integer carries no names without its enum, and
    // duplicating discord-api-types' 21-entry table here would be a second
    // source of truth that drifts. discord.js always resolves a webhook owner
    // through `client.users._add()`, so this arm does not fire in practice —
    // and `[]` beats reporting a name we did not actually look up.
    flags: typeof user.flags === "number" ? [] : serializeBitField(user.flags),
    createdAt: iso(user.createdTimestamp) ?? null,
  };
}

export interface GuildMemberLike {
  id: string;
  user?: UserLike | null;
  nickname?: string | null;
  displayName?: string;
  joinedTimestamp?: number | null;
  joinedAt?: Date | null;
  communicationDisabledUntilTimestamp?: number | null;
  communicationDisabledUntil?: Date | null;
  premiumSinceTimestamp?: number | null;
  premiumSince?: Date | null;
  avatar?: string | null;
  /** Used only to recognise — and drop — the implicit @everyone role. */
  guild?: { id?: string } | null;
  roles?: { readonly cache: CacheLike };
}

/** Trimmed member (plan §7.3): identity + roles + the dates moderation needs. */
export interface SerializedMember {
  id: string;
  user: SerializedUser | null;
  roles: string[];
  nickname: string | null;
  displayName: string | null;
  joinedAt: string | null;
  communicationDisabledUntil: string | null;
  premiumSince: string | null;
  avatar: string | null;
}

export function serializeMember(member: GuildMemberLike): SerializedMember {
  // `GuildMemberRoleManager.cache` unconditionally seeds @everyone (whose role
  // id IS the guild id) before the member's own roles. Discord's own
  // `member.roles` never lists it, and carrying it here would invite an agent
  // to call `remove_role(guildId)` — so it is dropped, leaving exactly the
  // ids Discord would return.
  const everyoneId = member.guild?.id;
  return {
    id: member.id,
    user: member.user ? serializeUser(member.user) : null,
    roles: idList(member.roles?.cache).filter(
      (roleId) => roleId !== everyoneId,
    ),
    nickname: member.nickname ?? null,
    displayName:
      member.displayName ?? member.nickname ?? member.user?.username ?? null,
    joinedAt: iso(member.joinedTimestamp ?? member.joinedAt) ?? null,
    communicationDisabledUntil:
      iso(
        member.communicationDisabledUntilTimestamp ??
          member.communicationDisabledUntil,
      ) ?? null,
    premiumSince:
      iso(member.premiumSinceTimestamp ?? member.premiumSince) ?? null,
    avatar: member.avatar ?? null,
  };
}

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

export interface RoleTagLike {
  botId?: string;
  integrationId?: string;
  premiumSubscriberRole?: true;
  subscriptionListingId?: string;
  availableForPurchase?: true;
  guildConnections?: true;
}

export interface RoleLike {
  id: string;
  name: string;
  /** Deprecated plain colour; kept because fixtures and older payloads only have this. */
  color?: number;
  colors?: { primaryColor?: number | null };
  position?: number;
  rawPosition?: number;
  permissions?: BitFieldSource;
  hoist?: boolean;
  mentionable?: boolean;
  managed?: boolean;
  icon?: string | null;
  unicodeEmoji?: string | null;
  tags?: RoleTagLike | null;
  createdTimestamp?: number | null;
  iconURL?(options?: unknown): string | null;
}

export interface SerializedRole {
  id: string;
  name: string;
  color: number | null;
  hexColor: string | null;
  position: number | null;
  permissions: string[];
  hoist: boolean | null;
  mentionable: boolean | null;
  managed: boolean | null;
  icon: string | null;
  iconUrl: string | null;
  unicodeEmoji: string | null;
  tags: RoleTagLike | null;
  createdAt: string | null;
}

export function serializeRole(role: RoleLike): SerializedRole {
  // Role.hexColor() reads colors.primaryColor and throws when `colors` is
  // missing, which is exactly what a fixture (or a partially patched role)
  // looks like — so the colour is resolved here instead of via the getter.
  const primary = role.colors?.primaryColor;
  const color = typeof primary === "number" ? primary : (role.color ?? null);
  return {
    id: role.id,
    name: role.name,
    color,
    hexColor: toHexColor(color),
    // rawPosition is Discord's own position; `position` is recomputed from the
    // guild's role cache and reads 0 on a role built outside a populated guild.
    position: role.rawPosition ?? role.position ?? null,
    permissions: serializePermissions(role.permissions),
    hoist: role.hoist ?? null,
    mentionable: role.mentionable ?? null,
    managed: role.managed ?? null,
    icon: role.icon ?? null,
    iconUrl: role.iconURL?.() ?? null,
    unicodeEmoji: role.unicodeEmoji ?? null,
    // Copied, not handed over: these are discord.js' own cached objects, and
    // returning them by reference would let a consumer mutate the library's
    // state through what is supposed to be a plain JSON snapshot.
    tags: role.tags ? { ...role.tags } : null,
    createdAt: iso(role.createdTimestamp) ?? null,
  };
}

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

export interface PermissionOverwriteLike {
  id: string;
  /** OverwriteType: 0 = role, 1 = member (Discord's own enum). */
  type?: number;
  allow?: BitFieldSource;
  deny?: BitFieldSource;
}

export interface SerializedOverwrite {
  id: string;
  type: number | null;
  allow: string[];
  deny: string[];
}

export interface ForumTagLike {
  id: string;
  name: string;
  emoji?: {
    id?: string | null;
    name?: string | null;
    animated?: boolean;
  } | null;
  moderated?: boolean;
}

export interface DefaultReactionEmojiLike {
  id?: string | null;
  name?: string | null;
  animated?: boolean;
}

export interface ChannelLike {
  id: string;
  type: number;
  name?: string | null;
  parentId?: string | null;
  position?: number;
  rawPosition?: number;
  createdTimestamp?: number | null;
  // text / forum / stage
  topic?: string | null;
  nsfw?: boolean;
  rateLimitPerUser?: number | null;
  lastMessageId?: string | null;
  // voice
  bitrate?: number;
  userLimit?: number;
  rtcRegion?: string | null;
  videoQualityMode?: number | null;
  // threads
  archived?: boolean | null;
  locked?: boolean | null;
  autoArchiveDuration?: number | null;
  // discord.js gives this as epoch ms (`Date.parse(thread_metadata…)`), while
  // raw fixtures carry the ISO string — `iso()` accepts both, so declare both.
  archiveTimestamp?: string | number | null;
  ownerId?: string | null;
  invitable?: boolean | null;
  memberCount?: number | null;
  messageCount?: number | null;
  totalMessageSent?: number | null;
  appliedTags?: readonly string[];
  // forum-only
  availableTags?: readonly ForumTagLike[];
  defaultReactionEmoji?: DefaultReactionEmojiLike | null;
  defaultSortOrder?: number | null;
  defaultForumLayout?: number;
  // discord.js declares this `ThreadAutoArchiveDuration | null` on a forum.
  defaultAutoArchiveDuration?: number | null;
  permissionOverwrites?: { readonly cache: CacheLike };
}

/**
 * Common fields are always present; the type-specific ones are optional and
 * simply absent when the channel type doesn't have them — which is why the
 * result goes through `compact()`.
 */
export interface SerializedChannel {
  id: string;
  type: number;
  name: string | null;
  parentId: string | null;
  position: number | null;
  createdAt: string | null;
  topic?: string | null;
  nsfw?: boolean;
  rateLimitPerUser?: number | null;
  lastMessageId?: string | null;
  bitrate?: number;
  userLimit?: number;
  rtcRegion?: string | null;
  videoQualityMode?: number | null;
  archived?: boolean | null;
  locked?: boolean | null;
  autoArchiveDuration?: number | null;
  archiveTimestamp?: string | null;
  ownerId?: string | null;
  invitable?: boolean | null;
  memberCount?: number | null;
  messageCount?: number | null;
  totalMessageSent?: number | null;
  appliedTags?: string[];
  availableTags?: {
    id: string;
    name: string;
    emoji: DefaultReactionEmojiLike | null;
    moderated: boolean;
  }[];
  defaultReactionEmoji?: DefaultReactionEmojiLike | null;
  defaultSortOrder?: number | null;
  defaultForumLayout?: number;
  defaultAutoArchiveDuration?: number | null;
  permissionOverwrites?: SerializedOverwrite[];
}

function serializeOverwrite(value: unknown): SerializedOverwrite | null {
  if (value === null || typeof value !== "object") return null;
  const overwrite = value as PermissionOverwriteLike;
  if (typeof overwrite.id !== "string") return null;
  return {
    id: overwrite.id,
    type: overwrite.type ?? null,
    allow: serializePermissions(overwrite.allow),
    deny: serializePermissions(overwrite.deny),
  };
}

function serializeOverwriteList(
  cache: CacheLike | undefined,
): SerializedOverwrite[] | undefined {
  if (cache === undefined) return undefined;
  const out: SerializedOverwrite[] = [];
  for (const value of valuesOf(cache)) {
    const overwrite = serializeOverwrite(value);
    if (overwrite !== null) out.push(overwrite);
  }
  return out;
}

export function serializeChannel(channel: ChannelLike): SerializedChannel {
  const overwrites = serializeOverwriteList(
    channel.permissionOverwrites?.cache,
  );
  return compact({
    id: channel.id,
    type: channel.type,
    name: channel.name ?? null,
    parentId: channel.parentId ?? null,
    // rawPosition is the API position; `position` is recomputed from the guild
    // channel cache (0 for a channel built outside a populated guild), and
    // threads have neither.
    position: channel.rawPosition ?? channel.position ?? null,
    createdAt: iso(channel.createdTimestamp) ?? null,
    topic: channel.topic,
    nsfw: channel.nsfw,
    rateLimitPerUser: channel.rateLimitPerUser,
    lastMessageId: channel.lastMessageId,
    bitrate: channel.bitrate,
    userLimit: channel.userLimit,
    rtcRegion: channel.rtcRegion,
    videoQualityMode: channel.videoQualityMode,
    archived: channel.archived,
    locked: channel.locked,
    autoArchiveDuration: channel.autoArchiveDuration,
    archiveTimestamp: iso(channel.archiveTimestamp),
    ownerId: channel.ownerId,
    invitable: channel.invitable,
    memberCount: channel.memberCount,
    messageCount: channel.messageCount,
    totalMessageSent: channel.totalMessageSent,
    appliedTags: channel.appliedTags ? [...channel.appliedTags] : undefined,
    availableTags: channel.availableTags?.map((tag) => ({
      id: tag.id,
      name: tag.name,
      // `{...}` — same rule as `role.tags`: never return a live library object.
      emoji: tag.emoji ? { ...tag.emoji } : null,
      moderated: tag.moderated ?? false,
    })),
    // `{...}` — see the note on `role.tags`. The ternary preserves absence:
    // a channel kind that has no such field must keep the key dropped
    // (`undefined`), `null` must stay "Discord says none".
    defaultReactionEmoji:
      channel.defaultReactionEmoji == null
        ? channel.defaultReactionEmoji
        : { ...channel.defaultReactionEmoji },
    defaultSortOrder: channel.defaultSortOrder,
    defaultForumLayout: channel.defaultForumLayout,
    defaultAutoArchiveDuration: channel.defaultAutoArchiveDuration,
    permissionOverwrites: overwrites,
  });
}

// ---------------------------------------------------------------------------
// guild
// ---------------------------------------------------------------------------

export interface GuildLike {
  id: string;
  name: string;
  description?: string | null;
  ownerId?: string;
  icon?: string | null;
  banner?: string | null;
  splash?: string | null;
  discoverySplash?: string | null;
  features?: readonly string[];
  vanityURLCode?: string | null;
  vanityURLUses?: number | null;
  verificationLevel?: number;
  mfaLevel?: number;
  nsfwLevel?: number;
  explicitContentFilter?: number;
  defaultMessageNotifications?: number;
  preferredLocale?: string;
  afkTimeout?: number;
  afkChannelId?: string | null;
  systemChannelId?: string | null;
  systemChannelFlags?: BitFieldSource;
  rulesChannelId?: string | null;
  publicUpdatesChannelId?: string | null;
  safetyAlertsChannelId?: string | null;
  widgetEnabled?: boolean | null;
  widgetChannelId?: string | null;
  premiumTier?: number;
  premiumSubscriptionCount?: number | null;
  premiumProgressBarEnabled?: boolean;
  memberCount?: number;
  available?: boolean;
  joinedTimestamp?: number;
  createdTimestamp?: number;
  approximateMemberCount?: number | null;
  approximatePresenceCount?: number | null;
  iconURL?(options?: unknown): string | null;
  bannerURL?(options?: unknown): string | null;
  splashURL?(options?: unknown): string | null;
  discoverySplashURL?(options?: unknown): string | null;
  channels?: { readonly cache: CacheLike };
  roles?: { readonly cache: CacheLike };
  emojis?: { readonly cache: CacheLike };
  stickers?: { readonly cache: CacheLike };
  presences?: { readonly cache: CacheLike };
}

/**
 * Settings overview behind `get_server` (plan §8.2). Channel/role lists stay
 * out — the tool maps the caches through `serializeChannel`/`serializeRole`,
 * because embedding them here would make every event payload huge.
 */
export interface SerializedGuild {
  id: string;
  name: string;
  description: string | null;
  ownerId: string | null;
  available: boolean | null;
  features: string[];
  icon: string | null;
  iconUrl: string | null;
  banner: string | null;
  bannerUrl: string | null;
  splash: string | null;
  splashUrl: string | null;
  discoverySplash: string | null;
  discoverySplashUrl: string | null;
  vanityURLCode: string | null;
  vanityURLUses: number | null;
  verificationLevel: number | null;
  mfaLevel: number | null;
  nsfwLevel: number | null;
  explicitContentFilter: number | null;
  defaultMessageNotifications: number | null;
  preferredLocale: string | null;
  afkTimeout: number | null;
  afkChannelId: string | null;
  systemChannelId: string | null;
  systemChannelFlags: string[];
  rulesChannelId: string | null;
  publicUpdatesChannelId: string | null;
  safetyAlertsChannelId: string | null;
  widgetEnabled: boolean | null;
  widgetChannelId: string | null;
  premiumTier: number | null;
  premiumSubscriptionCount: number | null;
  premiumProgressBarEnabled: boolean | null;
  memberCount: number | null;
  approximateMemberCount?: number | null;
  approximatePresenceCount?: number | null;
  onlineCount?: number;
  channelCount?: number;
  threadCount?: number;
  roleCount?: number;
  emojiCount?: number;
  stickerCount?: number;
  createdAt: string | null;
  joinedAt: string | null;
}

function onlineCountOf(
  manager: { readonly cache: CacheLike } | undefined,
): number | undefined {
  if (manager === undefined) return undefined;
  let online = 0;
  for (const value of valuesOf(manager.cache)) {
    const status = (value as { status?: unknown }).status;
    if (typeof status === "string" && status !== "offline") online += 1;
  }
  return online;
}

export function serializeGuild(guild: GuildLike): SerializedGuild {
  const channels = channelCounts(guild.channels);
  return {
    id: guild.id,
    name: guild.name,
    description: guild.description ?? null,
    ownerId: guild.ownerId ?? null,
    available: guild.available ?? null,
    features: guild.features ? [...guild.features] : [],
    icon: guild.icon ?? null,
    iconUrl: guild.iconURL?.() ?? null,
    banner: guild.banner ?? null,
    bannerUrl: guild.bannerURL?.() ?? null,
    splash: guild.splash ?? null,
    splashUrl: guild.splashURL?.() ?? null,
    discoverySplash: guild.discoverySplash ?? null,
    discoverySplashUrl: guild.discoverySplashURL?.() ?? null,
    vanityURLCode: guild.vanityURLCode ?? null,
    vanityURLUses: guild.vanityURLUses ?? null,
    verificationLevel: guild.verificationLevel ?? null,
    mfaLevel: guild.mfaLevel ?? null,
    nsfwLevel: guild.nsfwLevel ?? null,
    explicitContentFilter: guild.explicitContentFilter ?? null,
    defaultMessageNotifications: guild.defaultMessageNotifications ?? null,
    preferredLocale: guild.preferredLocale ?? null,
    afkTimeout: guild.afkTimeout ?? null,
    afkChannelId: guild.afkChannelId ?? null,
    systemChannelId: guild.systemChannelId ?? null,
    systemChannelFlags: serializeBitField(guild.systemChannelFlags),
    rulesChannelId: guild.rulesChannelId ?? null,
    publicUpdatesChannelId: guild.publicUpdatesChannelId ?? null,
    safetyAlertsChannelId: guild.safetyAlertsChannelId ?? null,
    widgetEnabled: guild.widgetEnabled ?? null,
    widgetChannelId: guild.widgetChannelId ?? null,
    premiumTier: guild.premiumTier ?? null,
    premiumSubscriptionCount: guild.premiumSubscriptionCount ?? null,
    premiumProgressBarEnabled: guild.premiumProgressBarEnabled ?? null,
    memberCount: guild.memberCount ?? null,
    // Approximate counts only exist when the guild was fetched with counts
    // (`?with_counts=true`); a gateway-delivered guild has no such field, so
    // these stay omitted rather than pretending to be null-ish facts.
    approximateMemberCount: guild.approximateMemberCount ?? null,
    approximatePresenceCount: guild.approximatePresenceCount ?? null,
    // Discord only pushes PRESENCE_UPDATE for non-offline transitions, so this
    // counts the presence *cache*, not a live roster: on a long-running session
    // it drifts upward and can disagree with `approximatePresenceCount` above.
    onlineCount: onlineCountOf(guild.presences),
    // Threads live in the same manager as channels — counting them separately
    // keeps `channelCount` meaning "postable channels" (plan §8.2).
    channelCount: channels.channels,
    threadCount: channels.threads,
    roleCount: cacheCount(guild.roles),
    emojiCount: cacheCount(guild.emojis),
    stickerCount: cacheCount(guild.stickers),
    createdAt: iso(guild.createdTimestamp) ?? null,
    joinedAt: iso(guild.joinedTimestamp) ?? null,
  };
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

export interface EmbedAuthorLike {
  name?: string;
  url?: string | null;
  iconURL?: string | null;
}

export interface EmbedFooterLike {
  text?: string;
  iconURL?: string | null;
}

export interface EmbedAssetLike {
  url?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface EmbedFieldLike {
  name?: string;
  value?: string;
  inline?: boolean;
}

export interface EmbedLike {
  title?: string | null;
  description?: string | null;
  url?: string | null;
  color?: number | null;
  hexColor?: string | null;
  timestamp?: string | null;
  author?: EmbedAuthorLike | null;
  footer?: EmbedFooterLike | null;
  image?: EmbedAssetLike | null;
  thumbnail?: EmbedAssetLike | null;
  video?: EmbedAssetLike | null;
  provider?: { name?: string; url?: string | null } | null;
  fields?: readonly EmbedFieldLike[];
}

export interface SerializedEmbed {
  title: string | null;
  description: string | null;
  url: string | null;
  color: number | null;
  hexColor: string | null;
  timestamp: string | null;
  author: { name: string; url: string | null; iconUrl: string | null } | null;
  footer: { text: string; iconUrl: string | null } | null;
  image: { url: string; width: number | null; height: number | null } | null;
  thumbnail: {
    url: string;
    width: number | null;
    height: number | null;
  } | null;
  video: { url: string; width: number | null; height: number | null } | null;
  provider: { name: string | null; url: string | null } | null;
  fields: { name: string; value: string; inline: boolean }[];
}

function serializeEmbedAsset(
  asset: EmbedAssetLike | null | undefined,
): SerializedEmbed["image"] {
  if (!asset) return null;
  return {
    url: asset.url ?? "",
    width: asset.width ?? null,
    height: asset.height ?? null,
  };
}

/** Embed summary — the raw APIEmbed is small, but its proxy URLs and null padding are not. */
export function serializeEmbed(embed: EmbedLike): SerializedEmbed {
  const author = embed.author;
  const footer = embed.footer;
  const provider = embed.provider;
  return {
    title: embed.title ?? null,
    description: embed.description ?? null,
    url: embed.url ?? null,
    color: embed.color ?? null,
    hexColor: embed.hexColor ?? toHexColor(embed.color),
    timestamp: iso(embed.timestamp) ?? null,
    author: author
      ? {
          name: author.name ?? "",
          url: author.url ?? null,
          iconUrl: author.iconURL ?? null,
        }
      : null,
    footer: footer
      ? { text: footer.text ?? "", iconUrl: footer.iconURL ?? null }
      : null,
    image: serializeEmbedAsset(embed.image),
    thumbnail: serializeEmbedAsset(embed.thumbnail),
    video: serializeEmbedAsset(embed.video),
    provider: provider
      ? { name: provider.name ?? null, url: provider.url ?? null }
      : null,
    fields: (embed.fields ?? []).map((field) => ({
      name: field.name ?? "",
      value: field.value ?? "",
      inline: field.inline ?? false,
    })),
  };
}

export interface AttachmentLike {
  id: string;
  name?: string;
  size?: number;
  url?: string;
  proxyURL?: string;
  contentType?: string | null;
  width?: number | null;
  height?: number | null;
  description?: string | null;
  ephemeral?: boolean;
  duration?: number | null;
}

export interface SerializedAttachment {
  id: string;
  filename: string | null;
  size: number | null;
  url: string | null;
  proxyUrl: string | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  description: string | null;
  ephemeral: boolean | null;
  duration: number | null;
}

export function serializeAttachment(
  attachment: AttachmentLike,
): SerializedAttachment {
  return {
    id: attachment.id,
    // discord.js calls it `name`; Discord's attachment object calls it `filename`.
    filename: attachment.name ?? null,
    size: attachment.size ?? null,
    url: attachment.url ?? null,
    proxyUrl: attachment.proxyURL ?? null,
    contentType: attachment.contentType ?? null,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    description: attachment.description ?? null,
    ephemeral: attachment.ephemeral ?? null,
    duration: attachment.duration ?? null,
  };
}

export interface PollAnswerLike {
  id?: number;
  text?: string | null;
  voteCount?: number;
}

export interface PollLike {
  question?: { text?: string | null } | null;
  answers?: CacheLike;
  expiresTimestamp?: number | null;
  allowMultiselect?: boolean;
  layoutType?: number;
  resultsFinalized?: boolean;
}

export interface SerializedPoll {
  question: string | null;
  answers: { id: number | null; text: string | null; votes: number | null }[];
  expiresAt: string | null;
  allowMultiselect: boolean | null;
  layoutType: number | null;
  finalized: boolean | null;
}

export function serializePoll(poll: PollLike): SerializedPoll {
  const answers = valuesOf(poll.answers).map((value) => {
    const answer = (value ?? {}) as PollAnswerLike;
    return {
      id: answer.id ?? null,
      text: answer.text ?? null,
      votes: answer.voteCount ?? null,
    };
  });
  return {
    question: poll.question?.text ?? null,
    answers,
    expiresAt: iso(poll.expiresTimestamp) ?? null,
    allowMultiselect: poll.allowMultiselect ?? null,
    layoutType: poll.layoutType ?? null,
    finalized: poll.resultsFinalized ?? null,
  };
}

export interface MessageMentionsLike {
  everyone?: boolean;
  users?: CacheLike;
  roles?: CacheLike;
  channels?: CacheLike;
  repliedUser?: UserLike | null;
}

export interface MessageLike {
  id: string;
  channelId: string;
  guildId?: string | null;
  type?: number | null;
  createdTimestamp?: number | null;
  editedTimestamp?: number | null;
  author?: UserLike | null;
  content?: string | null;
  pinned?: boolean | null;
  tts?: boolean | null;
  webhookId?: string | null;
  flags?: BitFieldSource;
  attachments?: CacheLike;
  embeds?: readonly EmbedLike[];
  mentions?: MessageMentionsLike;
  stickers?: CacheLike;
  reference?: {
    messageId?: string | null;
    channelId?: string;
    guildId?: string | null;
  } | null;
  poll?: PollLike | null;
}

/**
 * Trimmed message (plan §7.3). Everything Discord reports as `null` stays
 * `null` — that is how discord.js renders a partial (uncached) message too,
 * so a `messageDelete` payload never invents content it doesn't have.
 */
export interface SerializedMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  type: number | null;
  timestamp: string | null;
  editedTimestamp: string | null;
  author: SerializedUser | null;
  content: string | null;
  pinned: boolean | null;
  tts: boolean | null;
  webhookId: string | null;
  flags: string[];
  attachments: SerializedAttachment[];
  embeds: SerializedEmbed[];
  mentions: {
    everyone: boolean;
    users: string[];
    roles: string[];
    channels: string[];
    repliedUserId: string | null;
  };
  stickers: string[];
  reference: {
    messageId: string | null;
    channelId: string | null;
    guildId: string | null;
  } | null;
  poll: SerializedPoll | null;
}

export function serializeMessage(message: MessageLike): SerializedMessage {
  const mentions = message.mentions;
  const reference = message.reference;
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId ?? null,
    type: message.type ?? null,
    timestamp: iso(message.createdTimestamp) ?? null,
    editedTimestamp: iso(message.editedTimestamp) ?? null,
    author: message.author ? serializeUser(message.author) : null,
    content: message.content ?? null,
    pinned: message.pinned ?? null,
    tts: message.tts ?? null,
    webhookId: message.webhookId ?? null,
    flags: serializeBitField(message.flags),
    attachments: valuesOf(message.attachments).flatMap((value) => {
      const attachment = value as AttachmentLike | undefined;
      return attachment === undefined || typeof attachment.id !== "string"
        ? []
        : [serializeAttachment(attachment)];
    }),
    embeds: (message.embeds ?? []).map((embed) => serializeEmbed(embed)),
    mentions: {
      everyone: mentions?.everyone ?? false,
      users: idList(mentions?.users),
      roles: idList(mentions?.roles),
      channels: idList(mentions?.channels),
      repliedUserId: mentions?.repliedUser?.id ?? null,
    },
    stickers: idList(message.stickers),
    reference: reference
      ? {
          messageId: reference.messageId ?? null,
          channelId: reference.channelId ?? null,
          guildId: reference.guildId ?? null,
        }
      : null,
    poll: message.poll ? serializePoll(message.poll) : null,
  };
}

// ---------------------------------------------------------------------------
// voice state
// ---------------------------------------------------------------------------

export interface VoiceStateLike {
  /** discord.js names it `id`; it is the user's id. */
  id: string;
  channelId?: string | null;
  sessionId?: string | null;
  serverDeaf?: boolean | null;
  serverMute?: boolean | null;
  selfDeaf?: boolean | null;
  selfMute?: boolean | null;
  streaming?: boolean | null;
  selfVideo?: boolean | null;
  suppress?: boolean | null;
  requestToSpeakTimestamp?: number | string | null;
  member?: GuildMemberLike | null;
}

/** Full triple (plan §7.3) plus the flags `update_member` mutates. */
export interface SerializedVoiceState {
  userId: string;
  channelId: string | null;
  sessionId: string | null;
  serverDeaf: boolean | null;
  serverMute: boolean | null;
  selfDeaf: boolean | null;
  selfMute: boolean | null;
  streaming: boolean | null;
  selfVideo: boolean | null;
  suppress: boolean | null;
  requestToSpeakTimestamp: string | null;
  member: SerializedMember | null;
}

export function serializeVoiceState(
  state: VoiceStateLike,
): SerializedVoiceState {
  return {
    userId: state.id,
    channelId: state.channelId ?? null,
    sessionId: state.sessionId ?? null,
    serverDeaf: state.serverDeaf ?? null,
    serverMute: state.serverMute ?? null,
    selfDeaf: state.selfDeaf ?? null,
    selfMute: state.selfMute ?? null,
    streaming: state.streaming ?? null,
    selfVideo: state.selfVideo ?? null,
    suppress: state.suppress ?? null,
    requestToSpeakTimestamp: iso(state.requestToSpeakTimestamp) ?? null,
    member: state.member ? serializeMember(state.member) : null,
  };
}

// ---------------------------------------------------------------------------
// expressions, invites, webhooks, bans
// ---------------------------------------------------------------------------

export interface EmojiLike {
  id?: string | null;
  name?: string | null;
  animated?: boolean | null;
  available?: boolean | null;
  managed?: boolean | null;
  /** discord.js spells it `requiresColons`; Discord's API spells it `require_colons`. */
  requiresColons?: boolean | null;
  roles?: { readonly cache: CacheLike };
  createdTimestamp?: number | null;
  imageURL?(options?: unknown): string | null;
}

export interface SerializedEmoji {
  id: string | null;
  name: string | null;
  animated: boolean | null;
  available: boolean | null;
  managed: boolean | null;
  requireColons: boolean | null;
  roles: string[];
  url: string | null;
  createdAt: string | null;
}

export function serializeEmoji(emoji: EmojiLike): SerializedEmoji {
  return {
    id: emoji.id ?? null,
    name: emoji.name ?? null,
    animated: emoji.animated ?? null,
    available: emoji.available ?? null,
    managed: emoji.managed ?? null,
    requireColons: emoji.requiresColons ?? null,
    roles: idList(emoji.roles?.cache),
    // `.url` is deprecated (and warns at runtime); imageURL() is the supported path.
    url: emoji.imageURL?.() ?? null,
    createdAt: iso(emoji.createdTimestamp) ?? null,
  };
}

export interface InviteLike {
  code: string;
  url?: string;
  guild?: { id?: string; name?: string } | null;
  channel?: { id?: string; name?: string | null; type?: number } | null;
  channelId?: string | null;
  inviter?: UserLike | null;
  inviterId?: string | null;
  maxAge?: number | null;
  maxUses?: number | null;
  uses?: number | null;
  temporary?: boolean | null;
  targetType?: number | null;
  targetUser?: UserLike | null;
  targetApplication?: { id?: string } | null;
  expiresAt?: Date | string | null;
  memberCount?: number | null;
  presenceCount?: number | null;
  type?: number;
  createdTimestamp?: number | null;
}

export interface SerializedInvite {
  code: string;
  url: string | null;
  guildId: string | null;
  guildName: string | null;
  channelId: string | null;
  channel: { id: string; name: string | null; type: number | null } | null;
  inviter: SerializedUser | null;
  inviterId: string | null;
  maxAge: number | null;
  maxUses: number | null;
  uses: number | null;
  temporary: boolean | null;
  type: number | null;
  targetType: number | null;
  targetUserId: string | null;
  targetApplicationId: string | null;
  expiresAt: string | null;
  memberCount: number | null;
  presenceCount: number | null;
  createdAt: string | null;
}

export function serializeInvite(invite: InviteLike): SerializedInvite {
  const channel = invite.channel;
  return {
    code: invite.code,
    url:
      invite.url ?? (invite.code ? `https://discord.gg/${invite.code}` : null),
    guildId: invite.guild?.id ?? null,
    guildName: invite.guild?.name ?? null,
    channelId: invite.channelId ?? channel?.id ?? null,
    channel: channel?.id
      ? {
          id: channel.id,
          name: channel.name ?? null,
          type: channel.type ?? null,
        }
      : null,
    inviter: invite.inviter ? serializeUser(invite.inviter) : null,
    inviterId: invite.inviterId ?? invite.inviter?.id ?? null,
    maxAge: invite.maxAge ?? null,
    maxUses: invite.maxUses ?? null,
    uses: invite.uses ?? null,
    temporary: invite.temporary ?? null,
    type: invite.type ?? null,
    targetType: invite.targetType ?? null,
    targetUserId: invite.targetUser?.id ?? null,
    targetApplicationId: invite.targetApplication?.id ?? null,
    expiresAt: iso(invite.expiresAt) ?? null,
    memberCount: invite.memberCount ?? null,
    presenceCount: invite.presenceCount ?? null,
    createdAt: iso(invite.createdTimestamp) ?? null,
  };
}

export interface WebhookLike {
  id: string;
  name?: string | null;
  type?: number;
  channelId?: string;
  guildId?: string | null;
  applicationId?: string | null;
  avatar?: string | null;
  owner?: UserLike | null;
  createdTimestamp?: number | null;
  avatarURL?(options?: unknown): string | null;
}

/**
 * Webhook WITHOUT its two secrets: `token` is the credential and `url` embeds
 * the token in the path, so emitting either one hands over webhook control.
 * `manage_webhook` adds the token back only when Warden holds
 * MANAGE_WEBHOOKS (plan §8.9).
 */
export interface SerializedWebhook {
  id: string;
  name: string | null;
  type: number | null;
  channelId: string | null;
  guildId: string | null;
  applicationId: string | null;
  avatar: string | null;
  avatarUrl: string | null;
  owner: SerializedUser | null;
  createdAt: string | null;
}

export function serializeWebhook(webhook: WebhookLike): SerializedWebhook {
  return {
    id: webhook.id,
    name: webhook.name ?? null,
    type: webhook.type ?? null,
    channelId: webhook.channelId ?? null,
    guildId: webhook.guildId ?? null,
    applicationId: webhook.applicationId ?? null,
    avatar: webhook.avatar ?? null,
    avatarUrl: webhook.avatarURL?.() ?? null,
    owner: webhook.owner ? serializeUser(webhook.owner) : null,
    createdAt: iso(webhook.createdTimestamp) ?? null,
  };
}

export interface BanLike {
  user?: UserLike | null;
  reason?: string | null;
  guild?: { id?: string } | null;
}

export interface SerializedBan {
  user: SerializedUser | null;
  reason: string | null;
  guildId: string | null;
}

export function serializeBan(ban: BanLike): SerializedBan {
  return {
    user: ban.user ? serializeUser(ban.user) : null,
    reason: ban.reason ?? null,
    guildId: ban.guild?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// presences
// ---------------------------------------------------------------------------

export interface ActivityLike {
  name?: string;
  type?: number;
  state?: string | null;
  details?: string | null;
  url?: string | null;
  applicationId?: string | null;
  timestamps?: {
    start?: Date | number | null;
    end?: Date | number | null;
  } | null;
  emoji?: {
    id?: string | null;
    name?: string | null;
    animated?: boolean | null;
  } | null;
}

export interface SerializedActivity {
  name: string | null;
  type: number | null;
  state: string | null;
  details: string | null;
  url: string | null;
  applicationId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  emoji: {
    id: string | null;
    name: string | null;
    animated: boolean | null;
  } | null;
}

export function serializeActivity(activity: ActivityLike): SerializedActivity {
  const emoji = activity.emoji;
  const timestamps = activity.timestamps;
  return {
    name: activity.name ?? null,
    type: activity.type ?? null,
    state: activity.state ?? null,
    details: activity.details ?? null,
    url: activity.url ?? null,
    applicationId: activity.applicationId ?? null,
    startedAt: iso(timestamps?.start) ?? null,
    endedAt: iso(timestamps?.end) ?? null,
    emoji: emoji
      ? {
          id: emoji.id ?? null,
          name: emoji.name ?? null,
          animated: emoji.animated ?? null,
        }
      : null,
  };
}

export interface PresenceLike {
  userId?: string;
  status?: string;
  guild?: { id?: string } | null;
  user?: UserLike | null;
  clientStatus?: { web?: string; mobile?: string; desktop?: string } | null;
  activities?: CacheLike;
}

export interface SerializedPresence {
  userId: string | null;
  guildId: string | null;
  status: string | null;
  user: SerializedUser | null;
  clientStatus: { web?: string; mobile?: string; desktop?: string } | null;
  activities: SerializedActivity[];
}

export function serializePresence(presence: PresenceLike): SerializedPresence {
  return {
    userId: presence.userId ?? null,
    guildId: presence.guild?.id ?? null,
    status: presence.status ?? null,
    user: presence.user ? serializeUser(presence.user) : null,
    // `{...}` — see the note on `role.tags`: never return a live library object.
    clientStatus: presence.clientStatus ? { ...presence.clientStatus } : null,
    activities: valuesOf(presence.activities).map((value) =>
      serializeActivity((value ?? {}) as ActivityLike),
    ),
  };
}
