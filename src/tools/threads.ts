/**
 * Threads domain (plan §8.4).
 *
 * Phase 6 ships the read half — `list`, `list_archived` and `get_member`.
 * The mutation half (`create`/`edit`/`delete`/`join`/`leave`/
 * `add_member`/`remove_member`) is Phase 7's `manage_thread` and widens this
 * same tool rather than adding a second one.
 *
 * Three Discord/discord.js facts shape these reads, and each one is answered
 * in the payload instead of being papered over:
 *
 * * **There is no `guild.threads`.** discord.js hangs threads off their
 *   parent (`channel.threads`) and off the guild's *channel* cache; the only
 *   guild-level REST call is `guild.channels.fetchActiveThreads()`. `list`
 *   therefore reads `guild.channels.cache` and never touches the network —
 *   the gateway keeps active threads current (THREAD_CREATE/UPDATE/DELETE and
 *   threadListSync), so a REST round-trip would buy nothing but latency.
 * * **Archived threads are per-parent-channel only.** Discord has no
 *   guild-wide archived endpoint (`/guilds/{id}/threads/active` exists;
 *   `/guilds/{id}/threads/archived/*` does not) — the archived routes are
 *   `GET /channels/{id}/threads/archived/{public|private}`. So `list_archived`
 *   *requires* `channel_id`. Asking for it without one gets `invalid_input`
 *   that says exactly this, rather than a silent empty list that reads as
 *   "nothing is archived".
 * * **Archived paging is on `archive_timestamp`, not a snowflake.** Discord's
 *   `before` for those routes is an ISO8601 timestamp. discord.js accepts a
 *   thread id instead by resolving it against its cache — and *drops the
 *   parameter entirely* when the id is not cached, so a cursor from before a
 *   restart would quietly re-fetch page one forever. {@link resolveArchivedBefore}
 *   converts it here, where a miss becomes an error that names the field to
 *   use instead (`archiveTimestamp`, which every returned thread carries).
 *   Same reason `private` passes `fetchAll: true`: discord.js' default routes
 *   to `/users/@me/threads/archived/private`, which only lists threads the
 *   *bot* joined, while the ManageThreads note this tool gives describes
 *   `/threads/archived/private` — every private archived thread.
 * * **`ThreadMember` exposes `thread`, not `threadId`, and `guildMember`, not
 *   `member`** (the latter is private). The mapping is here rather than
 *   guessed at by a caller.
 *
 * plan §8.4's `archived` flag for `list` is realised as the separate
 * `list_archived` action the same table already names — one action that
 * answers "active, from cache" and one that answers "archived, from Discord"
 * is a clearer contract than a boolean that silently changes which system is
 * being queried.
 */

import { ChannelType } from "discord.js";
import type { Guild, GuildBasedChannel, ThreadChannel } from "discord.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { resolveChannel, resolveGuild } from "../discord/guards.js";
import { isWardenError } from "../discord/errors.js";
import type { WardenError } from "../discord/errors.js";
import {
  serializeBitField,
  serializeChannel,
  serializeMember,
} from "../discord/serializers/index.js";
import { fail } from "../shared/result.js";
import type { ToolResult } from "../shared/result.js";
import { compareSnowflakes, isSnowflake } from "../shared/ids.js";
import {
  attempt,
  isCursor,
  optionalCursor,
  optionalId,
  parseCursorTime,
  readOk,
  toCallToolResult,
} from "./context.js";
import type { ToolContext } from "./context.js";

/**
 * Newest first — ids embed their creation time, so this is real recency
 * ordering rather than cache iteration order. {@link compareSnowflakes} does
 * the length-first part: a plain lexicographic compare puts a 17-digit id
 * after a 19-digit one, which would order 2015's oldest threads as newest.
 */
function byNewest(a: { id: string }, b: { id: string }): number {
  return compareSnowflakes(b.id, a.id);
}

