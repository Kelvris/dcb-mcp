/**
 * Server & settings domain (plan §8.2).
 *
 * Phase 4 ships `get_server`, the read every agent reaches for after
 * `get_bot_status`: what this server is, what it allows, and what it
 * contains. Phase 6 adds `get_audit_log`. The mutating half of this domain
 * (`update_server`, vanity URL, welcome screen, onboarding, widget,
 * membership screening) and the remaining reads (integrations, stage
 * instances) follow in Phases 8 and 10.
 */

import { AuditLogEvent } from "discord.js";
import type { GuildBasedChannel } from "discord.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { resolveGuild } from "../discord/guards.js";
import { isWardenError } from "../discord/errors.js";
import {
  compact,
  serializeAuditLogEntry,
  serializeChannel,
  serializeGuild,
} from "../discord/serializers/index.js";
import type {
  SerializedAuditEntry,
  SerializedChannel,
  SerializedGuild,
} from "../discord/serializers/index.js";
import { fail, ok } from "../shared/result.js";
import type { ToolResult } from "../shared/result.js";
import {
  attempt,
  optionalId,
  readOk,
  scrubText,
  toCallToolResult,
} from "./context.js";
import type { ToolContext } from "./context.js";

/**
 * The channel list `get_server` returns: enough to navigate the server and
 * pick a `channel_id` for the next tool, without the per-channel detail that
 * `manage_channel` (Phase 6) exists for. Overwrites are deliberately absent —
 * they are the largest field on a channel and answering "what can I see" is
 * the channel-read tool's job, not the overview's.
 */
export type ChannelSummary = Pick<
  SerializedChannel,
  | "id"
  | "type"
  | "name"
  | "parentId"
  | "position"
  | "topic"
  | "nsfw"
  | "rateLimitPerUser"
  | "bitrate"
  | "userLimit"
  | "archived"
  | "locked"
  | "ownerId"
  | "memberCount"
>;

export interface ServerOverview extends SerializedGuild {
  /** Postable channels, sorted by position; threads are excluded. */
  channels: ChannelSummary[];
}

function channelSummary(channel: GuildBasedChannel): ChannelSummary {
  const full = serializeChannel(channel);
  // `compact` drops the keys that do not apply to this channel kind (a voice
  // channel has no `topic`, a text channel no `userLimit`) while keeping
  // `null` for "Discord says none" — the same rule the serializers follow.
  return compact({
    id: full.id,
    type: full.type,
    name: full.name,
    parentId: full.parentId,
    position: full.position,
    topic: full.topic,
    nsfw: full.nsfw,
    rateLimitPerUser: full.rateLimitPerUser,
    bitrate: full.bitrate,
    userLimit: full.userLimit,
    archived: full.archived,
    locked: full.locked,
    ownerId: full.ownerId,
    memberCount: full.memberCount,
  });
}

/** Stable order: category/position first, then id — never cache iteration. */
function byPosition(a: ChannelSummary, b: ChannelSummary): number {
  const byRank = (a.position ?? -1) - (b.position ?? -1);
  return byRank !== 0 ? byRank : a.id.localeCompare(b.id);
}

