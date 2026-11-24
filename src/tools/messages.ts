/**
 * Messages domain (plan §8.5) — the read tools `get_messages` and
 * `search_messages`. Everything that writes, deletes, pins or reacts is
 * Phase 7.
 *
 * Both are REST reads, so both run through `attempt()` (tools/context.ts):
 * a 404 or a 50013 from Discord must come back as the uniform structured
 * failure, not as an SDK-level "the tool threw".
 *
 * ## Why a raw-route adapter exists in this file
 *
 * Discord's guild message search has **no discord.js wrapper** —
 * `client.rest.get(Routes.guildMessagesSearch(...))` is the only way in, and
 * what comes back is `APIMessage`: Discord's *wire* shape (`channel_id`,
 * `icon_url`, ISO strings), not discord.js' object graph. Feeding that
 * straight to the serializers would silently produce empty fields, because
 * they read the discord.js spellings.
 *
 * {@link toMessageLike} converts wire → the structural shape the serializers
 * already accept, and it is deliberately narrow: it maps every field the
 * message serializer reads and nothing else. The alternative (a second
 * serializer set for wire shapes) would be two sources of truth for "what a
 * message is", which drifts; this is one mapping, next to the only caller
 * that needs it.
 */

import type {
  APIMessage,
  GuildBasedChannel,
  TextBasedChannel,
} from "discord.js";
import { MessageFlagsBitField, Routes } from "discord.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { resolveChannel, resolveGuild } from "../discord/guards.js";
import { isWardenError } from "../discord/errors.js";
import type { WardenError } from "../discord/errors.js";
import { serializeMessage } from "../discord/serializers/index.js";
import type {
  MessageLike,
  SerializedMessage,
} from "../discord/serializers/index.js";
import { compareSnowflakes } from "../shared/ids.js";
import { fail } from "../shared/result.js";
import type { ToolResult } from "../shared/result.js";
import {
  attempt,
  optionalId,
  readOk,
  requiredId,
  toCallToolResult,
} from "./context.js";
import type { ToolContext } from "./context.js";

// ---------------------------------------------------------------------------
// wire → structural adapters (see the file header)
// ---------------------------------------------------------------------------

function isoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type WireUser = NonNullable<APIMessage["author"]>;

/**
 * The two bodies `GET /guilds/{id}/messages/search` can return.
 *
 * Declared here rather than imported: discord.js re-exports neither
 * `APIMessageSearchResult` nor `APIMessageSearchIndexNotReadyResponse`, and
 * taking `discord-api-types` on as a direct dependency for two interfaces
 * would be a new dependency to satisfy a type-only need.
 *
 * Both are optional-fielded because they share a single cast in
 * `searchMessages` — Discord answers with the *error-shaped* 202 body when
 * the guild is not indexed yet and the result body otherwise, and we cannot
 * narrow between them before reading `code`.
 */
interface SearchNotReadyBody {
  message?: string;
  code?: number;
  documents_indexed?: number;
  retry_after?: number;
}

interface SearchHitBody {
  total_results?: number;
  /**
   * Discord is mid-way through deep-indexing this guild's history — the
   * matches below are real but incomplete. Surfaced as a note: reporting a
   * partial result set as complete is the same failure the members module
   * documents for a partial cache.
   */
  doing_deep_historical_index?: boolean;
  /**
   * Groups of matches. The wire once nested "surrounding context" inside
   * each group; the installed `discord-api-types` documents that context is
   * no longer returned, so a group is normally just its match. Entries may
   * carry a `hit: true` marker — when the wire marks anything, only marked
   * entries count as matches (see `searchMessages`).
   */
  messages?: (APIMessage & { hit?: boolean })[][];
}

function toUserLike(user: WireUser): NonNullable<MessageLike["author"]> {
  return {
    id: user.id,
    username: user.username,
    globalName: user.global_name ?? null,
    discriminator: user.discriminator,
    avatar: user.avatar ?? null,
    // `UserLike` models these as `boolean | undefined` (discord.js always
    // says `false`), while the wire omits them — `undefined` is the honest
    // "not stated", `null` would be a lie about what Discord sent.
    bot: user.bot ?? undefined,
    system: user.system ?? undefined,
    // The wire carries `flags` as a bare integer; `serializeUser` documents
    // that it reports `[]` for that form rather than inventing names.
    flags: user.flags,
    createdTimestamp: null,
  };
}

