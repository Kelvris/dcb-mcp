/**
 * Messages domain (plan §8.5) — all ten of its tools.
 *
 * Phase 6 shipped the reads (`get_messages`, `search_messages`); Phase 7
 * ships the writes: `send_message`, `edit_message`, `delete_message`,
 * `bulk_delete_messages`, `crosspost_message`, `manage_pins`,
 * `manage_reactions` and `get_poll_results`. Every write goes through
 * `mutate()` (tools/context.ts), so plan §6's preflight, the layer-4 limit
 * checks and the `dry_run` → `would_perform` contract are written once
 * instead of eight times.
 *
 * Reads are REST reads and run through `attempt()`: a 404 or a 50013 from
 * Discord must come back as the uniform structured failure, not as an
 * SDK-level "the tool threw".
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
 *
 * ## Two facts the write half is built around
 *
 * - **Ownership decides the permission, and only a fetch knows it.**
 *   `edit_message`, `delete_message` and `crosspost_message` need
 *   `ManageMessages` only when the message is somebody else's, so the
 *   message is fetched first and the flag is chosen from its author. That
 *   fetch is a *read* and it runs inside `mutate()`'s permission-refinement
 *   hook — after layers 1–3, before the dry-run short-circuit.
 * - **`media_type` is deliberately not an input.** plan §8.5 names
 *   `{name, media_type, base64}` for an attachment, but discord.js resolves
 *   a `Buffer` to raw bytes with no content type at all, and
 *   `@discordjs/rest` then sniffs the type out of the bytes (`filetypeinfo`)
 *   before falling back to `application/octet-stream`. There is no code path
 *   that can carry an agent-supplied MIME type to Discord, so accepting one
 *   would be a field that validates, echoes back, and does nothing — the
 *   schema omits it and says why in the `attachments` description instead.
 */

import type {
  APIEmbed,
  APIMessage,
  AttachmentPayload,
  GuildBasedChannel,
  Message,
  MessageCreateOptions,
  MessageEditOptions,
  MessageMentionOptions,
  PartialEmoji,
  PartialEmojiOnlyId,
  PartialGroupDMChannel,
  PermissionResolvable,
  PollData,
  TextBasedChannel,
} from "discord.js";
import {
  ChannelType,
  MessageFlagsBitField,
  PermissionFlagsBits,
  Routes,
  resolvePartialEmoji,
} from "discord.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  checkBulkDelete,
  checkConnection,
  checkFileSize,
  LIMITS,
  resolveChannel,
  resolveGuild,
} from "../discord/guards.js";
import { isWardenError } from "../discord/errors.js";
import type { WardenError } from "../discord/errors.js";
import { serializeMessage, serializeUser } from "../discord/serializers/index.js";
import type {
  MessageLike,
  SerializedMessage,
} from "../discord/serializers/index.js";
import { compareSnowflakes } from "../shared/ids.js";
import { fail } from "../shared/result.js";
import type { ToolResult } from "../shared/result.js";
import {
  attempt,
  auditReason,
  mutate,
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

// ---------------------------------------------------------------------------
// mutation helpers (Phase 7)
// ---------------------------------------------------------------------------

/** Discord allows 10 attachments per message. */
const MAX_ATTACHMENTS = 10;
/** Discord allows 10 embeds per message. */
const MAX_EMBEDS = 10;
/** Discord allows 3 stickers per message. */
const MAX_STICKERS = 3;
/** `APIPoll.answers` — "up to 10". */
const MAX_POLL_ANSWERS = 10;
/** Discord's poll duration window, in hours. */
const POLL_HOURS = { min: 1, max: 768 };
/** discord.js requires a duration on `PollData`; Discord's own default. */
const DEFAULT_POLL_HOURS = 24;
/** Discord's reaction-user page ceiling. */
const MAX_REACTION_USERS = 100;

/**
 * A resolved channel the mutation can actually post to.
 *
 * `requireTextChannel` is the read-side narrowing; this one exists because a
 * mutation's failure has to name the *operation* being refused — "has no
 * message history" tells an agent that called `send_message` nothing it can
 * act on.
 */
function requirePostable(
  channel: GuildBasedChannel | null,
  channelId: string,
): Exclude<TextBasedChannel, PartialGroupDMChannel> | WardenError {
  if (!channel) {
    // Unreachable through `mutate`: every message tool passes `channelId`,
    // which is what makes `preflight` resolve one. Kept as a typed guard so
    // the narrowing below is not a cast.
    return fail({
      error: "invalid_input",
      message: `No channel was resolved for ${channelId}.`,
      remediation: "Pass channel_id — every message mutation is channel-scoped.",
      details: { channelId },
    });
  }
  if (!channel.isTextBased() || !("messages" in channel)) {
    return fail({
      error: "invalid_input",
      message: `Channel ${channelId} cannot carry messages (type ${channel.type}).`,
      remediation:
        "Pass a text, announcement, forum or media channel — or a thread id. manage_channel's 'list' shows what the server has.",
      details: { channelId, channelType: channel.type },
    });
  }
  return channel;
}

/** Is this message Warden's own? Ownership is what the permission layer keys on. */
function isOwnMessage(ctx: ToolContext, message: Message): boolean {
  return message.author !== null && message.author.id === ctx.discord.client.user?.id;
}

/** One upload as the agent supplies it. */
interface AttachmentInput {
  name: string;
  base64: string;
}

/**
 * Decoded length of well-formed base64, without decoding it.
 *
 * `floor(len/4)*3` over-counts by the padding characters, and subtracting
 * them makes the figure exact — so layer 4 can enforce the byte ceiling with
 * pure arithmetic instead of materialising a buffer the tool is about to
 * reject anyway.
 */
function decodedByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/**
 * Layer 4 for uploads: the payload must be decodable base64 and must fit
 * `LIMITS.attachmentBytes`.
 *
 * The shape check lives here rather than only in zod because the tool
 * functions are also called directly (by tests, and by any future caller
 * that skips MCP's schema validation) — a malformed body must not reach
 * `Buffer.from`, which would silently produce garbage bytes and post them.
 */
function checkAttachmentPayloads(
  attachments: readonly AttachmentInput[] | undefined,
): WardenError | null {
  if (!attachments) return null;
  for (const { name, base64 } of attachments) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
      return fail({
        error: "invalid_input",
        message: `Attachment '${name}' is not valid base64.`,
        remediation:
          "Encode the file first (for example `base64 -w0 file.png`) and pass the result as `base64`.",
        details: { name },
      });
    }
    const tooBig = checkFileSize(name, decodedByteLength(base64), LIMITS.attachmentBytes);
    if (tooBig) return tooBig;
  }
  return null;
}