export async function getServer(
  ctx: ToolContext,
  args: { guild_id?: string },
): Promise<ToolResult> {
  // Read-only, so no preflight: nothing is mutated, and `resolveGuild` already
  // produces the structured not_ready/not_found/invalid_input answers.
  const guild = resolveGuild(
    ctx.discord,
    args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
  );
  if (isWardenError(guild)) return fail(guild);

  const channels = [...guild.channels.cache.values()]
    // Threads live in the same cache; they are reachable through
    // `manage_thread` (Phase 6), and listing them here would bury the
    // postable channels an agent is actually choosing between.
    .filter((channel) => !channel.isThread())
    .map(channelSummary)
    .sort(byPosition);

  const notes: string[] = [];
  if (guild.available === false) {
    notes.push(
      "This guild is currently unavailable (Discord incident or outage) — its data may be stale and mutations will fail until it recovers.",
    );
  }

  const serialized = serializeGuild(guild);
  // `ok()` does not scrub (shared/result.ts), and these four fields are the
  // operator-authored text in this payload — a token pasted into a guild
  // description or channel topic would otherwise reach the MCP result
  // verbatim, against plan §4 ("the token never appears in tool results").
  // Same obligation guards.ts documents for `blockersFor`.
  const overview: ServerOverview = {
    ...serialized,
    name: scrubText(serialized.name),
    description: scrubText(serialized.description),
    channels: channels.map((channel) => ({
      ...channel,
      name: scrubText(channel.name),
      topic: scrubText(channel.topic),
    })),
  };

  return ok("guild.get", overview, notes);
}

/**
 * Reverse map of `AuditLogEvent`: `34` → `"MemberBanAdd"`.
 *
 * Built once from the enum so `action_type` can accept Discord's own names —
 * the spelling an agent reads in the docs and on the developer portal — and
 * so entries can report a *name* rather than the number the API carries.
 * `AuditLogEvent` values are numbers, so `Object.entries` gives `[name,
 * value]` pairs directly.
 */
const AUDIT_ACTION_NAMES = new Map<number, string>(
  Object.entries(AuditLogEvent)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([name, value]) => [value, name]),
);

/** A subset worth naming in a schema description, not the whole enum. */
const AUDIT_ACTION_EXAMPLES = [
  "MemberBanAdd",
  "MemberKick",
  "MemberUpdate",
  "MessageDelete",
  "RoleCreate",
  "RoleUpdate",
  "ChannelCreate",
  "ChannelDelete",
  "GuildUpdate",
  "InviteCreate",
  "WebhookCreate",
  "EmojiCreate",
  "AutoModerationRuleCreate",
] as const;

/**
 * Accept either spelling of an action: the name ("MemberBanAdd") or the raw
 * number Discord sends ("34"). Both are what an agent plausibly has — the
 * name from the docs, the number from an event payload — and rejecting one
 * would just push the mapping onto the caller.
 */
function resolveActionType(input: string): number | ReturnType<typeof fail> {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (AUDIT_ACTION_NAMES.has(numeric)) return numeric;
  }
  const byName = Object.entries(AuditLogEvent).find(
    ([name, value]) => name === trimmed && typeof value === "number",
  );
  if (byName !== undefined) return byName[1] as number;

  return fail({
    error: "invalid_input",
    message: `'${input}' is not an audit-log action.`,
    remediation:
      `Pass a Discord audit-log action name (e.g. ${AUDIT_ACTION_EXAMPLES.slice(0, 4).join(", ")}) ` +
      "or its numeric value — see the action_type description for more names.",
    details: { field: "action_type", value: input },
  });
}

export interface GetAuditLogArgs {
  guild_id?: string;
  action_type?: string;
  user_id?: string;
  target_id?: string;
  before?: string;
  limit?: number;
}