/**
 * Threads visible in this guild's channel cache.
 *
 * `AnyThreadChannel` rather than `ThreadChannel`-only is what
 * `isThread()` narrows to; threads and channels share one cache, which is
 * also why `manage_channel`'s list filters them out.
 */
function cachedThreads(guild: Guild): ThreadChannel[] {
  const out: ThreadChannel[] = [];
  for (const channel of guild.channels.cache.values()) {
    if (channel.isThread()) out.push(channel);
  }
  return out;
}

/**
 * Which half of Discord's archived endpoints to call.
 *
 * `public` covers news *and* public threads (both live under
 * `/threads/archived/public`); `private` is its own endpoint and needs
 * ManageThreads in the parent.
 */
function isPrivate(thread: ThreadChannel): boolean {
  return thread.type === ChannelType.GuildPrivateThread;
}

export async function manageThread(
  ctx: ToolContext,
  args: {
    action: "list" | "list_archived" | "get_member";
    guild_id?: string;
    channel_id?: string;
    thread_id?: string;
    user_id?: string;
    type?: "public" | "private";
    before?: string;
    limit?: number;
  },
): Promise<ToolResult> {
  const guild = resolveGuild(
    ctx.discord,
    args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
  );
  if (isWardenError(guild)) return guild;

  if (args.action === "list") {
    const limit = args.limit ?? 50;
    const all = cachedThreads(guild);
    const matching = all
      .filter((thread) => !thread.archived)
      .filter(
        (thread) =>
          args.channel_id === undefined || thread.parentId === args.channel_id,
      )
      .filter((thread) => {
        if (args.type === undefined) return true;
        // Mirrors Discord's own public/private split: private threads are a
        // distinct channel type, everything else is publicly readable.
        return args.type === "private" ? isPrivate(thread) : !isPrivate(thread);
      })
      .sort(byNewest);
    const threads = matching
      .slice(0, limit)
      // Serialize *before* `readOk`: a live ThreadChannel carries `guild`,
      // `client` and a parent back-reference, and `scrubData` walks whatever
      // it is handed. Handing it a serializer output is the difference
      // between scrubbing a name and traversing the whole object graph.
      .map((thread) => serializeChannel(thread));

    const notes: string[] = [];
    const archivedCount = all.filter((thread) => thread.archived).length;
    if (archivedCount > 0) {
      notes.push(
        `${archivedCount} archived thread(s) are excluded from this cache-based list — action 'list_archived' reads them from Discord, one parent channel at a time.`,
      );
    }
    // Gated on truncation, not on a full page: a cache holding exactly
    // `limit` threads has no rest to see, and saying so would send an agent
    // narrowing filters for nothing.
    if (matching.length > threads.length) {
      notes.push(
        "This page is full and this cache list has no cursor: raise `limit` (max 100), or narrow with `channel_id`/`type`, to see the rest.",
      );
    }
    return readOk(
      "thread.list",
      { threads, count: threads.length, limit, fromCache: true },
      notes,
    );
  }

  if (args.action === "list_archived") {
    // No parent channel, no endpoint — see the file header.
    if (args.channel_id === undefined) {
      return fail({
        error: "invalid_input",
        message:
          "manage_thread 'list_archived' needs a channel_id — Discord only exposes archived threads per parent channel.",
        remediation:
          "Pass channel_id (the text/forum/announcement channel the threads belonged to). Discord has no guild-wide archived-thread endpoint; to sweep a whole server, call this once per channel — manage_channel's 'list' gives you the ids.",
      });
    }

    const parent = resolveChannel(guild, args.channel_id);
    if (isWardenError(parent)) return parent;
    const parentWithThreads = requireThreadParent(parent, args.channel_id);
    if (isWardenError(parentWithThreads)) return parentWithThreads;

    const limit = args.limit ?? 50;
    const type = args.type ?? "public";

    const before =
      args.before === undefined
        ? undefined
        : resolveArchivedBefore(args.before, parentWithThreads, guild);
    if (isWardenError(before)) return before;

    const fetched = await attempt(() =>
      parentWithThreads.threads.fetchArchived({
        type,
        limit,
        // See the file header: discord.js' default (`fetchAll: false`) routes
        // `private` to `/users/@me/threads/archived/private` — only threads
        // the *bot* joined — while the ManageThreads note below describes
        // `/threads/archived/private`, which is every private thread.
        // It also decides *which* `before` shape discord.js forwards, so the
        // cursor has already been resolved to an ISO timestamp above and is
        // passed in the one form no branch of its logic can drop.
        ...(type === "private" ? { fetchAll: true } : {}),
        ...(before !== undefined ? { before } : {}),
      }),
    );
    if (isWardenError(fetched)) return fail(fetched);

    // Discord pages these routes by `archive_timestamp` descending, and that
    // order *is* the paging contract: the note below hands the agent the last
    // element's `archiveTimestamp` as the next cursor. Re-sorting by id (as
    // `list` does) would make the last element the oldest-*created* thread,
    // whose archive time is not the page minimum — following that cursor
    // would re-fetch threads this page already returned.
    const page = [...fetched.threads.values()]
      .sort((a, b) => (b.archiveTimestamp ?? 0) - (a.archiveTimestamp ?? 0))
      .slice(0, limit);
    const threads = page
      // Same reason as `list`: the fetched threads are live objects.
      .map((thread) => serializeChannel(thread));

    // The cursor for the page after this one — the oldest archive time on
    // this page (the last element, now that the order is archive-desc), or
    // null on an empty page. Millisecond precision because discord.js'
    // `archiveTimestamp` is a parsed ms value — and the wire sees ms anyway:
    // `fetchArchived` re-encodes any non-snowflake `before` to milliseconds
    // (see `resolveArchivedBefore`), so a fuller-precision timestamp from an
    // earlier page is truncated at that boundary, not here.
    const lastArchivedAt = page.at(-1)?.archiveTimestamp ?? null;
    const nextBefore =
      lastArchivedAt === null ? null : new Date(lastArchivedAt).toISOString();

    const notes: string[] = [];
    if (fetched.hasMore) {
      notes.push(
        "There are more archived threads: pass `before` with `nextBefore` (this page's oldest archiveTimestamp) to page further back.",
      );
    }
    if (type === "private") {
      notes.push(
        "Private archived threads need ManageThreads in the parent channel — an empty result there usually means Warden lacks that permission rather than that nothing exists.",
      );
    }
    return readOk(
      "thread.list_archived",
      {
        threads,
        count: threads.length,
        limit,
        type,
        parentId: parentWithThreads.id,
        before: before ?? null,
        nextBefore,
      },
      notes,
    );
  }

  // action === "get_member"
  //
  // Hoisted into `const`s *before* the guard: TypeScript does not carry a
  // property narrowing (`args.user_id === undefined` → `string`) into a
  // closure, and the fetch below runs inside `attempt()`'s callback. A local
  // is narrowed for good, so `member:` below sees `string`, not
  // `string | undefined`.
  const threadId = args.thread_id;
  const userId = args.user_id;
  if (threadId === undefined || userId === undefined) {
    return fail({
      error: "invalid_input",
      message:
        "manage_thread with action 'get_member' needs both thread_id and user_id.",
      remediation:
        "Pass thread_id (the thread to inspect) and user_id (the member to look up).",
    });
  }

  const channel = resolveChannel(guild, threadId);
  if (isWardenError(channel)) return channel;
  const thread = asThread(channel, threadId);
  if (isWardenError(thread)) return thread;

  // `force: true` because thread membership churns (people join and leave,
  // threads archive) and a stale cache entry here would report someone as
  // present after they left. A user who is not in the thread comes back as a
  // 404, which `attempt()` maps to the uniform not_found.
  const fetched = await attempt(() =>
    thread.members.fetch({
      member: userId,
      withMember: true,
      force: true,
    }),
  );
  if (isWardenError(fetched)) return fail(fetched);

  return readOk("thread.get_member", {
    threadId: fetched.thread.id,
    // `ThreadMember#id` is the *user's* id, which is what the caller passed.
    userId: fetched.id,
    joinedAt:
      fetched.joinedTimestamp !== null
        ? new Date(fetched.joinedTimestamp).toISOString()
        : null,
    // `ThreadMemberFlagsBitField` → names; there is no `mute` on a
    // ThreadMember (that is a *voice* state, reported by `get_member`).
    flags: serializeBitField(fetched.flags),
    // Present because `withMember: true` was requested; still typed
    // defensively — a partial thread member arrives without it.
    member: fetched.guildMember ? serializeMember(fetched.guildMember) : null,
  });
}

