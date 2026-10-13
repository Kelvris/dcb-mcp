/**
 * Observe domain (plan §8.1) — tools that answer "what is Warden, and what
 * just happened" without touching Discord's REST API.
 *
 * `get_bot_status` (Phase 4) is the honest-capability report of §8.1 and the
 * tool an agent should call first. Phase 5 adds the event tools —
 * `get_events`, `watch`, `read_watch`, `list_watches`, `unwatch`,
 * `wait_for_event` — all served from the process-local buffer and watch
 * sessions (plan §7), never from Discord.
 *
 * That locality is why these tools keep answering while the gateway is down:
 * `not_ready` belongs to tools that need Discord (§5); an agent polling a
 * watch through a reconnect should see `idle`, not an error. They add a
 * note saying so instead.
 */

import type { Client, Guild } from "discord.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  PRIVILEGED_INTENTS,
  WARDEN_INTENT_NAMES,
} from "../discord/client.js";
import { blockersFor, resolveGuild } from "../discord/guards.js";
import { isWardenError } from "../discord/errors.js";
import { serializePermissions } from "../discord/serializers/index.js";
import { normalizeFilter } from "../events/normalize.js";
import { fail, ok } from "../shared/result.js";
import type { ToolResult } from "../shared/result.js";
import type { WardenError } from "../discord/errors.js";
import type { EventFilter } from "../events/types.js";
import { toCallToolResult, optionalId, scrubText } from "./context.js";
import type { ToolContext } from "./context.js";

/** Warden's top role and what it can do inside one guild. */
export interface GuildCapability {
  id: string;
  name: string;
  available: boolean;
  counts: { members: number | null; channels: number; roles: number };
  /** `null` while Warden's own member is not cached in this guild yet. */
  topRole: {
    id: string;
    name: string;
    position: number;
    permissions: string[];
  } | null;
  /**
   * Effective guild-wide permissions (Administrator short-circuits to all).
   *
   * Empty **and meaningless** while `topRole` is `null` — "not cached yet",
   * not "has no permissions"; `blockers` says so in words for that case.
   */
  permissions: string[];
  /**
   * Known reasons a mutation would fail: roles above Warden's top role and
   * missing key permissions. `[]` means "nothing known is in the way" — not
   * "every target is editable" (see `blockersFor`).
   */
  blockers: string[];
}

export interface BotStatusData {
  ready: boolean;
  bot: { id: string; username: string; discriminator: string } | null;
  gateway: {
    status: string;
    pingMs: number | null;
    readySince: string | null;
    guildCount: number;
    reconnects: number;
    disconnects: number;
    lastCloseCode: number | null;
    /**
     * Non-null once the connection can **never** become ready (invalid or
     * reset token, privileged intents not enabled, destroyed client): the
     * reason plus the operator-facing fix. This is what separates "retry in
     * a few seconds" from "fix your token first" — without it a bad token
     * would report `ready:false` forever while the remediation sat only on
     * stderr.
     */
    fatal: { reason: string; remediation: string } | null;
  };
  intents: {
    count: number;
    names: string[];
    /** Must be enabled in the developer portal or the gateway rejects login. */
    privileged: string[];
  };
  /** Non-secret slice of the configuration this process was started with. */
  config: {
    applicationId: string | null;
    defaultGuildId: string | null;
    dryRun: boolean;
    maxEvents: number;
    maxWatches: number;
    logLevel: string;
  };
  guilds: GuildCapability[];
}

/** Per-guild capability report — plan §8.1's "bot's top role + blockers". */
function capabilityReport(client: Client, guild: Guild): GuildCapability {
  const counts = {
    members: guild.memberCount ?? null,
    channels: guild.channels.cache.filter((channel) => !channel.isThread())
      .size,
    roles: guild.roles.cache.size,
  };

  // `guild.members.me` is deliberately not used: it throws before READY and
  // fabricates a role-less partial when the real member is uncached (the two
  // discord.js behaviours `guards.ts` documents in its file header).
  const me = client.user
    ? guild.members.cache.get(client.user.id)
    : undefined;
  if (!me) {
    return {
      id: guild.id,
      name: scrubText(guild.name),
      available: guild.available,
      counts,
      topRole: null,
      permissions: [],
      blockers: [
        "Warden's own member is not cached in this guild yet — retry in a few seconds.",
      ],
    };
  }

  const top = me.roles.highest;
  return {
    id: guild.id,
    name: scrubText(guild.name),
    available: guild.available,
    counts,
    topRole: {
      id: top.id,
      name: scrubText(top.name),
      position: top.position,
      permissions: serializePermissions(top.permissions),
    },
    permissions: serializePermissions(me.permissions),
    blockers: blockersFor(me),
  };
}