export async function getAuditLog(
  ctx: ToolContext,
  args: GetAuditLogArgs,
): Promise<ToolResult> {
  const guild = resolveGuild(
    ctx.discord,
    args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
  );
  if (isWardenError(guild)) return guild;

  const notes: string[] = [];
  let type: number | undefined;
  if (args.action_type !== undefined) {
    const resolved = resolveActionType(args.action_type);
    if (isWardenError(resolved)) return resolved;
    type = resolved;
  }

  const limit = args.limit ?? 50;
  // Discord's audit-log endpoint filters on action type, executor and paging
  // cursor server-side; it has **no target filter** (RESTGetAPIAuditLogQuery
  // documents exactly four query parameters). `target_id` is therefore
  // applied to the fetched page here, and the payload says so — otherwise a
  // target-filtered call on a busy server would read "this target has no
  // history" when the truth is "this target's history was not on page one".
  const fetched = await attempt(() =>
    guild.fetchAuditLogs({
      ...(type !== undefined ? { type } : {}),
      ...(args.user_id !== undefined ? { user: args.user_id } : {}),
      ...(args.before !== undefined ? { before: args.before } : {}),
      limit,
    }),
  );
  if (isWardenError(fetched)) return fail(fetched);

  const all = [...fetched.entries.values()];
  const filtered =
    args.target_id === undefined
      ? all
      : all.filter((entry) => entry.targetId === args.target_id);

  if (args.target_id !== undefined && filtered.length < all.length) {
    notes.push(
      `Discord has no server-side target filter: ${all.length} entries were fetched and ${all.length - filtered.length} were dropped for not matching target_id. Page further back with before to look deeper.`,
    );
  }
  if (all.length === limit && args.before === undefined) {
    notes.push(
      "This page is full: pass the oldest entry's id as `before` to page further back.",
    );
  }

  const entries: SerializedAuditEntry[] = filtered.map((entry) =>
    serializeAuditLogEntry({
      id: entry.id,
      // `entry.action` is the numeric AuditLogEvent; the name is what an
      // agent can put straight back into `action_type`.
      action: AUDIT_ACTION_NAMES.get(entry.action) ?? entry.action,
      actionType: entry.actionType,
      targetType: entry.targetType,
      targetId: entry.targetId,
      reason: entry.reason,
      executor: entry.executor,
      // Forwarded explicitly: `serializeAuditLogEntry` falls back to the
      // executor *object*, which is null for a user discord.js could not
      // resolve — dropping the id here would silently null the one field
      // whose entire purpose is "who did this" surviving a partial user.
      executorId: entry.executorId,
      changes: entry.changes,
      extra: entry.extra as Record<string, unknown> | null,
      createdTimestamp: entry.createdTimestamp,
    }),
  );

  return readOk(
    "audit.get",
    { entries, count: entries.length, limit },
    notes,
  );
}

export function registerGuildTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_server",
    {
      title: "Server overview",
      description:
        "Read-only overview of one server Warden is in: settings (verification level, MFA, NSFW level, explicit-content filter, defaults, AFK/system channels), features, vanity URL, boost info, member/role/emoji counts, and a channel summary sorted by position (id, name, type, parent, topic, limits). Requires no permissions beyond membership. Fails with not_found if Warden is not in the guild, and with invalid_input if neither guild_id nor WARDEN_GUILD_ID names one.",
      inputSchema: z.object({
        guild_id: optionalId(
          "Guild to describe (default: WARDEN_GUILD_ID, the one-server setup).",
        ),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await getServer(ctx, args)),
  );

  server.registerTool(
    "get_audit_log",
    {
      title: "Audit log",
      description:
        "Read a server's audit log: who did what to whom, when, and the reason they gave. Filter by action_type (an AuditLogEvent name like 'MemberBanAdd' or its number), user_id (the executor), target_id, and page with before/limit (1-100). Each entry carries the executor, the target id, the reason, the property changes and action-specific extras. Note: Discord has no server-side target filter, so target_id narrows each fetched page.",
      inputSchema: z.object({
        guild_id: optionalId(
          "Guild to read (default: WARDEN_GUILD_ID, the one-server setup).",
        ),
        action_type: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            `Only this action: a Discord AuditLogEvent name (${AUDIT_ACTION_EXAMPLES.join(", ")}, …) or its numeric value.`,
          ),
        user_id: optionalId("Only actions performed by this user."),
        target_id: optionalId(
          "Only actions performed on this entity — applied per fetched page, since Discord filters targets client-side.",
        ),
        before: optionalId(
          "Return entries recorded before this entry id — pass the previous call's oldest id to page backwards.",
        ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum entries to return (1-100, default 50)."),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await getAuditLog(ctx, args)),
  );
}