/**
 * A resolved channel that must be a thread.
 *
 * `resolveChannel` resolves channels *and* threads from one id space (guards
 * documents why), so the type check lives here rather than in the resolver —
 * a caller that asks for a thread should never silently get a text channel.
 */
function asThread(
  channel: GuildBasedChannel,
  channelId: string,
): ThreadChannel | WardenError {
  if (!channel.isThread()) {
    return fail({
      error: "invalid_input",
      message: `Channel ${channelId} is not a thread.`,
      remediation:
        "get_member reads a thread's members — pass a thread id (manage_channel's 'list' shows channels; manage_thread's 'list' shows threads).",
      details: { channelId },
    });
  }
  return channel;
}

/**
 * A resolved channel that can *contain* threads — the parent side of
 * `list_archived`.
 *
 * Narrowing is left to TypeScript rather than spelled out as a return type:
 * after the `isThread()` and `in` guards, the remaining union is exactly the
 * channels discord.js gives a `.threads` manager, so `parent.threads.
 * fetchArchived` below typechecks against the *real* manager signature
 * instead of a hand-written approximation of it.
 */
function requireThreadParent(
  channel: GuildBasedChannel,
  channelId: string,
) {
  if (channel.isThread()) {
    return fail({
      error: "invalid_input",
      message: `Channel ${channelId} is itself a thread.`,
      remediation:
        "list_archived takes the *parent* channel the threads lived in — pass that channel's id (manage_channel's 'list' shows them).",
      details: { channelId },
    });
  }
  if (!("threads" in channel)) {
    return fail({
      error: "invalid_input",
      message: `Channel ${channelId} has no threads (type ${channel.type}).`,
      remediation:
        "Only text, announcement, forum and media channels can hold threads — pass one of those.",
      details: { channelId, channelType: channel.type },
    });
  }
  return channel;
}

