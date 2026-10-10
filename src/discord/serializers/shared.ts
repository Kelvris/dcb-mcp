/**
 * The public serializer primitives: the two bit-field readers and the two
 * container helpers every entity serializer leans on.
 *
 * Everything else this module originally held has moved next door to
 * `internal.ts`, which `index.ts` does not re-export — so the public surface
 * of the serializer set stays exactly these four functions plus the two types
 * they mention.
 */

import type { BitFieldSource, CacheLike } from "./internal.js";
import {
  PERMISSION_NAME_ALIASES,
  bitFieldNames,
  dedupe,
  idOf,
  valuesOf,
} from "./internal.js";

export type { BitFieldSource, CacheLike } from "./internal.js";

/**
 * Drop keys whose value is `undefined` (not applicable / not cached) while
 * keeping `null` (Discord explicitly reported "none").
 *
 * The record is an object literal so the inferred type keeps its keys; only
 * the undefined-valued ones disappear at runtime, which is exactly the JSON
 * `JSON.stringify` would produce anyway.
 */
export function compact<T extends Record<string, unknown>>(record: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/** Collection/array of id-bearing objects (or raw ids) → the id list. */
export function idList(source: CacheLike | null | undefined): string[] {
  const out: string[] = [];
  for (const value of valuesOf(source)) {
    const id = idOf(value);
    if (id !== null) out.push(id);
  }
  return out;
}

/** Permission names, alias-collapsed and deduplicated. */
export function serializePermissions(value: BitFieldSource): string[] {
  return dedupe(bitFieldNames(value), PERMISSION_NAME_ALIASES);
}

/** Any other bit field (message/user/system-channel flags …) → names. */
export function serializeBitField(value: BitFieldSource): string[] {
  return dedupe(bitFieldNames(value));
}
