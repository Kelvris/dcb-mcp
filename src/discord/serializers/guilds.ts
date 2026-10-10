/**
 * The guild and everything scoped to it: expressions (emoji), invites,
 * webhooks and bans.
 *
 * Webhooks are scrubbed here rather than left to the caller — `token` and
 * `url` are omitted, and the URL would be just as bad because it embeds the
 * token.
 */

import { cacheCount, channelCounts, iso, valuesOf } from "./internal.js";
import type { SerializedUser, UserLike } from "./members.js";
import { serializeUser } from "./members.js";
import type { BitFieldSource, CacheLike } from "./shared.js";
import { idList, serializeBitField } from "./shared.js";

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