/**
 * Discord's wire message → the structural {@link MessageLike} the existing
 * serializers read.
 *
 * `?? null` everywhere: search results are trimmed by Discord (no `reactions`
 * key, and a stripped message can arrive with only an id and a channel), and
 * "id + whatever Discord gave us" is the rule plan §7.4 already sets for the
 * event pipeline.
 *
 * `guildId` is a parameter rather than a field read: `APIMessage` has no
 * `guild_id` at all (only gateway `MESSAGE_CREATE` carries it), and this
 * adapter is only ever called for results of a guild-scoped search — so the
 * guild is a fact we already hold, not something to fish out of a shape that
 * does not have it.
 */
export function toMessageLike(
  raw: APIMessage,
  guildId: string | null = null,
): MessageLike {
  return {
    id: raw.id,
    channelId: raw.channel_id,
    guildId,
    type: raw.type ?? null,
    createdTimestamp: isoMs(raw.timestamp),
    editedTimestamp: isoMs(raw.edited_timestamp),
    author: raw.author ? toUserLike(raw.author) : null,
    content: raw.content ?? null,
    pinned: raw.pinned ?? null,
    tts: raw.tts ?? null,
    webhookId: raw.webhook_id ?? null,
    // The wire carries `MessageFlags` as a bare integer; the serializers take
    // a bitfield or a name list. Wrapping (rather than reverse-mapping) keeps
    // unknown future bits honest: `BitField#toArray` returns the names it
    // knows and drops the rest, which is exactly what `serializeBitField`
    // expects as its input.
    flags:
      raw.flags === undefined ? undefined : new MessageFlagsBitField(raw.flags),
    attachments: (raw.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      name: attachment.filename,
      size: attachment.size,
      url: attachment.url,
      proxyURL: attachment.proxy_url,
      contentType: attachment.content_type,
      width: attachment.width,
      height: attachment.height,
      description: attachment.description,
      ephemeral: attachment.ephemeral,
      // The wire spells it `duration_secs` (seconds, as a float) and
      // `AttachmentLike` calls it `duration` — discord.js' naming.
      duration: attachment.duration_secs,
    })),
    embeds: (raw.embeds ?? []).map((embed) => ({
      title: embed.title,
      description: embed.description,
      url: embed.url,
      color: embed.color,
      timestamp: embed.timestamp,
      author: embed.author
        ? {
            name: embed.author.name,
            url: embed.author.url,
            iconURL: embed.author.icon_url,
          }
        : null,
      footer: embed.footer
        ? {
            text: embed.footer.text,
            iconURL: embed.footer.icon_url,
          }
        : null,
      image: embed.image,
      thumbnail: embed.thumbnail,
      video: embed.video,
      provider: embed.provider,
      fields: embed.fields,
    })),
    mentions: {
      everyone: raw.mention_everyone ?? false,
      users: (raw.mentions ?? []).map((user) => toUserLike(user)),
      roles: (raw.mention_roles ?? []).map((id) => ({ id })),
      channels: (raw.mention_channels ?? []).map((mention) => ({
        id: mention.id,
      })),
      // The wire reference carries ids only; the mentioned user object is
      // not in the payload, so `null` is the honest answer here.
      repliedUser: null,
    },
    stickers: (raw.sticker_items ?? []).map((sticker) => ({ id: sticker.id })),
    reference: raw.message_reference
      ? {
          messageId: raw.message_reference.message_id ?? null,
          channelId: raw.message_reference.channel_id ?? null,
          guildId: raw.message_reference.guild_id ?? null,
        }
      : null,
    poll: raw.poll
      ? {
          question: { text: raw.poll.question?.text ?? null },
          // The wire answer id is `answer_id` and the text lives under
          // `poll_media`; the vote count is keyed by that same id in
          // `results.answer_counts`, which is optional (Discord omits results
          // until the first vote lands).
          answers: (raw.poll.answers ?? []).map((answer) => ({
            id: answer.answer_id,
            text: answer.poll_media?.text ?? null,
            voteCount:
              raw.poll?.results?.answer_counts?.find(
                (count) => count.id === answer.answer_id,
              )?.count,
          })),
          expiresTimestamp: isoMs(raw.poll.expiry),
          allowMultiselect: raw.poll.allow_multiselect ?? false,
          layoutType: raw.poll.layout_type,
          resultsFinalized: raw.poll.results?.is_finalized ?? undefined,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

/** Newest first, whatever order Discord answered in — ids carry time. */
function newestFirst(messages: SerializedMessage[]): SerializedMessage[] {
  return messages.sort((a, b) => compareSnowflakes(b.id, a.id));
}

export async function getMessages(
  ctx: ToolContext,
  args: {
    guild_id?: string;
    channel_id: string;
    before?: string;
    after?: string;
    around?: string;
    limit?: number;
  },
): Promise<ToolResult> {
  const guild = resolveGuild(
    ctx.discord,
    args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
  );
  if (isWardenError(guild)) return guild;

  const channel = resolveChannel(guild, args.channel_id);
  if (isWardenError(channel)) return channel;
  const textBased = requireTextChannel(channel, args.channel_id);
  if (isWardenError(textBased)) return textBased;

  // One cursor at a time: `before`+`after` is a window Discord answers
  // inconsistently (and `around` alongside either is meaningless), so the
  // ambiguity is resolved here rather than inherited into the results.
  const cursors = [
    args.before !== undefined ? "before" : null,
    args.after !== undefined ? "after" : null,
    args.around !== undefined ? "around" : null,
  ].filter((name): name is string => name !== null);
  if (cursors.length > 1) {
    return fail({
      error: "invalid_input",
      message: `Provide at most one of before, after or around — got ${cursors.join(" and ")}.`,
      remediation:
        "before pages backwards from a message id, after pages forwards, around returns the window centred on one id. Pick one.",
      details: { received: cursors },
    });
  }

  const fetched = await attempt(() =>
    textBased.messages.fetch({
      limit: args.limit ?? 50,
      cache: false,
      ...(args.before !== undefined ? { before: args.before } : {}),
      ...(args.after !== undefined ? { after: args.after } : {}),
      ...(args.around !== undefined ? { around: args.around } : {}),
    }),
  );
  if (isWardenError(fetched)) return fail(fetched);

  const messages = newestFirst(
    [...fetched.values()].map((message) => serializeMessage(message)),
  );
  const notes: string[] = [];
  if (messages.length === (args.limit ?? 50)) {
    notes.push(
      "This page is full — pass the oldest id as `before` (or the newest as `after`) to continue.",
    );
  }
  return readOk(
    "message.history",
    { messages, count: messages.length },
    notes,
  );
}

export async function searchMessages(
  ctx: ToolContext,
  args: {
    guild_id?: string;
    query: string;
    author_id?: string;
    channel_id?: string;
    limit?: number;
    offset?: number;
    sort_by?: "relevance" | "timestamp";
    sort_order?: "asc" | "desc";
    min_id?: string;
    max_id?: string;
  },
): Promise<ToolResult> {
  const guild = resolveGuild(
    ctx.discord,
    args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
  );
  if (isWardenError(guild)) return guild;

  // `rest.get` takes a `URLSearchParams` (not a plain object), and Discord's
  // array query-string convention is repeated keys — `author_id=1&author_id=2`.
  // Building it explicitly keeps that visible instead of hidden behind a
  // serializer helper, and lets us drop unset filters rather than send
  // `undefined`.
  const query = new URLSearchParams();
  query.set("content", args.query);
  query.set("limit", String(args.limit ?? 25));
  query.set("offset", String(args.offset ?? 0));
  if (args.author_id !== undefined) query.set("author_id", args.author_id);
  if (args.channel_id !== undefined) query.set("channel_id", args.channel_id);
  if (args.sort_by !== undefined) query.set("sort_by", args.sort_by);
  if (args.sort_order !== undefined) query.set("sort_order", args.sort_order);
  if (args.min_id !== undefined) query.set("min_id", args.min_id);
  if (args.max_id !== undefined) query.set("max_id", args.max_id);

  const response = await attempt(() =>
    ctx.discord.client.rest.get(Routes.guildMessagesSearch(guild.id), { query }),
  );
  if (isWardenError(response)) return fail(response);

  const body = response as SearchNotReadyBody & SearchHitBody;

  // A 202 (not an error): Discord is still indexing this guild and answers
  // with an error-shaped body. Reporting it as a failure would be wrong —
  // the call worked — and returning zero hits would look like "nothing
  // matches", so it is a success with `ready: false` and the retry hint.
  if (body.code === 110_000) {
    return readOk(
      "message.search",
      {
        ready: false,
        totalResults: 0,
        hits: [],
        documentsIndexed: (body as { documents_indexed?: number }).documents_indexed ?? 0,
        retryAfterSeconds: body.retry_after ?? null,
      },
      [
        "Discord has not finished indexing this guild for search — no results exist yet. Retry after the given delay.",
      ],
    );
  }

  const groups = body.messages ?? [];
  // Discord nests results in groups, but the documented content of a group
  // has shrunk to the match alone ("surrounding context is no longer
  // returned"). Per group: entries the wire marks `hit` win over position,
  // and a group that marks nothing is taken whole. The preference must stay
  // per-group — a global "any marker anywhere" rule would discard every
  // match in an unmarked group, the same silent-drop shape as the mixed-length
  // pagination bug, just wire-conditional.
  const matches = groups.flatMap((group) => {
    const marked = group.filter((message) => message.hit === true);
    return marked.length > 0 ? marked : group;
  });
  const hits = matches.map((message) =>
    serializeMessage(toMessageLike(message, guild.id)),
  );

  const notes: string[] = [];
  if (body.doing_deep_historical_index) {
    notes.push(
      "Discord is still deep-indexing this guild's history — these matches are real, but older messages may be missing; retry later for the full set.",
    );
  }

  return readOk(
    "message.search",
    {
      ready: true,
      totalResults: body.total_results ?? hits.length,
      hits,
      count: hits.length,
    },
    notes,
  );
}

/** A resolved channel that can answer a message-history read. */
function requireTextChannel(
  channel: GuildBasedChannel,
  channelId: string,
): TextBasedChannel | WardenError {
  // `isTextBased()` is discord.js' own narrowing; the `messages` check below
  // is the belt to its braces — PartialGroupDMChannel is the one type the
  // union admits that has no message manager, and this call site would
  // otherwise learn that from the runtime rather than from the compiler.
  if (!channel.isTextBased() || !("messages" in channel)) {
    return fail({
      error: "invalid_input",
      message: `Channel ${channelId} has no message history (type ${channel.type}).`,
      remediation:
        "get_messages needs a text-based channel or a thread — check the id.",
      details: { channelId, channelType: channel.type },
    });
  }
  return channel;
}

export function registerMessageTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_messages",
    {
      title: "Get messages",
      description:
        "Fetch message history from one channel or thread: newest first, with before/after/around snowflake cursors and a 1-100 limit. Each message is trimmed to id, author, content, timestamps, attachments, embeds, mentions, stickers, reply reference and poll. Needs Warden to be able to see the channel; answers not_found for an unknown channel and invalid_input if two cursors are given at once.",
      inputSchema: z.object({
        guild_id: optionalId(
          "Guild to read (default: WARDEN_GUILD_ID, the one-server setup).",
        ),
        channel_id: requiredId("Channel or thread to read history from."),
        before: optionalId("Return messages sent before this message id."),
        after: optionalId("Return messages sent after this message id."),
        around: optionalId(
          "Return the window of messages centred on this message id.",
        ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum messages to return (1-100, default 50)."),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await getMessages(ctx, args)),
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description:
        "Discord's guild message search: full-text over message content, narrowed by author, channel, min/max id, and paged with limit (1-25) and offset (max 9975). Returns each match as a message (Discord no longer returns thread context alongside a match, and a note appears while a deep historical index is still running). Requires Warden to have Read Message History and Message Content; while Discord is still indexing a guild it answers ready:false with a retry delay instead of pretending there are no matches.",
      inputSchema: z.object({
        guild_id: optionalId(
          "Guild to search (default: WARDEN_GUILD_ID, the one-server setup).",
        ),
        query: z
          .string()
          .min(1)
          .max(1024)
          .describe("Words to search message content for."),
        author_id: optionalId("Only messages authored by this user."),
        channel_id: optionalId("Only messages in this channel or thread."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("Maximum matches to return (1-25, default 25)."),
        offset: z
          .number()
          .int()
          .min(0)
          .max(9975)
          .optional()
          .describe("Skip this many matches (max 9975)."),
        sort_by: z
          .enum(["relevance", "timestamp"])
          .optional()
          .describe("Sort by relevance to the query, or by time (default)."),
        sort_order: z
          .enum(["asc", "desc"])
          .optional()
          .describe("Direction to sort in (default desc)."),
        min_id: optionalId("Only messages after this id."),
        max_id: optionalId("Only messages before this id."),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await searchMessages(ctx, args)),
  );
}