export async function getBotStatus(
  ctx: ToolContext,
  args: { guild_id?: string },
): Promise<ToolResult> {
  const status = ctx.discord.status();
  const ready = ctx.discord.isReady();

  const data: BotStatusData = {
    ready,
    // Usernames, guild names and role names are operator-authored free text,
    // so they go through `scrubText` like everything else in this payload
    // that a human typed (plan §4 — see `scrubText`'s doc).
    bot:
      status.user === null
        ? null
        : { ...status.user, username: scrubText(status.user.username) },
    gateway: {
      status: status.wsStatus,
      pingMs: status.wsPingMs,
      readySince: status.readyAt,
      guildCount: status.guildCount,
      reconnects: status.reconnects,
      disconnects: status.disconnects,
      lastCloseCode: status.lastCloseCode,
      fatal: status.fatal,
    },
    intents: {
      count: WARDEN_INTENT_NAMES.length,
      names: [...WARDEN_INTENT_NAMES],
      privileged: [...PRIVILEGED_INTENTS],
    },
    config: {
      applicationId: ctx.config.DISCORD_APPLICATION_ID ?? null,
      defaultGuildId: ctx.config.WARDEN_GUILD_ID ?? null,
      dryRun: ctx.config.WARDEN_DRY_RUN,
      maxEvents: ctx.config.WARDEN_MAX_EVENTS,
      maxWatches: ctx.config.WARDEN_MAX_WATCHES,
      logLevel: ctx.config.WARDEN_LOG_LEVEL,
    },
    guilds: [],
  };

  const notes: string[] = [];
  if (!ready) {
    // Deliberately a success: this is the diagnostic tool, and answering the
    // question "what is the state" is exactly its job. The not_ready failure
    // belongs to the tools that need Discord.
    if (data.gateway.fatal) {
      // Never say "retry" when retrying cannot work — a reset token or a
      // disabled privileged intent fails forever, and the fix is an operator
      // action, not another call.
      notes.push(
        `The Discord connection can never become ready: ${data.gateway.fatal.reason} Fix: ${data.gateway.fatal.remediation}`,
      );
    } else {
      notes.push(
        "The Discord gateway is not connected yet — tools that talk to Discord answer not_ready until it is. Call get_bot_status again in a few seconds.",
      );
    }
    if (args.guild_id !== undefined) {
      // Say the filter was dropped rather than silently returning `guilds: []`
      // — an agent comparing a ready and an unready call would otherwise read
      // "this guild has no capability report" instead of "not applicable yet".
      notes.push(
        "The guild_id filter was not applied because no guild is cached while the gateway is down.",
      );
    }
    return ok("bot.status", data, notes);
  }

  let guilds = [...ctx.discord.client.guilds.cache.values()];
  if (args.guild_id !== undefined) {
    const resolved = resolveGuild(ctx.discord, args.guild_id);
    if (isWardenError(resolved)) return fail(resolved);
    guilds = [resolved];
  }
  // Sorted by id: cache order follows Discord's GUILD_CREATE sequence, which
  // would otherwise reorder the report between calls (plan: stable output —
  // same rule `get_server` applies to its channels).
  guilds.sort((a, b) => a.id.localeCompare(b.id));
  data.guilds = guilds.map((guild) =>
    capabilityReport(ctx.discord.client, guild),
  );

  return ok("bot.status", data, notes);
}

// ---------------------------------------------------------------------------
// event tools (plan §8.1) — every one served from the local buffer
// ---------------------------------------------------------------------------

/** Tool-boundary filter input — snake_case, mirroring the zod schema. */
export interface EventFilterInput {
  types?: string[];
  guild_id?: string;
  channel_id?: string;
  author_id?: string;
  target_id?: string;
  message_id?: string;
}

export interface GetEventsArgs {
  filter?: EventFilterInput;
  since_seq?: number;
  since?: string;
  limit?: number;
}

export interface CreateWatchArgs {
  name: string;
  filter?: EventFilterInput;
  since_seq?: number;
  since?: string;
}

