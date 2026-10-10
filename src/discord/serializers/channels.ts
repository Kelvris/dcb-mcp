/**
 * Channels, with the structures scoped to them: permission overwrites, forum
 * tags and default reaction emoji.
 */

import { iso, valuesOf } from "./internal.js";
import type { BitFieldSource, CacheLike } from "./shared.js";
import { compact, serializePermissions } from "./shared.js";

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
