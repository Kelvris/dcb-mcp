/**
 * Watch sessions (plan §7.4) — named cursors over the bus, plus the
 * one-shot wait. This is the anti-hammering design's session half: an agent
 * creates a watch once and then only reads *new* matches (`seq > cursor`),
 * so a channel can be followed live without re-pulling unchanged history and
 * without a single REST call.
 *
 * Lifecycle decisions, each deliberate:
 *
 * - **Idle expiry, lazily.** Watches expire 30 minutes after their last read
 *   and are pruned on the next registry operation instead of on a timer: no
 *   timer can outlive its watch, expiry needs no shutdown coordination, and
 *   an abandoned watch frees its slot exactly when the cap is next checked.
 * - **Name is the id.** `watch({name})` returns that name as `watch_id`;
 *   duplicate names are rejected instead of silently replacing a session an
 *   agent may be mid-read on. One identity, no id-to-name lookup to get
 *   wrong.
 * - **Cursor starts after `since`.** Without one, a new watch starts at the
 *   current head (only *future* matches); with `since_seq`/`since` it starts
 *   at 0 with the bound carried inside the filter, so the first `read_watch`
 *   returns the matching slice from the buffer onward (§8.1's "initial
 *   cursor").
 * - **Long-poll via bus subscription, not polling.** `block_ms` awaits the
 *   next matching push; the timer is `unref`ed so a pending wait can never
 *   hold the process open through shutdown.
 */

import type { WardenError } from "../discord/errors.js";
import { fail } from "../shared/result.js";
import type { EventBus } from "./bus.js";
import { matchesFilter } from "./types.js";
import type { EventFilter, NormalizedEvent } from "./types.js";

/** Idle lifetime of a watch (plan §7.4: "auto-expire after 30 min idle"). */
export const WATCH_IDLE_MS = 30 * 60 * 1000;

export interface WatchSummary {
  /** The watch's name — the same string `read_watch`/`unwatch` take. */
  watch_id: string;
  name: string;
  filter: EventFilter;
  cursor: number;
  created_at: string;
  last_read_at: string;
  idle_seconds: number;
}

export interface WatchReadResult {
  events: NormalizedEvent[];
  /** Advanced to the newest event returned; unchanged on an idle read. */
  cursor: number;
  /** True when nothing matched (before or after the optional wait). */
  idle: boolean;
  /**
   * Buffered events that matched this watch's cursor position but were
   * already evicted from the ring before this read (a busy guild outrunning
   * `WARDEN_MAX_EVENTS`). Non-zero means this read may be an incomplete
   * slice — the tool turns it into a note (§7.4's REST fallback), because a
   * silently truncated "live follow" is worse than a flagged one.
   */
  evictedCount: number;
}

export interface WatchWaitResult {
  /** The first matching event, or `null` on timeout. */
  event: NormalizedEvent | null;
  timeout: boolean;
}

export interface WatchRegistry {
  create(input: { name: string; filter: EventFilter }): WatchSummary | WardenError;
  list(): WatchSummary[];
  read(input: {
    name: string;
    /** Long-poll bound, ms; 0 reads without waiting. */
    blockMs?: number;
    limit?: number;
  }): Promise<WatchReadResult | WardenError>;
  remove(name: string): { watch_id: string; removed: true } | WardenError;
  /**
   * One-shot wait for the next event matching `filter` (§8.1
   * `wait_for_event`) — no watch created, no cursor advanced.
   */
  waitOnce(input: {
    filter: EventFilter;
    timeoutMs: number;
  }): Promise<WatchWaitResult>;
}

interface Watch {
  name: string;
  filter: EventFilter;
  cursor: number;
  createdAtMs: number;
  lastReadAtMs: number;
}

interface WatchRegistryOptions {
  bus: EventBus;
  maxWatches: number;
  /** @default 30 minutes */
  idleMs?: number;
  /** Test seam: deterministic clocks. */
  now?: () => number;
}

