/**
 * Phase 6 — the read tools (plan §8, §12 done-when).
 *
 * Two things are pinned here, in this order:
 *
 *  - **Schema introspection**: every Phase 6 tool's field builders accept the
 *    shapes an agent actually has and reject the rest *before* a Discord
 *    round-trip. The cursor builder (`optionalCursor`) gets its own block
 *    because it is the one builder that accepts two different shapes.
 *  - **Behaviour**, driven against real discord.js objects built from raw
 *    payloads — the same rule `tools.test.ts`, `guards.test.ts` and
 *    `serialize.test.ts` follow. Every REST-backed read is stubbed at the
 *    narrowest seam for that read (`rest.get`, `messages.fetch`'s route,
 *    `members.search`, `threads.fetchArchived`), so what is under test is
 *    Warden's contract: the options it sends, the payload it shapes, the
 *    failure it returns when Discord says no.
 *
 * The `list_archived` cursor tests are the reason this file exists in that
 * shape: discord.js silently *drops* an unresolvable `before` rather than
 * erroring, which looks exactly like a working cursor that always returns
 * page one. A test that only checks the happy path would never notice.
 */

import { DiscordAPIError } from "@discordjs/rest";
import type { DiscordErrorData } from "@discordjs/rest";
import {
  AuditLogEvent,
  CategoryChannel,
  Collection,
  GuildMember,
  OverwriteType,
  PermissionFlagsBits,
  PermissionOverwrites,
  ThreadChannel,
  User,
} from "discord.js";
import type {
  FetchedThreadsMore,
  PublicThreadChannel,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { manageChannel } from "../src/tools/channels.js";
import { isCursor, optionalCursor } from "../src/tools/context.js";
import type { ToolContext } from "../src/tools/context.js";
import { getAuditLog } from "../src/tools/guild.js";
import { getMember, getUser, listMembers } from "../src/tools/members.js";
import { getMessages, searchMessages } from "../src/tools/messages.js";
import { manageRole } from "../src/tools/roles.js";
import type { RoleListData } from "../src/tools/roles.js";
import { manageThread } from "../src/tools/threads.js";

import {
  BOT_ID,
  GENERAL,
  GUILD_ID,
  MEMBER_ID,
  OWNER_ID,
  THREAD,
  VOICE,
  WARDEN_ROLE,
  construct,
  expectFailure,
  expectNotes,
  expectOk,
  makeContext,
} from "./fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function guildOf(ctx: ToolContext) {
  const guild = ctx.discord.client.guilds.cache.get(GUILD_ID);
  if (guild === undefined) throw new Error("fixture guild is missing");
  return guild;
}

/**
 * The one-server setup plan §8 assumes: `WARDEN_GUILD_ID` names the guild, so
 * a read can be called without repeating `guild_id` on every call — which is
 * also the path a real deployment takes, so the default is exercised here
 * rather than being hidden behind an explicit argument.
 */
function makeCtx(): ToolContext {
  return makeContext({
    config: loadConfig({
      DISCORD_BOT_TOKEN: "unit-test-token",
      WARDEN_GUILD_ID: GUILD_ID,
    }),
  });
}

/** `#general` — the one fixture channel that owns a `.threads` manager. */
function parentOf(ctx: ToolContext) {
  const channel = guildOf(ctx).channels.cache.get(GENERAL);
  if (channel === undefined || !("threads" in channel)) {
    throw new Error("fixture parent channel is missing");
  }
  return channel;
}

/** A channel id no fixture declares — unknown ids must not be *valid* ids. */
const MISSING_CHANNEL = "400000000000000099";
const MISSING_USER = "500000000000000099";

const BODY = { body: undefined, files: [] };

/** The Discord 404s the two member/user reads have to translate. */
function discord404(code: number, message: string): DiscordAPIError {
  return new DiscordAPIError(
    { code, message } as DiscordErrorData,
    code,
    404,
    "GET",
    `/guilds/${GUILD_ID}`,
    BODY,
  );
}

/** The `query` of the n-th request a stubbed `client.rest.get` received. */
function queryOf(
  spy: { mock: { calls: unknown[][] } },
  index = 0,
): URLSearchParams {
  const options = spy.mock.calls[index]?.[1] as
    | { query?: URLSearchParams }
    | undefined;
  return options?.query ?? new URLSearchParams();
}

/**
 * Realistic-looking but fake token — the plan §4 obligation every read
 * payload carries, so a regression here fails a test instead of leaking.
 */
const TOKEN_SHAPED =
  "leak ABCDEFGHIJKLMNOPQRSTUVWXYZabcd.12345678." +
  "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
const TOKEN_RE =
  /[A-Za-z0-9_-]{18,48}\.[A-Za-z0-9_-]{4,16}\.[A-Za-z0-9_-]{20,64}/;

// ---------------------------------------------------------------------------
// optionalCursor — the paged-cursor field builder
// ---------------------------------------------------------------------------

