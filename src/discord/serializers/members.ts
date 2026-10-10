/**
 * Users, members and roles (plan §7.3).
 *
 * These are the identity and hierarchy shapes, and `members.ts` is the only
 * entity module the others import: a message has an author, an invite has an
 * inviter, a presence has a user. Grouping all three here is what keeps the
 * remaining modules from needing to import each other.
 */

import { iso, toHexColor } from "./internal.js";
import type { BitFieldSource, CacheLike } from "./shared.js";
import { idList, serializeBitField, serializePermissions } from "./shared.js";

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
