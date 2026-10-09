/**
 * Discord/whatever → structured {@link WardenError} translation — the safety
 * net behind `guards.ts` (plan §6/§9): whatever DiscordAPIError slips past
 * the preflight lands here and comes out in the same uniform shape.
 *
 * Code meanings are grounded in `discord-api-types`' RESTJSONErrorCodes (the
 * enum Discord's ecosystem maintains), not folklore. Two plan-era myths fixed:
 * hierarchy violations are NOT a distinct code — Discord reports them as
 * 50013 Missing Permissions (which is why the preflight exists), and 50024 is
 * "wrong channel type", not hierarchy.
 *
 * Secrets: every emitted string goes through `scrub()` (TOKEN_LIKE + the
 * webhook/interaction path mask) — a token echoed in a Discord error message
 * cannot survive this module, including when a caller hands us a
 * `WardenError` that is already structured.
 */

import { redact } from "../logger.js";

export type WardenErrorKind =
  | "not_ready"
  | "missing_permission"
  | "role_hierarchy"
  | "target_protected"
  | "invalid_input"
  | "not_found"
  | "rate_limited"
  | "discord_api"
  | "internal";

/** Uniform failure payload returned by every tool (plan §9). */
export interface WardenError {
  ok: false;
  error: WardenErrorKind;
  message: string;
  discordCode?: number;
  missingPermissions?: string[];
  bot?: { role: string; position: number };
  target?:
    { role: string; position: number } | { user: string; protected: string };
  remediation: string;
  details?: Record<string, unknown>;
}

/** Thrown by waitForReady() while the gateway is not up yet. */
export class WardenNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WardenNotReadyError";
  }
}

export function isWardenError(value: unknown): value is WardenError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WardenError>;
  return (
    candidate.ok === false &&
    typeof candidate.error === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.remediation === "string"
  );
}

/** Structural check — works for real discord.js errors and test doubles. */
export interface DiscordApiErrorLike extends Error {
  code?: number | string;
  status?: number;
  method?: string;
  url?: string;
  rawError?: {
    code?: number | string;
    message?: string;
    errors?: unknown;
    retry_after?: number;
    global?: boolean;
  };
}

export function isDiscordApiError(
  value: unknown,
): value is DiscordApiErrorLike {
  if (!(value instanceof Error)) return false;
  const candidate = value as Partial<DiscordApiErrorLike>;
  // `method` matters: @discordjs/rest's HTTPError (5xx after retries) carries
  // status+method but neither rawError nor code — without it a 502 would fall
  // through to `internal` ("bug in Warden") instead of the status fallback.
  return (
    typeof candidate.status === "number" &&
    (candidate.rawError !== undefined ||
      candidate.code !== undefined ||
      typeof candidate.method === "string")
  );
}

/**
 * Masks the bearer secret in a webhook/interaction URL by *path shape*. It is
 * not bot-token shaped, so `redact()`'s three-segment TOKEN_LIKE never matches
 * it — any message or detail carrying such a URL needs this too. This is what
 * keeps a failing webhook REST call from leaking its token through
 * `details.route`.
 */
