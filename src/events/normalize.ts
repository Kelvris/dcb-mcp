/**
 * Gateway event → normalized draft (plan §7.2–§7.3).
 *
 * ## How capture works
 *
 * discord.js parses most gateway events and re-emits them under camelCase
 * names with typed payloads (`messageCreate`, `guildMemberAdd`, …) — those
 * are the table keys, and their extractors feed the entity serializers from
 * `discord/serializers/`, which is what keeps payloads to the curated size
 * §7.3 asks for.
 *
 * Eight events in §7.2's inventory are **not** emitted by discord.js 14
 * (`applicationCommandCreate/Update/Delete`, `integrationCreate/Update/Delete`,
 * `voiceChannelStatusUpdate`, `voiceChannelStartTimeUpdate`). Those specs
 * carry a `wire` name and are captured from discord.js' `raw` dispatch
 * instead — see `events/index.ts` — so the inventory is complete rather than
 * "complete except the events the library ignores".
 *
 * ## Why defensive extraction
 *
 * Several events hand back partials (an uncached `messageDelete`, a member
 * leave with a stripped thread member). Plan §7.4's rule applies: an event is
 * "id + whatever Discord gave us" — every extractor reads optional fields
 * with `?? null`/`str()` and never assumes presence beyond the id. A shape
 * that still throws is caught at the dispatch layer (`events/index.ts`) and
 * logged, never crashing the pipeline.
 *
 * ## Canonical type names
 *
 * `type` is the discord.js name by default (which equals the wire name
 * lower-camel-cased for most events), with the five wire/library divergences
 * (`GUILD_ROLE_CREATE` → `roleCreate`, …) resolved through {@link WIRE_ALIASES},
 * and two meta renames (`READY` → `ready`, `RESUMED` → `resumed`).
 * {@link canonicalType} accepts either spelling, so filters read naturally
 * whichever way the operator copies the name (§7.2's closing note).
 */

import type { WardenError } from "../discord/errors.js";
import {
  serializeBan,
  serializeChannel,
  serializeEmoji,
  serializeGuild,
  serializeInvite,
  serializeMember,
  serializeMessage,
  serializePresence,
  serializeRole,
  serializeUser,
  serializeVoiceState,
} from "../discord/serializers/index.js";
import type {
  BanLike,
  ChannelLike,
  EmojiLike,
  GuildLike,
  GuildMemberLike,
  InviteLike,
  MessageLike,
  PresenceLike,
  RoleLike,
  UserLike,
  VoiceStateLike,
} from "../discord/serializers/index.js";
import { fail } from "../shared/result.js";
import type { EventDraft, EventFilter } from "./types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Non-empty string, else `null` (ids and names Discord may omit). */
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isoFromMs(ms: number | null | undefined): string | null {
  return ms !== null && ms !== undefined && Number.isFinite(ms)
    ? new Date(ms).toISOString()
    : null;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function safeJson(value: unknown): string | null {
  try {
    const json: unknown = JSON.stringify(value);
    return typeof json === "string" ? json : null;
  } catch {
    // Cyclic or exotic values — drop rather than lose the whole event.
    return null;
  }
}

function plain(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? ({ ...value } as Record<string, unknown>)
    : null;
}

/** `{id, name}` of an emoji-ish, else `null`. */
function emojiRef(value: unknown): { id: string | null; name: string | null } | null {
  if (typeof value !== "object" || value === null) return null;
  const ref = value as { id?: unknown; name?: unknown };
  const id = str(ref.id);
  const name = str(ref.name);
  return id === null && name === null ? null : { id, name };
}

/**
 * A soundboard sound id is a snowflake string *or* a plain number (built-in
 * sounds) — discord.js types it `Snowflake | number | null`, so both are
 * carried as-is rather than one being coerced to `null`.
 */
function soundIdOf(value: unknown): string | number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : str(value);
}

// ---------------------------------------------------------------------------
// local shapes — the fields each hand-rolled extractor reads. Only the
// serializer-fed events borrow their structural types from the serializers;
// the rest are declared here with `unknown` fields so fixtures and discord.js
// objects both fit and every read goes through the coercions above.
// ---------------------------------------------------------------------------

interface StageInstanceShape {
  id?: unknown;
  guildId?: unknown;
  channelId?: unknown;
  topic?: unknown;
  privacyLevel?: unknown;
  guildScheduledEventId?: unknown;
}

interface ScheduledEventShape {
  id?: unknown;
  guildId?: unknown;
  channelId?: unknown;
  creatorId?: unknown;
  name?: unknown;
  description?: unknown;
  scheduledStartTimestamp?: unknown;
  scheduledEndTimestamp?: unknown;
  status?: unknown;
  entityType?: unknown;
  userCount?: unknown;
  entityMetadata?: { location?: unknown } | null;
}

interface AuditChangeShape {
  key?: unknown;
  type?: unknown;
  oldValue?: unknown;
  newValue?: unknown;
}

interface AuditEntryShape {
  id?: unknown;
  action?: unknown;
  actionType?: unknown;
  reason?: unknown;
  executorId?: unknown;
  executor?: { id?: unknown } | null;
  targetId?: unknown;
  target?: { id?: unknown } | null;
  targetType?: unknown;
  changes?: readonly AuditChangeShape[] | null;
}

interface AutomodActionShape {
  type?: unknown;
  metadata?: unknown;
}

interface AutomodRuleShape {
  id?: unknown;
  name?: unknown;
  enabled?: unknown;
  triggerType?: unknown;
  eventType?: unknown;
  actions?: readonly AutomodActionShape[] | null;
  guild?: { id?: unknown } | null;
}

interface AutomodExecutionShape {
  ruleId?: unknown;
  ruleTriggerType?: unknown;
  action?: AutomodActionShape | null;
  userId?: unknown;
  channelId?: unknown;
  guildId?: unknown;
  messageId?: unknown;
  alertSystemMessageId?: unknown;
  content?: unknown;
  matchedKeyword?: unknown;
  matchedContent?: unknown;
}

