/**
 * Channels domain (plan §8.3).
 *
 * Phase 6 ships the **read** half — `list` and `get` — which is what an agent
 * needs to pick a `channel_id` before it can do anything else. The mutation
 * half of this tool (`create`/`edit`/`delete`/`clone`) plus
 * `manage_channel_permissions`, `set_voice_channel_status` and
 * `follow_channel` follow in Phase 9, and they widen *this* tool rather than
 * adding a second one — plan §8 names one `manage_channel` for the domain.
 *
 * Reads skip the preflight (plan §6 covers mutations) but not the resolution
 * layer: `resolveGuild`/`resolveChannel` already answer `not_ready`,
 * `not_found` and `invalid_input` in the uniform shape.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { resolveChannel, resolveGuild } from "../discord/guards.js";
import { isWardenError } from "../discord/errors.js";
import { serializeChannel } from "../discord/serializers/index.js";
import type { SerializedChannel } from "../discord/serializers/index.js";
import { fail } from "../shared/result.js";
import type { ToolResult } from "../shared/result.js";
import { optionalId, readOk, toCallToolResult } from "./context.js";
import type { ToolContext } from "./context.js";

/** Stable order: category/position first, then id — never cache iteration. */
export function byPosition(
  a: { position: number | null; id: string },
  b: { position: number | null; id: string },
): number {
  const byRank = (a.position ?? -1) - (b.position ?? -1);
  return byRank !== 0 ? byRank : a.id.localeCompare(b.id);
}

export async function manageChannel(
  ctx: ToolContext,
  args: { action: "list" | "get"; guild_id?: string; channel_id?: string },
): Promise<ToolResult> {
  const guild = resolveGuild(
    ctx.discord,
    args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
  );
  if (isWardenError(guild)) return guild;

  if (args.action === "list") {
    const channels = [...guild.channels.cache.values()]
      // Threads share the channel cache; they belong to `manage_thread`
      // (Phase 6 ships its reads too), and mixing them in would bury the
      // postable channels an agent is choosing between.
      .filter((channel) => !channel.isThread())
      .map((channel) => serializeChannel(channel))
      .sort(byPosition);
    return readOk("channel.list", { channels, count: channels.length });
  }

  if (args.channel_id === undefined) {
    return fail({
      error: "invalid_input",
      message: "manage_channel with action 'get' needs a channel_id.",
      remediation:
        "Pass channel_id — or call action 'list' to see what this server has.",
    });
  }

  const channel = resolveChannel(guild, args.channel_id);
  if (isWardenError(channel)) return channel;

  const notes: string[] = [];
  if (channel.isThread()) {
    notes.push(
      `Channel ${channel.id} is a thread, not a postable channel — manage_thread reads threads (its list/list_archived/get_member actions).`,
    );
  }
  if (channel.isVoiceBased()) {
    // Voice regions are validated against Discord's list when a *mutation*
    // picks one (Phase 9); here the note just names the field's constraint.
    notes.push(
      "This is a voice-based channel: bitrate and user_limit apply, and Warden can read its voice states through the event tools.",
    );
  }

  const serialized: SerializedChannel = serializeChannel(channel);
  return readOk("channel.get", { channel: serialized }, notes);
}

export function registerChannelTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "manage_channel",
    {
      title: "Manage channels",
      description:
        "Read channels of a server Warden is in. Supported actions: 'list' (every non-thread channel, sorted by position, including permission overwrites) and 'get' (one channel's full shape — name, topic, type, category, position, nsfw, slowmode, voice settings, forum tags, overwrites). Threads are read through manage_thread instead. Requires no permissions beyond membership; answers not_found if the id is not in the guild.",
      inputSchema: z.object({
        action: z
          .enum(["list", "get"])
          .describe("What to do: 'list' every channel, or 'get' one by id."),
        guild_id: optionalId(
          "Guild to read (default: WARDEN_GUILD_ID, the one-server setup).",
        ),
        channel_id: optionalId(
          "Channel to describe — required for action 'get'; ignored by 'list'.",
        ),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await manageChannel(ctx, args)),
  );
}