const SECRET_SEGMENT = /\/(webhooks|interactions)\/(\d+)\/[^/?#\s]+/g;

function scrubSecretSegments(text: string): string {
  return text.replace(SECRET_SEGMENT, "/$1/$2/[redacted-secret]");
}

/**
 * Every string this module emits passes through here and nothing else:
 * `redact()` for anything bot-token shaped, plus the path-shape mask for
 * webhook/interaction secrets that TOKEN_LIKE structurally cannot match.
 * Routing all output through one function is what makes the header's "no
 * token survives" claim checkable rather than a promise per call site.
 */
function scrub(text: string): string {
  return redact(scrubSecretSegments(text));
}

function sanitizeRoute(route: string): string {
  // scrub() BEFORE slicing: truncating first could cut a token in half,
  // pushing its head below TOKEN_LIKE's {18,} floor so the regex would no
  // longer recognise it and the fragment would be emitted raw.
  return scrub(route).slice(0, 500);
}

interface KnownCode {
  kind: WardenErrorKind;
  message: string;
  remediation: string;
}

/** 10xxx "Unknown X" family → what entity Discord didn't recognise. */
const UNKNOWN_ENTITIES: Record<number, string> = {
  10001: "account",
  10002: "application",
  10003: "channel",
  10004: "server",
  10005: "integration",
  10006: "invite",
  10007: "member",
  10008: "message",
  10009: "permission overwrite",
  10010: "integration provider",
  10011: "role",
  10012: "token",
  10013: "user",
  10014: "emoji",
  10015: "webhook",
  10016: "webhook service",
  10020: "session",
  10021: "asset",
  10026: "ban",
  // 10027 is UnknownSKU (a monetization product), 10028 UnknownStoreListing —
  // only the latter is a "store listing".
  10027: "SKU",
  10028: "store listing",
  10029: "entitlement",
};

const REMEDIATION_REFRESH =
  "Refresh the list and re-check the id — it was deleted (or never existed) since it was last read.";

/** 50014 is also what discord.js reports for its own TokenInvalid at login. */
const TOKEN_INVALID_MESSAGE = "Discord rejected the bot token.";
const TOKEN_INVALID_REMEDIATION =
  "DISCORD_BOT_TOKEN is invalid or was reset — copy a fresh token from the developer portal into your MCP client config and restart Warden.";

/**
 * Verified Discord codes → Warden shape. Codes sourced from
 * `discord-api-types` RESTJSONErrorCodes; only codes with a known meaning
 * belong here — unknown codes fall through to status-based mapping.
 */
const KNOWN_CODES: Record<number, KnownCode> = {
  // — access / permissions —
  50001: {
    kind: "missing_permission",
    message: "Warden cannot access that server or channel.",
    remediation:
      "Check Warden is still a member of the server and can View Channel there — re-invite it with the README OAuth2 URL if it was kicked or the channel perms changed.",
  },
  50013: {
    kind: "missing_permission",
    message: "Discord says Warden lacks the permission this action needs.",
    remediation:
      "Run get_bot_status for the capability report: grant the missing permission in Server Settings → Roles, or move the Warden role above the target's highest role — Discord reports role-hierarchy failures with this same 50013 code.",
  },
  50014: {
    kind: "discord_api",
    message: TOKEN_INVALID_MESSAGE,
    remediation: TOKEN_INVALID_REMEDIATION,
  },
  50005: {
    kind: "missing_permission",
    message:
      "Only the author (or a member with Manage Messages) can edit that message.",
    remediation:
      "Edit your own messages freely; editing someone else's requires the Manage Messages permission in that channel.",
  },

  // — input / structure —
  50003: {
    kind: "invalid_input",
    message: "This action cannot run in a DM channel.",
    remediation:
      "Pass a server channel id (or set WARDEN_GUILD_ID and use server tools).",
  },
  50006: {
    kind: "invalid_input",
    message: "A message must contain content, embeds, stickers, or files.",
    remediation: "Provide `content` or at least one other payload field.",
  },
  50008: {
    kind: "invalid_input",
    message: "That channel type does not accept messages.",
    remediation:
      "Use the tool matching the channel type: threads → manage_thread, forums → manage_thread (create post), voice → set_voice_channel_status.",
  },
  50016: {
    kind: "invalid_input",
    message: "Bulk delete accepts between 2 and 100 message ids.",
    remediation: "Split the ids into bulk_delete_messages calls of 2–100 each.",
  },
  50021: {
    kind: "invalid_input",
    message: "Discord forbids acting on system messages (joins, boosts, pins).",
    remediation: "Target a regular member message instead.",
  },
  50024: {
    kind: "invalid_input",
    message: "This action doesn't work on that channel type.",
    remediation:
      "Use the tool matching the channel type (threads → manage_thread, voice status → set_voice_channel_status, announcements → crosspost_message).",
  },
  50034: {
    kind: "invalid_input",
    message: "Bulk delete cannot remove messages older than 14 days.",
    remediation: "Delete old messages one by one, or leave them in place.",
  },
  50035: {
    kind: "invalid_input",
    message: "Discord rejected the request body.",
    remediation:
      "Check `details.fields` — one or more input values had the wrong type or were out of range.",
  },
  50045: {
    kind: "invalid_input",
    message: "That upload exceeds Discord's file size limit.",
    remediation:
      "Discord's default limit is 20 MiB (higher with Nitro/boosts) — send a smaller file or reference an existing URL in an embed.",
  },
  50046: {
    kind: "invalid_input",
    message: "Discord couldn't read that file upload.",
    remediation:
      "Check `file.base64` and `file.media_type` (must be a real base64 image/audio payload).",
  },
  50083: {
    kind: "invalid_input",
    message: "That thread is archived.",
    remediation:
      "Unarchive it first: manage_thread { action: 'edit', archived: false, thread_id }.",
  },
  40005: {
    kind: "invalid_input",
    message: "The request payload is too large for Discord.",
    remediation:
      "Reduce the number of ids/fields or shrink attachments and retry.",
  },
  40058: {
    kind: "invalid_input",
    message: "Forum channels only accept new posts, not plain messages.",
    remediation:
      "Create a post with manage_thread { action: 'create', channel_id }.",
  },
  30033: {
    kind: "invalid_input",
    message: "That thread has reached Discord's participant limit.",
    remediation: "Nothing to fix on Warden's side — the thread is full.",
  },

  // — targets —
  50007: {
    kind: "target_protected",
    message: "That user cannot receive direct messages.",
    remediation:
      "They have DMs closed (or share no server with Warden) — no permission change can force this.",
  },
  40007: {
    kind: "target_protected",
    message: "That user is banned from this server.",
    remediation:
      "Unban them first (unban_member) if you intend to act on them.",
  },
  40032: {
    kind: "invalid_input",
    message: "That user isn't connected to a voice channel.",
    remediation:
      "Only members currently in voice can be moved or voice-modified — check get_member first.",
  },
  40033: {
    kind: "invalid_input",
    message: "That message has already been crossposted.",
    remediation:
      "No action needed — the announcement already went out to follower channels.",
  },

  // — rate limits surfaced as JSON errors —
  40003: {
    kind: "rate_limited",
    message: "Discord throttled opening that DM channel.",
    remediation:
      "Wait a moment and retry — DM channels are rate limited per user.",
  },
};

/** Nesting Discord's `errors` tree uses is 3–4 deep; 8 is generous headroom. */
const MAX_FIELD_DEPTH = 8;
/**
 * Breadth is unbounded even when depth isn't (an array of 10⁵ ids is one
 * level), so the walk stops here — `details.fields` is a hint for the agent,
 * not an exhaustive audit of Discord's complaint.
 */
const MAX_FIELD_ERRORS = 25;

function flattenFieldErrors(errors: unknown): string[] {
  const out: string[] = [];
  walkFieldErrors(errors, "", 0, out);
  return out;
}

function walkFieldErrors(
  errors: unknown,
  path: string,
  depth: number,
  out: string[],
): void {
  if (depth > MAX_FIELD_DEPTH || out.length >= MAX_FIELD_ERRORS) return;
  if (errors === null || typeof errors !== "object") return;
  if (Array.isArray(errors)) {
    // Index-based so the breadth cap is checked *before* each recursion: with
    // `forEach` a 200k-element array still walks every entry (and builds a
    // `${path}[${index}]` string for each) after `out` is already full.
    for (let index = 0; index < errors.length; index += 1) {
      if (out.length >= MAX_FIELD_ERRORS) return;
      walkFieldErrors(errors[index], `${path}[${index}]`, depth + 1, out);
    }
    return;
  }
  const record = errors as Record<string, unknown>;
  const own = record._errors;
  if (Array.isArray(own)) {
    for (const entry of own) {
      if (out.length >= MAX_FIELD_ERRORS) return;
      if (entry && typeof entry === "object") {
        const message = (entry as { message?: unknown }).message;
        // Redacted here rather than at the call site so no future caller of
        // this walker can put an un-redacted field into a payload.
        if (typeof message === "string")
          out.push(scrub(`${path || "(body)"}: ${message}`));
      }
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "_errors") continue;
    if (out.length >= MAX_FIELD_ERRORS) return;
    walkFieldErrors(value, path ? `${path}.${key}` : key, depth + 1, out);
  }
}

const STATUS_FALLBACKS: Record<
  number,
  Pick<KnownCode, "kind" | "message" | "remediation">
> = {
  400: {
    kind: "invalid_input",
    message: "Discord rejected the request as malformed (HTTP 400).",
    remediation:
      "Check the tool inputs against its schema — a value was the wrong type or out of range.",
  },
  401: {
    kind: "discord_api",
    message: "Discord rejected the credentials (HTTP 401).",
    remediation:
      "DISCORD_BOT_TOKEN is invalid, expired, or was reset — copy a fresh token from the developer portal and restart Warden.",
  },
  403: {
    kind: "missing_permission",
    message: "Discord denied the action (HTTP 403).",
    remediation:
      "Warden lacks access here — check get_bot_status: grant the permission or raise the Warden role above the target's.",
  },
  404: {
    kind: "not_found",
    message: "Discord couldn't find that resource (HTTP 404).",
    remediation: REMEDIATION_REFRESH,
  },
  413: {
    // Usually carries code 40005 (which KNOWN_CODES handles), but a proxy in
    // front of Discord can return 413 with no JSON body at all.
    kind: "invalid_input",
    message: "Discord rejected the request as too large (HTTP 413).",
    remediation:
      "The payload is over Discord's limit — attachments, embeds, poll answers and audit-log reasons all have hard size caps. Shrink it and retry.",
  },
  429: {
    kind: "rate_limited",
    message: "Discord rate-limited this request (HTTP 429).",
    remediation:
      "Retry after `details.retry_after` seconds — discord.js usually absorbs this for you.",
  },
  500: {
    kind: "discord_api",
    message: "Discord had an internal server error (HTTP 500).",
    remediation: "This is transient — retry in a few seconds.",
  },
  502: {
    kind: "discord_api",
    message: "Discord gateway returned bad gateway (HTTP 502).",
    remediation: "This is transient — retry in a few seconds.",
  },
};

/** Translate a DiscordAPIError-shaped failure into the uniform Warden shape. */
function fromDiscordApiError(error: DiscordApiErrorLike): WardenError {
  const raw = error.rawError;
  const code =
    typeof raw?.code === "number"
      ? raw.code
      : typeof error.code === "number"
        ? error.code
        : undefined;
  const status = error.status;
  const discordMessage =
    (typeof raw?.message === "string" && raw.message) ||
    error.message ||
    "unknown error";

  const details: Record<string, unknown> = {};
  if (code !== undefined) details.discordCode = code;
  if (status !== undefined) details.httpStatus = status;
  if (error.method && error.url)
    details.route = sanitizeRoute(`${error.method} ${error.url}`);
  if (typeof raw?.retry_after === "number")
    details.retry_after = raw.retry_after;
  const fields = flattenFieldErrors(raw?.errors);
  if (fields.length > 0) details.fields = fields;

  let base: Pick<KnownCode, "kind" | "message" | "remediation"> | undefined =
    code !== undefined ? KNOWN_CODES[code] : undefined;

  if (!base && code !== undefined && code in UNKNOWN_ENTITIES) {
    const entity = UNKNOWN_ENTITIES[code];
    base = {
      kind: "not_found",
      message: `Discord doesn't know that ${entity} (code ${code}).`,
      remediation:
        entity === "ban"
          ? "That user isn't banned (already unbanned?) — list_bans to confirm."
          : REMEDIATION_REFRESH,
    };
  }

  if (!base && status !== undefined) {
    base =
      STATUS_FALLBACKS[status] ??
      (status >= 500 ? STATUS_FALLBACKS[500] : undefined);
  }

  const kind = base?.kind ?? "discord_api";
  const message = base?.message ?? "Discord rejected the request.";
  const remediation =
    base?.remediation ??
    "Check WARDEN_LOG_LEVEL=debug stderr output; if it persists, report it with the log line attached.";

  const suffix =
    code !== undefined || status !== undefined
      ? ` Discord said: "${discordMessage}"`
      : "";
  const result: WardenError = {
    ok: false,
    error: kind,
    message: scrub(`${message}${suffix}`),
    remediation: scrub(remediation),
  };
  if (code !== undefined) result.discordCode = code;
  if (Object.keys(details).length > 0) result.details = details;
  return result;
}

/** Depth past which a nested container is replaced instead of descended into. */
const MAX_REDACT_DEPTH = 6;

/**
 * Scrub every string leaf of a value. Guard errors are *built* out of
 * Discord-supplied text (role names, member names, audit-log reasons), so a
 * `WardenError` handed back to us is treated as untrusted input rather than
 * passed through.
 *
 * The depth cap bounds how far we walk; it must never exempt *content*, so
 * leaves are checked before it — but a container past it is REPLACED, not
 * returned: handing back the raw object would emit every string inside it
 * untouched. Same trade `logger.ts` makes at its own depth limit.
 */
function redactDeep(value: unknown, depth = 0): unknown {
  // A string handed to us is scrubbed whatever its depth — but strings inside
  // a container that has already hit the cap are never reached at all, which
  // is why the cap replaces its container rather than returning it.
  if (typeof value === "string") return scrub(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_REDACT_DEPTH) return "[depth-limit]";
  // Both classes need a hand: their interesting properties (`message`,
  // `stack`, the ISO date) are own-but-non-enumerable or getters, so
  // `Object.entries` would hand back a bare `{}` and silently drop them.
  if (value instanceof Error) {
    return {
      name: scrub(value.name),
      message: scrub(value.message),
      // scrub BEFORE slicing — the same trap sanitizeRoute() documents at
      // :119: cutting first can split a token in half and push its head below
      // TOKEN_LIKE's {18,} floor, so the fragment would be emitted raw.
      ...(value.stack ? { stack: scrub(value.stack).slice(0, 2000) } : {}),
    };
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDeep(entry, depth + 1));
  }
  // Plain object: rebuild from enumerable own properties. Deliberately *not*
  // the same as `logger.ts:114-197` — there is no `toJSON` call, no breadth
  // cap and no cycle guard here, because the depth cap already terminates
  // cycles (a self-reference lands on "[depth-limit]"), `details` is fed JSON
  // error bodies (no functions, no toJSON to honour) and discord.js's
  // `Base.toJSON()` is `flatten(this)`, a subset of what we already see. A
  // Map/Set would collapse to {} and a boxed String to a per-character
  // object — neither leaks, but don't start passing one in.
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = redactDeep(entry, depth + 1);
  }
  return out;
}

