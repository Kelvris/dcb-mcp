/**
 * Snowflake ids — the one place a Discord id is defined (plan §3 reserves
 * this module for it). Both the env validator (`config.ts`) and every tool
 * input schema (`tools/context.ts`'s `optionalId`) must agree on what an id
 * looks like, so the pattern lives here instead of being written twice.
 *
 * 17–20 digits: the original snowflakes are 17–18, and the id space has grown
 * since (Discord now issues 19–20 digit ids), so the range is deliberately
 * wide — rejecting a *real* id is worse than accepting a slightly long one.
 */

export const SNOWFLAKE = /^\d{17,20}$/;

/** Structural check for a Discord snowflake (no Discord lookup implied). */
export function isSnowflake(value: string): boolean {
  return SNOWFLAKE.test(value);
}

/**
 * Order two ids the way the id *space* orders them: by digit length first,
 * then lexicographically within a length (equal-length digit strings compare
 * numerically that way).
 *
 * Plain string comparison is wrong across lengths and plain length-first
 * comparison is wrong within them — and mixing them is worse than either: a
 * length-first sort paired with a lexicographic filter drops every id whose
 * length differs from the cursor whenever its first digit is lower (`19`-digit
 * id vs an `7…`-digit cursor), which an agent reads as "the list ended" rather
 * than as a hole. Every sort *and* filter over ids must use this one.
 */
export function compareSnowflakes(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