export interface ReadWatchArgs {
  watch_id: string;
  block_ms?: number;
  limit?: number;
}

export interface WaitForEventArgs {
  filter?: EventFilterInput;
  timeout_ms: number;
}

/**
 * Validate + canonicalize a tool filter, rejecting the one genuinely
 * ambiguous input (both cursor styles at once). Shared by `get_events`,
 * `watch` and `wait_for_event` so their semantics cannot drift.
 */
function buildFilter(args: {
  filter?: EventFilterInput;
  since_seq?: number;
  since?: string;
}): EventFilter | WardenError {
  if (args.since_seq !== undefined && args.since !== undefined) {
    return fail({
      error: "invalid_input",
      message: "Provide either since_seq or since, not both.",
      remediation:
        "since_seq pages forward from a cursor a previous call returned; since selects by wall-clock time. Pick one.",
    });
  }
  const normalized = normalizeFilter({
    ...args.filter,
    // Only override the spread when actually given: an explicit `undefined`
    // would otherwise wipe a value the caller put inside `filter`.
    ...(args.since_seq !== undefined ? { since_seq: args.since_seq } : {}),
    ...(args.since !== undefined ? { since: args.since } : {}),
  });
  return isWardenError(normalized) ? fail(normalized) : normalized;
}

/** "Buffer can't answer that, Discord can" note — plan §7.4's REST fallback. */
function bufferHorizonNote(ctx: ToolContext, sinceSeq: number | undefined): string | null {
  if (sinceSeq === undefined) return null;
  const oldest = ctx.events.bus.oldestSeq;
  if (oldest === 0 || sinceSeq >= oldest - 1) return null;
  return (
    `The buffer only holds events from seq ${oldest} onward; anything older must come ` +
    "from the REST tools (get_messages, search_messages, get_audit_log)."
  );
}

export async function getEvents(
  ctx: ToolContext,
  args: GetEventsArgs,
): Promise<ToolResult> {
  const filter = buildFilter(args);
  if (isWardenError(filter)) return fail(filter);

  const bus = ctx.events.bus;
  // `since` is converted to a seq cursor so both bounds page forward
  // oldest-first; without either bound, this is the tail (latest `limit`).
  const afterSeq =
    args.since_seq ?? (args.since !== undefined ? bus.cursorFor(args.since) : undefined);
  const { events, cursor } = bus.query({ filter, afterSeq, limit: args.limit });

  const notes: string[] = [];
  if (!ctx.discord.isReady()) {
    notes.push(
      "The Discord gateway is not connected — the buffer only holds events captured before the disconnect.",
    );
  }
  const horizon = bufferHorizonNote(ctx, afterSeq);
  if (horizon !== null) notes.push(horizon);

  return ok(
    "event.get",
    { events, cursor, count: events.length },
    notes,
  );
}

/**
 * Present a canonical filter back in the tool boundary's own snake_case
 * shape, so an agent reading a filter from `watch`/`list_watches` can pass
 * it straight back into a `filter` argument without renaming every key.
 *
 * The two `since` bounds deliberately stay out: they travel as *top-level*
 * siblings of `filter` (mirroring the input schemas, where `filter` declares
 * only the six id/type keys) — see {@link presentSince}.
 */
function presentFilter(filter: EventFilter): Record<string, unknown> {
  const presented: Record<string, unknown> = {};
  if (filter.types !== undefined) presented.types = filter.types;
  if (filter.guildId !== undefined) presented.guild_id = filter.guildId;
  if (filter.channelId !== undefined) presented.channel_id = filter.channelId;
  if (filter.authorId !== undefined) presented.author_id = filter.authorId;
  if (filter.targetId !== undefined) presented.target_id = filter.targetId;
  if (filter.messageId !== undefined) presented.message_id = filter.messageId;
  return presented;
}

/** The since bounds as top-level siblings of `filter` (see {@link presentFilter}). */
function presentSince(filter: EventFilter): Record<string, unknown> {
  return {
    ...(filter.sinceSeq !== undefined ? { since_seq: filter.sinceSeq } : {}),
    ...(filter.since !== undefined ? { since: filter.since } : {}),
  };
}

