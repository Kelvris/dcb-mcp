/**
 * Phase 5 — watch sessions and the one-shot wait (plan §7.4/§8.1; §11's
 * `watches.test.ts` row).
 *
 * What this pins: cursor advance with no double delivery, idle empty reads,
 * `block_ms` long-polling (early wake on a matching push, timeout otherwise),
 * lazy 30-minute expiry, the `WARDEN_MAX_WATCHES` cap with expiry freeing
 * slots, duplicate-name rejection, and `wait_for_event`'s future-only
 * semantics.
 */

import { describe, expect, it } from "vitest";

import { createEventBus } from "../src/events/bus.js";
import type { EventDraft } from "../src/events/types.js";
import {
  WATCH_IDLE_MS,
  createWatchRegistry,
} from "../src/events/watches.js";
import type { WardenError } from "../src/discord/errors.js";

const CH = "400000000000000001";
const OTHER_CH = "400000000000000002";
const ALICE = "100000000000000001";

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return { type: "messageCreate", channelId: CH, data: {}, ...overrides };
}

function failure(value: unknown): WardenError {
  if (typeof value === "object" && value !== null && "ok" in value && value.ok === false) {
    return value as WardenError;
  }
  throw new Error(`expected a WardenError, got ${JSON.stringify(value)}`);
}

function success<T>(value: T | WardenError): T {
  if (typeof value === "object" && value !== null && "ok" in value) {
    throw new Error(`expected success, got ${JSON.stringify(value)}`);
  }
  return value as T;
}