export function createWatchRegistry(options: WatchRegistryOptions): WatchRegistry {
  const { bus, maxWatches } = options;
  const idleMs = options.idleMs ?? WATCH_IDLE_MS;
  const now = options.now ?? (() => Date.now());
  const watches = new Map<string, Watch>();

  const prune = (): void => {
    const cutoff = now() - idleMs;
    for (const [name, watch] of watches) {
      if (watch.lastReadAtMs <= cutoff) watches.delete(name);
    }
  };

  const toSummary = (watch: Watch): WatchSummary => {
    const nowMs = now();
    return {
      watch_id: watch.name,
      name: watch.name,
      filter: watch.filter,
      cursor: watch.cursor,
      created_at: new Date(watch.createdAtMs).toISOString(),
      last_read_at: new Date(watch.lastReadAtMs).toISOString(),
      idle_seconds: Math.max(0, Math.round((nowMs - watch.lastReadAtMs) / 1000)),
    };
  };

  const notFound = (name: string): WardenError => {
    const idleMinutes = Math.round(idleMs / 60_000);
    return fail({
      error: "not_found",
      message: `Watch "${name}" does not exist — it was never created, or expired after ${idleMinutes} minutes idle.`,
      remediation:
        "list_watches() to see the live watches, watch() to create one.",
    });
  };

  const create = (input: { name: string; filter: EventFilter }): WatchSummary | WardenError => {
    prune();
    const name = input.name.trim();
    if (name.length === 0) {
      return fail({
        error: "invalid_input",
        message: "name must not be empty.",
        remediation: "Give the watch a short descriptive name, e.g. \"mod-log\".",
      });
    }
    if (watches.has(name)) {
      return fail({
        error: "invalid_input",
        message: `A watch named "${name}" already exists.`,
        remediation:
          "unwatch() it first if you mean to replace it, or choose another name.",
      });
    }
    if (watches.size >= maxWatches) {
      return fail({
        error: "invalid_input",
        message: `The watch limit of ${maxWatches} concurrent watches has been reached.`,
        remediation: `unwatch() watches you no longer need, or raise WARDEN_MAX_WATCHES (currently ${maxWatches}) when starting the server.`,
      });
    }
    // A `since` bound lives inside the filter itself, so a cursor of 0
    // already skips older history on read; without one, start at the head.
    const cursor =
      input.filter.sinceSeq !== undefined || input.filter.since !== undefined
        ? 0
        : bus.seq;
    const stamp = now();
    const watch: Watch = {
      name,
      filter: input.filter,
      cursor,
      createdAtMs: stamp,
      lastReadAtMs: stamp,
    };
    watches.set(name, watch);
    return toSummary(watch);
  };

  const list = (): WatchSummary[] => {
    prune();
    return [...watches.values()].map(toSummary);
  };

  const collect = (watch: Watch, limit?: number) =>
    bus.query({ filter: watch.filter, afterSeq: watch.cursor, limit });

  const read = async (input: {
    name: string;
    blockMs?: number;
    limit?: number;
  }): Promise<WatchReadResult | WardenError> => {
    prune();
    const watch = watches.get(input.name);
    if (!watch) return notFound(input.name);

    // Capture the pre-read cursor so eviction between reads is visible: seqs
    // this watch never got to see because the ring moved past them. No
    // cursor-0 special case: a fresh head-start watch has cursor = bus.seq ≥
    // oldestSeq and an empty bus has oldestSeq 0, so the clamp alone is 0
    // there — while a *since*-based cursor-0 watch over a wrapped ring is
    // exactly the read that must be flagged.
    const preCursor = watch.cursor;

    let result = collect(watch, input.limit);
    const blockMs = Math.max(0, input.blockMs ?? 0);
    if (result.events.length === 0 && blockMs > 0) {
      await waitForMatch(bus, watch.filter, watch.cursor, blockMs);
      // Re-read after the wake-up: pushes during the wait are all stored, so
      // one collect returns the whole batch, not just the matching push that
      // resolved the waiter.
      result = collect(watch, input.limit);
    }
    if (result.events.length > 0) watch.cursor = result.cursor;
    watch.lastReadAtMs = now();
    // Computed against the *current* oldest, not the pre-wait one: a block_ms
    // read can see the ring wrap past its cursor while it waits.
    const evictedCount = Math.max(0, bus.oldestSeq - preCursor - 1);
    return {
      events: result.events,
      cursor: watch.cursor,
      idle: result.events.length === 0,
      evictedCount,
    };
  };

  const remove = (name: string): { watch_id: string; removed: true } | WardenError => {
    prune();
    if (!watches.delete(name)) return notFound(name);
    return { watch_id: name, removed: true };
  };

  const waitOnce = async (input: {
    filter: EventFilter;
    timeoutMs: number;
  }): Promise<WatchWaitResult> => {
    // Future events only: `get_events` is the history path, this is the
    // "tell me when it happens" path.
    const startSeq = bus.seq;
    const timeoutMs = Math.max(0, input.timeoutMs);
    const event = await new Promise<NormalizedEvent | null>((resolve) => {
      let settled = false;
      const finish = (value: NormalizedEvent | null): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(value);
      };
      const unsubscribe = bus.subscribe((candidate) => {
        if (candidate.seq > startSeq && matchesFilter(candidate, input.filter)) {
          finish(candidate);
        }
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
      // Logical timeout only — must not hold the process open at shutdown.
      timer.unref?.();
    });
    return event === null
      ? { event: null, timeout: true }
      : { event, timeout: false };
  };

  return { create, list, read, remove, waitOnce };
}

/**
 * Resolve on the first event matching `filter` with `seq > afterSeq`, or
 * after `timeoutMs`. The unsubscribe/clearTimeout run in `finally`-equivalent
 * order inside `finish`, so no waiter outlives its read in either direction.
 */
function waitForMatch(
  bus: EventBus,
  filter: EventFilter,
  afterSeq: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve();
    };
    const unsubscribe = bus.subscribe((event) => {
      if (event.seq > afterSeq && matchesFilter(event, filter)) finish();
    });
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
  });
}
