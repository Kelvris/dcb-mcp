/**
 * Guild audit-log entries (plan §8.2 `get_audit_log`).
 *
 * Same contract as the rest of the set — structural `*Like` input, compact
 * camelCase output, `null` for "Discord says none", no discord.js import —
 * with three shape decisions worth stating, because an audit entry is the
 * one payload whose whole point is *evidence*:
 *
 * * **`changes` keeps Discord's values verbatim.** `old`/`new` are left as
 *   whatever the entry carried (strings, numbers, booleans, null) rather than
 *   being stringified: half the value of an audit entry is knowing that a
 *   channel's `nsfw` went `false → true`, and flattening that to text would
 *   destroy the type that makes it checkable. They are free text (a rename,
 *   an audit reason), so the tool layer scrubs them on the way out.
 * * **`extra` is narrowed to scalar fields.** `GuildAuditLogsEntry#extra`
 *   holds the action-specific extras (prune `removed` count, delete-restore
 *   duration, unlink integration ids) *and* live discord.js objects — a
 *   member prune's `members` is a `Collection` of GuildMember. Emitting that
 *   would ship a library object into a JSON payload, so only string/number/
 *   boolean leaves are kept and everything else is dropped by omission.
 * * **`action` is the name discord.js reports** (`"MemberBanAdd"`), which is
 *   what an agent can put back into `action_type`. A bare number is passed
 *   through as text for hand-built payloads; real entries never reach that
 *   arm, since v14 resolves the name for us.
 */

import { iso } from "./internal.js";
import type { SerializedUser } from "./members.js";
import { serializeUser } from "./members.js";

export interface AuditChangeLike {
  key?: string;
  old?: unknown;
  new?: unknown;
}

/**
 * The executor as Discord reports it.
 *
 * Deliberately not `UserLike`: discord.js types `GuildAuditLogsEntry#executor`
 * as `User | PartialUser | null`, and `PartialUser#username` is
 * `string | null`. A partial (a user Discord no longer resolves, or one the
 * cache has only an id for) therefore cannot satisfy `UserLike`, which is why
 * {@link SerializedAuditEntry.executor} may be `null` even when
 * {@link SerializedAuditEntry.executorId} is set — the id is the part of an
 * audit entry that is never optional, and dropping it would be the real loss.
 */
export interface AuditExecutorLike {
  id?: string;
  username?: string | null;
  globalName?: string | null;
  /**
   * `string | null`, not `string | null | undefined`: discord.js builds
   * `PartialUser` as `Partialize<User, 'username' | 'tag' | 'discriminator'>`,
   * which turns those three keys into a literal `null` rather than making
   * them optional — so a partial executor hands back `discriminator: null`
   * and `username: null`, never a tag.
   */
  discriminator?: string | null;
  avatar?: string | null;
  bot?: boolean;
  system?: boolean;
  /** Raw integer is fine — `serializeUser` documents that form. */
  flags?: unknown;
  createdTimestamp?: number | null;
}

export interface AuditEntryLike {
  id?: string;
  /**
   * `unknown` rather than `string | number`: discord.js declares these off
   * `GuildAuditLogsEntry`'s *generic* `TAction`, which resolves to `unknown`
   * for an unparameterised entry. {@link actionName} narrows them.
   */
  action?: unknown;
  actionType?: unknown;
  targetType?: unknown;
  targetId?: string | null;
  reason?: string | null;
  executor?: AuditExecutorLike | null;
  executorId?: string | null;
  changes?: readonly AuditChangeLike[];
  extra?: Record<string, unknown> | null;
  createdTimestamp?: number | null;
  createdAt?: Date | null;
}

export interface SerializedAuditEntry {
  id: string;
  /** Discord's action name (`"MemberBanAdd"`); numbers pass through as text. */
  action: string | null;
  actionType: string | null;
  targetType: string | null;
  targetId: string | null;
  /** `null` only when Discord gave us no usable user object — see above. */
  executor: SerializedUser | null;
  /**
   * Always present when Discord named one, even if `executor` is `null`:
   * "who did this" survives a partial user.
   */
  executorId: string | null;
  /** The audit-log reason the actor (or their client) attached — free text. */
  reason: string | null;
  changes: { key: string; old: unknown; new: unknown }[];
  /** Action-specific extras with scalar values only (see file header). */
  extra: Record<string, string | number | boolean> | null;
  at: string | null;
}

/**
 * Narrow an action/target name coming out of a generic-typed entry.
 *
 * Only primitives become text. Anything else (`undefined`, an object where a
 * name was expected) becomes `null` — `"[object Object]"` in an audit trail
 * would be worse than an honest absence, and this payload's whole purpose is
 * that it can be trusted as evidence.
 */
export function actionName(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function scalarOnly(
  extra: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean> | null {
  if (extra === null || extra === undefined) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function executorOf(entry: AuditEntryLike): {
  executor: SerializedUser | null;
  executorId: string | null;
} {
  const raw = entry.executor;
  const executorId = entry.executorId ?? raw?.id ?? null;
  if (raw === null || raw === undefined || typeof raw.username !== "string") {
    return { executor: null, executorId };
  }
  if (executorId === null) return { executor: null, executorId: null };
  return {
    executor: serializeUser({
      id: executorId,
      username: raw.username,
      globalName: raw.globalName ?? null,
      discriminator: raw.discriminator ?? undefined,
      avatar: raw.avatar ?? null,
      bot: raw.bot ?? false,
      system: raw.system ?? false,
      flags: typeof raw.flags === "number" ? raw.flags : undefined,
      createdTimestamp: raw.createdTimestamp ?? null,
    }),
    executorId,
  };
}

export function serializeAuditLogEntry(
  entry: AuditEntryLike,
): SerializedAuditEntry {
  const { executor, executorId } = executorOf(entry);
  return {
    id: entry.id ?? "",
    action: actionName(entry.action),
    actionType: actionName(entry.actionType),
    targetType: actionName(entry.targetType),
    targetId: entry.targetId ?? null,
    executor,
    executorId,
    reason: entry.reason ?? null,
    changes: (entry.changes ?? []).map((change) => ({
      key: change.key ?? "",
      old: change.old ?? null,
      new: change.new ?? null,
    })),
    extra: scalarOnly(entry.extra),
    at: iso(entry.createdTimestamp ?? entry.createdAt) ?? null,
  };
}
