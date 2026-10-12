/**
 * Observe domain (plan §8.1) — tools that answer "what is Warden, and what
 * just happened" without touching Discord's REST API.
 *
 * Phase 4 ships `get_bot_status`, the tool an agent should call first: it is
 * the honest-capability report of plan §8.1 and the reason a misconfigured
 * bot is diagnosable from inside the MCP session instead of from the logs.
 * The event tools (`get_events`, `watch`, `read_watch`, `list_watches`,
 * `unwatch`, `wait_for_event`) join this module in Phase 5.
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
import { fail, ok } from "../shared/result.js";
import type { ToolResult } from "../shared/result.js";
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
}
