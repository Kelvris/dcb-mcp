/**
 * The tool registry (plan §3/§8): one module per domain, all registered on
 * the same server.
 *
 * Phase 4 wires the first two domains — `observe` (status) and `guild`
 * (overview). Later phases extend this seam by adding a domain module and one
 * line here; nothing else in the server changes, which is what keeps the
 * ~60-tool catalog (plan §8) from turning into a single huge file.
 */

import type { McpServer } from "@modelcontextprotocol/server";

import { registerGuildTools } from "./guild.js";
import { registerObserveTools } from "./observe.js";
import type { ToolContext } from "./context.js";

export type { ToolContext } from "./context.js";
export { toCallToolResult } from "./context.js";

export function registerAll(server: McpServer, ctx: ToolContext): void {
  registerObserveTools(server, ctx);
  registerGuildTools(server, ctx);
}