/** Base64 → the `{attachment, name}` pairs discord.js uploads. */
function toFiles(
  attachments: readonly AttachmentInput[] | undefined,
): AttachmentPayload[] {
  return (attachments ?? []).map(({ name, base64 }) => ({
    attachment: Buffer.from(base64, "base64"),
    name,
  }));
}

/**
 * What a dry run echoes for an upload: the file's name and size, never its
 * body. `would_perform.params` is a transcript an agent reads, and a 20 MiB
 * base64 blob in it would drown everything else (and re-print operator data
 * for no decision it informs).
 */
function echoAttachments(
  attachments: readonly AttachmentInput[] | undefined,
): { name: string; bytes: number }[] | undefined {
  return attachments?.map(({ name, base64 }) => ({
    name,
    bytes: decodedByteLength(base64),
  }));
}

// --- input schemas ---------------------------------------------------------

const embedFieldSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  inline: z.boolean().optional(),
});

/**
 * An embed in Discord's own wire spelling (`icon_url`, not discord.js'
 * `iconURL`), so the parsed value *is* an `APIEmbed` and there is no second
 * mapping to drift out of sync with the serializer.
 */
const embedSchema = z.object({
  title: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  url: z.url().optional(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  timestamp: z.string().optional(),
  author: z
    .object({
      name: z.string().min(1),
      url: z.url().optional(),
      icon_url: z.url().optional(),
    })
    .optional(),
  footer: z
    .object({ text: z.string().min(1), icon_url: z.url().optional() })
    .optional(),
  image: z.object({ url: z.url() }).optional(),
  thumbnail: z.object({ url: z.url() }).optional(),
  fields: z.array(embedFieldSchema).max(25).optional(),
});

type EmbedInput = z.infer<typeof embedSchema>;

function toApiEmbed(embed: EmbedInput): APIEmbed {
  return embed;
}

const allowedMentionsSchema = z.object({
  parse: z.array(z.enum(["roles", "users", "everyone"])).optional(),
  roles: z.array(requiredId("Role id Warden is allowed to mention.")).optional(),
  users: z.array(requiredId("User id Warden is allowed to mention.")).optional(),
  replied_user: z.boolean().optional(),
});

type AllowedMentionsInput = z.infer<typeof allowedMentionsSchema>;

function toMentionOptions(input: AllowedMentionsInput): MessageMentionOptions {
  return {
    ...(input.parse ? { parse: input.parse } : {}),
    ...(input.roles ? { roles: input.roles } : {}),
    ...(input.users ? { users: input.users } : {}),
    ...(input.replied_user !== undefined
      ? { repliedUser: input.replied_user }
      : {}),
  };
}

const pollSchema = z.object({
  question: z.string().min(1),
  answers: z
    .array(
      z.object({
        text: z.string().min(1),
        emoji: z.string().min(1).optional(),
      }),
    )
    .min(1)
    .max(MAX_POLL_ANSWERS),
  duration_hours: z
    .number()
    .int()
    .min(POLL_HOURS.min)
    .max(POLL_HOURS.max)
    .optional()
    .describe(
      `How long the poll runs, in hours (${POLL_HOURS.min}-${POLL_HOURS.max}, default ${DEFAULT_POLL_HOURS}). Discord's unit is hours, not minutes.`,
    ),
  allow_multiselect: z.boolean().optional(),
});

type PollInput = z.infer<typeof pollSchema>;

function toPollData(poll: PollInput): PollData {
  return {
    question: { text: poll.question },
    answers: poll.answers.map((answer) => ({
      text: answer.text,
      ...(answer.emoji ? { emoji: answer.emoji } : {}),
    })),
    duration: poll.duration_hours ?? DEFAULT_POLL_HOURS,
    allowMultiselect: poll.allow_multiselect ?? false,
  };
}

const attachmentSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("File name Discord should show, including its extension."),
  base64: z
    .string()
    .min(1)
    .describe(
      "The file's base64 body. No `media_type`: discord.js cannot forward one, so Discord derives the content type from the bytes themselves.",
    ),
});

const attachmentListSchema = z
  .array(attachmentSchema)
  .max(MAX_ATTACHMENTS)
  .describe(
    `Files to attach (up to ${MAX_ATTACHMENTS}, ${LIMITS.attachmentBytes / (1024 * 1024)} MiB each).`,
  );

const REASON_FIELD = z
  .string()
  .min(1)
  .max(512)
  .describe(
    "Why this is happening — recorded in the server's audit log after Warden's own `warden:<tool>` prefix.",
  );

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Run every check and return `would_perform` without touching Discord (or set WARDEN_DRY_RUN).",
  );

// --- shared request fragments ---------------------------------------------

/**
 * `refinePermissions` probe: fetch the message whose author decides the
 * permission set, and hand it back to `execute` through `target`.
 *
 * The value is captured rather than re-fetched so the probe costs exactly
 * one GET whether or not the call ends up writing. `execute` still carries a
 * fallback fetch: TypeScript cannot see that `refinePermissions` ran, and a
 * re-fetch beats an `internal` error on a path that should be unreachable.
 */
function ownershipProbe(
  ctx: ToolContext,
  channelId: string,
  messageId: string,
  target: { current: Message | null },
): (pass: {
  channel: GuildBasedChannel | null;
}) => Promise<readonly PermissionResolvable[] | WardenError> {
  return async (pass) => {
    const channel = requirePostable(pass.channel, channelId);
    if (isWardenError(channel)) return channel;
    const message = await attempt(() => channel.messages.fetch(messageId));
    if (isWardenError(message)) return fail(message);
    target.current = message;
    return isOwnMessage(ctx, message)
      ? []
      : [PermissionFlagsBits.ManageMessages];
  };
}

/**
 * The message `execute` should mutate — re-fetched only if the ownership
 * probe somehow did not run.
 */
async function resolveTarget(
  channel: TextBasedChannel,
  messageId: string,
  target: { current: Message | null },
): Promise<Message | WardenError> {
  if (target.current) return target.current;
  const message = await attempt(() => channel.messages.fetch(messageId));
  return isWardenError(message) ? fail(message) : message;
}

/**
 * Emoji → the route identifier Discord's reaction endpoints expect.
 *
 * discord.js computes this inside `MessageManager.react` and exports only
 * the parsing half (`resolvePartialEmoji`), so the encoding is repeated
 * here rather than reaching into the library: a custom emoji becomes
 * `a:name:id` (or `name:id`), a unicode emoji is percent-encoded, and a
 * bare snowflake is refused because it names no emoji at all.
 */
