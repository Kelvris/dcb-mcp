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
import type { PermissionResolvable } from "discord.js";
import { z } from "zod";

import type { WardenDiscord } from "../discord/client.js";
import { isWardenError, scrub, toWardenError } from "../discord/errors.js";
import type { WardenError } from "../discord/errors.js";
import { preflight } from "../discord/guards.js";
import type { PreflightPass, PreflightRequest } from "../discord/guards.js";
import type { Config } from "../config.js";
import type { EventRuntime } from "../events/index.js";
import type { Logger } from "../logger.js";
import { SNOWFLAKE } from "../shared/ids.js";
import { fail, ok } from "../shared/result.js";
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
 * Optional cursor argument restricted to the ISO8601 shape.
 *
 * {@link isCursor} admits snowflakes because message history and the audit
 * log page by id — but the routes that page by *time* (the archived-thread
 * routes, the pinned-message list) have no id to give back, and handing them
 * one is the failure `resolveArchivedBefore` exists to catch: discord.js
 * converts `before` with `new Date(value).toISOString()`, and an id is an
 * `Invalid Date`, which throws a bare `RangeError` outside `attempt()`'s
 * mapping. Rejecting the id shape in the schema is the earliest place that
 * can be caught, and the refinement goes through {@link parseCursorTime} so a
 * shape-valid timestamp that names no real instant is refused too.
 */