export function createWatch(
  ctx: ToolContext,
  args: CreateWatchArgs,
): ToolResult {
  const filter = buildFilter(args);
  if (isWardenError(filter)) return fail(filter);

  const created = ctx.events.watches.create({ name: args.name, filter });
  if (isWardenError(created)) return fail(created);

  const notes: string[] = [];
  if (!ctx.discord.isReady()) {
    notes.push(
      "The watch was created while the Discord gateway is not connected — it captures from the next event onward.",
    );
  }
  return ok(
    "event.watch",
    {
      watch_id: created.watch_id,
      name: created.name,
      cursor: created.cursor,
      filter: presentFilter(created.filter),
      // Top-level siblings of `filter`, exactly where the input takes them —
      // an agent can paste both back verbatim.
      ...presentSince(created.filter),
    },
    notes,
  );
}

export async function readWatch(
  ctx: ToolContext,
  args: ReadWatchArgs,
): Promise<ToolResult> {
  const result = await ctx.events.watches.read({
    name: args.watch_id,
    blockMs: args.block_ms,
    limit: args.limit,
  });
  if (isWardenError(result)) return fail(result);

  const notes: string[] = [];
  if (result.evictedCount > 0) {
    // The count only — `bus.oldestSeq` has moved on since it was computed,
    // and quoting a later snapshot next to it would be self-contradictory.
    notes.push(
      `${result.evictedCount} event(s) since this watch's cursor were already evicted from the ring ` +
        "before this read; a matching event may have been missed — " +
        "read more often, raise WARDEN_MAX_EVENTS, or cover the gap with the REST tools (get_messages, search_messages, get_audit_log).",
    );
  }
  if (!ctx.discord.isReady()) {
    notes.push(
      "The Discord gateway is not connected — no new events can arrive until it reconnects.",
    );
  }
  return ok(
    "event.read",
    {
      events: result.events,
      cursor: result.cursor,
      idle: result.idle,
      count: result.events.length,
    },
    notes,
  );
}

export function listWatches(ctx: ToolContext): ToolResult {
  const watches = ctx.events.watches.list().map((watch) => ({
    ...watch,
    filter: presentFilter(watch.filter),
    ...presentSince(watch.filter),
  }));
  return ok("event.list", { watches, count: watches.length });
}

export function removeWatch(ctx: ToolContext, watchId: string): ToolResult {
  const removed = ctx.events.watches.remove(watchId);
  if (isWardenError(removed)) return fail(removed);
  return ok("event.unwatch", removed);
}

export async function waitForEvent(
  ctx: ToolContext,
  args: WaitForEventArgs,
): Promise<ToolResult> {
  const filter = buildFilter(args);
  if (isWardenError(filter)) return fail(filter);

  const result = await ctx.events.watches.waitOnce({
    filter,
    timeoutMs: args.timeout_ms,
  });

  const notes: string[] = [];
  if (result.timeout && !ctx.discord.isReady()) {
    notes.push(
      "The Discord gateway is not connected — no events can arrive until it reconnects.",
    );
  }
  return ok("event.wait", { event: result.event, timeout: result.timeout }, notes);
}

// ---------------------------------------------------------------------------
// zod input schemas
// ---------------------------------------------------------------------------

const LIMIT_FIELD = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .describe("Maximum events to return (1-200, default 50).");

const SINCE_FIELDS = {
  since_seq: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Return only events after this sequence number — pass a previous call's cursor to page forward.",
    ),
  since: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)), {
      error: "must be an ISO 8601 timestamp, e.g. 2026-10-01T12:00:00.000Z",
    })
    .optional()
    .describe("Return only events after this timestamp (alternative to since_seq)."),
};

const filterShape = () => ({
  types: z
    .array(z.string().min(1).max(64))
    .max(50)
    .optional()
    .describe(
      'Event types: canonical names ("messageCreate"), wire names ("MESSAGE_CREATE"), or wildcard prefixes ("message*", "guildScheduledEvent*"). Omit for every type.',
    ),
  guild_id: optionalId("Only events from this guild."),
  channel_id: optionalId("Only events from this channel or thread."),
  author_id: optionalId(
    "Only events whose actor is this user: message author, reaction/vote user, audit-log executor.",
  ),
  target_id: optionalId(
    "Only events about this entity: the role, member, banned user, scheduled event or automod rule affected.",
  ),
  message_id: optionalId(
    "Only events about this message: its edits, reactions, poll votes and deletion.",
  ),
});

const filterSchema = z.object(filterShape());

function watchName(description: string): z.ZodString {
  return z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/, {
      error: "must be 1-64 characters of letters, digits, '_', '.' or '-'",
    })
    .describe(description);
}

