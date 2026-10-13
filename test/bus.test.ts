/**
 * Phase 5 — the event ring buffer (plan §7.4; §11's `bus.test.ts` row).
 *
 * What this pins: the stamp contract (monotonic seq, derived id, capture
 * time), ring wrap-around without seq reuse, tail-vs-paging reads, both
 * `since` semantics (seq and wall-clock), filter matching over every id
 * field plus wildcards, subscriber delivery — and the plan §4 contract that
 * a token-shaped string never survives ingest.
 */

import { describe, expect, it } from "vitest";

import { createEventBus } from "../src/events/bus.js";
import type { EventBus, EventQuery } from "../src/events/bus.js";
import type { EventDraft } from "../src/events/types.js";

const GUILD = "300000000000000001";
const CHANNEL = "400000000000000001";
const OTHER_CHANNEL = "400000000000000002";
const ALICE = "100000000000000001";
const MESSAGE = "500000000000000001";

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return { type: "messageCreate", data: {}, ...overrides };
}

/** Bus with a clock that advances one second per push, for `since` tests. */
function tickingBus(capacity = 50) {
  let tick = 0;
  const base = Date.parse("2026-10-01T00:00:00.000Z");
  const bus = createEventBus({
    capacity,
    now: () => new Date(base + (tick++) * 1000),
  });
  return { bus, base };
}

