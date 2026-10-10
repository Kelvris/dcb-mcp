/**
 * Type-level assertions for the preflight contract (plan §6).
 *
 * `PreflightRequest.targetMember` and `.targetRole` are required-but-nullable,
 * and that requirement is the *whole* fix for a real failure mode: while they
 * were optional, omitting one silently disabled the hierarchy and
 * protected-target layer — the checks this module exists to run — with no
 * runtime symptom at all. A correctly-written call site looks identical whether
 * the field is optional or required, so `test/guards.test.ts` could not catch a
 * regression here even in principle; reverting the types passed every test.
 *
 * Each `@ts-expect-error` below becomes an **unused directive** if its field
 * turns optional again, which `tsc` reports as an error — so `npm run
 * typecheck` fails and the fail-open behaviour cannot quietly return. This is
 * the reason they are directives rather than runtime assertions.
 *
 * **Every negative case names the *other* target field explicitly.** That is
 * load-bearing, not stylistic: a `@ts-expect-error` is satisfied by *any* error
 * on the line it annotates, so a literal omitting both fields would keep its
 * directive "used" by the sibling's error even after its own field went
 * optional — the mutation would sail through `tsc`. Supplying the sibling
 * isolates exactly one missing property, which is the mutation that test exists
 * to catch. Break this rule and the assertions become permanently green.
 *
 * The repository had no type tests before this file; it establishes the
 * pattern for any future field whose presence, rather than its value, is what
 * keeps a safety check running.
 */

import { describe, expect, it } from "vitest";
import type { PreflightRequest } from "../src/discord/guards.js";

/** Exists purely so the literals below have a type to fail against. */
function accepts(_request: PreflightRequest): true {
  return true;
}

describe("PreflightRequest target fields are fail-closed at the type level", () => {
  it("rejects a request that omits targetMember", () => {
    // @ts-expect-error targetMember is required — an omitted field is
    // indistinguishable from a misspelled one, and either silently disables
    // the hierarchy and protected-target layer. `targetRole: null` below
    // supplies the sibling field so this directive is satisfied by *this*
    // missing property alone, not by whichever error happens to land here.
    expect(accepts({ tool: "member.kick", targetRole: null })).toBe(true);
  });

  it("rejects a request that omits targetRole", () => {
    // @ts-expect-error targetRole is required for the same reason.
    expect(accepts({ tool: "role.update", targetMember: null })).toBe(true);
  });

  it("accepts an explicit null, which is how a tool declares 'no target'", () => {
    expect(
      accepts({ tool: "guild.update", targetMember: null, targetRole: null }),
    ).toBe(true);
  });
});
