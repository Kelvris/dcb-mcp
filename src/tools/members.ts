/**
 * Members domain (plan §8.6) — the read tools: `list_members`, `get_member`,
 * `get_user`. The mutations (`update_member`, `kick_member`,
 * `timeout_member`, `prune_members`) are Phase 8.
 *
 * The one design decision worth stating up front: **`list_members` reads the
 * gateway cache, not REST.** `role_id`, `in_voice` and `online` are all
 * cache-only predicates (Discord's list-members endpoint filters on none of
 * them), so honouring them over REST would mean paging the whole member list
 * through Warden for every call. The cache is complete for any bot with the
 * `GuildMembers` intent, and where it is not — a large guild still syncing,
 * or the intent disabled — the payload says so in a note instead of quietly
 * reporting a short list as the truth. `query` is the exception: member
 * search has no cache representation at all, so it always goes to REST.
 */

import type { Guild, GuildMember } from "discord.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  checkMemberHierarchy,
  resolveBotMember,
  resolveChannel,
  resolveGuild,
} from "../discord/guards.js";
import { isWardenError } from "../discord/errors.js";
import {
  serializeMember,
  serializePermissions,
  serializeRole,
  serializeUser,
} from "../discord/serializers/index.js";
import type { SerializedRole } from "../discord/serializers/index.js";
import { compareSnowflakes } from "../shared/ids.js";
import { fail } from "../shared/result.js";
import type { ToolResult } from "../shared/result.js";
import {
  attempt,
  optionalId,
  readOk,
  requiredId,
  scrubText,
  toCallToolResult,
} from "./context.js";
import type { ToolContext } from "./context.js";

const LIST_LIMIT = 100;

export interface ListMembersArgs {
  guild_id?: string;
  limit?: number;
  after?: string;
  query?: string;
  role_id?: string;
  in_voice?: boolean;
  online?: boolean;
}

/** Cache predicate: is this member currently in a voice channel? */
function inVoice(member: GuildMember): boolean {
  return member.voice !== null && member.voice.channelId !== null;
}

/** Cache predicate: is this member online? Absent presence counts as offline. */
function isOnline(member: GuildMember): boolean {
  const status = member.presence?.status;
  return status !== undefined && status !== "offline";
}

export async function listMembers(
  ctx: ToolContext,
  args: ListMembersArgs,
): Promise<ToolResult> {
  const guild = resolveGuild(
    ctx.discord,
    args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
  );
  if (isWardenError(guild)) return guild;

  const limit = args.limit ?? LIST_LIMIT;
  const notes: string[] = [];

  // `query` searches by username — a REST-only capability, so it takes the
  // API path regardless of what the cache holds, and the cache filters below
  // do not apply to its results.
  if (args.query !== undefined) {
    const found = await attempt(() =>
      guild.members.search({ query: args.query as string, limit }),
    );
    if (isWardenError(found)) return fail(found);
    const members = [...found.values()]
      .map((member) => serializeMember(member))
      .sort((a, b) => compareSnowflakes(a.id, b.id));
    return readOk(
      "member.list",
      { members, count: members.length, limit, query: args.query },
      [
        "Member search is a Discord-side query on username — role_id/in_voice/online are not applied to its results; filter those client-side.",
      ],
    );
  }

  const candidates = [...guild.members.cache.values()];
  const filtered = candidates
    .filter((member) => args.role_id === undefined || member.roles.cache.has(args.role_id))
    .filter((member) => args.in_voice !== true || inVoice(member))
    .filter((member) => args.online !== true || isOnline(member))
    // One comparator on *both* sides of this pair (see `compareSnowflakes`):
    // a length-first sort with a lexicographic filter — what this was — drops
    // every id whose length differs from `after` whenever its first digit is
    // lower, and an agent reads that hole as "no more members".
    .sort((a, b) => compareSnowflakes(a.id, b.id))
    .filter(
      (member) =>
        args.after === undefined || compareSnowflakes(member.id, args.after) > 0,
    )
    .slice(0, limit);

  if (
    guild.memberCount !== null &&
    guild.members.cache.size < guild.memberCount
  ) {
    notes.push(
      `Only ${guild.members.cache.size} of ${guild.memberCount} members are cached — the list is partial. ` +
        "Retry in a few seconds, or use query to search Discord directly.",
    );
  }
  if (args.in_voice === true || args.online === true) {
    notes.push(
      "in_voice/online are answered from the gateway cache (Discord's list endpoint cannot filter on them).",
    );
  }

  const members = filtered.map((member) => serializeMember(member));
  // `notes` is not optional here: it is the *only* place the partial-cache and
  // cache-filter disclosures exist, and dropping them would report a short
  // list as complete — the exact failure the module header commits to avoid.
  return readOk("member.list", { members, count: members.length, limit }, notes);
}