export function registerObserveTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_bot_status",
    {
      title: "Bot status",
      description:
        "Warden's live gateway status and per-server capability report: connection state, ws ping, ready-since, cached guilds, Warden's top role and effective permissions in each, and every known blocker (a role above Warden, a missing key permission). Read-only and safe to call at any time — while the gateway is still connecting it answers ready:false instead of failing. Call this first when a mutation reports not_ready.",
      inputSchema: z.object({
        guild_id: optionalId(
          "Limit the capability report to this guild (default: every cached guild).",
        ),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await getBotStatus(ctx, args)),
  );

  server.registerTool(
    "get_events",
    {
      title: "Get events",
      description:
        "Pull recent events from Warden's in-memory buffer — no Discord API calls. Filter by event type (canonical or wire names, wildcards like \"message*\"), guild, channel, author, target or message, or fetch by since_seq/since. Without a bound it returns the newest events (the tail); with one it pages forward oldest-first and returns a cursor to continue from. History older than the buffer belongs to the REST tools (get_messages, search_messages, get_audit_log).",
      inputSchema: z.object({
        filter: filterSchema.optional(),
        ...SINCE_FIELDS,
        limit: LIMIT_FIELD,
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => toCallToolResult(await getEvents(ctx, args)),
  );

  server.registerTool(
    "watch",
    {
      title: "Create watch",
      description:
        "Create a named watch: a cursor over the event buffer that starts at the current head (or after since_seq/since) and from then on only delivers NEW matching events — the anti-hammering way to follow a channel, one message, or an event type live. Returns watch_id (the name you chose) and the initial cursor. Names are unique (unwatch to reuse one); watches expire after 30 idle minutes and count against WARDEN_MAX_WATCHES.",
      inputSchema: z.object({
        name: watchName("Unique watch name — becomes the watch_id other tools take."),
        filter: filterSchema.optional(),
        ...SINCE_FIELDS,
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) => toCallToolResult(createWatch(ctx, args)),
  );

  server.registerTool(
    "read_watch",
    {
      title: "Read watch",
      description:
        "Read only what a watch has not delivered yet: events with seq > cursor, with the cursor advanced so nothing is returned twice. An idle watch answers [] with idle:true. block_ms (max 25000) long-polls until the next matching event or timeout, so following a live channel needs one call per event, not a tight poll loop.",
      inputSchema: z.object({
        watch_id: watchName("The watch to read (the name passed to watch())."),
        block_ms: z
          .number()
          .int()
          .min(0)
          .max(25_000)
          .optional()
          .describe(
            "Wait up to this many ms for a new matching event instead of returning [] immediately (max 25000).",
          ),
        limit: LIMIT_FIELD,
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => toCallToolResult(await readWatch(ctx, args)),
  );

  server.registerTool(
    "list_watches",
    {
      title: "List watches",
      description:
        "List every live watch with its filter, current cursor, creation and last-read times, and idle seconds. Watches idle for 30 minutes disappear automatically — an empty list here explains why a read_watch answered not_found.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => toCallToolResult(listWatches(ctx)),
  );

  server.registerTool(
    "unwatch",
    {
      title: "Remove watch",
      description:
        "Remove a watch and its cursor. Call it when an agent is done following a channel, or to free a slot before creating a watch under the same name. An unknown watch_id answers not_found — list_watches shows what is live.",
      inputSchema: z.object({
        watch_id: watchName("The watch to remove (the name passed to watch())."),
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) => toCallToolResult(removeWatch(ctx, args.watch_id)),
  );

  server.registerTool(
    "wait_for_event",
    {
      title: "Wait for event",
      description:
        "One-shot wait: block until the next event matching the filter arrives (timeout_ms, max 25000), then return it — or timeout:true. Creates no watch and consumes nothing from the buffer; use it to await one specific thing (a member joining, a message in one channel) instead of polling. For buffered history use get_events; for continuous following use watch + read_watch.",
      inputSchema: z.object({
        filter: filterSchema.optional(),
        timeout_ms: z
          .number()
          .int()
          .min(0)
          .max(25_000)
          .describe(
            "Maximum time to wait in ms (max 25000 — MCP requests must stay well under the 60s client timeout).",
          ),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => toCallToolResult(await waitForEvent(ctx, args)),
  );
}