interface InteractionShape {
  id?: unknown;
  type?: unknown;
  applicationId?: unknown;
  guildId?: unknown;
  channelId?: unknown;
  user?: { id?: unknown } | null;
  commandName?: unknown;
  customId?: unknown;
  componentType?: unknown;
}

interface TypingShape {
  channel?: { id?: unknown; guildId?: unknown } | null;
  user?: { id?: unknown } | null;
  guild?: { id?: unknown } | null;
  startedAt?: unknown;
  startedTimestamp?: unknown;
}

interface SoundShape {
  soundId?: unknown;
  name?: unknown;
  volume?: unknown;
  available?: unknown;
  guildId?: unknown;
  emoji?: unknown;
}

interface StickerShape {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  tags?: unknown;
  format?: unknown;
  available?: unknown;
  guildId?: unknown;
}

interface EffectShape {
  guild?: { id?: unknown } | null;
  channelId?: unknown;
  userId?: unknown;
  emoji?: unknown;
  animationType?: unknown;
  animationId?: unknown;
  soundId?: unknown;
  soundVolume?: unknown;
}

interface PollAnswerShape {
  id?: unknown;
  text?: unknown;
  poll?: {
    messageId?: unknown;
    channelId?: unknown;
    channel?: { guildId?: unknown } | null;
  } | null;
  messageId?: unknown;
  emoji?: unknown;
}

interface ThreadShape {
  id?: unknown;
  guildId?: unknown;
  guild?: { id?: unknown } | null;
}

interface ThreadMemberShape {
  id?: unknown;
  thread?: ThreadShape | null;
  joinedTimestamp?: unknown;
  flags?: unknown;
}

interface ReactionShape {
  message?: (ThreadShape & MessageLike) | null;
  messageId?: unknown;
  emoji?: unknown;
  count?: unknown;
}

interface UserShape {
  id?: unknown;
}

interface GuildShape {
  id?: unknown;
  name?: unknown;
  unavailable?: unknown;
}

interface RawPayload {
  id?: unknown;
  guild_id?: unknown;
  application_id?: unknown;
  name?: unknown;
  description?: unknown;
  type?: unknown;
  version?: unknown;
  status?: unknown;
  enabled?: unknown;
  voice_start_time?: unknown;
}

// ---------------------------------------------------------------------------
// spec table
// ---------------------------------------------------------------------------

/**
 * One entry per §7.2 event. `extract` receives the listener's argument tuple
 * (or the raw dispatch payload `d` for `wire` specs) and must not throw for
 * partial input — but when it does, dispatch catches and logs it.
 */
export interface EventSpec {
  /** Canonical type; defaults to the table key. */
  type?: string;
  /** Wire name — set only for events captured from `raw` (no discord.js listener). */
  wire?: string;
  extract(args: readonly unknown[]): EventDraft;
}

/** Wire names whose discord.js listener differs from the camel-cased wire form. */
const WIRE_ALIASES: Readonly<Record<string, string>> = {
  GUILD_ROLE_CREATE: "roleCreate",
  GUILD_ROLE_UPDATE: "roleUpdate",
  GUILD_ROLE_DELETE: "roleDelete",
  GUILD_EMOJIS_UPDATE: "emojiUpdate",
  GUILD_STICKERS_UPDATE: "stickerUpdate",
};

/**
 * `MESSAGE_DELETE_BULK` → `messageDeleteBulk`, `READY` → `ready`: lower-case
 * each segment, keep the first segment lower-case.
 */
