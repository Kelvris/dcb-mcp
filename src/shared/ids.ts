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
