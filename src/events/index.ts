/**
 * The event runtime (plan §5/§7): one bus, one watch registry, and the
 * listener wiring that captures every §7.2 event into them. `createWarden()`
 * builds it once, before `login()`, so even `READY` is captured.
 *
 * Capture is two-pronged:
 *
 * - every event discord.js parses is subscribed under its listener name,
 *   with the extractor receiving discord.js' typed payload — that is what
 *   lets entity events flow through `discord/serializers/` (§7.3);
 * - the eight §7.2 events discord.js does **not** emit (`wire` specs in
 *   `normalize.ts`) are read from the `raw` dispatch, which carries every
 *   gateway packet before discord.js handles it — so the plan's inventory is
 *   complete without waiting on library support.
 *
 * Extraction failures are contained per event: a shape discord.js changed
 * (or a partial we mis-read) logs a warning with the event type and moves
 * on — one malformed payload must never take the pipeline, or the MCP
 * session, down.
 */

import { Events } from "discord.js";
import type { Client } from "discord.js";

import type { Logger } from "../logger.js";
import { createEventBus, loggerListenerError } from "./bus.js";
import type { EventBus } from "./bus.js";
import { EVENT_SPECS } from "./normalize.js";
import { createWatchRegistry } from "./watches.js";
import type { WatchRegistry } from "./watches.js";
import type { EventDraft } from "./types.js";

export interface EventRuntime {
  readonly bus: EventBus;
  readonly watches: WatchRegistry;
}

export interface EventRuntimeOptions {
  /** Ring-buffer capacity (`WARDEN_MAX_EVENTS`). */
  maxEvents: number;
  /** Concurrent watch cap (`WARDEN_MAX_WATCHES`). */
  maxWatches: number;
}

export function createEventRuntime(
  client: Client,
  options: EventRuntimeOptions,
  logger: Logger,
): EventRuntime {
  const log = logger.child({ component: "events" });
  const bus = createEventBus({
    capacity: options.maxEvents,
    onListenerError: loggerListenerError(logger),
  });
  const watches = createWatchRegistry({
    bus,
    maxWatches: options.maxWatches,
  });

  const capture = (type: string, extract: () => EventDraft): void => {
    try {
      bus.push(extract());
    } catch (error) {
      log.warn("event extraction failed", {
        eventType: type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  for (const [listener, spec] of Object.entries(EVENT_SPECS)) {
    if (spec.wire !== undefined) continue; // raw-captured, see below
    const type = spec.type ?? listener;
    // discord.js' emitter is typed per event; the extractor already narrows
    // the payload it needs, so the handler is deliberately variadic.
    client.on(listener as never, (...args: readonly unknown[]) => {
      capture(type, () => spec.extract(args));
    });
  }

  const rawSpecs = new Map(
    Object.values(EVENT_SPECS)
      .filter((spec) => spec.wire !== undefined)
      .map((spec) => [spec.wire as string, spec]),
  );
  client.on(Events.Raw, (data: { t?: unknown; d?: unknown }) => {
    const wire = typeof data?.t === "string" ? data.t : undefined;
    if (wire === undefined) return;
    const spec = rawSpecs.get(wire);
    if (!spec) return;
    capture(wire, () => spec.extract([data.d]));
  });

  return { bus, watches };
}

export type { EventBus } from "./bus.js";
export type { WatchRegistry, WatchSummary, WatchReadResult, WatchWaitResult } from "./watches.js";
export { WATCH_IDLE_MS } from "./watches.js";
export { DEFAULT_LIMIT, MAX_LIMIT } from "./bus.js";
export { canonicalType, KNOWN_TYPES, normalizeFilter, EVENT_SPECS } from "./normalize.js";
export type { RawEventFilter } from "./normalize.js";
export { matchesFilter } from "./types.js";
export type { EventDraft, EventFilter, NormalizedEvent } from "./types.js";
