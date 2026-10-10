/**
 * Implementation details shared by the entity serializers.
 *
 * Deliberately **not** re-exported by `index.ts`. These are the primitives
 * the serializers use to do their work, not an API a caller should reach for
 * — only `BitFieldSource` and `CacheLike` escape, because they appear in
 * public signatures, and `shared.ts` re-exports those.
 *
 * Nothing here knows about a specific Discord entity, which is what lets the
 * entity modules depend on one direction only: on `shared.ts` and this file,
 * never on each other's internals.
 */

/** Anything Discord stores as a bit field: a discord.js BitField or plain names. */
export type BitFieldSource =
  { toArray(): string[] } | readonly string[] | null | undefined;

/**
 * A discord.js Collection (or a plain array fixture): iterable, and `size` is
 * optional because arrays expose `length` instead.
 */
export type CacheLike = Iterable<unknown> & { readonly size?: number };

/** Deprecated permission name → the canonical name sharing its bit. */
export const PERMISSION_NAME_ALIASES: Readonly<Record<string, string>> = {
  // Discord renamed ManageEmojisAndStickers → ManageGuildExpressions; both
  // entries carry bit 1<<30, so PermissionsBitField.toArray() returns both.
  ManageEmojisAndStickers: "ManageGuildExpressions",
};

/** Date/epoch → ISO string; preserves the input's presence (undefined stays undefined). */
export function iso(
  value: Date | number | string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Role/embed colour int → `#rrggbb`; never throws on malformed input. */
export function toHexColor(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `#${(Math.trunc(value) & 0xffffff).toString(16).padStart(6, "0")}`;
}

/**
 * Collection / array / manager cache → its values.
 *
 * discord.js Collections (and every array) expose `values()`; going through
 * it means a Map-like never has to be destructured as `[key, value]` pairs.
 */
export function valuesOf(source: CacheLike | null | undefined): unknown[] {
  if (source === null || source === undefined) return [];
  if (Array.isArray(source)) return [...source];
  const maybe = source as { values?: () => Iterable<unknown> };
  if (typeof maybe.values === "function") return [...maybe.values()];
  return [...source];
}

/** Anything id-bearing (or a raw id string) → its id, or `null`. */
export function idOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string") return id;
    if (typeof id === "number") return String(id);
  }
  return null;
}

/** Length of an array, a Collection, or anything else iterable with a `size`. */
function countOf(source: CacheLike): number {
  if (Array.isArray(source)) return source.length;
  return typeof source.size === "number" ? source.size : [...source].length;
}

/** Manager → its cache size; `undefined` (key omitted) when the fixture has no manager. */
export function cacheCount(
  manager: { readonly cache: CacheLike } | undefined,
): number | undefined {
  return manager === undefined ? undefined : countOf(manager.cache);
}

/**
 * discord.js lands **threads** in `guild.channels` as well — `ChannelManager`'s
 * `_add` accepts types 10/11/12 — so a bare cache size would report every forum
 * post as a channel. The values are discord-api-types' `ChannelType`
 * (AnnouncementThread / PublicThread / PrivateThread), inlined so this module
 * keeps its structural, no-discord.js-import contract.
 */
const THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);

/** Whether a cache entry is a thread rather than a channel. */
function isThreadChannel(value: unknown): boolean {
  const type = (value as { type?: unknown }).type;
  return typeof type === "number" && THREAD_CHANNEL_TYPES.has(type);
}

/**
 * Splits `guild.channels.cache` into "channels" and "threads". Both come from
 * the same manager, so `channelCount` and `threadCount` always add up to the
 * total and neither double-counts.
 */
export function channelCounts(
  manager: { readonly cache: CacheLike } | undefined,
): {
  channels: number | undefined;
  threads: number | undefined;
} {
  if (manager === undefined) return { channels: undefined, threads: undefined };
  let channels = 0;
  let threads = 0;
  for (const value of valuesOf(manager.cache)) {
    if (isThreadChannel(value)) threads += 1;
    else channels += 1;
  }
  return { channels, threads };
}

/** A bit field → its member names, or `[]` for an absent one. */
export function bitFieldNames(value: BitFieldSource): readonly string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  const maybe = value as { toArray?: () => string[] };
  return typeof maybe.toArray === "function" ? maybe.toArray() : [];
}

/** Collapse aliases to their canonical name and drop repeats. */
export function dedupe(
  names: readonly string[],
  aliases?: Readonly<Record<string, string>>,
): string[] {
  const out: string[] = [];
  for (const name of names) {
    const canonical = aliases?.[name] ?? name;
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}
