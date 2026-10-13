/**
 * The event ring buffer (plan §7.4): every captured event is stamped once
 * here — monotonic `seq`, derived `id`, capture timestamp — and kept until
 * the ring wraps. Reads are local and never touch Discord, which is what
 * makes `get_events`/`read_watch`/`wait_for_event` the anti-hammering
 * alternative to polling the REST API.
 *
 * ## Scrub at ingest (plan §4)
 *
 * `push()` runs every payload string through `scrub()` before it enters the
 * buffer. Event payloads are full of operator- and user-authored free text
 * (message bodies, nicknames, audit reasons, channel topics) — exactly where
 * a pasted token would live — and one choke point at the only door into the
 * buffer means every consumer (tools, watches, waits, future phases) can
 * hand stored events back verbatim without re-scrubbing. The cost is one
 * regex pass per free-text field, against an ingest rate Discord itself
 * throttles.
 *
 * ## Ring semantics
 *
 * `seq` starts at 1 and never resets or reuses, even as old events are
 * evicted — cursors (`since_seq`, watch cursors) therefore stay meaningful
 * across a wrap: they simply point at history the buffer no longer holds,
 * and reads return whatever newer slice still matches.
 */

import { scrub } from "../discord/errors.js";
import type { Logger } from "../logger.js";
import { matchesFilter } from "./types.js";
import type { EventDraft, EventFilter, NormalizedEvent } from "./types.js";

/** One buffered event plus what a query can ask for it. */
export interface EventQuery {
  filter?: EventFilter;
  /**
   * Return events with `seq > afterSeq`, oldest first (paging forward).
   * Without it, a query returns the **tail**: the most recent `limit`
   * matches — the "what just happened" pull.
   */
  afterSeq?: number;
  /** @default 50, capped at 200 (see DEFAULT_LIMIT/MAX_LIMIT). */
  limit?: number;
}

export interface EventQueryResult {
  events: NormalizedEvent[];
  /**
   * Resume point for the events actually returned: the seq of the newest
   * event in this result, or the requested `afterSeq` (or the current head
   * when nothing was requested) when the result is empty. Paging reads
   * (`afterSeq`) therefore continue exactly where a batch stopped; a *tail*
   * pull's cursor only covers the window it returned — older history is
   * `get_events`' `since_seq: 0` or the REST tools, never implied by this
   * number.
   */
  cursor: number;
}