function toCamel(wire: string): string {
  const parts = wire
    .toLowerCase()
    .split("_")
    .filter((part) => part.length > 0);
  return parts
    .map((part, index) =>
      index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
}

// --- shared draft builders -------------------------------------------------

function messageDraft(message: unknown, type: string): EventDraft {
  const m = message as Partial<MessageLike> | null | undefined;
  return {
    type,
    guildId: m?.guildId ?? null,
    channelId: m?.channelId ?? null,
    authorId: m?.author?.id ?? null,
    messageId: m?.id ?? null,
    data: { ...serializeMessage(m as MessageLike) },
  };
}

function memberDraft(member: unknown, type: string): EventDraft {
  const m = member as Partial<GuildMemberLike> & { guild?: { id?: string } } | null | undefined;
  return {
    type,
    guildId: m?.guild?.id ?? null,
    channelId: null,
    authorId: null,
    targetId: m?.id ?? null,
    data: { ...serializeMember(m as GuildMemberLike) },
  };
}

function roleDraft(role: unknown, type: string): EventDraft {
  const r = role as Partial<RoleLike> & { guild?: { id?: string } } | null | undefined;
  return {
    type,
    guildId: r?.guild?.id ?? null,
    channelId: null,
    authorId: null,
    targetId: r?.id ?? null,
    data: { ...serializeRole(r as RoleLike) },
  };
}

function channelDraft(
  channel: unknown,
  type: string,
  extra: Record<string, unknown> = {},
): EventDraft {
  const c = channel as Partial<ChannelLike> & { guildId?: unknown } | null | undefined;
  // No `targetId` here: the channel is the event's subject *and* already
  // reachable as `channelId`, and `targetId` stays reserved for subjects
  // that no other field names (see types.ts).
  return {
    type,
    guildId: str(c?.guildId),
    channelId: str(c?.id),
    authorId: null,
    data: { ...serializeChannel(c as ChannelLike), ...extra },
  };
}

function soundDraft(sound: unknown): Record<string, unknown> {
  const s = sound as SoundShape | null | undefined;
  return {
    soundId: soundIdOf(s?.soundId),
    name: str(s?.name),
    volume: num(s?.volume),
    available: bool(s?.available),
    emoji: emojiRef(s?.emoji),
  };
}

function scheduledEventDraft(
  event: unknown,
  type: string,
  extra: Record<string, unknown> = {},
): EventDraft {
  const e = event as ScheduledEventShape | null | undefined;
  return {
    type,
    guildId: str(e?.guildId),
    channelId: str(e?.channelId),
    authorId: str(e?.creatorId),
    targetId: str(e?.id),
    data: {
      id: str(e?.id),
      name: str(e?.name),
      description: str(e?.description),
      status: e?.status ?? null,
      entityType: e?.entityType ?? null,
      scheduledStartAt: isoFromMs(num(e?.scheduledStartTimestamp)),
      scheduledEndAt: isoFromMs(num(e?.scheduledEndTimestamp)),
      userCount: num(e?.userCount),
      creatorId: str(e?.creatorId),
      location: str(e?.entityMetadata?.location),
      ...extra,
    },
  };
}

function automodRuleDraft(rule: unknown, type: string): EventDraft {
  const r = rule as AutomodRuleShape | null | undefined;
  return {
    type,
    // discord.js passes only the rule; the guild is reachable as `rule.guild`
    // — without it the whole AUTO_MODERATION_CONFIGURATION family would be
    // invisible to `filter.guild_id`.
    guildId: str(r?.guild?.id),
    channelId: null,
    authorId: null,
    targetId: str(r?.id),
    data: {
      id: str(r?.id),
      name: str(r?.name),
      enabled: bool(r?.enabled),
      triggerType: r?.triggerType ?? null,
      eventType: r?.eventType ?? null,
      actions: (r?.actions ?? []).map((action) => ({
        type: num(action?.type),
        metadata: plain(action?.metadata),
      })),
    },
  };
}

// --- the table -------------------------------------------------------------

/**
 * Keyed by the discord.js listener name — the canonical `type` — except for
 * the eight `wire` specs, whose key is the camel-cased wire name (which is
 * also their canonical type, so filters work identically either way).
 */
export const EVENT_SPECS: Readonly<Record<string, EventSpec>> = {
  // --- Meta (plan §7.2) ----------------------------------------------------
  clientReady: {
    type: "ready",
    extract: ([client]) => {
      const c = client as {
        user?: UserLike | null;
        guilds?: { cache?: { size?: number } };
      };
      return {
        type: "ready",
        guildId: null,
        channelId: null,
        authorId: null,
        data: {
          user: c.user ? { ...serializeUser(c.user) } : null,
          guildCount: num(c.guilds?.cache?.size),
        },
      };
    },
  },
  shardResume: {
    type: "resumed",
    extract: ([shardId, replayed]) => ({
      type: "resumed",
      guildId: null,
      channelId: null,
      authorId: null,
      data: { shardId: num(shardId), replayedEvents: num(replayed) },
    }),
  },
  interactionCreate: {
    // Observed only (plan §7.2): the interaction **token** is deliberately
    // absent — Warden never responds to interactions, and a token in the
    // buffer would be exactly the secret-shaped string §4 forbids leaving.
    extract: ([interaction]) => {
      const i = interaction as InteractionShape | null | undefined;
      const authorId = str(i?.user?.id);
      return {
        type: "interactionCreate",
        guildId: str(i?.guildId),
        channelId: str(i?.channelId),
        authorId,
        data: {
          id: str(i?.id),
          type: num(i?.type),
          applicationId: str(i?.applicationId),
          guildId: str(i?.guildId),
          channelId: str(i?.channelId),
          userId: authorId,
          commandName: str(i?.commandName),
          customId: str(i?.customId),
          componentType: num(i?.componentType),
        },
      };
    },
  },
  applicationCommandCreate: {
    wire: "APPLICATION_COMMAND_CREATE",
    extract: ([raw]) => applicationCommandDraft(raw, "applicationCommandCreate"),
  },
  applicationCommandUpdate: {
    wire: "APPLICATION_COMMAND_UPDATE",
    extract: ([raw]) => applicationCommandDraft(raw, "applicationCommandUpdate"),
  },
  applicationCommandDelete: {
    wire: "APPLICATION_COMMAND_DELETE",
    extract: ([raw]) => applicationCommandDraft(raw, "applicationCommandDelete"),
  },

  // --- GUILDS (plan §7.2) --------------------------------------------------
  guildCreate: {
    extract: ([guild]) => ({
      type: "guildCreate",
      guildId: str((guild as GuildShape)?.id),
      channelId: null,
      authorId: null,
      data: { ...serializeGuild(guild as GuildLike) },
    }),
  },
  guildUpdate: {
    extract: ([, guild]) => ({
      type: "guildUpdate",
      guildId: str((guild as GuildShape)?.id),
      channelId: null,
      authorId: null,
      data: { ...serializeGuild(guild as GuildLike) },
    }),
  },
  guildDelete: {
    // An outage delivers an unavailable stub; a kick delivers the full guild.
    // Only the fields both cases (may) have are read — §7.4's partial rule.
    // Deliberately *not* serializeGuild: its key set would shrink to nulls on
    // a stub, reading as "the guild's fields were dropped" rather than "this
    // payload is intentionally minimal".
    extract: ([guild]) => {
      const g = guild as GuildShape | null | undefined;
      const id = str(g?.id);
      return {
        type: "guildDelete",
        guildId: id,
        channelId: null,
        authorId: null,
        data: { id, name: str(g?.name), unavailable: bool(g?.unavailable) },
      };
    },
  },
  roleCreate: {
    extract: ([role]) => roleDraft(role, "roleCreate"),
  },
  roleUpdate: {
    extract: ([, role]) => roleDraft(role, "roleUpdate"),
  },
  roleDelete: {
    extract: ([role]) => roleDraft(role, "roleDelete"),
  },
  channelCreate: {
    extract: ([channel]) => channelDraft(channel, "channelCreate"),
  },
  channelUpdate: {
    extract: ([, channel]) => channelDraft(channel, "channelUpdate"),
  },
  channelDelete: {
    extract: ([channel]) => channelDraft(channel, "channelDelete"),
  },
  channelPinsUpdate: {
    extract: ([channel, date]) => {
      const c = channel as Partial<ChannelLike> & { guildId?: unknown };
      return {
        type: "channelPinsUpdate",
        guildId: str(c.guildId),
        channelId: str(c.id),
        authorId: null,
        data: {
          channelId: str(c.id),
          lastPinAt: date instanceof Date && !Number.isNaN(date.valueOf())
            ? date.toISOString()
            : null,
        },
      };
    },
  },
  threadCreate: {
    extract: ([thread, newlyCreated]) =>
      channelDraft(thread, "threadCreate", { newlyCreated: bool(newlyCreated) }),
  },
  threadUpdate: {
    extract: ([, thread]) => channelDraft(thread, "threadUpdate"),
  },
  threadDelete: {
    extract: ([thread]) => channelDraft(thread, "threadDelete"),
  },
  threadListSync: {
    extract: ([threads, guild]) => {
      const ids = keysOf(threads);
      return {
        type: "threadListSync",
        guildId: str((guild as GuildShape)?.id),
        channelId: null,
        authorId: null,
        data: { threadIds: ids, count: ids.length },
      };
    },
  },
  threadMemberUpdate: {
    extract: ([, member]) => {
      const m = member as ThreadMemberShape | null | undefined;
      return {
        type: "threadMemberUpdate",
        guildId: str(m?.thread?.guildId ?? m?.thread?.guild?.id),
        channelId: str(m?.thread?.id),
        authorId: null,
        targetId: str(m?.id),
        data: {
          threadId: str(m?.thread?.id),
          userId: str(m?.id),
          joinedAt: isoFromMs(num(m?.joinedTimestamp)),
          flags: num(m?.flags),
        },
      };
    },
  },
  threadMembersUpdate: {
    extract: ([added, removed, thread]) => {
      const t = thread as ThreadShape | null | undefined;
      const addedList = mapValues(added, (member) => {
        const m = member as ThreadMemberShape;
        return {
          userId: str(m?.id),
          joinedAt: isoFromMs(num(m?.joinedTimestamp)),
        };
      });
      const removedIds = mapValues(removed, (member) =>
        str((member as ThreadMemberShape)?.id),
      );
      return {
        type: "threadMembersUpdate",
        guildId: str(t?.guildId ?? t?.guild?.id),
        channelId: str(t?.id),
        authorId: null,
        data: {
          threadId: str(t?.id),
          added: addedList,
          removed: removedIds,
          addedCount: addedList.length,
          removedCount: removedIds.length,
        },
      };
    },
  },
  stageInstanceCreate: {
    extract: ([stage]) => stageDraft(stage, "stageInstanceCreate"),
  },
  stageInstanceUpdate: {
    extract: ([, stage]) => stageDraft(stage, "stageInstanceUpdate"),
  },
  stageInstanceDelete: {
    extract: ([stage]) => stageDraft(stage, "stageInstanceDelete"),
  },
  voiceChannelStatusUpdate: {
    wire: "VOICE_CHANNEL_STATUS_UPDATE",
    extract: ([raw]) => {
      const p = (raw ?? {}) as RawPayload;
      const channelId = str(p.id);
      return {
        type: "voiceChannelStatusUpdate",
        guildId: str(p.guild_id),
        channelId,
        authorId: null,
        data: { channelId, status: str(p.status) },
      };
    },
  },
  voiceChannelStartTimeUpdate: {
    wire: "VOICE_CHANNEL_START_TIME_UPDATE",
    extract: ([raw]) => {
      const p = (raw ?? {}) as RawPayload & { voice_start_time?: unknown };
      const channelId = str(p.id);
      const seconds = num(p.voice_start_time);
      return {
        type: "voiceChannelStartTimeUpdate",
        guildId: str(p.guild_id),
        channelId,
        authorId: null,
        data: {
          channelId,
          startedAt: seconds === null ? null : isoFromMs(seconds * 1000),
        },
      };
    },
  },

  // --- GUILD_MEMBERS (plan §7.2) ------------------------------------------
  guildMemberAdd: {
    extract: ([member]) => memberDraft(member, "guildMemberAdd"),
  },
  guildMemberUpdate: {
    extract: ([, member]) => memberDraft(member, "guildMemberUpdate"),
  },
  guildMemberRemove: {
    extract: ([member]) => memberDraft(member, "guildMemberRemove"),
  },

  // --- GUILD_MODERATION (plan §7.2) ---------------------------------------
  guildAuditLogEntryCreate: {
    extract: ([entry, guild]) => {
      const e = entry as AuditEntryShape | null | undefined;
      const executorId = str(e?.executorId) ?? str(e?.executor?.id);
      const targetId = str(e?.targetId) ?? str(e?.target?.id);
      return {
        type: "guildAuditLogEntryCreate",
        guildId: str((guild as GuildShape)?.id),
        channelId: null,
        authorId: executorId,
        targetId,
        data: {
          id: str(e?.id),
          action: num(e?.action),
          actionType: str(e?.actionType),
          reason: cut(str(e?.reason) ?? "", 512) || null,
          executorId,
          targetId,
          targetType: str(e?.targetType),
          // `changes` is the diff; the full entry (including `extra` payloads
          // like prune counts) stays a REST concern — get_audit_log, §7.4.
          changes: (e?.changes ?? []).slice(0, AUDIT_CHANGE_LIMIT).map((change) => ({
            key: str(change?.key),
            type: str(change?.type),
            oldValue: cutValue(change?.oldValue),
            newValue: cutValue(change?.newValue),
          })),
          changesTruncated: (e?.changes?.length ?? 0) > AUDIT_CHANGE_LIMIT,
        },
      };
    },
  },
  guildBanAdd: {
    extract: ([ban]) => banDraft(ban, "guildBanAdd"),
  },
  guildBanRemove: {
    extract: ([ban]) => banDraft(ban, "guildBanRemove"),
  },

  // --- GUILD_EXPRESSIONS (plan §7.2) --------------------------------------
  emojiUpdate: {
    extract: ([, emoji]) => expressionDraft(emoji, "emojiUpdate", "emoji"),
  },
  stickerUpdate: {
    extract: ([, sticker]) => {
      const s = sticker as StickerShape | null | undefined;
      return {
        type: "stickerUpdate",
        guildId: str(s?.guildId),
        channelId: null,
        authorId: null,
        targetId: str(s?.id),
        data: {
          id: str(s?.id),
          name: str(s?.name),
          description: str(s?.description),
          tags: str(s?.tags),
          format: s?.format ?? null,
          available: bool(s?.available),
        },
      };
    },
  },
  guildSoundboardSoundCreate: {
    extract: ([sound]) => soundDraftEvent(sound, "guildSoundboardSoundCreate"),
  },
  guildSoundboardSoundUpdate: {
    extract: ([, sound]) => soundDraftEvent(sound, "guildSoundboardSoundUpdate"),
  },
  guildSoundboardSoundDelete: {
    extract: ([sound]) => soundDraftEvent(sound, "guildSoundboardSoundDelete"),
  },
  guildSoundboardSoundsUpdate: {
    extract: ([sounds, guild]) => {
      const list = mapValues(sounds, soundDraft);
      return {
        type: "guildSoundboardSoundsUpdate",
        guildId: str((guild as GuildShape)?.id),
        channelId: null,
        authorId: null,
        data: { sounds: list, count: list.length },
      };
    },
  },

  // --- GUILD_INTEGRATIONS (plan §7.2) -------------------------------------
  guildIntegrationsUpdate: {
    extract: ([guild]) => {
      const id = str((guild as GuildShape)?.id);
      return {
        type: "guildIntegrationsUpdate",
        guildId: id,
        channelId: null,
        authorId: null,
        data: { guildId: id },
      };
    },
  },
  integrationCreate: {
    wire: "INTEGRATION_CREATE",
    extract: ([raw]) => integrationDraft(raw, "integrationCreate"),
  },
  integrationUpdate: {
    wire: "INTEGRATION_UPDATE",
    extract: ([raw]) => integrationDraft(raw, "integrationUpdate"),
  },
  integrationDelete: {
    wire: "INTEGRATION_DELETE",
    extract: ([raw]) => integrationDraft(raw, "integrationDelete"),
  },

  // --- GUILD_WEBHOOKS (plan §7.2) -----------------------------------------
  webhooksUpdate: {
    extract: ([channel]) => {
      const c = channel as Partial<ChannelLike> & { guildId?: unknown };
      return {
        type: "webhooksUpdate",
        guildId: str(c.guildId),
        channelId: str(c.id),
        authorId: null,
        data: { channelId: str(c.id) },
      };
    },
  },

  // --- GUILD_INVITES (plan §7.2) ------------------------------------------
  inviteCreate: {
    extract: ([invite]) => inviteDraft(invite, "inviteCreate"),
  },
  inviteDelete: {
    extract: ([invite]) => inviteDraft(invite, "inviteDelete"),
  },

  // --- GUILD_VOICE_STATES (plan §7.2) -------------------------------------
  voiceStateUpdate: {
    extract: ([, state]) => {
      const vs = state as Partial<VoiceStateLike> & { guild?: { id?: string } } | null;
      const userId = str(vs?.id);
      return {
        type: "voiceStateUpdate",
        guildId: vs?.guild?.id ?? null,
        channelId: str(vs?.channelId),
        authorId: null,
        targetId: userId,
        data: { ...serializeVoiceState(vs as VoiceStateLike) },
      };
    },
  },
  voiceChannelEffectSend: {
    extract: ([effect]) => {
      const e = effect as EffectShape | null | undefined;
      return {
        type: "voiceChannelEffectSend",
        guildId: str(e?.guild?.id),
        channelId: str(e?.channelId),
        authorId: str(e?.userId),
        data: {
          channelId: str(e?.channelId),
          userId: str(e?.userId),
          emoji: emojiRef(e?.emoji),
          animationType: e?.animationType ?? null,
          animationId: num(e?.animationId),
          soundId: soundIdOf(e?.soundId),
          soundVolume: num(e?.soundVolume),
        },
      };
    },
  },

  // --- GUILD_PRESENCES (plan §7.2) ----------------------------------------
  presenceUpdate: {
    extract: ([, presence]) => {
      const p = presence as Partial<PresenceLike> | null | undefined;
      const userId = str(p?.userId) ?? str(p?.user?.id);
      return {
        type: "presenceUpdate",
        guildId: str(p?.guild?.id),
        channelId: null,
        authorId: userId,
        data: { ...serializePresence(p as PresenceLike) },
      };
    },
  },

  // --- GUILD_MESSAGES (plan §7.2) -----------------------------------------
  messageCreate: {
    extract: ([message]) => messageDraft(message, "messageCreate"),
  },
  messageUpdate: {
    extract: ([, message]) => messageDraft(message, "messageUpdate"),
  },
  messageDelete: {
    extract: ([message]) => messageDraft(message, "messageDelete"),
  },
  messageDeleteBulk: {
    extract: ([messages, channel]) => {
      const c = channel as Partial<ChannelLike> & { guildId?: unknown };
      const ids = keysOf(messages);
      return {
        type: "messageDeleteBulk",
        guildId: str(c.guildId),
        channelId: str(c.id),
        authorId: null,
        data: { ids, count: ids.length },
      };
    },
  },

  // --- GUILD_MESSAGE_REACTIONS (plan §7.2) --------------------------------
  messageReactionAdd: {
    extract: ([reaction, user]) => reactionDraft(reaction, user, "messageReactionAdd"),
  },
  messageReactionRemove: {
    extract: ([reaction, user]) => reactionDraft(reaction, user, "messageReactionRemove"),
  },
  messageReactionRemoveAll: {
    extract: ([message, reactions]) => {
      const m = message as Partial<MessageLike> | null | undefined;
      return {
        type: "messageReactionRemoveAll",
        guildId: m?.guildId ?? null,
        channelId: m?.channelId ?? null,
        authorId: null,
        messageId: m?.id ?? null,
        data: {
          messageId: m?.id ?? null,
          removedCount: collectionSize(reactions),
        },
      };
    },
  },
  messageReactionRemoveEmoji: {
    extract: ([reaction]) => {
      const r = reaction as ReactionShape | null | undefined;
      const m = r?.message;
      return {
        type: "messageReactionRemoveEmoji",
        guildId: str(m?.guildId),
        channelId: str(m?.channelId),
        authorId: null,
        messageId: str(r?.messageId) ?? str(m?.id),
        data: {
          messageId: str(r?.messageId) ?? str(m?.id),
          emoji: emojiRef(r?.emoji),
        },
      };
    },
  },

  // --- GUILD_MESSAGE_TYPING (plan §7.2) -----------------------------------
  typingStart: {
    extract: ([typing]) => {
      const t = typing as TypingShape | null | undefined;
      const started =
        t?.startedAt instanceof Date && !Number.isNaN(t.startedAt.valueOf())
          ? t.startedAt.toISOString()
          : isoFromMs(num(t?.startedTimestamp));
      return {
        type: "typingStart",
        guildId: str(t?.guild?.id ?? t?.channel?.guildId),
        channelId: str(t?.channel?.id),
        authorId: str(t?.user?.id),
        data: { userId: str(t?.user?.id), startedAt: started },
      };
    },
  },

  // --- GUILD_SCHEDULED_EVENTS (plan §7.2) ---------------------------------
  guildScheduledEventCreate: {
    extract: ([event]) => scheduledEventDraft(event, "guildScheduledEventCreate"),
  },
  guildScheduledEventUpdate: {
    extract: ([, event]) => scheduledEventDraft(event, "guildScheduledEventUpdate"),
  },
  guildScheduledEventDelete: {
    extract: ([event]) => scheduledEventDraft(event, "guildScheduledEventDelete"),
  },
  guildScheduledEventUserAdd: {
    extract: ([event, user]) => scheduledGuestDraft(event, user, "guildScheduledEventUserAdd"),
  },
  guildScheduledEventUserRemove: {
    extract: ([event, user]) => scheduledGuestDraft(event, user, "guildScheduledEventUserRemove"),
  },

  // --- AUTO_MODERATION_* (plan §7.2) --------------------------------------
  autoModerationRuleCreate: {
    extract: ([rule]) => automodRuleDraft(rule, "autoModerationRuleCreate"),
  },
  autoModerationRuleUpdate: {
    extract: ([, rule]) => automodRuleDraft(rule, "autoModerationRuleUpdate"),
  },
  autoModerationRuleDelete: {
    extract: ([rule]) => automodRuleDraft(rule, "autoModerationRuleDelete"),
  },
  autoModerationActionExecution: {
    extract: ([execution]) => {
      const x = execution as AutomodExecutionShape | null | undefined;
      const userId = str(x?.userId);
      return {
        type: "autoModerationActionExecution",
        guildId: str(x?.guildId),
        channelId: str(x?.channelId),
        authorId: userId,
        targetId: str(x?.ruleId),
        messageId: str(x?.messageId),
        data: {
          ruleId: str(x?.ruleId),
          ruleTriggerType: x?.ruleTriggerType ?? null,
          action: x?.action
            ? {
                type: num(x.action.type),
                metadata: plain(x.action.metadata),
              }
            : null,
          userId,
          channelId: str(x?.channelId),
          messageId: str(x?.messageId),
          alertSystemMessageId: str(x?.alertSystemMessageId),
          // The flagged message body is raw user text — it passes the bus's
          // scrub on ingest like every other free-text field.
          content: cut(str(x?.content) ?? "", 1000) || null,
          matchedKeyword: str(x?.matchedKeyword),
          matchedContent: cut(str(x?.matchedContent) ?? "", 500) || null,
        },
      };
    },
  },

  // --- POLLS (plan §7.2) ---------------------------------------------------
  messagePollVoteAdd: {
    extract: ([answer, userId]) => pollVoteDraft(answer, userId, "messagePollVoteAdd"),
  },
  messagePollVoteRemove: {
    extract: ([answer, userId]) => pollVoteDraft(answer, userId, "messagePollVoteRemove"),
  },
};

/** Audit-log diffs are capped so one busy edit cannot flood the buffer. */
const AUDIT_CHANGE_LIMIT = 25;

// --- late helpers (hoisted usage is fine — function declarations) ----------

function applicationCommandDraft(raw: unknown, type: string): EventDraft {
  const p = (raw ?? {}) as RawPayload;
  const id = str(p.id);
  return {
    type,
    guildId: str(p.guild_id),
    channelId: null,
    authorId: null,
    targetId: id,
    data: {
      id,
      applicationId: str(p.application_id),
      guildId: str(p.guild_id),
      name: str(p.name),
      description: str(p.description),
      type: num(p.type),
      version: str(p.version),
    },
  };
}

function integrationDraft(raw: unknown, type: string): EventDraft {
  const p = (raw ?? {}) as RawPayload & { enabled?: unknown; user?: UserShape };
  const id = str(p.id);
  return {
    type,
    guildId: str(p.guild_id),
    channelId: null,
    authorId: str(p.user?.id),
    targetId: id,
    data: {
      id,
      guildId: str(p.guild_id),
      // The integration's `type` is the source name ("twitch", "youtube"), a
      // string in the gateway payload — never a number.
      type: str(p.type),
      name: str(p.name),
      enabled: bool(p.enabled),
      userId: str(p.user?.id),
    },
  };
}

function stageDraft(stage: unknown, type: string): EventDraft {
  const s = stage as StageInstanceShape | null | undefined;
  // A stage instance's id *is* its channel id, so it lives in `channelId`
  // and is not repeated as `targetId`.
  return {
    type,
    guildId: str(s?.guildId),
    channelId: str(s?.channelId),
    authorId: null,
    data: {
      id: str(s?.id),
      channelId: str(s?.channelId),
      topic: str(s?.topic),
      privacyLevel: s?.privacyLevel ?? null,
      guildScheduledEventId: str(s?.guildScheduledEventId),
    },
  };
}

function banDraft(ban: unknown, type: string): EventDraft {
  const b = ban as Partial<BanLike> & { guild?: { id?: string } } | null | undefined;
  const userId = str(b?.user?.id);
  return {
    type,
    guildId: str(b?.guild?.id),
    channelId: null,
    authorId: null,
    targetId: userId,
    data: { ...serializeBan(b as BanLike) },
  };
}

function expressionDraft(
  emoji: unknown,
  type: string,
  kind: "emoji",
): EventDraft {
  const e = emoji as Partial<EmojiLike> & {
    guildId?: unknown;
    guild?: { id?: unknown } | null;
  } | null | undefined;
  const id = str(e?.id);
  // Read guildId and the `guild` getter separately: the second only when the
  // first is absent, so a discord.js lazy getter is not touched needlessly.
  const guildId = str(e?.guildId) ?? str(e?.guild?.id);
  return {
    type,
    guildId,
    channelId: null,
    authorId: null,
    targetId: id,
    data: { kind, ...serializeEmoji(e as EmojiLike) },
  };
}

function soundDraftEvent(sound: unknown, type: string): EventDraft {
  const s = sound as SoundShape | null | undefined;
  // `targetId` stays a snowflake *string*: a built-in sound's numeric id is
  // carried in `data.soundId` (the `target_id` filter is snowflake-validated).
  const id = str(s?.soundId);
  return {
    type,
    guildId: str(s?.guildId),
    channelId: null,
    authorId: null,
    targetId: id,
    data: soundDraft(sound),
  };
}

function inviteDraft(invite: unknown, type: string): EventDraft {
  const i = invite as Partial<InviteLike> & {
    guildId?: unknown;
    guild?: { id?: string } | null;
  } | null;
  return {
    type,
    guildId: str(i?.guildId) ?? str(i?.guild?.id),
    channelId: str(i?.channelId) ?? str(i?.channel?.id),
    authorId: null,
    data: { ...serializeInvite(i as InviteLike) },
  };
}

function reactionDraft(
  reaction: unknown,
  user: unknown,
  type: string,
): EventDraft {
  const r = reaction as ReactionShape | null | undefined;
  const m = r?.message;
  const authorId = str((user as UserShape | null | undefined)?.id);
  const messageId = str(r?.messageId) ?? str(m?.id);
  return {
    type,
    guildId: str(m?.guildId),
    channelId: str(m?.channelId),
    authorId,
    messageId,
    data: {
      messageId,
      emoji: emojiRef(r?.emoji),
      userId: authorId,
      count: num(r?.count),
    },
  };
}

function scheduledGuestDraft(
  event: unknown,
  user: unknown,
  type: string,
): EventDraft {
  const e = event as ScheduledEventShape | null | undefined;
  const userId = str((user as UserShape | null | undefined)?.id);
  return {
    type,
    guildId: str(e?.guildId),
    channelId: str(e?.channelId),
    authorId: userId,
    targetId: str(e?.id),
    data: { eventId: str(e?.id), name: str(e?.name), userId },
  };
}

function pollVoteDraft(
  answer: unknown,
  userId: unknown,
  type: string,
): EventDraft {
  const a = answer as PollAnswerShape | null | undefined;
  const poll = a?.poll ?? null;
  const messageId = str(poll?.messageId) ?? str(a?.messageId);
  const authorId = str(userId);
  return {
    type,
    guildId: str(poll?.channel?.guildId),
    channelId: str(poll?.channelId),
    authorId,
    messageId,
    data: {
      messageId,
      channelId: str(poll?.channelId),
      answerId: num(a?.id),
      answerText: str(a?.text),
      emoji: emojiRef(a?.emoji),
      userId: authorId,
    },
  };
}

function cutValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return cut(value, 300);
  if (typeof value === "number" || typeof value === "boolean") return value;
  const json = safeJson(value);
  return json === null ? null : cut(json, 300);
}