function toEmojiRoute(emoji: string): string | WardenError {
  // The Snowflake overload of `resolvePartialEmoji` wins for a plain string
  // and types the result as id-only, but at runtime a non-snowflake string
  // goes through `parseEmoji` and comes back with a name — so the union is
  // restated here and narrowed by `in` rather than trusted as typed.
  const resolved = resolvePartialEmoji(emoji) as
    | PartialEmoji
    | PartialEmojiOnlyId
    | null;
  if (!resolved || !("name" in resolved)) {
    // A bare snowflake (or an unparseable string) names no emoji.
    return fail({
      error: "invalid_input",
      message: `'${emoji}' is not an emoji Warden can react with.`,
      remediation:
        "Pass a unicode emoji (👍) or a custom one in Discord's `<a:name:id>` / `<name:id>` form — a bare id names no emoji.",
      details: { emoji },
    });
  }
  return resolved.id
    ? `${resolved.animated ? "a:" : ""}${resolved.name}:${resolved.id}`
    : encodeURIComponent(resolved.name);
}

// ---------------------------------------------------------------------------
// mutation tools (Phase 7)
// ---------------------------------------------------------------------------

export async function sendMessage(
  ctx: ToolContext,
  args: {
    guild_id?: string;
    channel_id: string;
    content?: string;
    embeds?: EmbedInput[];
    attachments?: AttachmentInput[];
    allowed_mentions?: AllowedMentionsInput;
    tts?: boolean;
    reply_to?: string;
    nonce?: string;
    sticker_ids?: string[];
    poll?: PollInput;
    dry_run?: boolean;
  },
): Promise<ToolResult> {
  // Argument validity is the schema's job (plan §5) and never touches
  // Discord, so it runs before the preflight rather than after it — an agent
  // that sent nothing at all should not first be told about permissions.
  const hasPayload = Boolean(
    args.content?.trim() ||
      args.embeds?.length ||
      args.attachments?.length ||
      args.sticker_ids?.length ||
      args.poll,
  );
  if (!hasPayload) {
    return fail({
      error: "invalid_input",
      message: "send_message needs something to send.",
      remediation:
        "Pass at least one of content, embeds, attachments, sticker_ids or poll.",
      details: { channel_id: args.channel_id },
    });
  }

  return mutate(ctx, {
    tool: "send_message",
    performed: "message.send",
    request: {
      tool: "send_message",
      guildId: args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
      channelId: args.channel_id,
      // Replaced by `refinePermissions`: the flags depend on whether the
      // resolved channel is a thread, which the id alone does not say.
      channelPermissions: [],
      targetMember: null,
      targetRole: null,
      action: "send a message in",
    },
    refinePermissions: async (pass) => {
      const channel = requirePostable(pass.channel, args.channel_id);
      if (isWardenError(channel)) return channel;
      const permissions: PermissionResolvable[] = [
        channel.isThread()
          ? PermissionFlagsBits.SendMessagesInThreads
          : PermissionFlagsBits.SendMessages,
      ];
      if (args.embeds?.length) permissions.push(PermissionFlagsBits.EmbedLinks);
      if (args.attachments?.length) {
        permissions.push(PermissionFlagsBits.AttachFiles);
      }
      if (args.tts) permissions.push(PermissionFlagsBits.SendTTSMessages);
      return permissions;
    },
    params: {
      channel_id: args.channel_id,
      content: args.content ?? null,
      embeds: args.embeds?.length ?? 0,
      attachments: echoAttachments(args.attachments),
      stickers: args.sticker_ids?.length ?? 0,
      poll: args.poll
        ? {
            question: args.poll.question,
            answers: args.poll.answers.length,
            duration_hours: args.poll.duration_hours ?? DEFAULT_POLL_HOURS,
          }
        : null,
      reply_to: args.reply_to ?? null,
      tts: args.tts ?? false,
    },
    dryRun: args.dry_run,
    validate: () => checkAttachmentPayloads(args.attachments),
    execute: async (pass) => {
      const channel = requirePostable(pass.channel, args.channel_id);
      if (isWardenError(channel)) return channel;
      const content =
        args.content !== undefined && args.content.trim().length > 0
          ? args.content
          : undefined;
      const payload: MessageCreateOptions = {
        ...(content !== undefined ? { content } : {}),
        ...(args.embeds?.length ? { embeds: args.embeds.map(toApiEmbed) } : {}),
        ...(args.attachments?.length ? { files: toFiles(args.attachments) } : {}),
        ...(args.allowed_mentions
          ? { allowedMentions: toMentionOptions(args.allowed_mentions) }
          : {}),
        ...(args.tts ? { tts: true } : {}),
        ...(args.reply_to
          ? { reply: { messageReference: args.reply_to } }
          : {}),
        ...(args.nonce ? { nonce: args.nonce } : {}),
        ...(args.sticker_ids?.length ? { stickers: args.sticker_ids } : {}),
        ...(args.poll ? { poll: toPollData(args.poll) } : {}),
      };
      // Explicit `Message`: `send` answers `Message<true> | Message<false>`
      // depending on the channel, and `attempt`'s inference otherwise picks
      // one arm of `Promise<T> | T` and leaves the other unmatched.
      const sent = await attempt<Message>(() => channel.send(payload));
      if (isWardenError(sent)) return fail(sent);
      return readOk("message.send", { message: serializeMessage(sent) });
    },
  });
}

