/**
 * The tool layer's shared runtime: the context every tool module receives,
 * the `ToolResult` → MCP envelope conversion, and the zod field builders
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
import { scrub, toWardenError } from "../discord/errors.js";
import type { WardenError } from "../discord/errors.js";
import type { Config } from "../config.js";
import type { EventRuntime } from "../events/index.js";
import type { Logger } from "../logger.js";
import { SNOWFLAKE } from "../shared/ids.js";
import { ok } from "../shared/result.js";
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
  return requiredId(description).optional();
}

/**
 * Required snowflake argument (`user_id`, …) — same validation as
 * {@link optionalId}, minus the optional: a tool whose whole job is "look up
 * this one thing" must not compile a call that omits it.
 */
export function requiredId(description: string): z.ZodString {
  return z
    .string()
    .regex(SNOWFLAKE, {
      error: "must be a Discord snowflake id (17-20 digits)",
    })
    .describe(description);
}

/**
 * ISO8601 UTC exactly as Discord writes it (`2024-01-31T12:00:00.000Z`) —
 * the shape the archived-thread routes page by. Private to this module so the
 * schema check below is the only definition of it.
 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/**
 * Is `value` shaped like a paged cursor?
 *
 * Discord does not agree with itself on what a cursor *is*: message history
 * and the audit log step by snowflake, the archived-thread routes step by an
 * ISO8601 `archive_timestamp`. An agent paging a list hands back whatever the
 * previous page gave it, so both shapes are accepted rather than only the id
 * shape that {@link optionalId} enforces.
 *
 * Exported because the tool that *consumes* the cursor branches on the same
 * two shapes — one predicate keeps the schema and that branch from drifting.
 */
export function isCursor(value: string): boolean {
  return SNOWFLAKE.test(value) || ISO_UTC.test(value);
}

/**
 * Optional cursor argument (`before` on a paged read) — see {@link isCursor}
 * for why this is a third builder instead of a reuse of {@link optionalId}.
 */
export function optionalCursor(
  description: string,
): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .refine(isCursor, {
      error:
        "must be a Discord snowflake id (17-20 digits) or an ISO8601 UTC timestamp (2024-01-31T12:00:00.000Z)",
    })
    .describe(description)
    .optional();
}

/**
 * Epoch milliseconds for an ISO8601 cursor, or `null` when the string names
 * no real instant.
 *
 * Shape ({@link isCursor}) is not validity. `Date.parse` *rolls* impossible
 * dates forward instead of failing — `2024-02-30` becomes March 1, which
 * would move a page boundary without telling anyone — and answers `NaN` for
 * the genuinely unparseable, which `toISOString()` then throws on. The round
 * trip below rejects both: the instant the string parses to must be the
 * instant the string *says* it names. The fraction is excluded from the
 * comparison because the shape check already proved it digits (nothing in it
 * can be invalid), while every component that can lie is compared.
 */
export function parseCursorTime(value: string): number | null {
  if (!ISO_UTC.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const said = value.replace(/\.\d+Z$/, "Z");
  const named = new Date(parsed).toISOString().replace(/\.\d{3}Z$/, "Z");
  return said === named ? parsed : null;
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

/** Depth past which a nested container is replaced instead of descended into. */
const MAX_SCRUB_DEPTH = 8;

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return scrub(value);
  if (value === null || typeof value !== "object") return value;
  // The cap terminates: a payload built by the serializers is a tree, but a
  // future tool could hand back something self-referential, and an unbounded
  // walk would spin forever on data that only ever needs masking at its
  // leaves. Leaves are scrubbed *before* the cap is consulted, so depth
  // never exempts content — the same trade `errors.ts: redactDeep` makes.
  if (depth >= MAX_SCRUB_DEPTH) return "[depth-limit]";
  if (Array.isArray(value)) {
    return value.map((entry) => scrubValue(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = scrubValue(entry, depth + 1);
  }
  return out;
}

/**
 * Deep-scrub every string leaf of a payload destined for a **success**
 * result (plan §4).
 *
 * `ok()` deliberately does not scrub (shared/result.ts) because the
 * serializers already curate *shape* — and Phase 6 is where that stops being
 * enough. A channel topic, a role name, a nickname, a message body and an
 * audit-log reason are all operator/user free text that arrives *from
 * Discord*, so no per-field `scrubText()` call at the call site can be
 * forgotten: the read tools pass their whole serialized payload through
 * here once, on the way out.
 */
export function scrubData<T>(value: T): T {
  return scrubValue(value, 0) as T;
}

/**
 * `ok()` for a payload built out of Discord objects.
 *
 * Scrubs the data *and* the notes (a note quoting a role name carries the
 * same free text the payload does), so "did this tool scrub?" has exactly
 * one answer for every read tool instead of one per field.
 */
export function readOk<T>(
  performed: string,
  data: T,
  notes?: readonly string[],
): ToolResult {
  const safeNotes = notes?.map((note) => scrub(note));
  return ok(performed, scrubData(data), safeNotes);
}

/**
 * Run a call that may throw (every REST-backed read: `fetchAuditLogs`,
 * `messages.fetch`, `members.search`, a raw `client.rest.get`) and map a
 * throw onto the uniform failure contract instead of letting it escape into
 * the SDK.
 *
 * `guards.ts` is the primary translator (plan §6) and `errors.ts` the safety
 * net behind it (plan §9) — but the safety net only runs if something feeds
 * it the thrown value. Without this seam a 404 or a 50013 from a read would
 * surface as an SDK-level "tool threw" rather than the structured
 * `{error, message, remediation}` every Warden failure uses.
 *
 * Mirrors the guards' resolver convention: returns `T | WardenError`, so a
 * caller narrows with `isWardenError()` exactly as it does after
 * `resolveGuild()`.
 */
export async function attempt<T>(
  operation: () => Promise<T> | T,
): Promise<T | WardenError> {
  try {
    return await operation();
  } catch (error) {
    return toWardenError(error);
  }
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
