/**
 * Structured logger — **stderr only**.
 *
 * stdout is the JSON-RPC channel between the MCP client and this server;
 * writing anything else there corrupts the protocol stream. Every log line
 * therefore goes to stderr as a single JSON object.
 *
 * Security: values that look like Discord bot tokens are redacted, and any
 * field whose key looks secret (token/password/secret/…) is redacted before
 * serialization. The token must never appear in a log line.
 */

export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export type LogFields = Record<string, unknown>;

/** Field keys whose values are always masked. */
const SENSITIVE_KEY =
  /token|password|passwd|secret|authorization|api[-_]?key|credential|cookie|private[-_]?key|bearer/i;

/**
 * Anything shaped like a Discord token
 * (`<base64 id>.<base64 timestamp>.<base64 hmac>`) embedded in free text.
 * Deliberately loose — false positives only hide log content, never secrets.
 * Quantifiers are bounded (keep TOKEN_MAX_LEN in sync if you widen them):
 * unbounded `{18,}` backtracks quadratically — an 8 KB opaque blob costs
 * ≈ 218 ms unbounded vs ≈ 3 ms bounded (~8×, growing quadratically).
 * A unit test asserts no `{n,}` unbounded quantifier creeps back in.
 */
export const TOKEN_LIKE =
  /[A-Za-z0-9_-]{18,48}\.[A-Za-z0-9_-]{4,16}\.[A-Za-z0-9_-]{20,64}/g;

/** Longest string TOKEN_LIKE can match: 48 + 1 + 16 + 1 + 64. */
const TOKEN_MAX_LEN = 48 + 1 + 16 + 1 + 64; // 130

/**
 * Above this length the text is cut — a log line shouldn't carry megabytes.
 * 8 KB covers every normal Discord payload (message 2000, embeds 6000) whole.
 * (A replacement marker near the cut may push the output a few chars past it.)
 */
const MAX_REDACT_LENGTH = 8192;

/**
 * Chars scanned past the cut when truncating. A token that STARTS before the
 * cut must be visible to the regex in full — if we scanned only the kept part
 * we'd match nothing (or part) and log a raw token prefix. Scanning one whole
 * TOKEN_MAX_LEN past the cut guarantees whole-token vision for any token whose
 * start is before the cut.
 */
const TOKEN_SCAN_MARGIN = TOKEN_MAX_LEN + 30;