export async function editMessage(
  ctx: ToolContext,
  args: {
    guild_id?: string;
    channel_id: string;
    message_id: string;
    content?: string;
    embeds?: EmbedInput[];
    attachments?: string[];
    flags?: ("suppress_embeds")[];
    close_poll?: boolean;
    dry_run?: boolean;
  },
): Promise<ToolResult> {
  const hasEdits = Boolean(
    args.content?.trim() ||
      args.embeds?.length ||
      args.attachments !== undefined ||
      args.flags?.length ||
      args.close_poll,
  );
  if (!hasEdits) {
    return fail({
      error: "invalid_input",
      message: "edit_message needs something to change.",
      remediation:
        "Pass at least one of content, embeds, attachments (the ids to keep), flags or close_poll.",
      details: { message_id: args.message_id },
    });
  }

  const target: { current: Message | null } = { current: null };

  return mutate(ctx, {
    tool: "edit_message",
    performed: "message.edit",
    request: {
      tool: "edit_message",
      guildId: args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
      channelId: args.channel_id,
      channelPermissions: [],
      targetMember: null,
      targetRole: null,
      action: "edit a message in",
    },
    refinePermissions: async (pass) => {
      const channel = requirePostable(pass.channel, args.channel_id);
      if (isWardenError(channel)) return channel;
      const message = await attempt(() =>
        channel.messages.fetch(args.message_id),
      );
      if (isWardenError(message)) return fail(message);
      target.current = message;
      if (args.close_poll && message.poll === null) {
        return fail({
          error: "invalid_input",
          message: `Message ${args.message_id} has no poll to close.`,
          remediation: "close_poll only applies to a message that carries a poll.",
          details: { message_id: args.message_id },
        });
      }
      return isOwnMessage(ctx, message)
        ? []
        : [PermissionFlagsBits.ManageMessages];
    },
    params: {
      channel_id: args.channel_id,
      message_id: args.message_id,
      content: args.content ?? null,
      embeds: args.embeds?.length ?? 0,
      attachments: args.attachments ?? null,
      flags: args.flags ?? [],
      close_poll: args.close_poll ?? false,
    },
    dryRun: args.dry_run,
    execute: async (pass) => {
      const channel = requirePostable(pass.channel, args.channel_id);
      if (isWardenError(channel)) return channel;
      const target0 = await resolveTarget(channel, args.message_id, target);
      if (isWardenError(target0)) return target0;

      let updated: Message = target0;
      const hasBodyEdits = Boolean(
        (args.content !== undefined && args.content.trim().length > 0) ||
          args.embeds?.length ||
          args.attachments !== undefined ||
          args.flags?.length,
      );
      if (hasBodyEdits) {
        const payload: MessageEditOptions = {
          ...(args.content !== undefined && args.content.trim().length > 0
            ? { content: args.content }
            : {}),
          ...(args.embeds?.length ? { embeds: args.embeds.map(toApiEmbed) } : {}),
          ...(args.attachments !== undefined
            ? { attachments: args.attachments.map((id) => ({ id })) }
            : {}),
          ...(args.flags?.length
            ? {
                // `MessageEditOptions.flags` accepts the editable names only
                // (SuppressEmbeds / IsComponentsV2), not a general bitfield —
                // so the wire names are mapped, not wrapped.
                flags: args.flags.map((flag) =>
                  flag === "suppress_embeds" ? "SuppressEmbeds" : flag,
                ),
              }
            : {}),
        };
        const edited = await attempt(() => target0.edit(payload));
        if (isWardenError(edited)) return fail(edited);
        updated = edited;
      }

      if (args.close_poll) {
        const poll = updated.poll;
        if (poll === null) {
          return fail({
            error: "invalid_input",
            message: `Message ${args.message_id} has no poll to close.`,
            remediation: "close_poll only applies to a message that carries a poll.",
            details: { message_id: args.message_id },
          });
        }
        const closed = await attempt(() => poll.end());
        if (isWardenError(closed)) return fail(closed);
        updated = closed;
      }

      return readOk("message.edit", { message: serializeMessage(updated) });
    },
  });
}

export async function deleteMessage(
  ctx: ToolContext,
  args: {
    guild_id?: string;
    channel_id: string;
    message_id: string;
    reason?: string;
    dry_run?: boolean;
  },
): Promise<ToolResult> {
  // The guild path is resolved first so the common case keeps plan §6's
  // ordering intact (preflight before any Discord call). Only a channel the
  // configured guild does not own falls through to the DM probe below.
  const guild = resolveGuild(
    ctx.discord,
    args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
  );
  if (!isWardenError(guild)) {
    const channel = resolveChannel(guild, args.channel_id);
    if (!isWardenError(channel)) {
      const target: { current: Message | null } = { current: null };
      const reason = auditReason("delete_message", args.reason);
      return mutate(ctx, {
        tool: "delete_message",
        performed: "message.delete",
        request: {
          tool: "delete_message",
          guildId: guild.id,
          channelId: args.channel_id,
          channelPermissions: [],
          targetMember: null,
          targetRole: null,
          action: "delete a message in",
        },
        refinePermissions: ownershipProbe(
          ctx,
          args.channel_id,
          args.message_id,
          target,
        ),
        params: {
          channel_id: args.channel_id,
          message_id: args.message_id,
          reason: args.reason ?? null,
        },
        dryRun: args.dry_run,
        execute: async (pass) => {
          const channel = requirePostable(pass.channel, args.channel_id);
          if (isWardenError(channel)) return channel;
          const message = await resolveTarget(
            channel,
            args.message_id,
            target,
          );
          if (isWardenError(message)) return message;
          // Raw REST rather than `message.delete()`: discord.js' wrapper
          // takes no `reason`, and message deletion is one of the calls
          // Discord *does* write to the audit log (plan §4).
          const deleted = await attempt(() =>
            ctx.discord.client.rest.delete(
              Routes.channelMessage(args.channel_id, message.id),
              { reason },
            ),
          );
          if (isWardenError(deleted)) return fail(deleted);
          return readOk("message.delete", {
            channel_id: args.channel_id,
            message_id: message.id,
            deleted: true,
          });
        },
      });
    }
  } else if (guild.error === "not_ready") {
    return guild;
  }

  return deleteDirectMessage(ctx, args);
}

/**
 * `delete_message` for a DM (plan §8.5: "supports threads/DMs").
 *
 * A DM channel id belongs to no guild, so it cannot go through `preflight`
 * — whose first act is resolving one. Layer 1 (connection) still runs here,
 * and layers 2–3 have nothing to check: a DM has no permissions to be
 * missing and no role hierarchy to sit in. Everything else — the uniform
 * envelope, `dry_run`, `attempt()` — is unchanged.
 */
async function deleteDirectMessage(
  ctx: ToolContext,
  args: { channel_id: string; message_id: string; dry_run?: boolean },
): Promise<ToolResult> {
  const connectionError = checkConnection(ctx.discord);
  if (connectionError) return connectionError;

  const channel = await attempt(() =>
    ctx.discord.client.channels.fetch(args.channel_id),
  );
  if (isWardenError(channel)) return fail(channel);
  if (!channel || !channel.isDMBased() || !channel.isTextBased()) {
    return fail({
      error: "invalid_input",
      message: `Channel ${args.channel_id} is neither a DM nor a channel of the configured guild.`,
      remediation:
        "For a server channel pass guild_id (or set WARDEN_GUILD_ID); DMs need no guild, only the DM channel id.",
      details: { channel_id: args.channel_id },
    });
  }

  if (args.dry_run === true || ctx.config.WARDEN_DRY_RUN) {
    return readOk("message.delete", {
      would_perform: {
        tool: "delete_message",
        params: { channel_id: args.channel_id, message_id: args.message_id },
        checks: "all passed",
      },
    });
  }

  const deleted = await attempt(() =>
    ctx.discord.client.rest.delete(
      Routes.channelMessage(args.channel_id, args.message_id),
    ),
  );
  if (isWardenError(deleted)) return fail(deleted);
  return readOk("message.delete", {
    channel_id: args.channel_id,
    message_id: args.message_id,
    deleted: true,
  });
}

