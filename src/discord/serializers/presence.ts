/**
 * Live member state: presences, activities and voice states.
 *
 * Grouped because all three answer the same question — what is this member
 * doing *right now*, as opposed to what they are. A voice state keeps its
 * full triple, since that is exactly what voice tools act on.
 */

import { iso, valuesOf } from "./internal.js";
import type {
  GuildMemberLike,
  SerializedMember,
  SerializedUser,
  UserLike,
} from "./members.js";
import { serializeMember, serializeUser } from "./members.js";
import type { CacheLike } from "./shared.js";

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