/** Mask token-shaped substrings in free text (truncates very long input). */
export function redact(text: string): string {
  if (text.length <= MAX_REDACT_LENGTH) {
    return text.replace(TOKEN_LIKE, "[redacted-token]");
  }
  const keep = MAX_REDACT_LENGTH;
  const scan = text.slice(0, keep + TOKEN_SCAN_MARGIN);
  // Manual exec pass: every token starting before `keep` is seen whole and
  // masked (even when it straddles the cut); matches starting at or past
  // `keep` are never emitted, so they're irrelevant.
  let out = "";
  let last = 0;
  TOKEN_LIKE.lastIndex = 0;
  for (
    let match = TOKEN_LIKE.exec(scan);
    match !== null;
    match = TOKEN_LIKE.exec(scan)
  ) {
    const start = match.index;
    if (start >= keep) break;
    out += scan.slice(last, start) + "[redacted-token]";
    last = Math.min(start + match[0].length, keep);
    if (last >= keep) break;
  }
  out += scan.slice(last, keep);
  // The marker appended for a near-cut match can overhang the cut; trim so
  // output stays within MAX_REDACT_LENGTH (only the marker can be cut — raw
  // text was already bounded by slice(last, start) with start < keep).
  const clipped = out.length > keep ? out.slice(0, keep) : out;
  return `${clipped}…[truncated ${text.length - keep} chars]`;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** Stop descending past this nesting depth — keeps a pathological log line bounded. */
const MAX_DEPTH = 32;

/** Cap on array breadth per line — depth is bounded, breadth must be too. */
const MAX_ARRAY_ITEMS = 2000;

/**
 * JSON encoder with the three things this logger cares about:
 * - secrets masked by field name or token shape,
 * - Errors rendered as `{name, message, stack}` (redacted),
 * - true cycles (ancestor references) rendered as `"[circular]"`.
 *
 * Cycle detection is ancestor-scoped on purpose: an object referenced twice
 * but not cyclically must serialize both times — a global "seen" set would
 * silently replace the second occurrence with `[circular]` and eat real
 * diagnostic data. Returns undefined for values JSON omits (undefined,
 * functions, symbols).
 */
function encode(
  value: unknown,
  ancestors: readonly unknown[],
  depth: number,
): string | undefined {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return undefined;
  }
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(redact(value));
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());

  if (depth >= MAX_DEPTH) return JSON.stringify("[depth-limit]");
  if (ancestors.includes(value)) return JSON.stringify("[circular]");

  const next = [...ancestors, value];
  const object = value as Record<string, unknown>;

  if (value instanceof Error) {
    return JSON.stringify({
      name: redact(value.name),
      message: redact(value.message),
      stack: value.stack ? redact(value.stack) : undefined,
    });
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? "null" : JSON.stringify(value.toISOString());
  }
  // Honour toJSON (Date handled above); `next` so a toJSON returning `this`
  // still hits the cycle guard. Returning undefined propagates so the key is
  // omitted, exactly like JSON.stringify does.
  if (typeof object.toJSON === "function") {
    try {
      return encode(object.toJSON.call(value), next, depth + 1);
    } catch {
      return JSON.stringify("[broken-tojson]");
    }
  }
  if (Array.isArray(value)) {
    // Indexed loop, not .map(): map skips sparse holes, and join() would then
    // render a hole as an empty string → malformed JSON like `[,1,]`.
    const items: string[] = [];
    const bounded = Math.min(value.length, MAX_ARRAY_ITEMS);
    for (let i = 0; i < bounded; i++) {
      try {
        // Per-element recovery, matching the object branch below: one
        // throwing getter costs one element, not its siblings.
        items.push(encode(value[i], next, depth + 1) ?? "null");
      } catch {
        items.push(JSON.stringify("[unserializable]"));
      }
    }
    if (value.length > bounded) {
      items.push(JSON.stringify(`…[${value.length - bounded} more items]`));
    }
    return `[${items.join(",")}]`;
  }

  const pairs: string[] = [];
  for (const key of Object.keys(object)) {
    let encoded: string | undefined;
    if (isSensitiveKey(key)) {
      encoded = JSON.stringify("[redacted]");
    } else {
      try {
        // One throwing getter/proxy trap costs one field — the line (and its
        // real level/msg/ts) must survive, otherwise the log lies.
        encoded = encode(object[key], next, depth + 1);
      } catch {
        encoded = JSON.stringify("[unserializable]");
      }
    }
    if (encoded !== undefined)
      pairs.push(`${JSON.stringify(redact(key))}:${encoded}`);
  }
  return `{${pairs.join(",")}}`;
}

/** Safe single-line JSON for one log event (never throws). */
function safeStringify(value: unknown): string {
  try {
    return encode(value, [], 0) ?? "{}";
  } catch {
    return '{"level":"error","msg":"unserializable log fields"}';
  }
}

export interface Logger {
  readonly level: LogLevel;
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  /** Returns a logger that merges `fields` into every line it writes. */
  child(fields: LogFields): Logger;
}

function stderrWrite(line: string): void {
  process.stderr.write(line + "\n");
}

/**
 * @param level minimum level to emit
 * @param write sink (defaults to stderr) — injectable for tests
 */
export function createLogger(
  level: LogLevel = "warn",
  write: (line: string) => void = stderrWrite,
  baseFields: LogFields = {},
): Logger {
  const enabled = (candidate: LogLevel): boolean =>
    LEVEL_ORDER[candidate] <= LEVEL_ORDER[level];

  const emit = (
    candidate: LogLevel,
    message: string,
    fields?: LogFields,
  ): void => {
    if (!enabled(candidate)) return;
    // Caller fields are spread FIRST, envelope keys LAST: a field named
    // `level`/`msg`/`ts` (e.g. forwarded from an untrusted object) must never
    // rewrite the line's level or message — that would break filtering and
    // make logs lie about what happened.
    const line = safeStringify({
      ...baseFields,
      ...(fields ?? {}),
      ts: new Date().toISOString(),
      level: candidate,
      msg: message,
    });
    write(line);
  };

  return {
    level,
    error: (message, fields) => emit("error", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    info: (message, fields) => emit("info", message, fields),
    debug: (message, fields) => emit("debug", message, fields),
    child: (fields) => createLogger(level, write, { ...baseFields, ...fields }),
  };
}