export async function getMember(
  ctx: ToolContext,
  args: { guild_id?: string; user_id: string; channel_id?: string },
): Promise<ToolResult> {
  const guild = resolveGuild(
    ctx.discord,
    args.guild_id ?? ctx.config.WARDEN_GUILD_ID,
  );
  if (isWardenError(guild)) return guild;

  const notes: string[] = [];
  let member = guild.members.cache.get(args.user_id);
  if (!member) {
    // Not cached is normal (the member may have left, or never joined): REST
    // is the authority here, and a 404 from it maps to the same not_found the
    // guards use.
    const fetched = await attempt(() => guild.members.fetch(args.user_id));
    if (isWardenError(fetched)) return fail(fetched);
    member = fetched;
  }

  const roles: SerializedRole[] = [...member.roles.cache.values()]
    // The @everyone role is seeded into every member's role cache by
    // discord.js (the same row `serializeMember` drops): reporting it here
    // would hand an agent a role it can neither assign nor remove, so it is
    // filtered out for consistency with `member.roles` in the payload below.
    .filter((role) => role.id !== guild.id)
    .map((role) => serializeRole(role))
    .sort((a, b) => (b.position ?? -1) - (a.position ?? -1));

  let effectivePermissions: string[] = [];
  if (args.channel_id !== undefined) {
    const channel = resolveChannel(guild, args.channel_id);
    if (isWardenError(channel)) return channel;
    const permissions = channel.permissionsFor(member);
    if (permissions === null) {
      notes.push(
        `Warden could not resolve this channel's permissions (${channel.id}) — the effective permission list is empty until it can.`,
      );
    } else {
      effectivePermissions = serializePermissions(permissions);
    }
  } else {
    effectivePermissions = serializePermissions(member.permissions);
  }

  // The hierarchy verdict is the whole reason `get_member` is more than a
  // serializer call: plan §6's preflight exists because agents discover
  // hierarchy the hard way. Here it is *reported*, not enforced — a read
  // must still answer for a member Warden could never act on.
  const verdict = hierarchyVerdict(ctx, guild, member);

  const data = {
    member: serializeMember(member),
    roles,
    effectivePermissions,
    hierarchy: verdict,
    inVoice: inVoice(member),
    // `voice` is a live discord.js object; only the id-bearing fields matter.
    voiceChannelId: member.voice?.channelId ?? null,
    communicationDisabledUntil:
      member.communicationDisabledUntilTimestamp !== null
        ? new Date(member.communicationDisabledUntilTimestamp).toISOString()
        : null,
    isOwner: member.id === guild.ownerId,
  };
  return readOk("member.get", data, notes);
}

/**
 * What `get_member` reports about hierarchy (see {@link hierarchyVerdict}).
 *
 * Two shapes rather than one optional-laden object: an agent branches on
 * `canAct`, and the details that only exist in one of the two cases are
 * required there instead of optional everywhere.
 */
export type HierarchyVerdict =
  | {
      canAct: true;
      botTopRole: { id: string; name: string; position: number };
      targetTopRole: { id: string; name: string; position: number };
    }
  | {
      canAct: false;
      /** The `error` kind of the refusal: role_hierarchy, target_protected… */
      reason: string;
      message: string;
      remediation: string;
      bot?: { role: string; position: number };
      target?:
        | { role: string; position: number }
        | { user: string; protected: string };
    };

/**
 * "Would Warden be able to act on this member?" — plan §6's checks, run for
 * their *diagnosis* instead of their verdict.
 *
 * A read must still answer for a member Warden could never act on, so
 * nothing here fails the tool: the refusal (or the reason it cannot be
 * judged) is reported as data, with the same message and remediation the
 * mutation would have received.
 */