export function optionalIsoCursor(
  description: string,
): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .refine((value) => parseCursorTime(value) !== null, {
      error:
        "must be an ISO8601 UTC timestamp (2024-01-31T12:00:00.000Z) naming a real instant",
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
 * The `X-Audit-Log-Reason` header a mutating call carries (plan §4).
 *
 * Discord records who did what in the guild's audit log, and this prefix is
 * what makes the entry attributable to Warden rather than to the bot account
 * acting on its own; the agent's `reason` rides along after it.
 *
 * Scope: the header is attached wherever Discord both *accepts* it and
 * *writes an entry* — message deletes, bulk deletes, pins, and thread
 * create/edit/delete. Sends, edits, reaction changes, crosspost and poll
 * closure create no audit-log entry at all, so there is nothing for the
 * header to annotate, and discord.js's wrappers for those take no `reason`
 * parameter either. Inventing one there would be a parameter the library
 * silently drops, which is worse than saying so at the call site.
 *
 * Where discord.js *does* drop a reason that Discord would record (its
 * `MessageManager.delete` and `bulkDelete` take none), the call goes through
 * `client.rest` directly so the header still lands.
 */
export function auditReason(tool: string, reason?: string): string {
  const base = `warden:${tool}`;
  const detail = reason?.trim();
  return detail ? `${base} — ${detail}` : base;
}

/** Everything one mutation needs to run the plan §6 pipeline. */
export interface MutationSpec {
  /** MCP tool name — surfaced in preflight errors and in `would_perform`. */
  tool: string;
  /** Dotted action name for the success envelope, e.g. `"message.send"`. */
  performed: string;
  /**
   * Layers 1–3: connection, resolution, permissions, hierarchy.
   *
   * `channelPermissions` here is what can be stated *before* anything is
   * resolved — usually `[]`, because the flags that matter often depend on
   * facts only the preflight can produce (see {@link refinePermissions}).
   */
  request: PreflightRequest;
  /**
   * The channel flags that turn out to be needed, decided after the base
   * preflight has resolved the guild and channel.
   *
   * Two questions need an answer that is not knowable from the arguments
   * alone, and both are answered here rather than guessed at up front:
   *
   * - **Which channel is it?** `send_message` needs `SendMessagesInThreads`
   *   in a thread and `SendMessages` in a channel, and the id does not say
   *   which. Guessing both and requiring the pair would refuse every send;
   *   guessing one would under-check half the time.
   * - **Whose message is it?** `edit_message`, `delete_message` and
   *   `crosspost_message` need `ManageMessages` only when the message is
   *   somebody else's, and only a fetch knows the author.
   *
   * The returned set **replaces** `request.channelPermissions` and is
   * re-checked by a second `preflight()` — so the permission logic stays in
   * `guards.ts` instead of being re-derived here. The hook runs *after*
   * layers 1–3 (the agent hears a connection or resolution problem first)
   * and *before* the dry-run short-circuit, so a dry run reports the same
   * verdict a real call would. Its own fetch is a read, not a mutation: the
   * guarantee `mutate` preserves is that no **write** leaves the process
   * before every check has passed.
   *
   * Return `[]` when the probe finds no extra requirement (Warden's own
   * message), or a `WardenError` when the probe itself fails — a message id
   * that does not exist should read as `not_found` from here, not as a
   * success that then mutates nothing.
   */
  refinePermissions?: (
    pass: PreflightPass,
  ) => Promise<readonly PermissionResolvable[] | WardenError>;
  /**
   * The agent's arguments, echoed back verbatim on a dry run. They are
   * free text (a message body, a thread name), so the dry-run payload goes
   * through `readOk()`'s scrub rather than `ok()`'s.
   *
   * Echoed *curated*, never raw: an attachment's base64 body is megabytes
   * of noise in a transcript, so each tool replaces it with its byte count
   * before it gets here.
   */
  params: Record<string, unknown>;
  /** The tool's own `dry_run`; the `WARDEN_DRY_RUN` env flag ORs in. */
  dryRun?: boolean;
  /**
   * Layer 4 checks that are not plain numeric ranges — `checkBulkDelete`'s
   * age rule, `checkAppliedTags`'s forum rules. They run *after* the
   * permission layer and *before* the dry-run short-circuit, which is the
   * order plan §6 specifies and the reason they are not simply called from
   * the tool: a dry run must validate the same inputs a real call would.
   */
  validate?: () => WardenError | null;
  /**
   * The mutation itself, wrapped by the caller in `attempt()`-free code:
   * `mutate` maps any throw onto the uniform failure contract. Receives the
   * passing preflight so ownership checks can reuse its resolved permissions
   * instead of computing them a second time.
   */
  execute: (pass: PreflightPass) => Promise<ToolResult>;
}

/**
 * Plan §6's pipeline for every mutating tool: preflight → optional permission
 * refinement → layer-4 limits → optional dry run → execute.
 *
 * Three decisions are worth spelling out:
 *
 * - **The preflight runs first, always.** Nothing in `execute` is reached
 *   when Warden is not ready, the guild/channel is unknown, or a statically
 *   known permission is missing, so "the tool touched Discord before
 *   checking" cannot happen — except through the {@link refinePermissions}
 *   probe, which is a read and is itself part of the permission layer.
 * - **`dry_run` short-circuits before `execute`** — "ask first, act second"
 *   means no write is ever sent, and the checks that precede it (including
 *   the probe) are the same ones a real call would run.
 * - **Success payloads are scrubbed** (via `readOk`): a mutation echoes the
 *   text it was handed, which is operator free text exactly as plan §4
 *   defines it.
 */
export async function mutate(
  ctx: ToolContext,
  spec: MutationSpec,
): Promise<ToolResult> {
  let pass = preflight(ctx.discord, spec.request);
  if (isWardenError(pass)) return pass;

  if (spec.refinePermissions) {
    const refined = await spec.refinePermissions(pass);
    if (isWardenError(refined)) return refined;
    // Re-run rather than patch `pass.botChannelPermissions` by hand: the
    // second pass reuses guards.ts' own ordering (guild → channel flags →
    // hierarchy), so a refinement can never quietly skip a layer.
    pass = preflight(ctx.discord, {
      ...spec.request,
      channelPermissions: refined,
    });
    if (isWardenError(pass)) return pass;
  }

  const limitError = spec.validate?.() ?? null;
  if (limitError) return limitError;

  if (spec.dryRun === true || ctx.config.WARDEN_DRY_RUN) {
    return readOk(spec.performed, {
      would_perform: {
        tool: spec.tool,
        params: spec.params,
        checks: "all passed",
      },
    });
  }

  const result = await attempt(() => spec.execute(pass));
  // `fail()` re-runs the redaction on the way out: a failure built inside
  // `execute` and a throw mapped by `attempt()` travel the same path, so no
  // caller has to remember which of the two it is holding.
  return result.ok ? result : fail(result);
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