/**
 * Turn `before` into the ISO8601 `archive_timestamp` that Discord's archived
 * routes actually filter on.
 *
 * discord.js performs this conversion itself, but it does so by looking the id
 * up in its own cache and then writing the parameter *only if* the lookup
 * succeeded (`if (toUse) query.set(...)`) — so a cursor from before a restart
 * is dropped and the route quietly re-serves page one, which reads as a
 * working cursor rather than as an error. Resolving here means a miss is a
 * failure that names the field to use instead.
 *
 * Both input shapes are accepted because both are what agents have to hand:
 * `archiveTimestamp` (durable, on every returned thread) and the thread id
 * (what a caller naturally re-passes, valid while it is still cached).
 */
function resolveArchivedBefore(
  before: string,
  parent: GuildBasedChannel,
  guild: Guild,
): string | WardenError {
  if (!isCursor(before)) {
    return fail({
      error: "invalid_input",
      message: `before '${before}' is not a cursor list_archived can page with.`,
      remediation:
        "Pass `archiveTimestamp` from the previous page — every thread list_archived returns carries it, and unlike a thread id it keeps working after a restart.",
      details: { before, parentId: parent.id },
    });
  }

  // Not a snowflake ⇒ the schema already proved the *shape* of an ISO
  // timestamp; prove the date is real before anything converts it.
  // `Date.parse` rolls impossible dates forward (2024-02-30 → March 1)
  // instead of failing, and returns NaN for the unparseable — which
  // `toISOString()` would throw as a bare `RangeError`, outside `attempt()`'s
  // mapping, exactly the failure mode `attempt()` exists to prevent.
  if (!isSnowflake(before)) {
    if (parseCursorTime(before) === null) {
      return fail({
        error: "invalid_input",
        message: `before '${before}' is not a timestamp list_archived can page with.`,
        remediation:
          "Pass `archiveTimestamp` from the previous page — every thread list_archived returns carries it (ISO8601 UTC, e.g. 2024-06-01T00:00:00.000Z).",
        details: { before, parentId: parent.id },
      });
    }
    // Passed through exactly as received — Warden does not re-encode it —
    // but the ceiling is not here: discord.js' `fetchArchived` re-encodes a
    // non-snowflake `before` with `new Date(before).toISOString()` on its way
    // to the wire, so a microsecond cursor still arrives at Discord truncated
    // to milliseconds (a `nextBefore` from the previous page already is ms).
    return before;
  }

  const resolved = resolveChannel(guild, before);
  if (
    isWardenError(resolved) ||
    !resolved.isThread() ||
    resolved.parentId !== parent.id
  ) {
    return fail({
      error: "invalid_input",
      message: `before '${before}' is not a cached thread of channel ${parent.id}, so Warden cannot derive the archive timestamp Discord pages by.`,
      remediation:
        "Pass `archiveTimestamp` from the previous page instead — a thread id only resolves while that thread is still in the gateway cache.",
      details: { before, parentId: parent.id },
    });
  }

  const archivedAt = resolved.archiveTimestamp;
  if (!resolved.archived || typeof archivedAt !== "number") {
    return fail({
      error: "invalid_input",
      message: `Thread ${before} is not archived, so it cannot serve as a list_archived cursor.`,
      remediation:
        "Page with `archiveTimestamp` from a previous list_archived response — it is the archive time of a thread that is actually archived.",
      details: { before, parentId: parent.id },
    });
  }

  return new Date(archivedAt).toISOString();
}