export interface EventBus {
  /** Stamp, scrub and store one event; notifies subscribers synchronously. */
  push(draft: EventDraft): NormalizedEvent;
  /** Newest seq held or ever seen; 0 before the first event. */
  readonly seq: number;
  /** Events currently buffered. */
  readonly size: number;
  /** Oldest buffered seq, or 0 when empty. */
  readonly oldestSeq: number;
  /**
   * Resume point for a wall-clock `since`: the seq of the newest buffered
   * event at or before that timestamp, so paging from it (like `afterSeq`)
   * moves forward oldest-first without skipping the middle.
   */
  cursorFor(since: string): number;
  query(options?: EventQuery): EventQueryResult;
  /**
   * Observe new events synchronously as they are pushed. Used by the watch
   * long-poll and the one-shot wait; listeners must not throw (a listener
   * error is caught and reported through the bus's `onListenerError`).
   */
  subscribe(listener: (event: NormalizedEvent) => void): () => void;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

interface EventBusOptions {
  capacity: number;
  /** Test seam: deterministic timestamps. */
  now?: () => Date;
  /** Reported (not swallowed silently) listener faults. */
  onListenerError?: (error: unknown) => void;
}

export function createEventBus(options: EventBusOptions): EventBus {
  const capacity = Math.max(1, Math.floor(options.capacity));
  const now = options.now ?? (() => new Date());
  const buffer: NormalizedEvent[] = [];
  const listeners = new Set<(event: NormalizedEvent) => void>();
  let latestSeq = 0;

  const push = (draft: EventDraft): NormalizedEvent => {
    latestSeq += 1;
    const event: NormalizedEvent = {
      seq: latestSeq,
      id: `ev_${latestSeq}`,
      at: now().toISOString(),
      // Every string field passes the scrub too, not just `data`: today the
      // stamped fields are only ids and a type name, but scrubbing them
      // removes the load-bearing invariant that nothing else can ever carry
      // free text past this choke point (§4).
      type: scrub(draft.type),
      guildId: scrubNullable(draft.guildId ?? null),
      channelId: scrubNullable(draft.channelId ?? null),
      authorId: scrubNullable(draft.authorId ?? null),
      // Optional fields stay absent rather than null — the normalized record
      // (§7.3) only carries them when they apply, and filters compare equal
      // against `undefined` just as against `null` (neither matches a value).
      ...(draft.targetId !== undefined && draft.targetId !== null
        ? { targetId: scrub(draft.targetId) }
        : {}),
      ...(draft.messageId !== undefined && draft.messageId !== null
        ? { messageId: scrub(draft.messageId) }
        : {}),
      data: scrubRecord(draft.data),
    };

    buffer.push(event);
    if (buffer.length > capacity) {
      buffer.splice(0, buffer.length - capacity);
    }

    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        // A faulty subscriber must not lose the event or break ingest.
        options.onListenerError?.(error);
      }
    }
    return event;
  };

  const cursorFor = (since: string): number => {
    const bound = Date.parse(since);
    // Defensive: an unparseable bound (the tool boundary validates it) reads
    // as "up to now", which yields every buffered event rather than none.
    if (!Number.isFinite(bound)) return latestSeq;
    let cursor = 0;
    for (const event of buffer) {
      // Capture order makes `at` non-decreasing, so the first later event
      // ends the search.
      if (Date.parse(event.at) <= bound) cursor = event.seq;
      else break;
    }
    return cursor;
  };

  const query = (opts: EventQuery = {}): EventQueryResult => {
    const limit = clampLimit(opts.limit);
    const afterSeq = opts.afterSeq;
    let matched: NormalizedEvent[];

    if (afterSeq !== undefined) {
      // Paging forward: ascending from the cursor, stop at the limit so the
      // caller's next `cursor` lands exactly where this batch stopped.
      matched = [];
      for (const event of buffer) {
        if (event.seq <= afterSeq) continue;
        if (matchesFilter(event, opts.filter)) {
          matched.push(event);
          if (matched.length >= limit) break;
        }
      }
    } else {
      // Tail pull: the most recent `limit` matches, returned oldest first.
      const tail: NormalizedEvent[] = [];
      for (let i = buffer.length - 1; i >= 0; i--) {
        const event = buffer[i]!;
        if (!matchesFilter(event, opts.filter)) continue;
        tail.push(event);
        if (tail.length >= limit) break;
      }
      tail.reverse();
      matched = tail;
    }

    const cursor =
      matched.length > 0
        ? matched[matched.length - 1]!.seq
        : (afterSeq ?? latestSeq);
    return { events: matched, cursor };
  };

  const subscribe = (listener: (event: NormalizedEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    push,
    get seq() {
      return latestSeq;
    },
    get size() {
      return buffer.length;
    },
    get oldestSeq() {
      return buffer.length > 0 ? buffer[0]!.seq : 0;
    },
    cursorFor,
    query,
    subscribe,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/** Scrub a nullable id field; `null` (Discord says none) passes through. */
function scrubNullable(value: string | null): string | null {
  return value === null ? null : scrub(value);
}

/**
 * Deep scrub of the payload: strings pass `scrub()`, containers are walked.
 * The ids/type/at stamped above are snowflakes and timestamps — never free
 * text — so the payload is the only place a token-shaped string could hide.
 */
function scrubDeep(value: unknown): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (typeof value === "object" && value !== null) return scrubRecord(value);
  return value;
}

function scrubRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = scrubDeep(item);
    }
    return out;
  }
  return {};
}

/** Logger-shaped error sink used by the runtime (see `events/index.ts`). */
export function loggerListenerError(logger: Logger): (error: unknown) => void {
  const log = logger.child({ component: "events" });
  return (error: unknown) => {
    log.warn("event subscriber failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  };
}