describe("createEventBus — stamps", () => {
  it("stamps seq from 1, derives the id, and records the capture time", () => {
    const { bus, base } = tickingBus();
    const first = bus.push(draft());
    const second = bus.push(draft());

    expect(first).toMatchObject({ seq: 1, id: "ev_1", type: "messageCreate" });
    expect(first.at).toBe(new Date(base).toISOString());
    expect(second).toMatchObject({ seq: 2, id: "ev_2" });
    expect(bus.seq).toBe(2);
    expect(bus.size).toBe(2);
    expect(bus.oldestSeq).toBe(1);
  });

  it("keeps the optional fields absent rather than null", () => {
    const { bus } = tickingBus();
    const event = bus.push(draft({ guildId: GUILD }));
    expect(event.guildId).toBe(GUILD);
    expect(event.channelId).toBeNull();
    expect(event.authorId).toBeNull();
    expect("targetId" in event).toBe(false);
    expect("messageId" in event).toBe(false);
  });

  it("does not reset or reuse seq across ring wrap-around", () => {
    const { bus } = tickingBus(3);
    for (let i = 0; i < 5; i++) bus.push(draft());

    expect(bus.size).toBe(3);
    expect(bus.seq).toBe(5);
    expect(bus.oldestSeq).toBe(3);
    // Old history is gone, but the sequence still says where it stood —
    // cursors stay meaningful, they just point at evicted history.
    const { events, cursor } = bus.query({ afterSeq: 0 });
    expect(events.map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(cursor).toBe(5);
  });
});

describe("createEventBus — queries", () => {
  it("returns the tail (newest `limit`, ascending) when unbounded", () => {
    const { bus } = tickingBus();
    for (let i = 0; i < 10; i++) bus.push(draft());

    const { events, cursor } = bus.query({ limit: 3 });
    expect(events.map((event) => event.seq)).toEqual([8, 9, 10]);
    expect(cursor).toBe(10);
  });

  it("pages forward oldest-first from afterSeq and stops at the limit", () => {
    const { bus } = tickingBus();
    for (let i = 0; i < 5; i++) bus.push(draft());

    const firstPage = bus.query({ afterSeq: 0, limit: 2 });
    expect(firstPage.events.map((event) => event.seq)).toEqual([1, 2]);
    const secondPage = bus.query({ afterSeq: firstPage.cursor, limit: 2 });
    expect(secondPage.events.map((event) => event.seq)).toEqual([3, 4]);
  });

  it("keeps the requested cursor when a page comes back empty", () => {
    const { bus } = tickingBus();
    bus.push(draft());
    expect(bus.query({ afterSeq: 1 }).cursor).toBe(1);
    expect(bus.query({ afterSeq: 0, filter: { types: ["nope"] } }).cursor).toBe(0);
  });

  it("converts a wall-clock since into a seq cursor (cursorFor)", () => {
    const { bus, base } = tickingBus();
    for (let i = 0; i < 4; i++) bus.push(draft());

    // base+1s is the timestamp of seq 2.
    const cursor = bus.cursorFor(new Date(base + 1000).toISOString());
    expect(cursor).toBe(2);
    // Before every event → 0; after every event → head.
    expect(bus.cursorFor("2020-01-01T00:00:00.000Z")).toBe(0);
    expect(bus.cursorFor("2030-01-01T00:00:00.000Z")).toBe(4);
  });

  it("applies since from a cursorFor conversion without skipping the middle", () => {
    const { bus, base } = tickingBus();
    for (let i = 0; i < 5; i++) bus.push(draft());
    const afterSeq = bus.cursorFor(new Date(base).toISOString());
    const { events } = bus.query({ afterSeq, filter: { since: new Date(base).toISOString() } });
    // seq 1 is at `base` itself; `since` is exclusive → 2..5.
    expect(events.map((event) => event.seq)).toEqual([2, 3, 4, 5]);
  });

  it("clamps limit to 1..200", () => {
    const { bus } = tickingBus();
    for (let i = 0; i < 5; i++) bus.push(draft());
    expect(bus.query({ limit: 0 }).events).toHaveLength(1);
    expect(bus.query({ limit: 10_000 }).events).toHaveLength(5);
  });
});

describe("createEventBus — filter matching (plan §7.4)", () => {
  function seeded() {
    const { bus } = tickingBus();
    bus.push(
      draft({
        type: "messageCreate",
        guildId: GUILD,
        channelId: CHANNEL,
        authorId: ALICE,
        messageId: MESSAGE,
      }),
    );
    bus.push(
      draft({ type: "messageReactionAdd", guildId: GUILD, channelId: OTHER_CHANNEL, authorId: ALICE, messageId: MESSAGE }),
    );
    bus.push(draft({ type: "guildMemberAdd", guildId: GUILD, targetId: ALICE }));
    bus.push(draft({ type: "messageCreate", guildId: null, channelId: null })); // a DM
    return bus;
  }

  const types = (bus: EventBus, query: Omit<EventQuery, "afterSeq">) =>
    bus.query({ afterSeq: 0, ...query }).events.map((event) => event.type);

  it("matches exact types and `prefix*` wildcards", () => {
    const bus = seeded();
    expect(types(bus, { filter: { types: ["messageCreate"] } })).toEqual([
      "messageCreate",
      "messageCreate",
    ]);
    expect(types(bus, { filter: { types: ["message*"] } })).toEqual([
      "messageCreate",
      "messageReactionAdd",
      "messageCreate",
    ]);
    // OR across entries.
    expect(types(bus, { filter: { types: ["guildMemberAdd", "messageReactionAdd"] } })).toEqual([
      "messageReactionAdd",
      "guildMemberAdd",
    ]);
  });

  it("matches the id fields, and a null guild never matches a guild filter", () => {
    const bus = seeded();
    expect(types(bus, { filter: { channelId: CHANNEL } })).toEqual(["messageCreate"]);
    expect(types(bus, { filter: { guildId: GUILD } })).toEqual([
      "messageCreate",
      "messageReactionAdd",
      "guildMemberAdd",
    ]);
    expect(types(bus, { filter: { authorId: ALICE } })).toEqual([
      "messageCreate",
      "messageReactionAdd",
    ]);
    expect(types(bus, { filter: { targetId: ALICE } })).toEqual(["guildMemberAdd"]);
    // One message across its creation and its reaction — §7.4's use case.
    expect(types(bus, { filter: { messageId: MESSAGE } })).toEqual([
      "messageCreate",
      "messageReactionAdd",
    ]);
  });

  it("applies sinceSeq exclusively", () => {
    const bus = seeded();
    expect(types(bus, { filter: { sinceSeq: 2 } })).toEqual(["guildMemberAdd", "messageCreate"]);
  });
});

describe("createEventBus — scrub at ingest (plan §4)", () => {
  it("redacts token-shaped strings and webhook paths inside data", () => {
    const { bus } = tickingBus();
    const tokenish =
      "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZabcd.12345678." +
      "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
    const event = bus.push(
      draft({
        targetId: tokenish,
        data: {
          content:
            "deploy with ABCDEFGHIJKLMNOPQRSTUVWXYZabcd.12345678." +
            "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF now",
          nested: {
            url: "https://discord.com/api/webhooks/1234567890/secret-token-abc",
          },
          count: 7,
        },
      }),
    );

    const serialized = JSON.stringify(event.data);
    expect(serialized).not.toMatch(
      /[A-Za-z0-9_-]{18,48}\.[A-Za-z0-9_-]{4,16}\.[A-Za-z0-9_-]{20,64}/,
    );
    expect(serialized).not.toContain("secret-token-abc");
    // Non-string values pass through untouched.
    expect(event.data.count).toBe(7);
    // The stamped id fields are scrubbed too — not only `data` — so no
    // future extractor can smuggle free text past the ingest choke point.
    expect(event.targetId).not.toMatch(
      /[A-Za-z0-9_-]{18,48}\.[A-Za-z0-9_-]{4,16}\.[A-Za-z0-9_-]{20,64}/,
    );
  });
});

describe("createEventBus — subscribers", () => {
  it("delivers pushes in order and stops after unsubscribe", () => {
    const { bus } = tickingBus();
    const seen: number[] = [];
    const off = bus.subscribe((event) => seen.push(event.seq));
    bus.push(draft());
    off();
    bus.push(draft());
    expect(seen).toEqual([1]);
  });

  it("contains a throwing listener instead of losing the event", () => {
    const errors: unknown[] = [];
    const bus = createEventBus({
      capacity: 10,
      onListenerError: (error) => errors.push(error),
    });
    bus.subscribe(() => {
      throw new Error("listener bug");
    });
    const event = bus.push(draft());
    expect(event.seq).toBe(1);
    expect(bus.size).toBe(1);
    expect(errors).toHaveLength(1);
  });
});
