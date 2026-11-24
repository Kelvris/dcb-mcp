/**
 * Roles domain (plan §8.8).
 *
 * Phase 6 ships the read half — `list` — which is the input to every
 * hierarchy decision an agent makes before mutating anything. The mutation
 * half (`create`/`edit`/`delete`) plus `assign_roles` and `reorder_roles`
 * land in Phase 9 and widen this tool.
 *
 * The list deliberately reports **where Warden sits**, not just the roles:
 * plan §6's whole point is that hierarchy is the thing agents get wrong, and
 * a role list without "these N are above Warden's top role" is exactly the
 * information an agent has to re-derive (badly) from positions alone.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { resolveBotMember, resolveGuild } from "../discord/guards.js";
import { isWardenError } from "../discord/errors.js";
import { serializeRole } from "../discord/serializers/index.js";
import type { SerializedRole } from "../discord/serializers/index.js";
import type { ToolResult } from "../shared/result.js";
import { optionalId, readOk, toCallToolResult } from "./context.js";
import type { ToolContext } from "./context.js";

export interface RoleListData {
  roles: SerializedRole[];
  count: number;
  /**
   * Warden's own top role in this guild, and the roles sitting above it.
   *
   * `null` while Warden's member is not cached yet — the same "not
   * applicable" rule `get_bot_status` uses, never an empty array read as
   * "nothing is in the way".
   */
  warden: {
    topRoleId: string;
    topRolePosition: number | null;
    rolesAbove: { id: string; name: string; position: number | null }[];
  } | null;
}

export async function manageRole(
  ctx: ToolContext,
  args: { action: "list"; guild_id?: string },
): Promise<ToolResult> {
  const guild = resolveGuild(
    ctx.discord,
    args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
  );
  if (isWardenError(guild)) return guild;

  const notes: string[] = [];
  // Highest first: an agent reading a role list is almost always working out
  // the hierarchy, and top-down is the order that answer reads in.
  const roles = [...guild.roles.cache.values()]
    .map((role) => serializeRole(role))
    .sort((a, b) => (b.position ?? -1) - (a.position ?? -1) || a.id.localeCompare(b.id));

  let warden: RoleListData["warden"] = null;
  const botMember = resolveBotMember(ctx.discord, guild);
  if (isWardenError(botMember)) {
    notes.push(
      "Warden's own member is not cached in this guild yet, so the list carries no hierarchy verdict — retry in a few seconds.",
    );
  } else {
    const top = botMember.roles.highest;
    const rolesAbove = roles
      .filter((role) => {
        const cached = guild.roles.cache.get(role.id);
        // `comparePositionTo` is the comparison that survives discord.js'
        // recomputed positions (guards.ts documents why `position >` is not
        // enough); the cache lookup is the same object the serializer read.
        return cached !== undefined && cached.comparePositionTo(top) > 0;
      })
      .map((role) => ({
        id: role.id,
        name: role.name,
        position: role.position,
      }));
    warden = {
      topRoleId: top.id,
      topRolePosition: top.position,
      rolesAbove,
    };
    if (rolesAbove.length > 0) {
      notes.push(
        `${rolesAbove.length} role(s) sit above Warden's top role '${top.name}' — mutations against members holding them, or against the roles themselves, will be refused as role_hierarchy.`,
      );
    }
  }

  const data: RoleListData = { roles, count: roles.length, warden };
  return readOk("role.list", data, notes);
}

export function registerRoleTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "manage_role",
    {
      title: "Manage roles",
      description:
        "Read a server's roles, highest first: id, name, colour, permissions, hoist/mentionable/managed flags, icon and tags. Also reports where Warden itself sits — its top role and every role above it — so hierarchy is visible before any mutation is attempted. Supported action: 'list'. Requires no permissions beyond membership.",
      inputSchema: z.object({
        action: z
          .enum(["list"])
          .describe("What to do: 'list' every role of the guild."),
        guild_id: optionalId(
          "Guild to read (default: WARDEN_GUILD_ID, the one-server setup).",
        ),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await manageRole(ctx, args)),
  );
}