export async function bulkDeleteMessages(
  ctx: ToolContext,
  args: {
    guild_id?: string;
    channel_id: string;
    message_ids: string[];
    reason?: string;
    dry_run?: boolean;
  },
): Promise<ToolResult> {
  return mutate(ctx, {
    tool: "bulk_delete_messages",
    performed: "message.bulk_delete",
    request: {
      tool: "bulk_delete_messages",
      guildId: args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
      channelId: args.channel_id,
      channelPermissions: [PermissionFlagsBits.ManageMessages],
      targetMember: null,
      targetRole: null,
      action: "bulk-delete messages in",
    },
    params: {
      channel_id: args.channel_id,
      message_ids: args.message_ids,
      count: args.message_ids.length,
      reason: args.reason ?? null,
    },
    dryRun: args.dry_run,
    // Layer 4b: 2–100 ids, none older than 14 days, none future-dated.
    // Runs after the permission layer on purpose (guards.checkLimit) so a
    // missing ManageMessages is reported before a formatting mistake.
    validate: () => checkBulkDelete(args.message_ids),
    execute: async () => {
      const reason = auditReason("bulk_delete_messages", args.reason);
      // Raw REST again: `channel.bulkDelete` takes no `reason`, and Discord
      // records a MESSAGE_BULK_DELETE audit entry that would otherwise show
      // the bot acting on its own.
      const deleted = await attempt(() =>
        ctx.discord.client.rest.post(Routes.channelBulkDelete(args.channel_id), {
          body: { messages: args.message_ids },
          reason,
        }),
      );
      if (isWardenError(deleted)) return fail(deleted);
      return readOk("message.bulk_delete", {
        channel_id: args.channel_id,
        deleted: args.message_ids.length,
        message_ids: args.message_ids,
      });
    },
  });
}

export async function crosspostMessage(
  ctx: ToolContext,
  args: {
    guild_id?: string;
    channel_id: string;
    message_id: string;
    dry_run?: boolean;
  },
): Promise<ToolResult> {
  const target: { current: Message | null } = { current: null };

  return mutate(ctx, {
    tool: "crosspost_message",
    performed: "message.crosspost",
    request: {
      tool: "crosspost_message",
      guildId: args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
      channelId: args.channel_id,
      channelPermissions: [],
      targetMember: null,
      targetRole: null,
      action: "publish a message from",
    },
    // Discord's own rule for Publish: SendMessages when Warden sent the
    // message, SendMessages *plus* ManageMessages for anyone else's. The
    // channel type is checked here too — publishing only exists in an
    // announcement channel, and a dry run must not claim otherwise.
    refinePermissions: async (pass) => {
      const channel = requirePostable(pass.channel, args.channel_id);
      if (isWardenError(channel)) return channel;
      if (channel.type !== ChannelType.GuildAnnouncement) {
        return fail({
          error: "invalid_input",
          message: `Channel ${args.channel_id} is not an announcement channel (type ${channel.type}).`,
          remediation:
            "crosspost_message only fans out from an announcement channel — pass one of those, or edit the message's channel instead.",
          details: { channel_id: args.channel_id, channelType: channel.type },
        });
      }
      const message = await attempt(() =>
        channel.messages.fetch(args.message_id),
      );
      if (isWardenError(message)) return fail(message);
      target.current = message;
      const permissions: PermissionResolvable[] = [
        PermissionFlagsBits.SendMessages,
      ];
      if (!isOwnMessage(ctx, message)) {
        permissions.push(PermissionFlagsBits.ManageMessages);
      }
      return permissions;
    },
    params: {
      channel_id: args.channel_id,
      message_id: args.message_id,
    },
    dryRun: args.dry_run,
    execute: async (pass) => {
      const channel = requirePostable(pass.channel, args.channel_id);
      if (isWardenError(channel)) return channel;
      const message = await resolveTarget(channel, args.message_id, target);
      if (isWardenError(message)) return message;
      const published = await attempt(() => message.crosspost());
      if (isWardenError(published)) return fail(published);
      return readOk("message.crosspost", {
        message: serializeMessage(published),
      });
    },
  });
}

export async function managePins(
  ctx: ToolContext,
  args: {
    action: "pin" | "unpin" | "unpin_all" | "list";
    guild_id?: string;
    channel_id: string;
    message_id?: string;
    limit?: number;
    reason?: string;
    dry_run?: boolean;
  },
): Promise<ToolResult> {
  const needsMessage = args.action === "pin" || args.action === "unpin";
  if (needsMessage && args.message_id === undefined) {
    return fail({
      error: "invalid_input",
      message: `manage_pins with action '${args.action}' needs a message_id.`,
      remediation:
        "Pass message_id — action 'list' is the one that needs no message.",
      details: { action: args.action },
    });
  }

  // 'list' is a read (plan §8.5 folds get_pinned_messages in here): it runs
  // the resolution layer but no §6 preflight, exactly like get_messages.
  if (args.action === "list") {
    const guild = resolveGuild(
      ctx.discord,
      args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
    );
    if (isWardenError(guild)) return guild;
    const channel = resolveChannel(guild, args.channel_id);
    if (isWardenError(channel)) return channel;
    const text = requireTextChannel(channel, args.channel_id);
    if (isWardenError(text)) return text;

    const fetched = await attempt(() => text.messages.fetchPins());
    if (isWardenError(fetched)) return fail(fetched);
    // Discord's pin list has no cursor: one page, newest pin first. `limit`
    // trims that page rather than paging it — the note below says why there
    // is no "next page" to ask for.
    const page = fetched.items.slice(0, args.limit ?? fetched.items.length);
    const pins = page.map((item) => ({
      pinnedAt: item.pinnedAt.toISOString(),
      message: serializeMessage(item.message),
    }));
    const notes: string[] = [];
    if (fetched.hasMore) {
      notes.push(
        "Discord returned a full pin page — unpin some before asking for the rest; this endpoint has no cursor.",
      );
    }
    return readOk("pin.list", { pins, count: pins.length }, notes);
  }

  return mutate(ctx, {
    tool: "manage_pins",
    performed: `pin.${args.action}`,
    request: {
      tool: "manage_pins",
      guildId: args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
      channelId: args.channel_id,
      channelPermissions: [PermissionFlagsBits.ManageMessages],
      targetMember: null,
      targetRole: null,
      action: `${args.action} a pin in`,
    },
    params: {
      action: args.action,
      channel_id: args.channel_id,
      message_id: args.message_id ?? null,
      reason: args.reason ?? null,
    },
    dryRun: args.dry_run,
    execute: async (pass) => {
      const channel = requirePostable(pass.channel, args.channel_id);
      if (isWardenError(channel)) return channel;
      const reason = auditReason("manage_pins", args.reason);

      if (args.action === "pin" || args.action === "unpin") {
        const messageId = args.message_id as string;
        const changed =
          args.action === "pin"
            ? await attempt(() => channel.messages.pin(messageId, reason))
            : await attempt(() => channel.messages.unpin(messageId, reason));
        if (isWardenError(changed)) return fail(changed);
        return readOk(`pin.${args.action}`, {
          channel_id: args.channel_id,
          message_id: messageId,
          pinned: args.action === "pin",
        });
      }

      // Discord has no bulk-unpin route, so `unpin_all` is what its name
      // says: read the pin list, unpin each one, report the count. Any
      // single failure aborts with the id that failed, so the agent knows
      // what is left rather than assuming the channel is clear.
      const fetched = await attempt(() => channel.messages.fetchPins());
      if (isWardenError(fetched)) return fail(fetched);
      const ids = fetched.items.map((item) => item.message.id);
      for (const id of ids) {
        const changed = await attempt(() => channel.messages.unpin(id, reason));
        if (isWardenError(changed)) {
          return fail({
            ...changed,
            details: { ...(changed.details ?? {}), unpinned: ids.length - ids.indexOf(id) - 1, remaining: ids.length - ids.indexOf(id) },
          });
        }
      }
      return readOk("pin.unpin_all", {
        channel_id: args.channel_id,
        unpinned: ids.length,
        message_ids: ids,
      });
    },
  });
}