/**
 * Any thrown value → WardenError. Gateway-not-ready has its own kind,
 * everything else becomes `internal`.
 *
 * An already-structured `WardenError` is **re-scrubbed field by field**, not
 * passed through — this is the arm `guards.ts` will hit most often, and the
 * header's promise is that no token survives this file. Every field goes
 * through `redactDeep`, not just `message`/`remediation`/`details`: guards put
 * Discord-supplied role and member names into `bot`, `target` and
 * `missingPermissions`, which are precisely the fields carrying that text.
 * Object identity is traded away for it — callers must treat the result as
 * fresh.
 */
export function toWardenError(error: unknown): WardenError {
  if (isWardenError(error)) {
    return redactDeep(error) as WardenError;
  }

  if (error instanceof WardenNotReadyError) {
    return {
      ok: false,
      error: "not_ready",
      message: scrub(error.message),
      remediation:
        "The Discord gateway isn't connected yet — retry in a few seconds; get_bot_status reports live connection state.",
    };
  }

  if (isDiscordApiError(error)) return fromDiscordApiError(error);

  // discord.js' own login failure (DiscordjsError TokenInvalid) carries no HTTP
  // status — without this branch it would land in `internal` ("bug in Warden"),
  // which is the most common startup failure of all.
  if (
    error instanceof Error &&
    ((error as { code?: unknown }).code === "TokenInvalid" ||
      error.name.endsWith("[TokenInvalid]"))
  ) {
    return {
      ok: false,
      error: "discord_api",
      message: scrub(
        `${TOKEN_INVALID_MESSAGE} Discord said: "${error.message}"`,
      ),
      remediation: TOKEN_INVALID_REMEDIATION,
      details: { name: scrub(error.name) },
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  // scrub BEFORE slicing — see the same rule on `redactDeep`'s Error branch.
  const stack =
    error instanceof Error && error.stack
      ? scrub(error.stack).slice(0, 2000)
      : undefined;
  const result: WardenError = {
    ok: false,
    error: "internal",
    message: scrub(`Unexpected error: ${message}`),
    remediation:
      "This is a bug in Warden — capture the stderr log (WARDEN_LOG_LEVEL=debug) and report it with this line.",
  };
  const details: Record<string, unknown> = {};
  if (error instanceof Error) details.name = scrub(error.name);
  if (stack) details.stack = stack;
  result.details = details;
  return result;
}