/** Keys of a discord.js `Collection` (or any Map-like), else `[]`. */
function keysOf(value: unknown): string[] {
  if (value instanceof Map) return [...value.keys()].filter((k): k is string => typeof k === "string");
  if (typeof value === "object" && value !== null && "keys" in value) {
    try {
      const keys: unknown = (value as { keys(): unknown }).keys();
      if (keys && typeof keys === "object" && Symbol.iterator in keys) {
        return [...(keys as Iterable<unknown>)].filter(
          (k): k is string => typeof k === "string",
        );
      }
    } catch {
      // Non-iterable — fall through.
    }
  }
  return [];
}

/** `[key, value]` over a discord.js `Collection`, else `[]`. */
function mapValues<T>(value: unknown, map: (item: unknown) => T): T[] {
  const out: T[] = [];
  if (value instanceof Map) {
    for (const item of value.values()) out.push(map(item));
    return out;
  }
  if (typeof value === "object" && value !== null && "values" in value) {
    try {
      const values: unknown = (value as { values(): unknown }).values();
      if (values && typeof values === "object" && Symbol.iterator in values) {
        for (const item of values as Iterable<unknown>) out.push(map(item));
      }
    } catch {
      // Not iterable — empty list.
    }
  }
  return out;
}

/** `.size` of a Collection-like, else `null`. */
function collectionSize(value: unknown): number | null {
  if (value instanceof Map) return value.size;
  if (typeof value === "object" && value !== null && "size" in value) {
    return num((value as { size?: unknown }).size);
  }
  return null;
}