export async function manageReactions(
  ctx: ToolContext,
  args: {
    action: "add" | "remove" | "remove_all" | "remove_emoji" | "get_reaction_users";
    guild_id?: string;
    channel_id: string;
    message_id: string;
    emoji?: string;
    user_id?: string;
    limit?: number;
    after?: string;
    dry_run?: boolean;
  },
): Promise<ToolResult> {
  const needsEmoji =
    args.action === "add" ||
    args.action === "remove" ||
    args.action === "remove_emoji" ||
    args.action === "get_reaction_users";
  if (needsEmoji && args.emoji === undefined) {
    return fail({
      error: "invalid_input",
      message: `manage_reactions with action '${args.action}' needs an emoji.`,
      remediation:
        "Pass emoji (unicode 👍 or a custom `<a:name:id>`); only 'remove_all' acts on every emoji at once.",
      details: { action: args.action },
    });
  }

  // Reads need no §6 preflight — only the resolution layer.
  if (args.action === "get_reaction_users") {
    const guild = resolveGuild(
      ctx.discord,
      args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
    );
    if (isWardenError(guild)) return guild;
    const channel = resolveChannel(guild, args.channel_id);
    if (isWardenError(channel)) return channel;
    const text = requireTextChannel(channel, args.channel_id);
    if (isWardenError(text)) return text;

    const identifier = toEmojiRoute(args.emoji as string);
    if (isWardenError(identifier)) return identifier;

    const limit = args.limit ?? MAX_REACTION_USERS;
    const query = new URLSearchParams({ limit: String(limit) });
    if (args.after !== undefined) query.set("after", args.after);

    const users = await attempt(() =>
      ctx.discord.client.rest.get(
        Routes.channelMessageReaction(args.channel_id, args.message_id, identifier),
        { query },
      ),
    );
    if (isWardenError(users)) return fail(users);
    // The route answers with wire users (`global_name`, `flags` as an int),
    // which is exactly what `toUserLike` → `serializeUser` exists for.
    const list = (users as WireUser[]).map((user) =>
      serializeUser(toUserLike(user)),
    );
    const notes: string[] = [];
    if (list.length === limit) {
      notes.push(
        "This page is full — pass the newest id as `after` (nextAfter) to continue.",
      );
    }
    return readOk(
      "reaction.users",
      {
        channel_id: args.channel_id,
        message_id: args.message_id,
        emoji: args.emoji,
        users: list,
        count: list.length,
        nextAfter: list.at(-1)?.id ?? null,
      },
      notes,
    );
  }

  // Removing *someone else's* reaction is a moderation act; removing
  // Warden's own needs nothing beyond seeing the channel. `user_id`
  // therefore decides the flag statically — no probe required.
  const targetUserId = args.user_id ?? ctx.discord.client.user?.id ?? "";
  const removingOther =
    args.action === "remove" && targetUserId !== (ctx.discord.client.user?.id ?? "");

  return mutate(ctx, {
    tool: "manage_reactions",
    performed: `reaction.${args.action}`,
    request: {
      tool: "manage_reactions",
      guildId: args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
      channelId: args.channel_id,
      channelPermissions:
        args.action === "add"
          ? [PermissionFlagsBits.AddReactions]
          : removingOther || args.action === "remove_all" || args.action === "remove_emoji"
            ? [PermissionFlagsBits.ManageMessages]
            : [],
      targetMember: null,
      targetRole: null,
      action: `${args.action} a reaction in`,
    },
    params: {
      action: args.action,
      channel_id: args.channel_id,
      message_id: args.message_id,
      emoji: args.emoji ?? null,
      user_id: args.user_id ?? null,
    },
    dryRun: args.dry_run,
    execute: async (pass) => {
      const channel = requirePostable(pass.channel, args.channel_id);
      if (isWardenError(channel)) return channel;

      if (args.action === "add") {
        const reacted = await attempt(() =>
          channel.messages.react(args.message_id, args.emoji as string),
        );
        if (isWardenError(reacted)) return fail(reacted);
        return readOk("reaction.add", {
          channel_id: args.channel_id,
          message_id: args.message_id,
          emoji: args.emoji,
        });
      }

      if (args.action === "remove_all") {
        const removed = await attempt(() =>
          ctx.discord.client.rest.delete(
            Routes.channelMessageAllReactions(args.channel_id, args.message_id),
          ),
        );
        if (isWardenError(removed)) return fail(removed);
        return readOk("reaction.remove_all", {
          channel_id: args.channel_id,
          message_id: args.message_id,
        });
      }

      const identifier = toEmojiRoute(args.emoji as string);
      if (isWardenError(identifier)) return identifier;

      if (args.action === "remove_emoji") {
        const removed = await attempt(() =>
          ctx.discord.client.rest.delete(
            Routes.channelMessageReaction(args.channel_id, args.message_id, identifier),
          ),
        );
        if (isWardenError(removed)) return fail(removed);
        return readOk("reaction.remove_emoji", {
          channel_id: args.channel_id,
          message_id: args.message_id,
          emoji: args.emoji,
        });
      }

      // `remove`: one user's reaction. discord.js splits this across two
      // routes (own vs somebody else's) inside `ReactionUserManager.remove`,
      // which is unreachable without a cached reaction — so the split is
      // made here, against the same ids the library would use.
      const botId = ctx.discord.client.user?.id ?? "";
      const route =
        targetUserId === botId
          ? Routes.channelMessageOwnReaction(args.channel_id, args.message_id, identifier)
          : Routes.channelMessageUserReaction(
              args.channel_id,
              args.message_id,
              identifier,
              targetUserId,
            );
      const removed = await attempt(() =>
        ctx.discord.client.rest.delete(route),
      );
      if (isWardenError(removed)) return fail(removed);
      return readOk("reaction.remove", {
        channel_id: args.channel_id,
        message_id: args.message_id,
        emoji: args.emoji,
        user_id: targetUserId,
      });
    },
  });
}

