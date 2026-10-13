/**
 * Event-system core types (plan §7.3–§7.4): the normalized record every
 * gateway event becomes, the filter that selects events, and the single
 * matching rule the buffer, the watches and the one-shot wait all share.
 *
 * ## Field semantics (the filters depend on these)
 *
 * - `guildId` / `channelId` / `authorId` — always present, `null` when the
 *   event has none (a DM message has `guildId: null`; `ready` has neither
 *   guild nor channel). Stable shape: clients never guess whether a key
 *   exists.
 * - `targetId` — present only when the event is *about* one entity that is
 *   not already reachable through the other fields: e.g. the role in a role
 *   change, the member in a join/leave, the banned user, the scheduled
 *   event, the automod rule a rule-execution fired for, the audit log's
 *   affected object, a soundboard sound, a sticker, an integration or
 *   application command, a thread member, the user in a voice state. It
 *   exists so `filter.targetId` can answer "what
 *   happened to X" without enumerate-then-intersect (§7.4). Channel-,
 *   guild- and stage-shaped events do not set it — their subject is already
 *   `channelId`/`guildId`.
 * - `messageId` — present only when the event concerns one message (its
 *   creation, edit, deletion, a reaction or a poll vote on it), which is
 *   what lets a single filter follow one message across edits, reactions
 *   and deletion (§7.4: "watch one specific message").
 * - `data` — the curated payload: ids plus key fields, never a raw blob
 *   (§7.3). It is scrubbed (plan §4) on the way into the bus, so anything
 *   downstream — tools, watches, waits — can hand it back verbatim.
 */

/**
 * A gateway event after capture, stamped by the bus (seq/id/at) — the record
 * every read returns.
 */
export interface NormalizedEvent {
  /** Monotonic, starts at 1, never reused even after ring wrap. */
  seq: number;
  /** Stable id derived from the sequence: `ev_<seq>`. */
  id: string;
  /** Capture time, ISO 8601 (UTC). */
  at: string;
  /**
   * Canonical type: the discord.js camelCase name (`messageCreate`), with
   * wire aliases resolved (`GUILD_ROLE_CREATE` → `roleCreate`). See
   * `normalize.ts` for the canonicalization rules.
   */
  type: string;
  guildId: string | null;
  channelId: string | null;
  authorId: string | null;
  targetId?: string | null;
  messageId?: string | null;
  /** Curated payload (§7.3), scrubbed at ingest. */
  data: Record<string, unknown>;
}

/**
 * What a normalizer produces: a draft without `seq`/`id`/`at` — those are
 * the bus's stamps, assigned once, at the single ingest point.
 */
export interface EventDraft {
  type: string;
  guildId?: string | null;
  channelId?: string | null;
  authorId?: string | null;
  targetId?: string | null;
  messageId?: string | null;
  data: Record<string, unknown>;
}

/**
 * A filter in canonical form: `types` entries are already canonicalized
 * (`MESSAGE_CREATE`/`GUILD_ROLE_CREATE` → discord.js names) by
 * `normalizeFilter()`, so matching itself is a plain string comparison.
 *
 * All fields are AND-combined; within `types` events are OR'ed. `sinceSeq`
 * and `since` each match events strictly after their bound (§7.4: "only
 * events seq > cursor"); if a programmatic caller sets both, both apply —
 * the "one cursor style at a time" rule belongs to the tool boundary
 * (`observe.ts`), not to this matcher.
 */
export interface EventFilter {
  /** Canonical type names, or `prefix*` wildcards (`["message*"]`). */
  types?: readonly string[];
  guildId?: string;
  channelId?: string;
  authorId?: string;
  targetId?: string;
  messageId?: string;
  /** Events with `seq > sinceSeq`. */
  sinceSeq?: number;
  /** Events strictly after this ISO 8601 timestamp. */
  since?: string;
}

/**
 * Does one event satisfy one filter?
 *
 * The single matching implementation (plan: bus reads, watch reads and
 * `wait_for_event` must not drift apart). Everything is AND-combined;
 * an omitted field never filters.
 */
export function matchesFilter(
  event: NormalizedEvent,
  filter?: EventFilter,
): boolean {
  if (!filter) return true;

  const types = filter.types;
  if (types !== undefined && types.length > 0) {
    if (!types.some((pattern) => matchesType(event.type, pattern))) return false;
  }
  if (filter.guildId !== undefined && event.guildId !== filter.guildId) {
    return false;
  }
  if (filter.channelId !== undefined && event.channelId !== filter.channelId) {
    return false;
  }
  if (filter.authorId !== undefined && event.authorId !== filter.authorId) {
    return false;
  }
  if (filter.targetId !== undefined && event.targetId !== filter.targetId) {
    return false;
  }
  if (filter.messageId !== undefined && event.messageId !== filter.messageId) {
    return false;
  }
  if (filter.sinceSeq !== undefined && event.seq <= filter.sinceSeq) {
    return false;
  }
  if (filter.since !== undefined) {
    // `normalizeFilter()` validated this string at the tool boundary; if a
    // programmatic caller still passes junk, an unparseable bound is treated
    // as absent rather than silently dropping every event — hiding history
    // is the worse failure mode for a read tool.
    const bound = Date.parse(filter.since);
    if (Number.isFinite(bound) && Date.parse(event.at) <= bound) return false;
  }
  return true;
}

/**
 * Exact match, or prefix match for a `message*` wildcard (§7.4).
 * Patterns are canonicalized before they get here, so both
 * `MESSAGE_CREATE` and `messageCreate` compare equal to `event.type`.
 */
function matchesType(type: string, pattern: string): boolean {
  if (pattern.endsWith("*")) return type.startsWith(pattern.slice(0, -1));
  return type === pattern;
}