// ---------------------------------------------------------------------------
// type-name canonicalization & filter normalization
// ---------------------------------------------------------------------------

/**
 * Wire name or discord.js name → the canonical `type` an event carries.
 *
 * - listener keys resolve directly (with `clientReady` → `ready`,
 *   `shardResume` → `resumed`);
 * - `SCREAMING_SNAKE` wire names camel-case (`MESSAGE_DELETE_BULK` →
 *   `messageDeleteBulk`) and then apply {@link WIRE_ALIASES}`;
 * - anything else passes through unchanged (the tool boundary rejects
 *   unknown names against {@link KNOWN_TYPES}).
 */
export function canonicalType(input: string): string {
  const direct = EVENT_SPECS[input];
  if (direct) return direct.type ?? input;
  if (/^[A-Z0-9_]+$/.test(input)) {
    const mapped = WIRE_ALIASES[input] ?? toCamel(input);
    const spec = EVENT_SPECS[mapped];
    return spec ? (spec.type ?? mapped) : mapped;
  }
  return input;
}

/** Every canonical type name, for validation and error messages. */
export const KNOWN_TYPES: ReadonlySet<string> = new Set(
  Object.entries(EVENT_SPECS).map(([key, spec]) => spec.type ?? key),
);

/**
 * The reverse of {@link WIRE_ALIASES} plus plain camel→SCREAMING_SNAKE: the
 * canonical type a filter would name back to the gateway wire name
 * (`roleCreate` → `GUILD_ROLE_CREATE`, `messageDeleteBulk` →
 * `MESSAGE_DELETE_BULK`). Used to accept wire-prefixed wildcards that the
 * whole-event alias map alone cannot see (`GUILD_ROLE*`).
 */
