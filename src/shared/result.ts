/**
 * The uniform tool-result envelope (plan §5, "Result contract").
 *
 * Every tool returns a {@link ToolSuccess} on success and a {@link WardenError}
 * on failure — there is no third shape, so an MCP client branches on `ok`
 * alone and never has to guess.
 *
 * `fail()` is the only sanctioned way for a tool to build an error by hand,
 * and it deliberately routes through `toWardenError()`. That is not
 * ceremony: a role name, channel name, nickname or agent-supplied `reason`
 * can all contain a bot-token-shaped string, and this is the seam where such
 * a string would otherwise reach the transport. Building the error anywhere
 * else would bypass the scrubbing every failure gets.
 *
 * **`ok()` does not scrub**, and the distinction is deliberate rather than an
 * oversight. Success payloads are meant to be assembled from already-serialized
 * data (`src/discord/serialize.ts`), so the guarantee on that side is
 * structural: a tool passes through objects the serializers produced, not raw
 * strings it composed. The one guard that *does* return raw Discord text —
 * `blockersFor()`, whose role names are whatever the operator typed —
 * therefore redacts each line itself before it can travel as a note. Anything
 * added later that emits raw Discord strings into `data` inherits that
 * obligation.
 */

import { toWardenError } from "../discord/errors.js";
import type { WardenError } from "../discord/errors.js";

/** Success payload, exactly as documented in plan §5. */
export interface ToolSuccess<T = unknown> {
  ok: true;
  /** Dotted action name, e.g. `"member.kick"`. */
  performed: string;
  data: T;
  /** Operator-facing remarks — caveats, skipped steps, Discord quirks. */
  notes?: string[];
}

/** What every tool returns, success or failure. */
export type ToolResult<T = unknown> = ToolSuccess<T> | WardenError;

/**
 * Everything a failure carries. `ok` is absent because {@link fail} sets it —
 * that is what stops a caller from accidentally producing `{ok: true, error: …}`.
 */
export type FailSpec = Omit<WardenError, "ok">;

/**
 * Build a success payload.
 *
 * An empty `notes` is dropped rather than serialised as `[]`: tools would
 * otherwise emit `notes: []` on nearly every call, which is pure noise in a
 * transcript the agent has to read.
 */
export function ok<T>(
  performed: string,
  data: T,
  notes?: readonly string[],
): ToolSuccess<T> {
  return notes && notes.length > 0
    ? { ok: true, performed, data, notes: [...notes] }
    : { ok: true, performed, data };
}

/**
 * Build a redacted failure payload. See the file header for why failures
 * must pass through here and success payloads do not.
 */
export function fail(spec: FailSpec): WardenError {
  // toWardenError() recognises the shape and returns redactDeep(spec), so the
  // caller's strings are scrubbed (TOKEN_LIKE + webhook/interaction path)
  // without the values being re-derived.
  return toWardenError({ ...spec, ok: false });
}