export function registerThreadTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "manage_thread",
    {
      title: "Manage threads",
      description:
        "Read threads of a server Warden is in. Supported actions: 'list' (active threads from the gateway cache — filterable by parent channel and by public/private, newest first), 'list_archived' (archived threads fetched from Discord; requires channel_id, the parent channel, because Discord has no guild-wide archived endpoint — type public/private, before/limit paging), and 'get_member' (whether one user is in a thread, with their joined-at, flags and member record). Threads are only listed where Warden can see their parent channel.",
      inputSchema: z.object({
        action: z
          .enum(["list", "list_archived", "get_member"])
          .describe(
            "What to do: 'list' active threads from cache, 'list_archived' fetch archived ones from Discord, 'get_member' check one user's membership of a thread.",
          ),
        guild_id: optionalId(
          "Guild to read (default: WARDEN_GUILD_ID, the one-server setup).",
        ),
        channel_id: optionalId(
          "Parent channel: required by 'list_archived', and an optional filter for 'list'. Ignored by 'get_member'.",
        ),
        thread_id: optionalId(
          "Thread to inspect — required for action 'get_member'.",
        ),
        user_id: optionalId(
          "User to look up in the thread — required for action 'get_member'.",
        ),
        type: z
          .enum(["public", "private"])
          .describe(
            "Which threads: 'public' (public + announcement threads) or 'private'. Applies to both list actions.",
          )
          .optional(),
        before: optionalCursor(
          "Cursor to page backwards from ('list_archived' only): the `archiveTimestamp` of the oldest thread from the previous page. A thread id also works while Warden is still running.",
        ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum threads to return (1-100, default 50)."),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await manageThread(ctx, args)),
  );
}
