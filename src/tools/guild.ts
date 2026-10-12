/**
 * Server & settings domain (plan §8.2).
 *
 * Phase 4 ships `get_server`, the read every agent reaches for after
 * `get_bot_status`: what this server is, what it allows, and what it
 * contains. The mutating half of this domain (`update_server`, vanity URL,
 * welcome screen, onboarding, widget, membership screening) and the remaining
 * reads (audit log, integrations, stage instances) follow in Phases 6 and 10.
 */

import type { GuildBasedChannel } from "discord.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { resolveGuild } from "../discord/guards.js";
import { isWardenError } from "../discord/errors.js";
import {
  compact,
  serializeChannel,
  serializeGuild,
} from "../discord/serializers/index.js";
import type {
  SerializedChannel,
  SerializedGuild,
} from "../discord/serializers/index.js";
import { fail, ok } from "../shared/result.js";
import type { ToolResult } from "../shared/result.js";
import { optionalId, scrubText, toCallToolResult } from "./context.js";
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
}