function toWire(canonical: string): string {
  for (const [wire, alias] of Object.entries(WIRE_ALIASES)) {
    if (alias === canonical) return wire;
  }
  return canonical.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/** Raw (snake_case) filter as zod produces it, plus the since fields. */
export interface RawEventFilter {
  types?: readonly string[];
  guild_id?: string;
  channel_id?: string;
  author_id?: string;
  target_id?: string;
  message_id?: string;
  since_seq?: number;
  since?: string;
}

/**
 * Validate a tool-boundary filter and convert it to canonical form:
 * type entries resolve to canonical names (patterns keep their `*`), ids and
 * `since` are carried through.
 *
 * Returns a {@link WardenError} instead of throwing so the tool layer can
 * `fail()` it with the same envelope as every other rejection. Unknown type
 * names are rejected rather than silently matching nothing — a typo that
 * returns `[]` forever is indistinguishable from "no activity".
 */
export function normalizeFilter(raw: RawEventFilter): EventFilter | WardenError {
  const filter: EventFilter = {};

  if (raw.types !== undefined && raw.types.length > 0) {
    const patterns: string[] = [];
    for (const entry of raw.types) {
      if (entry.endsWith("*")) {
        const rawPrefix = entry.slice(0, -1);
        const prefix = canonicalType(rawPrefix);
        if (prefix === "" || [...KNOWN_TYPES].some((t) => t.startsWith(prefix))) {
          patterns.push(`${prefix}*`);
          continue;
        }
        // A wire prefix the whole-event aliases hide: `GUILD_ROLE*` camel-cases
        // to nothing, but every wire name under it resolves — expand to those
        // exact canonical types so an agent transcribing §7.2's wire table is
        // not rejected for a spelling the plan itself uses.
        if (/^[A-Z0-9_]+$/.test(rawPrefix)) {
          const expanded = [...KNOWN_TYPES].filter((t) => toWire(t).startsWith(rawPrefix));
          if (expanded.length > 0) {
            patterns.push(...expanded);
            continue;
          }
        }
        return fail({
          error: "invalid_input",
          message: `types pattern "${entry}" does not match any known event type.`,
          remediation:
            'Use canonical names ("messageCreate"), wire names ("MESSAGE_CREATE"), or a wildcard prefix that starts one ("message*", "role*"). Wire names also match per prefix ("GUILD_ROLE*" → roleCreate/roleUpdate/roleDelete).',
        });
      }
      const canonical = canonicalType(entry);
      if (!KNOWN_TYPES.has(canonical)) {
        return fail({
          error: "invalid_input",
          message: `Unknown event type "${entry}".`,
          remediation:
            'Use canonical names ("messageCreate"), wire names ("MESSAGE_CREATE"), or a wildcard prefix ("message*") — canonical names are the discord.js event names.',
        });
      }
      patterns.push(canonical);
    }
    filter.types = patterns;
  }

  if (raw.guild_id !== undefined) filter.guildId = raw.guild_id;
  if (raw.channel_id !== undefined) filter.channelId = raw.channel_id;
  if (raw.author_id !== undefined) filter.authorId = raw.author_id;
  if (raw.target_id !== undefined) filter.targetId = raw.target_id;
  if (raw.message_id !== undefined) filter.messageId = raw.message_id;
  if (raw.since_seq !== undefined) filter.sinceSeq = raw.since_seq;
  if (raw.since !== undefined) {
    if (!Number.isFinite(Date.parse(raw.since))) {
      return fail({
        error: "invalid_input",
        message: `since "${raw.since}" is not a timestamp.`,
        remediation:
          "Use an ISO 8601 timestamp, e.g. 2026-10-01T12:00:00.000Z (or a date like 2026-10-01).",
      });
    }
    filter.since = raw.since;
  }

  return filter;
}
