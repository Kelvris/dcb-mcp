/**
 * The tool layer's shared runtime: the context every tool module receives,
 * the `ToolResult` → MCP envelope conversion, and the two zod field builders
 * that keep input schemas consistent across ~60 tools.
 *
 * ## Why one envelope converter
 *
 * Tools compute a {@link ToolResult} (the uniform ok/fail contract of plan §5
 * and `shared/result.ts`) and never build MCP payloads themselves. This module
 * is the single place where that contract becomes wire format, so the mapping
 * cannot drift tool-by-tool:
 *
 * - `content[0].text` is the payload as JSON — every MCP client can read it;
 * - `structuredContent` carries the same object for clients that consume
 *   structured results (the SDK passes it through untouched when a tool has no
 *   declared `outputSchema`, which is how every Warden tool is registered —
 *   the envelope is uniform by contract, not by per-tool schema);
 * - `isError: true` marks every failure, so a client that only looks at the
 *   protocol level still sees the failure even before parsing the text.
 */

import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { WardenDiscord } from "../discord/client.js";
import { scrub } from "../discord/errors.js";
import type { Config } from "../config.js";
import type { EventRuntime } from "../events/index.js";
import type { Logger } from "../logger.js";
import { SNOWFLAKE } from "../shared/ids.js";
import type { ToolResult } from "../shared/result.js";

/**
 * Everything a tool module needs; built once by `createWarden()`.
 *
 * `config` is deliberately `Omit<…, "DISCORD_BOT_TOKEN">`. Nothing in the
 * tool layer ever needs the token — only `createWarden()` does, to hand it to
 * `discord.login()` — and typing it out means a future `ok("x", ctx.config)`
 * or a debug echo cannot compile the secret into a tool result (plan §4:
 * the token never appears in tool output).
 */
export interface ToolContext {
  readonly config: Omit<Config, "DISCORD_BOT_TOKEN">;
  readonly logger: Logger;
  readonly discord: WardenDiscord;
  /**
   * The event buffer and watch sessions (plan §7). Process-local state —
   * event tools read it without touching Discord, which is why they keep
   * answering while the gateway is down (see `observe.ts`).
   */
  readonly events: EventRuntime;
}

/**
 * Optional snowflake argument (`guild_id`, `channel_id`, …).
 *
 * Optional by design: plan §8 lets `guild_id` be omitted when
 * `WARDEN_GUILD_ID` names the one server this Warden manages. The regex gives
 * agents a rejection *before* a Discord round-trip when they paste a channel
 * name instead of an id.
 */
export function optionalId(description: string): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .regex(SNOWFLAKE, {
      error: "must be a Discord snowflake id (17-20 digits)",
    })
    .describe(description)
    .optional();
}

/**
 * Scrub one operator-authored free-text field before it enters a **success**
 * payload (`null`/`undefined` pass through).
 *
 * `ok()` deliberately does not scrub — success payloads are meant to carry
 * already-curated serializer output (shared/result.ts). That holds for ids,
 * counts and enum names, but a guild description, channel topic, nickname or
 * message body is raw human text, and plan §4 forbids a pasted token leaving
 * the process in any form. `scrub()` (not `redact()` alone) is the same
 * choke point every failure goes through: token-shaped strings *and*
 * webhook/interaction URL paths.
 */
export function scrubText<T extends string | null | undefined>(value: T): T {
  if (value == null) return value;
  // `scrub()` only ever returns a string; the cast preserves the caller's
  // null-vs-undefined shape (the serializers' "Discord says none" vs "not
  // applicable" distinction) rather than widening every field to
  // `string | null | undefined`.
  return scrub(value) as T;
}

/**
 * The uniform envelope (plan §5). Every tool's callback ends here.
 *
 * `structuredContent` takes the payload as-is: `ToolSuccess`/`WardenError` are
 * plain data by construction (serializers, guards, `fail()`), and the cast
 * exists because TS interfaces do not satisfy `Record<string, unknown>` by
 * implicit index signature — the values themselves are already JSON-safe.
 */
export function toCallToolResult(result: ToolResult): CallToolResult {
  const payload = result as unknown as Record<string, unknown>;
  const envelope: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: payload,
  };
  return result.ok ? envelope : { ...envelope, isError: true };
}