export async function getPollResults(
  ctx: ToolContext,
  args: {
    guild_id?: string;
    channel_id: string;
    message_id: string;
    answer_id?: number;
    limit?: number;
    after?: string;
  },
): Promise<ToolResult> {
  const guild = resolveGuild(
    ctx.discord,
    args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
  );
  if (isWardenError(guild)) return guild;
  const channel = resolveChannel(guild, args.channel_id);
  if (isWardenError(channel)) return channel;
  const text = requireTextChannel(channel, args.channel_id);
  if (isWardenError(text)) return text;

  // `force` because the whole point of this tool is *live* counts: a cached
  // message would report the numbers as of the last gateway update, which
  // for a poll that is still running is the wrong answer to the question.
  const message = await attempt(() =>
    text.messages.fetch({ message: args.message_id, force: true }),
  );
  if (isWardenError(message)) return fail(message);

  const poll = message.poll;
  if (poll === null) {
    return fail({
      error: "invalid_input",
      message: `Message ${args.message_id} has no poll.`,
      remediation:
        "get_poll_results only reads a message that carries a poll — check the id with get_messages.",
      details: { message_id: args.message_id },
    });
  }

  const answers = [...poll.answers.values()].map((answer) => ({
    id: answer.id,
    text: answer.text,
    emoji: answer.emoji
      ? { id: answer.emoji.id ?? null, name: answer.emoji.name, animated: "animated" in answer.emoji ? answer.emoji.animated : false }
      : null,
    voteCount: answer.voteCount,
  }));

  const data: Record<string, unknown> = {
    channel_id: args.channel_id,
    message_id: message.id,
    question: poll.question.text,
    answers,
    expiresAt:
      poll.expiresTimestamp === null
        ? null
        : new Date(poll.expiresTimestamp).toISOString(),
    expired:
      poll.expiresTimestamp !== null && Date.now() > poll.expiresTimestamp,
    allowMultiselect: poll.allowMultiselect,
    resultsFinalized: poll.resultsFinalized,
    layoutType: poll.layoutType,
  };

  if (args.answer_id !== undefined) {
    const answer = poll.answers.get(args.answer_id);
    if (answer === undefined) {
      return fail({
        error: "invalid_input",
        message: `Poll on message ${args.message_id} has no answer ${args.answer_id}.`,
        remediation:
          "Pass an `id` from this poll's `answers` list — answer ids are per-poll integers, not snowflakes.",
        details: { answer_id: args.answer_id, available: answers.map((a) => a.id) },
      });
    }
    const limit = args.limit ?? MAX_REACTION_USERS;
    const voters = await attempt(() =>
      answer.voters.fetch({
        limit,
        ...(args.after !== undefined ? { after: args.after } : {}),
      }),
    );
    if (isWardenError(voters)) return fail(voters);
    const users = [...voters.values()].map((user) => serializeUser(user));
    const notes: string[] = [];
    if (users.length === limit) {
      notes.push(
        "This page is full — pass the newest voter id as `after` (nextAfter) to continue.",
      );
    }
    data.voters = {
      answer_id: answer.id,
      users,
      count: users.length,
      nextAfter: users.at(-1)?.id ?? null,
    };
    return readOk("poll.results", data, notes);
  }

  return readOk("poll.results", data);
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

  // --- mutations (Phase 7) -------------------------------------------------

  server.registerTool(
    "send_message",
    {
      title: "Send message",
      description:
        "Post one message to a channel or thread: content (≤2000 chars), up to 10 embeds, up to 10 base64 attachments (≤20 MiB each — no media_type; Discord sniffs the content type from the bytes), up to 3 sticker ids, a poll, allowed_mentions, a reply target or a nonce. Needs Send Messages (Send Messages In Threads for a thread) plus Embed Links / Attach Files / Send TTS Messages only as used. dry_run returns would_perform without posting.",
      inputSchema: z.object({
        guild_id: optionalId(
          "Guild to send in (default: WARDEN_GUILD_ID, the one-server setup).",
        ),
        channel_id: requiredId("Channel or thread to post in."),
        content: z
          .string()
          .max(2000)
          .optional()
          .describe("Message text, up to 2000 characters."),
        embeds: z
          .array(embedSchema)
          .max(MAX_EMBEDS)
          .optional()
          .describe(`Rich embeds in Discord's wire shape (up to ${MAX_EMBEDS}).`),
        attachments: attachmentListSchema.optional(),
        allowed_mentions: allowedMentionsSchema
          .optional()
          .describe(
            "Whom this message may ping: parse rules, explicit role/user id lists, and whether to notify the replied user.",
          ),
        tts: z
          .boolean()
          .optional()
          .describe("Read the message aloud with Discord TTS (needs Send TTS Messages)."),
        reply_to: optionalId("Message id to reply to (adds a reply reference)."),
        nonce: z
          .string()
          .max(25)
          .optional()
          .describe("Client-side dedupe key — resending the same nonce does not double-post."),
        sticker_ids: z
          .array(requiredId("Sticker id to send."))
          .max(MAX_STICKERS)
          .optional()
          .describe(`Up to ${MAX_STICKERS} guild sticker ids.`),
        poll: pollSchema
          .optional()
          .describe("An attached poll: question, 1-10 answers, duration in hours, multiselect."),
        dry_run: DRY_RUN_FIELD,
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await sendMessage(ctx, args)),
  );

  server.registerTool(
    "edit_message",
    {
      title: "Edit message",
      description:
        "Edit a message Warden sent (or any message, with Manage Messages): replace content, replace embeds, set which attachment ids to keep, toggle suppress_embeds, and/or close an attached poll. Each field you pass replaces that part; fields you omit are left alone. Editing someone else's message needs Manage Messages; your own needs none. dry_run returns would_perform without writing.",
      inputSchema: z.object({
        guild_id: optionalId(
          "Guild the message is in (default: WARDEN_GUILD_ID, the one-server setup).",
        ),
        channel_id: requiredId("Channel or thread holding the message."),
        message_id: requiredId("Message to edit."),
        content: z
          .string()
          .max(2000)
          .optional()
          .describe("New message text (≤2000 chars)."),
        embeds: z
          .array(embedSchema)
          .max(MAX_EMBEDS)
          .optional()
          .describe(`Replacement embeds (up to ${MAX_EMBEDS}).`),
        attachments: z
          .array(requiredId("Attachment id to keep."))
          .max(MAX_ATTACHMENTS)
          .optional()
          .describe(
            "Attachment ids to keep — passing this removes every attachment not listed (empty array strips them all).",
          ),
        flags: z
          .array(z.enum(["suppress_embeds"]))
          .optional()
          .describe("Message flags to set. `suppress_embeds` hides embed previews."),
        close_poll: z
          .boolean()
          .optional()
          .describe("End an attached poll early so its results finalize now."),
        dry_run: DRY_RUN_FIELD,
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await editMessage(ctx, args)),
  );

  server.registerTool(
    "delete_message",
    {
      title: "Delete message",
      description:
        "Delete one message: your own with no extra permission, anyone else's with Manage Messages. Records `warden:delete_message` plus your reason in the audit log. Works in guild channels, threads and DMs (a DM id needs no guild). dry_run returns would_perform without deleting.",
      inputSchema: z.object({
        guild_id: optionalId(
          "Guild the message is in (default: WARDEN_GUILD_ID). Omit for a DM.",
        ),
        channel_id: requiredId("Channel, thread or DM holding the message."),
        message_id: requiredId("Message to delete."),
        reason: REASON_FIELD.optional(),
        dry_run: DRY_RUN_FIELD,
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await deleteMessage(ctx, args)),
  );

  server.registerTool(
    "bulk_delete_messages",
    {
      title: "Bulk delete messages",
      description:
        "Delete 2-100 messages from one channel in a single Discord call. Needs Manage Messages; ids must be under 14 days old and not future-dated (Discord's own rule — older messages answer invalid_input, delete them individually). Records `warden:bulk_delete_messages` plus your reason in the audit log. dry_run runs every check and returns would_perform without deleting.",
      inputSchema: z.object({
        guild_id: optionalId(
          "Guild the messages are in (default: WARDEN_GUILD_ID, the one-server setup).",
        ),
        channel_id: requiredId("Channel or thread to purge."),
        message_ids: z
          .array(requiredId("Message id to delete."))
          .min(2)
          .max(100)
          .describe("2-100 message ids, all in this channel."),
        reason: REASON_FIELD.optional(),
        dry_run: DRY_RUN_FIELD,
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await bulkDeleteMessages(ctx, args)),
  );

  server.registerTool(
    "crosspost_message",
    {
      title: "Crosspost message",
      description:
        "Publish (crosspost) one message from an announcement channel to every channel following it. Needs Send Messages, plus Manage Messages when the message is not Warden's own; the channel must be an announcement channel. Returns the published message with its follower count. dry_run returns would_perform without publishing.",
      inputSchema: z.object({
        guild_id: optionalId(
          "Guild the announcement channel is in (default: WARDEN_GUILD_ID).",
        ),
        channel_id: requiredId("Announcement channel holding the message."),
        message_id: requiredId("Message to publish."),
        dry_run: DRY_RUN_FIELD,
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await crosspostMessage(ctx, args)),
  );

  server.registerTool(
    "manage_pins",
    {
      title: "Manage pins",
      description:
        "Pin, unpin, unpin everything, or list pins in one channel. pin/unpin need Manage Messages and record `warden:manage_pins` plus your reason in the audit log; `list` is a read (no preflight) and returns each pin with when it was pinned. `unpin_all` walks the pin list since Discord has no bulk route, and reports how far it got if one fails. dry_run applies to the mutating actions.",
      inputSchema: z.object({
        action: z
          .enum(["pin", "unpin", "unpin_all", "list"])
          .describe("What to do — 'list' needs no message_id."),
        guild_id: optionalId(
          "Guild the channel is in (default: WARDEN_GUILD_ID, the one-server setup).",
        ),
        channel_id: requiredId("Channel or thread to work in."),
        message_id: optionalId(
          "Message to pin or unpin (required for actions 'pin' and 'unpin').",
        ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("For 'list': maximum pins to return (1-100)."),
        reason: REASON_FIELD.optional(),
        dry_run: DRY_RUN_FIELD,
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await managePins(ctx, args)),
  );

  server.registerTool(
    "manage_reactions",
    {
      title: "Manage reactions",
      description:
        "Add or remove reactions, clear them, or read who reacted. `add` needs Add Reactions; `remove` of Warden's own reaction needs nothing extra, of someone else's Manage Messages; `remove_all` and `remove_emoji` need Manage Messages. `get_reaction_users` is a read: page up to 100 users with `after`. Emoji may be unicode (👍) or custom (`<a:name:id>` / `<name:id>`). dry_run applies to the mutating actions.",
      inputSchema: z.object({
        action: z
          .enum(["add", "remove", "remove_all", "remove_emoji", "get_reaction_users"])
          .describe("What to do with the reaction."),
        guild_id: optionalId(
          "Guild the message is in (default: WARDEN_GUILD_ID, the one-server setup).",
        ),
        channel_id: requiredId("Channel or thread holding the message."),
        message_id: requiredId("Message to react to or read."),
        emoji: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The emoji: unicode 👍, a custom `<a:name:id>` or `<name:id>`. Required except for 'remove_all'.",
          ),
        user_id: optionalId(
          "Whose reaction to remove (default: Warden's own).",
        ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_REACTION_USERS)
          .optional()
          .describe(`For 'get_reaction_users': page size (1-${MAX_REACTION_USERS}).`),
        after: optionalId(
          "For 'get_reaction_users': return users after this id (paging).",
        ),
        dry_run: DRY_RUN_FIELD,
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await manageReactions(ctx, args)),
  );

  server.registerTool(
    "get_poll_results",
    {
      title: "Get poll results",
      description:
        "Live results of a message's poll: question, every answer with its current vote count, expiry and whether it has finalized. Fetched with force:true so running polls report today's numbers rather than a cached snapshot. Pass answer_id to page through that answer's voters (up to 100, `after` cursor). Needs only to see the channel.",
      inputSchema: z.object({
        guild_id: optionalId(
          "Guild the poll is in (default: WARDEN_GUILD_ID, the one-server setup).",
        ),
        channel_id: requiredId("Channel or thread holding the poll message."),
        message_id: requiredId("Message carrying the poll."),
        answer_id: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Also return this answer's voters (an id from `answers`)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_REACTION_USERS)
          .optional()
          .describe(`Voters per page (1-${MAX_REACTION_USERS}, default 100).`),
        after: optionalId("Return voters after this user id (paging)."),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await getPollResults(ctx, args)),
  );
}