/** Registry with an injectable clock and capacity. */
function setup(options: { maxWatches?: number; capacity?: number } = {}) {
  let clock = Date.parse("2026-10-01T00:00:00.000Z");
  const bus = createEventBus({ capacity: options.capacity ?? 100 });
  const registry = createWatchRegistry({
    bus,
    maxWatches: options.maxWatches ?? 20,
    now: () => clock,
  });
  return {
    bus,
    registry,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("watch lifecycle — cursor semantics (plan §7.4)", () => {
  it("starts at the current head: only future events are delivered", async () => {
    const { bus, registry } = setup();
    bus.push(draft()); // already happened before the watch existed

    const watch = success(registry.create({ name: "live", filter: {} }));
    expect(watch.cursor).toBe(1);

    bus.push(draft());
    const read = success(await registry.read({ name: "live" }));
    expect(read.events.map((event) => event.seq)).toEqual([2]);
    expect(read.cursor).toBe(2);
    expect(read.idle).toBe(false);
  });

  it("advances the cursor and never delivers an event twice", async () => {
    const { bus, registry } = setup();
    success(registry.create({ name: "w", filter: {} }));
    bus.push(draft());

    const first = success(await registry.read({ name: "w" }));
    expect(first.events).toHaveLength(1);
    const second = success(await registry.read({ name: "w" }));
    expect(second.events).toEqual([]);
    expect(second.idle).toBe(true);
    expect(second.cursor).toBe(first.cursor);
  });

  it("a since bound makes the first read return buffered history", async () => {
    const { bus, registry } = setup();
    bus.push(draft({ authorId: ALICE }));
    bus.push(draft({ channelId: OTHER_CH }));
    bus.push(draft({ authorId: ALICE }));

    success(
      registry.create({ name: "w", filter: { types: ["messageCreate"], authorId: ALICE } }),
    );
    const read = success(await registry.read({ name: "w" }));
    // No since → head-only …
    expect(read.events).toEqual([]);
    // … and no false eviction flag: cursor-0 against an *unwrapped* ring
    // (oldestSeq 1) is a clean history read, not a gap.
    expect(read.evictedCount).toBe(0);

    success(
      registry.create({
        name: "history",
        filter: { types: ["messageCreate"], authorId: ALICE, sinceSeq: 0 },
      }),
    );
    const history = success(await registry.read({ name: "history" }));
    // … with since_seq=0 the matching slice from the buffer comes back.
    expect(history.events.map((event) => event.seq)).toEqual([1, 3]);
    expect(history.evictedCount).toBe(0);
  });

  it("filters by channel, author, wildcard type and message id", async () => {
    const { bus, registry } = setup();
    success(
      registry.create({
        name: "w",
        filter: { types: ["message*"], channelId: CH },
      }),
    );
    bus.push(draft({ type: "messageReactionAdd" }));
    bus.push(draft({ channelId: OTHER_CH }));
    bus.push(draft());

    const read = success(await registry.read({ name: "w" }));
    expect(read.events.map((event) => event.type)).toEqual([
      "messageReactionAdd",
      "messageCreate",
    ]);
  });

  it("flags events evicted past the cursor between reads", async () => {
    const { bus, registry } = setup({ capacity: 3 });
    success(registry.create({ name: "w", filter: {} }));

    bus.push(draft()); // seq 1
    const first = success(await registry.read({ name: "w" }));
    expect(first.evictedCount).toBe(0);

    // seqs 2..5; the ring of 3 now holds only 3..5 — seq 2 was never read.
    for (let i = 0; i < 4; i++) bus.push(draft());
    const second = success(await registry.read({ name: "w" }));
    expect(second.events.map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(second.evictedCount).toBe(1);
  });

  it("flags evicted history for a since-based watch on its very first read", async () => {
    const { bus, registry } = setup({ capacity: 3 });
    for (let i = 0; i < 4; i++) bus.push(draft()); // seqs 1..4; ring holds 2..4

    // since_seq starts the watch at cursor 0 — the case a cursor>0 guard
    // would miss, and the one an agent most needs flagged.
    success(registry.create({ name: "w", filter: { sinceSeq: 0 } }));
    const read = success(await registry.read({ name: "w" }));
    expect(read.events.map((event) => event.seq)).toEqual([2, 3, 4]);
    expect(read.evictedCount).toBe(1); // seq 1 was already gone
  });
});

describe("watch long-polling — block_ms (plan §7.4/§8.1)", () => {
  it("wakes early on a matching push instead of waiting out the timeout", async () => {
    const { bus, registry } = setup();
    success(registry.create({ name: "w", filter: { channelId: CH } }));

    const started = Date.now();
    const pending = registry.read({ name: "w", blockMs: 5_000 });
    setTimeout(() => bus.push(draft()), 15);
    const read = success(await pending);

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(read.events.map((event) => event.seq)).toEqual([1]);
    expect(read.idle).toBe(false);
  });

  it("ignores non-matching pushes while blocked, then times out idle", async () => {
    const { bus, registry } = setup();
    success(registry.create({ name: "w", filter: { channelId: CH } }));

    const pending = registry.read({ name: "w", blockMs: 40 });
    bus.push(draft({ channelId: OTHER_CH, type: "guildMemberAdd" }));
    const read = success(await pending);

    expect(read.events).toEqual([]);
    expect(read.idle).toBe(true);
  });

  it("block_ms: 0 returns immediately", async () => {
    const { registry } = setup();
    success(registry.create({ name: "w", filter: {} }));
    const started = Date.now();
    const read = success(await registry.read({ name: "w", blockMs: 0 }));
    expect(Date.now() - started).toBeLessThan(100);
    expect(read.idle).toBe(true);
  });

  it("sees ring eviction that happened while it was blocked", async () => {
    const { bus, registry } = setup({ capacity: 3 });
    success(registry.create({ name: "w", filter: { channelId: CH } }));

    // While the read waits: seqs 1..4 do not match and are evicted by the
    // wrap; seq 5 matches and wakes it. The count must reflect the wrap that
    // happened *during* the wait, not the (empty) buffer at wait start.
    const pending = registry.read({ name: "w", blockMs: 5_000 });
    setTimeout(() => {
      for (let i = 0; i < 4; i++) bus.push(draft({ channelId: OTHER_CH }));
      bus.push(draft());
    }, 15);
    const read = success(await pending);

    expect(read.events.map((event) => event.seq)).toEqual([5]);
    // Ring holds 3..5; cursor was 0 → seqs 1 and 2 were lost unseen.
    expect(read.evictedCount).toBe(2);
  });
});

describe("watch lifecycle — expiry, caps, removal", () => {
  it("expires 30 idle minutes after the last read (lazily)", async () => {
    const { bus, registry, advance } = setup();
    success(registry.create({ name: "w", filter: {} }));
    bus.push(draft());
    success(await registry.read({ name: "w" })); // activity resets the clock

    advance(WATCH_IDLE_MS - 1_000);
    expect(registry.list()).toHaveLength(1);

    advance(2_000); // past the idle window since the read
    expect(registry.list()).toEqual([]);
    expect(failure(await registry.read({ name: "w" })).error).toBe("not_found");
    expect(failure(registry.remove("w")).error).toBe("not_found");
  });

  it("an expired watch frees its slot for a new one", async () => {
    const { registry, advance } = setup({ maxWatches: 1 });
    success(registry.create({ name: "first", filter: {} }));

    const rejected = failure(registry.create({ name: "second", filter: {} }));
    expect(rejected.error).toBe("invalid_input");
    expect(rejected.remediation).toContain("WARDEN_MAX_WATCHES");

    advance(WATCH_IDLE_MS + 1_000);
    expect(success(registry.create({ name: "second", filter: {} })).name).toBe("second");
  });

  it("rejects a duplicate name instead of replacing a live watch", () => {
    const { registry } = setup();
    success(registry.create({ name: "mod-log", filter: {} }));
    const duplicate = failure(registry.create({ name: "mod-log", filter: {} }));
    expect(duplicate.error).toBe("invalid_input");
    expect(duplicate.message).toContain("mod-log");
  });

  it("rejects an empty name", () => {
    const { registry } = setup();
    expect(failure(registry.create({ name: "   ", filter: {} })).error).toBe("invalid_input");
  });

  it("removes a watch by name", () => {
    const { registry } = setup();
    success(registry.create({ name: "w", filter: {} }));
    expect(success(registry.remove("w"))).toEqual({ watch_id: "w", removed: true });
    expect(registry.list()).toEqual([]);
  });

  it("lists summaries with cursor and idle time", async () => {
    const { bus, registry, advance } = setup();
    success(registry.create({ name: "w", filter: { types: ["message*"] } }));
    bus.push(draft());
    success(await registry.read({ name: "w" }));
    advance(6_000);

    const [summary] = registry.list();
    expect(summary).toMatchObject({
      watch_id: "w",
      name: "w",
      cursor: 1,
      idle_seconds: 6,
    });
    expect(summary?.filter.types).toEqual(["message*"]);
  });
});

describe("waitOnce — the one-shot wait (plan §8.1 wait_for_event)", () => {
  it("returns the first future match, whatever the buffer already held", async () => {
    const { bus, registry } = setup();
    bus.push(draft()); // history must not satisfy the wait

    const pending = registry.waitOnce({ filter: { channelId: CH }, timeoutMs: 5_000 });
    setTimeout(() => {
      bus.push(draft({ channelId: OTHER_CH })); // no match
      bus.push(draft({ authorId: ALICE })); // match
    }, 15);
    const result = await pending;

    expect(result.timeout).toBe(false);
    expect(result.event?.seq).toBe(3);
    expect(result.event?.authorId).toBe(ALICE);
  });

  it("times out with timeout:true and a null event", async () => {
    const { registry } = setup();
    const started = Date.now();
    const result = await registry.waitOnce({ filter: {}, timeoutMs: 30 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    expect(result).toEqual({ event: null, timeout: true });
  });

  it("creates no watch and consumes nothing", async () => {
    const { bus, registry } = setup();
    bus.push(draft());
    const result = await registry.waitOnce({ filter: {}, timeoutMs: 10 });
    expect(result.timeout).toBe(true);
    // Nothing was registered, and the buffer is untouched.
    expect(registry.list()).toEqual([]);
    expect(bus.size).toBe(1);
  });
});
