/**
 * The tool registry (plan §3/§8): one module per domain, all registered on
 * the same server.
 *
 * Phase 4 wired the first two domains — `observe` (status) and `guild`
 * (overview); Phase 5 added the event tools; Phase 6 adds the read tools of
 * channels, threads, roles, members and messages, plus the guild domain's
 * audit log. Later phases extend this seam by adding a domain module and one
 * line here; nothing else in the server changes, which is what keeps the
 * ~60-tool catalog (plan §8) from turning into a single huge file.
 */

import type { McpServer } from "@modelcontextprotocol/server";

import { registerChannelTools } from "./channels.js";
import { registerGuildTools } from "./guild.js";
import { registerMemberTools } from "./members.js";
import { registerMessageTools } from "./messages.js";
import { registerObserveTools } from "./observe.js";
import { registerRoleTools } from "./roles.js";
import { registerThreadTools } from "./threads.js";
import type { ToolContext } from "./context.js";

export type { ToolContext } from "./context.js";
export { toCallToolResult } from "./context.js";

export function registerAll(server: McpServer, ctx: ToolContext): void {
  registerObserveTools(server, ctx);
  registerGuildTools(server, ctx);
  registerChannelTools(server, ctx);
  registerThreadTools(server, ctx);
  registerRoleTools(server, ctx);
  registerMemberTools(server, ctx);
  registerMessageTools(server, ctx);
}