describe("optionalCursor", () => {
  const schema = optionalCursor("Cursor to page backwards from.");

  it("accepts both shapes a previous page can hand back", () => {
    // A snowflake: what `before` has always meant on message and audit pages.
    expect(schema.safeParse("900000000000000001").success).toBe(true);
    // …and an ISO8601 archive timestamp, which is what Discord's *archived
    // thread* routes actually filter on (see threads.ts's file header).
    expect(schema.safeParse("2024-01-31T12:00:00.000Z").success).toBe(true);
  });

  it("rejects anything else before a Discord round-trip", () => {
    expect(schema.safeParse("general").success).toBe(false);
    expect(schema.safeParse("2024-01-31").success).toBe(false);
    expect(schema.safeParse("").success).toBe(false);
    expect(schema.safeParse(undefined).success).toBe(true);
  });

  it("shares one definition of 'cursor' with the tool that resolves it", () => {
    expect(isCursor("900000000000000001")).toBe(true);
    expect(isCursor("2024-01-31T12:00:00.000Z")).toBe(true);
    expect(isCursor("not-a-cursor")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// manage_channel
// ---------------------------------------------------------------------------

describe("manage_channel", () => {
  it("lists postable channels in position order, without threads", async () => {
    const ctx = makeCtx();
    const data = expectOk(await manageChannel(ctx, { action: "list" }));
    const channels = data.channels as { id: string }[];
    expect(channels.map((channel) => channel.id)).toEqual([GENERAL, VOICE]);
    expect(data.count).toBe(2);
  });

  it("describes one channel, and flags when it is really a thread", async () => {
    const ctx = makeCtx();
    const general = expectOk(
      await manageChannel(ctx, { action: "get", channel_id: GENERAL }),
    );
    expect(general.channel).toMatchObject({ id: GENERAL, topic: "talk here" });

    const thread = await manageChannel(ctx, {
      action: "get",
      channel_id: THREAD,
    });
    expect(expectOk(thread).channel).toMatchObject({ id: THREAD });
    expect(expectNotes(thread).join(" ")).toMatch(/is a thread/);
  });

  it("names the missing argument and the unknown id distinctly", async () => {
    const ctx = makeCtx();
    const missing = expectFailure(await manageChannel(ctx, { action: "get" }));
    expect(missing.error).toBe("invalid_input");
    expect(missing.remediation).toMatch(/action 'list'/);

    const unknown = expectFailure(
      await manageChannel(ctx, { action: "get", channel_id: MISSING_CHANNEL }),
    );
    expect(unknown.error).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// manage_thread
// ---------------------------------------------------------------------------

describe("manage_thread", () => {
  /** Stub the archived-threads route and hand back the spy for assertions. */
  function stubArchived(
    ctx: ToolContext,
    fetched: Partial<FetchedThreadsMore> = {},
  ) {
    const parent = parentOf(ctx);
    return vi.spyOn(parent.threads, "fetchArchived").mockResolvedValue({
      threads: new Collection(),
      members: new Collection(),
      hasMore: false,
      ...fetched,
    } as FetchedThreadsMore);
  }

  /** An archived thread of `#general`, cached exactly as discord.js caches it. */
  function addArchivedThread(ctx: ToolContext, id: string, archivedAt: string) {
    const guild = guildOf(ctx);
    // `PublicThreadChannel<false>` rather than the base `ThreadChannel<boolean>`:
    // the caches below are typed against the concrete kinds, and a base-typed
    // thread carries `createdTimestamp: number | null` where they expect a
    // definite timestamp.
    const thread = construct<PublicThreadChannel<false>>(
      ThreadChannel,
      guild,
      {
        id,
        type: 11,
        name: "old-thread",
        parent_id: GENERAL,
        owner_id: OWNER_ID,
        message_count: 0,
        total_message_sent: 0,
        flags: 0,
        member_count: 1,
        thread_metadata: {
          archived: true,
          archive_timestamp: archivedAt,
          auto_archive_duration: 1440,
        },
      },
      ctx.discord.client,
    );
    // One cache, not two: `resolveArchivedBefore` resolves the cursor through
    // `resolveChannel`, which reads the guild's channel cache (threads live
    // there — see `cachedThreads`), so that is the only one that must hold it.
    guild.channels.cache.set(thread.id, thread);
    return thread;
  }

  it("lists active threads from the gateway cache", async () => {
    const ctx = makeCtx();
    const data = expectOk(await manageThread(ctx, { action: "list" }));
    expect((data.threads as { id: string }[]).map((thread) => thread.id)).toEqual(
      [THREAD],
    );
    expect(data.fromCache).toBe(true);

    const other = expectOk(
      await manageThread(ctx, { action: "list", channel_id: VOICE }),
    );
    expect(other.count).toBe(0);
  });

  it("says plainly that the cache list has no cursor when a page fills up", async () => {
    const ctx = makeCtx();
    // A second active thread so `limit: 1` genuinely truncates — the note's
    // gate is "something was cut", not "the page happens to be full": a
    // cache holding exactly `limit` threads has no rest to see, and claiming
    // one would send an agent narrowing filters for nothing.
    const guild = guildOf(ctx);
    const second = construct<PublicThreadChannel<false>>(
      ThreadChannel,
      guild,
      {
        id: "900000000000000082",
        type: 11,
        name: "second-thread",
        parent_id: GENERAL,
        owner_id: OWNER_ID,
        message_count: 0,
        total_message_sent: 0,
        flags: 0,
        member_count: 1,
        thread_metadata: { archived: false, auto_archive_duration: 1440 },
        last_message_id: null,
      },
      ctx.discord.client,
    );
    guild.channels.cache.set(second.id, second);

    const truncated = await manageThread(ctx, { action: "list", limit: 1 });
    expect(expectOk(truncated).count).toBe(1);
    const note = expectNotes(truncated).join(" ");
    // The old wording suggested a *smaller* limit would "see more" — it shows
    // fewer — and implied paging that this action does not have.
    expect(note).toMatch(/no cursor/);
    expect(note).toMatch(/raise `limit`/);
    expect(note).not.toMatch(/smaller limit/);

    // …and with room for every match, no "rest" exists to point at.
    const complete = await manageThread(ctx, { action: "list", limit: 100 });
    expect(expectOk(complete).count).toBe(2);
    expect(expectNotes(complete).join(" ")).not.toMatch(/no cursor/);
  });

  it("refuses to guess a guild-wide archived list", async () => {
    const ctx = makeCtx();
    const spy = stubArchived(ctx);
    const error = expectFailure(
      await manageThread(ctx, { action: "list_archived" }),
    );
    expect(error.error).toBe("invalid_input");
    expect(error.message).toMatch(/per parent channel/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes an ISO archive timestamp straight through as `before`", async () => {
    const ctx = makeCtx();
    const spy = stubArchived(ctx);
    const cursor = "2024-06-01T00:00:00.000Z";

    const result = await manageThread(ctx, {
      action: "list_archived",
      channel_id: GENERAL,
      before: cursor,
    });

    expect(expectOk(result).before).toBe(cursor);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "public", before: cursor }),
    );
  });

  it("resolves a cached thread id into the archive timestamp Discord wants", async () => {
    const ctx = makeCtx();
    const spy = stubArchived(ctx);
    const thread = addArchivedThread(
      ctx,
      "900000000000000077",
      "2024-06-01T00:00:00.000Z",
    );

    await manageThread(ctx, {
      action: "list_archived",
      channel_id: GENERAL,
      before: thread.id,
    });

    // Not the id: Discord's archived routes page by `archive_timestamp`, and
    // discord.js converts ids by cache lookup — passing it through would make
    // the cursor depend on library internals Warden does not control.
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ before: "2024-06-01T00:00:00.000Z" }),
    );
  });

  it("fails an unresolvable id instead of silently re-serving page one", async () => {
    const ctx = makeCtx();
    const spy = stubArchived(ctx);

    const error = expectFailure(
      await manageThread(ctx, {
        action: "list_archived",
        channel_id: GENERAL,
        before: MISSING_CHANNEL,
      }),
    );

    // The regression this suite exists for: discord.js drops an unresolvable
    // `before` (`if (toUse) query.set(...)`) and returns page 1 forever, which
    // reads as a cursor that works. Here it is a failure naming the field that
    // does work.
    expect(spy).not.toHaveBeenCalled();
    expect(error.error).toBe("invalid_input");
    expect(error.remediation).toMatch(/archiveTimestamp/);
  });

  it("rejects a shape-valid timestamp that names no real instant", async () => {
    const ctx = makeCtx();
    const spy = stubArchived(ctx);

    // Both ways `Date.parse` lies: NaN for the unparseable (whose
    // `toISOString()` would escape as a bare RangeError — outside `attempt()`'s
    // mapping, i.e. "the tool threw"), and a silent roll-forward for the
    // impossible date (2024-02-30 → March 1), which would shift the page
    // boundary without telling anyone. The zod shape check accepts both, so
    // the tool must not.
    for (const before of ["2024-13-45T99:99:99Z", "2024-02-30T00:00:00Z"]) {
      const error = expectFailure(
        await manageThread(ctx, {
          action: "list_archived",
          channel_id: GENERAL,
          before,
        }),
      );
      expect(error.error).toBe("invalid_input");
      expect(error.remediation).toMatch(/archiveTimestamp/);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("asks Discord for every private archived thread, not just joined ones", async () => {
    const ctx = makeCtx();
    const spy = stubArchived(ctx);

    await manageThread(ctx, {
      action: "list_archived",
      channel_id: GENERAL,
      type: "private",
    });

    // discord.js' default (`fetchAll: false`) routes `private` to
    // `/users/@me/threads/archived/private` — only threads the *bot* joined —
    // while this tool's ManageThreads note describes the full list.
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "private", fetchAll: true }),
    );

    const result = await manageThread(ctx, {
      action: "list_archived",
      channel_id: GENERAL,
      type: "private",
    });
    expect(expectNotes(result).join(" ")).toMatch(/ManageThreads/);
  });

  it("does not send fetchAll for public threads", async () => {
    const ctx = makeCtx();
    const spy = stubArchived(ctx);

    await manageThread(ctx, {
      action: "list_archived",
      channel_id: GENERAL,
      type: "public",
    });

    const [options] = spy.mock.calls[0] as [Record<string, unknown>];
    expect(options.type).toBe("public");
    expect("fetchAll" in options).toBe(false);
  });

  it("returns the parent, the echoed cursor, and a full-page hint", async () => {
    const ctx = makeCtx();
    const archived = addArchivedThread(
      ctx,
      "900000000000000078",
      "2024-05-01T00:00:00.000Z",
    );
    stubArchived(ctx, {
      threads: new Collection([[archived.id, archived]]),
      hasMore: true,
    });

    const result = await manageThread(ctx, {
      action: "list_archived",
      channel_id: GENERAL,
      limit: 1,
    });

    const data = expectOk(result);
    expect(data.parentId).toBe(GENERAL);
    expect(data.before).toBeNull();
    expect((data.threads as { id: string }[]).map((thread) => thread.id)).toEqual(
      [archived.id],
    );
    // The next page's cursor is this page's oldest archive — with one
    // thread, that thread's own archive time.
    expect(data.nextBefore).toBe("2024-05-01T00:00:00.000Z");
    expect(expectNotes(result).join(" ")).toMatch(/page further back/);
  });

  it("orders archived threads by archive time, not by id", async () => {
    const ctx = makeCtx();
    // Id order and archive order deliberately disagree: the *newer* thread
    // was archived first. Sorting by id (as `list` does) would put the
    // older-archived thread last, and its `archiveTimestamp` is not the page
    // minimum — an agent following the paging note would re-fetch part of
    // the page it just read.
    const newerArchived = addArchivedThread(
      ctx,
      "900000000000000080",
      "2024-06-01T00:00:00.000Z",
    );
    const olderArchived = addArchivedThread(
      ctx,
      "900000000000000081",
      "2024-01-01T00:00:00.000Z",
    );
    stubArchived(ctx, {
      threads: new Collection([
        [olderArchived.id, olderArchived],
        [newerArchived.id, newerArchived],
      ]),
      hasMore: true,
    });

    const result = await manageThread(ctx, {
      action: "list_archived",
      channel_id: GENERAL,
    });
    const data = expectOk(result);

    // Newest archive first — the order Discord's own route pages in.
    expect(
      (data.threads as { id: string }[]).map((thread) => thread.id),
    ).toEqual([newerArchived.id, olderArchived.id]);
    // …so the last element's archive time is the page minimum, which is
    // exactly what `nextBefore` offers for the next page back.
    expect(data.nextBefore).toBe("2024-01-01T00:00:00.000Z");
    expect(expectNotes(result).join(" ")).toMatch(/nextBefore/);
  });

  it("reads a thread member by user id", async () => {
    const ctx = makeCtx();
    // Stubbed at `rest.get` rather than on `thread.members.fetch` so discord.js'
    // own single-member path runs: it resolves `{member, withMember, force}`
    // down to `GET /threads/{id}/members/{user}` and rebuilds the ThreadMember
    // from the wire shape below.
    const rest = vi.spyOn(ctx.discord.client.rest, "get").mockResolvedValue({
      user_id: OWNER_ID,
      join_timestamp: "2026-01-01T00:00:00.000Z",
      flags: 1,
    });

    const data = expectOk(
      await manageThread(ctx, {
        action: "get_member",
        thread_id: THREAD,
        user_id: OWNER_ID,
      }),
    );

    expect(rest).toHaveBeenCalledTimes(1);
    // `withMember: true` is what makes the payload carry a member record.
    expect(queryOf(rest).get("with_member")).toBe("true");
    expect(data).toMatchObject({
      threadId: THREAD,
      // `ThreadMember#id` is the *user's* id, which is what was asked for.
      userId: OWNER_ID,
      joinedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("names both arguments get_member needs", async () => {
    const ctx = makeCtx();
    const error = expectFailure(
      await manageThread(ctx, { action: "get_member", thread_id: THREAD }),
    );
    expect(error.error).toBe("invalid_input");
    expect(error.message).toMatch(/both thread_id and user_id/);
  });

  it("rejects a non-thread id rather than reporting a text channel", async () => {
    const ctx = makeCtx();
    const error = expectFailure(
      await manageThread(ctx, {
        action: "get_member",
        channel_id: GENERAL,
        thread_id: GENERAL,
        user_id: OWNER_ID,
      }),
    );
    expect(error.error).toBe("invalid_input");
    expect(error.message).toMatch(/is not a thread/);
  });
});

// ---------------------------------------------------------------------------
// manage_role
// ---------------------------------------------------------------------------

describe("manage_role", () => {
  it("lists roles highest first and reports Warden's own position", async () => {
    const ctx = makeCtx();
    const result = await manageRole(ctx, { action: "list" });
    const data = expectOk(result) as unknown as RoleListData;

    expect(data.roles.map((role) => role.name)).toEqual([
      "Moderator",
      "Warden",
      "@everyone",
    ]);
    expect(data.warden).toMatchObject({ topRoleId: WARDEN_ROLE });
    // The one role above Warden — the whole reason this payload exists.
    expect(data.warden?.rolesAbove.map((role) => role.name)).toEqual([
      "Moderator",
    ]);
    expect(expectNotes(result).join(" ")).toMatch(/role_hierarchy/);
  });

  it("says the verdict is unavailable instead of implying none", async () => {
    const ctx = makeCtx();
    guildOf(ctx).members.cache.delete(BOT_ID);

    const result = await manageRole(ctx, { action: "list" });
    const data = expectOk(result) as unknown as RoleListData;

    expect(data.roles).toHaveLength(3);
    expect(data.warden).toBeNull();
    expect(expectNotes(result).join(" ")).toMatch(/no hierarchy verdict/);
  });
});

// ---------------------------------------------------------------------------
// list_members
// ---------------------------------------------------------------------------

describe("list_members", () => {
  it("lists the cached members in id order", async () => {
    const ctx = makeCtx();
    const data = expectOk(await listMembers(ctx, {}));
    expect((data.members as { id: string }[]).map((member) => member.id)).toEqual(
      [OWNER_ID, MEMBER_ID, BOT_ID],
    );
    expect(data.count).toBe(3);
  });

  it("flags a partial gateway cache rather than reporting a short list as truth", async () => {
    const ctx = makeCtx();
    guildOf(ctx).memberCount = 5;

    const result = await listMembers(ctx, {});
    const data = expectOk(result);

    expect(data.count).toBe(3);
    expect(expectNotes(result).join(" ")).toMatch(/Only 3 of 5 members are cached/);
  });

  it("filters by role from the cache", async () => {
    const ctx = makeCtx();
    const data = expectOk(await listMembers(ctx, { role_id: WARDEN_ROLE }));
    expect((data.members as { id: string }[]).map((member) => member.id)).toEqual(
      [BOT_ID],
    );
  });

  it("pages forward with `after`", async () => {
    const ctx = makeCtx();
    const data = expectOk(await listMembers(ctx, { after: MEMBER_ID }));
    expect((data.members as { id: string }[]).map((member) => member.id)).toEqual(
      [BOT_ID],
    );
  });

  it("pages across id lengths without silently dropping the longer ones", async () => {
    const ctx = makeCtx();
    const guild = guildOf(ctx);
    // A 19-digit id (what Discord issues today) beside the fixture's
    // 18-digit ones. The regression: a length-first *sort* paired with a
    // lexicographic *filter* excludes it whenever the cursor's first digit
    // is higher ("1100…" < "7000…" as strings, but longer as ids) — the page
    // then reads as "no more members" instead of as a hole. Real guilds mix
    // 2015-era and post-2022 ids, so this is the normal case, not a corner.
    const newer = construct<GuildMember>(
      GuildMember,
      ctx.discord.client,
      {
        user: {
          id: "1100000000000000001",
          username: "newbie",
          discriminator: "0",
        },
        roles: [],
        joined_at: "2026-01-01T00:00:00.000Z",
      },
      guild,
    );
    guild.members.cache.set(newer.id, newer);

    const data = expectOk(
      await listMembers(ctx, { after: "700000000000000000" }),
    );

    // Every fixture id (18 digits, first digit ≤ 2) is below the cursor;
    // the 19-digit id is above it no matter how its string starts.
    expect(
      (data.members as { id: string }[]).map((member) => member.id),
    ).toEqual(["1100000000000000001"]);
  });

  it("says in_voice is answered from the cache, not from Discord", async () => {
    const ctx = makeCtx();
    const result = await listMembers(ctx, { in_voice: true });
    const data = expectOk(result);

    expect(data.count).toBe(0);
    expect(expectNotes(result).join(" ")).toMatch(/gateway cache/);
  });

  it("sends `query` to Discord and says the cache filters do not apply", async () => {
    const ctx = makeCtx();
    const guild = guildOf(ctx);
    const bob = guild.members.cache.get(MEMBER_ID);
    if (bob === undefined) throw new Error("fixture member is missing");
    const search = vi
      .spyOn(guild.members, "search")
      .mockResolvedValue(new Collection([[MEMBER_ID, bob]]));

    const result = await listMembers(ctx, { query: "bo", limit: 10 });
    const data = expectOk(result);

    expect(search).toHaveBeenCalledWith({ query: "bo", limit: 10 });
    expect(data.query).toBe("bo");
    expect((data.members as { id: string }[]).map((member) => member.id)).toEqual(
      [MEMBER_ID],
    );
    expect(expectNotes(result).join(" ")).toMatch(/not applied to its results/);
  });
});

// ---------------------------------------------------------------------------
// get_member
// ---------------------------------------------------------------------------

describe("get_member", () => {
  it("reports roles, permissions and a hierarchy verdict", async () => {
    const ctx = makeCtx();
    const data = expectOk(await getMember(ctx, { user_id: MEMBER_ID }));

    expect(data.member).toMatchObject({ id: MEMBER_ID });
    // `@everyone` is seeded into every member's role cache and deliberately
    // dropped — an agent can neither assign nor remove it.
    expect(data.roles).toEqual([]);
    expect(data.hierarchy).toMatchObject({ canAct: true });
    expect(data.isOwner).toBe(false);
    expect(data.inVoice).toBe(false);
    expect((data.effectivePermissions as string[]).length).toBeGreaterThan(0);
  });

  it("reports the owner as protected rather than only failing later", async () => {
    const ctx = makeCtx();
    const data = expectOk(await getMember(ctx, { user_id: OWNER_ID }));

    expect(data.isOwner).toBe(true);
    expect(data.hierarchy).toMatchObject({
      canAct: false,
      reason: "target_protected",
      target: { protected: "owner" },
    });
  });

  it("can scope effective permissions to one channel", async () => {
    const ctx = makeCtx();
    const guildWide = expectOk(await getMember(ctx, { user_id: MEMBER_ID }));
    const inChannel = expectOk(
      await getMember(ctx, { user_id: MEMBER_ID, channel_id: GENERAL }),
    );
    const guildWidePermissions = guildWide.effectivePermissions as string[];
    const channelPermissions = inChannel.effectivePermissions as string[];

    // Baseline: @everyone (and so bob) can post in the guild.
    expect(guildWidePermissions).toContain("SendMessages");
    expect(Array.isArray(channelPermissions)).toBe(true);

    // …and an overwrite on `#general` is what the channel-scoped list is
    // computed from — without it the two lists would agree for the wrong
    // reason (neither would have consulted the channel).
    const channel = guildOf(ctx).channels.cache.get(GENERAL);
    if (channel === undefined || !("permissionOverwrites" in channel)) {
      throw new Error("fixture channel is missing");
    }
    const overwrite = construct<PermissionOverwrites>(
      PermissionOverwrites,
      ctx.discord.client,
      {
        id: GUILD_ID,
        type: OverwriteType.Role,
        allow: "0",
        deny: String(PermissionFlagsBits.SendMessages),
      },
      channel,
    );
    channel.permissionOverwrites.cache.set(GUILD_ID, overwrite);

    const scoped = expectOk(
      await getMember(ctx, { user_id: MEMBER_ID, channel_id: GENERAL }),
    );
    const scopedPermissions = scoped.effectivePermissions as string[];
    expect(scopedPermissions).toContain("ViewChannel");
    expect(scopedPermissions).not.toContain("SendMessages");

    const unknown = expectFailure(
      await getMember(ctx, {
        user_id: MEMBER_ID,
        channel_id: MISSING_CHANNEL,
      }),
    );
    expect(unknown.error).toBe("not_found");
  });

  it("maps a Discord 404 for an uncached member onto not_found", async () => {
    const ctx = makeCtx();
    vi.spyOn(guildOf(ctx).members, "fetch").mockRejectedValue(
      discord404(10_007, "Unknown Member"),
    );

    const error = expectFailure(await getMember(ctx, { user_id: MISSING_USER }));
    expect(error.error).toBe("not_found");
    expect(error.message).toMatch(/member/);
  });
});

// ---------------------------------------------------------------------------
// get_user
// ---------------------------------------------------------------------------

describe("get_user", () => {
  it("fetches a global user without needing a guild", async () => {
    const ctx = makeCtx();
    const user = construct<User>(
      User,
      ctx.discord.client,
      { id: MISSING_USER, username: "carol", discriminator: "0" },
    );
    const fetch = vi
      .spyOn(ctx.discord.client.users, "fetch")
      .mockResolvedValue(user);

    const data = expectOk(await getUser(ctx, { user_id: MISSING_USER }));

    expect(fetch).toHaveBeenCalledWith(MISSING_USER);
    expect(data.user).toMatchObject({ id: MISSING_USER, username: "carol" });
  });

  it("maps an id Discord does not know onto not_found", async () => {
    const ctx = makeCtx();
    vi.spyOn(ctx.discord.client.users, "fetch").mockRejectedValue(
      discord404(10_013, "Unknown User"),
    );

    const error = expectFailure(await getUser(ctx, { user_id: MISSING_USER }));
    expect(error.error).toBe("not_found");
    expect(error.message).toMatch(/user/);
  });
});

// ---------------------------------------------------------------------------
// get_messages
// ---------------------------------------------------------------------------

describe("get_messages", () => {
  const wireMessage = (id: string, content: string) => ({
    id,
    channel_id: GENERAL,
    guild_id: GUILD_ID,
    type: 0,
    content,
    timestamp: "2026-01-01T00:00:00.000Z",
    edited_timestamp: null,
    tts: false,
    pinned: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    author: { id: MEMBER_ID, username: "bob", discriminator: "0" },
  });

  it("returns the history newest first and forwards the cursor", async () => {
    const ctx = makeCtx();
    const rest = vi
      .spyOn(ctx.discord.client.rest, "get")
      .mockResolvedValue([
        wireMessage("900000000000000001", "older"),
        wireMessage("900000000000000002", "newer"),
      ]);

    const data = expectOk(
      await getMessages(ctx, {
        channel_id: GENERAL,
        before: "900000000000000005",
        limit: 10,
      }),
    );

    const messages = data.messages as { id: string; content: string }[];
    expect(messages.map((message) => message.id)).toEqual([
      "900000000000000002",
      "900000000000000001",
    ]);
    expect(data.count).toBe(2);

    expect(rest).toHaveBeenCalledTimes(1);
    const query = queryOf(rest);
    expect(query.get("limit")).toBe("10");
    expect(query.get("before")).toBe("900000000000000005");
    expect(query.get("after")).toBeNull();
  });

  it("refuses two cursors instead of letting Discord guess", async () => {
    const ctx = makeCtx();
    const rest = vi.spyOn(ctx.discord.client.rest, "get");

    const error = expectFailure(
      await getMessages(ctx, {
        channel_id: GENERAL,
        before: "900000000000000005",
        after: "900000000000000001",
      }),
    );

    expect(error.error).toBe("invalid_input");
    expect(error.message).toMatch(/at most one of before, after or around/);
    expect(rest).not.toHaveBeenCalled();
  });

  it("refuses a channel that has no message history", async () => {
    const ctx = makeCtx();
    // A category: `isTextBased()` is false, so there is no `.messages` to
    // read. Built here rather than in the shared fixture because the other
    // suites count channels.
    const guild = guildOf(ctx);
    const category = construct<CategoryChannel>(
      CategoryChannel,
      guild,
      {
        id: MISSING_CHANNEL,
        type: 4,
        name: "category",
        position: 5,
        permission_overwrites: [],
      },
      ctx.discord.client,
    );
    guild.channels.cache.set(category.id, category);
    const rest = vi.spyOn(ctx.discord.client.rest, "get");

    const error = expectFailure(
      await getMessages(ctx, { channel_id: category.id }),
    );

    expect(error.error).toBe("invalid_input");
    expect(error.message).toMatch(/no message history/);
    expect(rest).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// search_messages
// ---------------------------------------------------------------------------

describe("search_messages", () => {
  const hit = (id: string, content: string) => ({
    id,
    channel_id: GENERAL,
    type: 0,
    content,
    timestamp: "2026-01-01T00:00:00.000Z",
    edited_timestamp: null,
    tts: false,
    pinned: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    author: { id: OWNER_ID, username: "alice", discriminator: "0" },
  });

  it("returns each match as a message and forwards the query", async () => {
    const ctx = makeCtx();
    const rest = vi
      .spyOn(ctx.discord.client.rest, "get")
      .mockResolvedValue({
        total_results: 2,
        // What Discord documents today: one match per group, no surrounding
        // context ("surrounding context is no longer returned" —
        // discord-api-types, APIMessageSearchResult.messages).
        messages: [
          [hit("900000000000000001", "deploy is failing")],
          [hit("900000000000000002", "deployed at dawn")],
        ],
      });

    const data = expectOk(
      await searchMessages(ctx, { query: "deploy", limit: 5 }),
    );

    expect(data.ready).toBe(true);
    expect(data.totalResults).toBe(2);
    const messages = data.hits as { content: string; guildId: string }[];
    expect(messages.map((message) => message.content)).toEqual([
      "deploy is failing",
      "deployed at dawn",
    ]);
    expect(messages[0]?.guildId).toBe(GUILD_ID);

    const query = queryOf(rest);
    expect(query.get("content")).toBe("deploy");
    expect(query.get("limit")).toBe("5");
    expect(query.get("offset")).toBe("0");
  });

  it("trusts the wire's `hit` marker over a group's position", async () => {
    const ctx = makeCtx();
    // The older group shape — match plus context — must not leak the context
    // into the matches: the marker says which entry matched, and position
    // (which the wire never guaranteed) is not a substitute for it.
    vi.spyOn(ctx.discord.client.rest, "get").mockResolvedValue({
      total_results: 1,
      messages: [
        [
          { ...hit("900000000000000001", "deploy is failing"), hit: true },
          hit("900000000000000002", "same here"),
        ],
      ],
    });

    const data = expectOk(await searchMessages(ctx, { query: "deploy" }));
    const messages = data.hits as { id: string; content: string }[];
    expect(messages.map((message) => message.id)).toEqual([
      "900000000000000001",
    ]);
  });

  it("keeps matches from unmarked groups alongside marked ones", async () => {
    const ctx = makeCtx();
    // A mixed response: some groups carry the marker, some do not. A global
    // "any marker anywhere" rule would discard every match in the unmarked
    // groups — the same silent-drop shape as the pagination bug, just
    // conditional on what the wire chooses to mark.
    vi.spyOn(ctx.discord.client.rest, "get").mockResolvedValue({
      total_results: 3,
      messages: [
        [{ ...hit("900000000000000001", "deploy failed"), hit: true }],
        [hit("900000000000000002", "deployed at dawn")],
        [hit("900000000000000003", "deploying now")],
      ],
    });

    const data = expectOk(await searchMessages(ctx, { query: "deploy" }));
    expect(
      (data.hits as { id: string }[]).map((message) => message.id),
    ).toEqual([
      "900000000000000001",
      "900000000000000002",
      "900000000000000003",
    ]);
    expect(data.count).toBe(3);
  });

  it("notes when a deep historical index makes the matches incomplete", async () => {
    const ctx = makeCtx();
    vi.spyOn(ctx.discord.client.rest, "get").mockResolvedValue({
      total_results: 1,
      doing_deep_historical_index: true,
      messages: [[hit("900000000000000001", "deploy is failing")]],
    });

    const result = await searchMessages(ctx, { query: "deploy" });
    const data = expectOk(result);

    // Real hits, but "complete" would be a lie while older history is still
    // being indexed — the same partial-reads-as-complete failure
    // `list_members` refuses for a partial cache.
    expect(data.ready).toBe(true);
    expect((data.hits as unknown[]).length).toBe(1);
    expect(expectNotes(result).join(" ")).toMatch(/deep-indexing/);
  });

  it("reports Discord's indexing delay as a success, not as 'no matches'", async () => {
    const ctx = makeCtx();
    const rest = vi.spyOn(ctx.discord.client.rest, "get").mockResolvedValue({
      code: 110_000,
      message: "Search index not ready",
      documents_indexed: 4,
      retry_after: 30,
    });

    const result = await searchMessages(ctx, { query: "deploy" });
    const data = expectOk(result);

    // The call worked — a failure would send the agent hunting for a
    // permission, and an empty hit list would read as "nothing matched".
    expect(data.ready).toBe(false);
    expect(data.totalResults).toBe(0);
    expect(data.hits).toEqual([]);
    expect(data.documentsIndexed).toBe(4);
    expect(data.retryAfterSeconds).toBe(30);
    expect(expectNotes(result).join(" ")).toMatch(/not finished indexing/);
    expect(rest).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// get_audit_log
// ---------------------------------------------------------------------------

describe("get_audit_log", () => {
  const RAW_BAN = {
    id: "900000000000000010",
    action_type: AuditLogEvent.MemberBanAdd,
    user_id: OWNER_ID,
    target_id: MEMBER_ID,
    reason: "raid account",
    changes: [{ key: "nick", old_value: "bob", new_value: "bobby" }],
  };

  function stubAudit(ctx: ToolContext) {
    return vi.spyOn(ctx.discord.client.rest, "get").mockResolvedValue({
      audit_log_entries: [RAW_BAN],
      auto_moderation_rules: [],
      guild_scheduled_events: [],
    });
  }

  it("maps the action name to Discord's number and back again", async () => {
    const ctx = makeCtx();
    const rest = stubAudit(ctx);

    const data = expectOk(await getAuditLog(ctx, { action_type: "MemberBanAdd" }));

    // Out: the name is what goes back into `action_type` on the next call.
    expect(data.entries).toHaveLength(1);
    const [entry] = data.entries as {
      action: string;
      executorId: string | null;
      executor: unknown;
      targetId: string | null;
      reason: string | null;
      changes: { key: string; old: unknown; new: unknown }[];
      at: string;
    }[];
    expect(entry?.action).toBe("MemberBanAdd");
    expect(entry?.targetId).toBe(MEMBER_ID);
    expect(entry?.reason).toBe("raid account");
    expect(entry?.changes).toEqual([
      { key: "nick", old: "bob", new: "bobby" },
    ]);
    expect(entry?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The executor is a real user here — discord.js resolves it out of the
    // user cache — and the id accompanies it either way.
    expect(entry?.executor).toMatchObject({ id: OWNER_ID, username: "alice" });
    expect(entry?.executorId).toBe(OWNER_ID);

    // In: the name arrives as Discord's number.
    const query = queryOf(rest);
    expect(query.get("action_type")).toBe(String(AuditLogEvent.MemberBanAdd));
  });

  it("accepts the numeric spelling of an action too", async () => {
    const ctx = makeCtx();
    const rest = stubAudit(ctx);

    await getAuditLog(ctx, { action_type: String(AuditLogEvent.MemberBanAdd) });

    expect(queryOf(rest).get("action_type")).toBe(
      String(AuditLogEvent.MemberBanAdd),
    );
  });

  it("rejects an action Discord has no name for, naming ones that exist", async () => {
    const ctx = makeCtx();
    const rest = vi.spyOn(ctx.discord.client.rest, "get");

    const error = expectFailure(
      await getAuditLog(ctx, { action_type: "MemberExplode" }),
    );

    expect(error.error).toBe("invalid_input");
    expect(error.remediation).toMatch(/MemberBanAdd/);
    expect(rest).not.toHaveBeenCalled();
  });

  it("keeps the executor's id when Discord sends no usable user object", async () => {
    const ctx = makeCtx();
    // discord.js resolves the executor out of the *user* cache, so a user it
    // can no longer look up yields `executor: null`. `executorId` is why the
    // payload can still name who acted — without it an audit entry whose only
    // job is evidence would lose its actor.
    ctx.discord.client.users.cache.delete(OWNER_ID);
    stubAudit(ctx);

    const data = expectOk(await getAuditLog(ctx, {}));
    const [entry] = data.entries as {
      executor: unknown;
      executorId: string | null;
    }[];
    expect(entry?.executor).toBeNull();
    expect(entry?.executorId).toBe(OWNER_ID);
  });

  it("narrows to target_id in-process and says the page was filtered", async () => {
    const ctx = makeCtx();
    stubAudit(ctx);

    const matching = await getAuditLog(ctx, { target_id: MEMBER_ID });
    expect(expectOk(matching).count).toBe(1);
    expect(expectNotes(matching)).toEqual([]);

    const other = await getAuditLog(ctx, { target_id: MISSING_USER });
    const data = expectOk(other);
    expect(data.count).toBe(0);
    expect(expectNotes(other).join(" ")).toMatch(/no server-side target filter/);
  });

  it("forwards the executor and cursor filters to Discord", async () => {
    const ctx = makeCtx();
    const rest = stubAudit(ctx);

    const result = await getAuditLog(ctx, {
      user_id: OWNER_ID,
      before: "900000000000000099",
      limit: 1,
    });

    const query = queryOf(rest);
    expect(query.get("user_id")).toBe(OWNER_ID);
    expect(query.get("before")).toBe("900000000000000099");
    expect(query.get("limit")).toBe("1");
    // A cursor is already set, so "page further back" would be noise.
    expect(expectNotes(result)).toEqual([]);
  });

  it("hints to page further when a full page has no cursor yet", async () => {
    const ctx = makeCtx();
    stubAudit(ctx);

    const result = await getAuditLog(ctx, { limit: 1 });

    expect(expectNotes(result).join(" ")).toMatch(/page further back/);
  });
});

// ---------------------------------------------------------------------------
// plan §4 — every Phase 6 read scrubs on the way out
// ---------------------------------------------------------------------------

describe("readOk — scrubbing on every Phase 6 read", () => {
  it("scrubs a token-shaped channel topic in a read payload", async () => {
    const ctx = makeCtx();
    const channel = guildOf(ctx).channels.cache.get(GENERAL);
    if (channel === null || channel === undefined) {
      throw new Error("fixture channel is missing");
    }
    (channel as { topic: string | null }).topic = TOKEN_SHAPED;

    const data = expectOk(
      await manageChannel(ctx, { action: "get", channel_id: GENERAL }),
    );

    expect((data.channel as { topic: string }).topic).toBe(
      "leak [redacted-token]",
    );
    expect(JSON.stringify(data)).not.toMatch(TOKEN_RE);
  });

  it("scrubs a token-shaped role name in both payload and note", async () => {
    const ctx = makeCtx();
    const role = guildOf(ctx).roles.cache.get(WARDEN_ROLE);
    if (role === undefined) throw new Error("fixture role is missing");
    role.name = TOKEN_SHAPED;

    const result = await manageRole(ctx, { action: "list" });
    const data = expectOk(result);
    const notes = expectNotes(result).join(" ");

    expect(JSON.stringify(data)).not.toMatch(TOKEN_RE);
    // A note quoting the role name carries the same free text the payload
    // does, so it is scrubbed by the same call.
    expect(notes).toContain("[redacted-token]");
    expect(notes).not.toMatch(TOKEN_RE);
  });

  it("scrubs a token-shaped message body returned by a history read", async () => {
    const ctx = makeCtx();
    vi.spyOn(ctx.discord.client.rest, "get").mockResolvedValue([
      {
        id: "900000000000000003",
        channel_id: GENERAL,
        guild_id: GUILD_ID,
        type: 0,
        content: TOKEN_SHAPED,
        timestamp: "2026-01-01T00:00:00.000Z",
        edited_timestamp: null,
        tts: false,
        pinned: false,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
        author: { id: MEMBER_ID, username: "bob", discriminator: "0" },
      },
    ]);

    const data = expectOk(await getMessages(ctx, { channel_id: GENERAL }));
    const [message] = data.messages as { content: string }[];

    expect(message?.content).toBe("leak [redacted-token]");
    expect(JSON.stringify(data)).not.toMatch(TOKEN_RE);
  });
});