function hierarchyVerdict(
  ctx: ToolContext,
  guild: Guild,
  member: GuildMember,
): HierarchyVerdict {
  const botMember = resolveBotMember(ctx.discord, guild);
  if (isWardenError(botMember)) {
    return {
      canAct: false,
      reason: botMember.error,
      message:
        "Warden's own member is not cached in this guild yet, so the hierarchy cannot be judged.",
      remediation:
        "Retry in a few seconds; get_bot_status shows whether the guild finished loading.",
    };
  }

  const check = checkMemberHierarchy(botMember, member, { action: "act on" });
  if (check === null) {
    return {
      canAct: true,
      botTopRole: {
        id: botMember.roles.highest.id,
        name: scrubText(botMember.roles.highest.name),
        position: botMember.roles.highest.position,
      },
      targetTopRole: {
        id: member.roles.highest.id,
        name: scrubText(member.roles.highest.name),
        position: member.roles.highest.position,
      },
    };
  }
  // The structured error itself — message, positions, remediation — is the
  // most useful shape here, so it is reported verbatim (scrubbed on the way
  // out by readOk) alongside the boolean an agent branches on.
  return {
    canAct: false,
    reason: check.error,
    message: check.message,
    remediation: check.remediation,
    ...(check.bot !== undefined ? { bot: check.bot } : {}),
    ...(check.target !== undefined ? { target: check.target } : {}),
  };
}

export async function getUser(
  ctx: ToolContext,
  args: { user_id: string },
): Promise<ToolResult> {
  // No guild needed: this is the one read that works outside a server, which
  // is what makes it useful for "who is this id" after an event or an audit
  // entry named someone Warden has never seen.
  const user = await attempt(() => ctx.discord.client.users.fetch(args.user_id));
  if (isWardenError(user)) return fail(user);
  return readOk("user.get", { user: serializeUser(user) });
}

export function registerMemberTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_members",
    {
      title: "List members",
      description:
        "List members of a server Warden is in, ordered by id (join order). Filter by role_id, in_voice or online (answered from the gateway cache), page with limit/after, or search usernames with query (Discord-side search). A note flags a partial cache rather than reporting a short list as complete. Requires no permissions beyond membership.",
      inputSchema: z.object({
        guild_id: optionalId(
          "Guild to read (default: WARDEN_GUILD_ID, the one-server setup).",
        ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum members to return (1-100, default 100)."),
        after: optionalId(
          "Return only members whose id is greater than this — pass the previous call's last id to page forward.",
        ),
        query: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "Username search (Discord-side). Incompatible with the cache filters below.",
          ),
        role_id: optionalId("Only members holding this role."),
        in_voice: z
          .boolean()
          .optional()
          .describe("Only members currently in a voice channel (cache)."),
        online: z
          .boolean()
          .optional()
          .describe(
            "Only members whose presence is not offline (cache; needs the Presence intent).",
          ),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await listMembers(ctx, args)),
  );

  server.registerTool(
    "get_member",
    {
      title: "Get member",
      description:
        "One member of a server, in detail: user object, roles (with positions and managed flags), effective permissions (guild-wide, or of one channel when channel_id is given), voice state, timeout expiry, and a hierarchy verdict — whether Warden could act on them at all, with the exact reason and fix when it could not. Fetched from Discord when the member is not cached; answers not_found for someone who is not in the guild.",
      inputSchema: z.object({
        guild_id: optionalId(
          "Guild to read (default: WARDEN_GUILD_ID, the one-server setup).",
        ),
        user_id: requiredId("Member to describe."),
        channel_id: optionalId(
          "Report this member's effective permissions in this channel instead of their guild-wide ones.",
        ),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await getMember(ctx, args)),
  );

  server.registerTool(
    "get_user",
    {
      title: "Get user",
      description:
        "Global user object by id — username, display name, avatar, bot flag, account flags and creation date. Works outside any server (no guild_id), which makes it the way to identify an id seen in an event, an audit entry or a ban list. Answers not_found for an id Discord does not know.",
      inputSchema: z.object({
        user_id: requiredId("User to describe."),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => toCallToolResult(await getUser(ctx, args)),
  );
}
