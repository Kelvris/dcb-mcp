import {
  DiscordAPIError,
  HTTPError,
  type DiscordErrorData,
} from "@discordjs/rest";
import { describe, expect, it } from "vitest";
import {
  isDiscordApiError,
  isWardenError,
  toWardenError,
  WardenNotReadyError,
  type WardenError,
} from "../src/discord/errors.js";

const BOT_ID = "1052345678901234562";
/** Realistic-looking but fake token — used only to prove it never leaks. */
const TOKEN = `${Buffer.from(BOT_ID, "utf8").toString("base64url")}.GhIkLm.NpQrStUvWxYz0123456789abcdefghijklmnop`;

/**
 * `DiscordErrorData` is `{code, message, errors?}` — Discord's *rate-limit*
 * body additionally carries `retry_after`, which the type doesn't model.
 */
type RawError = DiscordErrorData & { retry_after?: number; global?: boolean };

const BODY = { body: undefined, files: [] };

/**
 * `discord-api-types`' `DiscordError` union cannot express the array-shaped
 * groups Discord actually nests under indexed fields
 * (`errors.embeds[0].description`), so the raw body arrives as `unknown` and
 * is narrowed exactly once here — the same tolerance `flattenFieldErrors`
 * applies at runtime.
 */
function apiError(
  raw: unknown,
  options: {
    status?: number;
    method?: string;
    url?: string;
    code?: number;
  } = {},
): DiscordAPIError {
  const data = raw as RawError;
  const {
    status = 400,
    method = "PATCH",
    url = "/channels/100000000000000004",
    code = data.code,
  } = options;
  return new DiscordAPIError(data, code, status, method, url, BODY);
}

function translate(error: unknown): WardenError {
  return toWardenError(error);
}

describe("isWardenError", () => {
  it("accepts a structurally valid payload", () => {
    expect(
      isWardenError({
        ok: false,
        error: "not_found",
        message: "gone",
        remediation: "refresh",
      }),
    ).toBe(true);
  });

  it("rejects a success payload, a non-object, and a partial object", () => {
    expect(
      isWardenError({ ok: true, error: "x", message: "y", remediation: "z" }),
    ).toBe(false);
    expect(isWardenError(null)).toBe(false);
    expect(isWardenError("nope")).toBe(false);
    // missing `remediation` → not a WardenError
    expect(
      isWardenError({ ok: false, error: "not_found", message: "gone" }),
    ).toBe(false);
  });
});

describe("isDiscordApiError", () => {
  it("accepts a DiscordAPIError (has status + code)", () => {
    expect(
      isDiscordApiError(
        apiError(
          { code: 50013, message: "Missing Permissions" },
          { status: 403 },
        ),
      ),
    ).toBe(true);
  });

  it("accepts an HTTPError (status + method, no code/rawError)", () => {
    // This is the whole reason `method` is in the predicate: without it a 502
    // would be classified as `internal` — "bug in Warden".
    expect(
      isDiscordApiError(
        new HTTPError(502, "Bad Gateway", "GET", "/guilds/1", BODY),
      ),
    ).toBe(true);
  });

  it("rejects a plain Error and non-errors", () => {
    expect(isDiscordApiError(new Error("boom"))).toBe(false);
    expect(isDiscordApiError({ status: 500 })).toBe(false);
    expect(isDiscordApiError(undefined)).toBe(false);
  });
});

describe("toWardenError — verified Discord codes", () => {
  // Codes and their meanings verified against discord-api-types'
  // RESTJSONErrorCodes. Two of the plan's examples were wrong and are pinned
  // here so they cannot drift back: 50024 is *wrong channel type*, not
  // hierarchy (hierarchy is 50013), and 30034 is *max daily app-command
  // creates*, not "already banned" (that's 40007).
  const cases: Array<{
    code: number;
    status: number;
    kind: WardenError["error"];
    fragment: string;
  }> = [
    {
      code: 50001,
      status: 403,
      kind: "missing_permission",
      fragment: "cannot access",
    },
    {
      code: 50013,
      status: 403,
      kind: "missing_permission",
      fragment: "lacks the permission",
    },
    {
      code: 50005,
      status: 403,
      kind: "missing_permission",
      fragment: "edit that message",
    },
    { code: 50003, status: 400, kind: "invalid_input", fragment: "DM channel" },
    {
      code: 50006,
      status: 400,
      kind: "invalid_input",
      fragment: "content, embeds",
    },
    {
      code: 50008,
      status: 400,
      kind: "invalid_input",
      fragment: "does not accept messages",
    },
    { code: 50016, status: 400, kind: "invalid_input", fragment: "2 and 100" },
    {
      code: 50021,
      status: 400,
      kind: "invalid_input",
      fragment: "system messages",
    },
    {
      code: 50024,
      status: 400,
      kind: "invalid_input",
      fragment: "channel type",
    },
    {
      code: 50034,
      status: 400,
      kind: "invalid_input",
      fragment: "older than 14 days",
    },
    {
      code: 50035,
      status: 400,
      kind: "invalid_input",
      fragment: "request body",
    },
    {
      code: 50045,
      status: 400,
      kind: "invalid_input",
      fragment: "file size limit",
    },
    {
      code: 50046,
      status: 400,
      kind: "invalid_input",
      fragment: "file upload",
    },
    { code: 50083, status: 400, kind: "invalid_input", fragment: "archived" },
    { code: 40005, status: 413, kind: "invalid_input", fragment: "too large" },
    { code: 40058, status: 400, kind: "invalid_input", fragment: "new posts" },
    {
      code: 30033,
      status: 400,
      kind: "invalid_input",
      fragment: "participant limit",
    },
    {
      code: 50007,
      status: 403,
      kind: "target_protected",
      fragment: "direct messages",
    },
    { code: 40007, status: 403, kind: "target_protected", fragment: "banned" },
    {
      code: 40032,
      status: 400,
      kind: "invalid_input",
      fragment: "voice channel",
    },
    {
      code: 40033,
      status: 400,
      kind: "invalid_input",
      fragment: "crossposted",
    },
    { code: 40003, status: 429, kind: "rate_limited", fragment: "DM channel" },
    {
      code: 50014,
      status: 401,
      kind: "discord_api",
      fragment: "rejected the bot token",
    },
  ];

  for (const { code, status, kind, fragment } of cases) {
    it(`maps ${code} → ${kind}`, () => {
      const result = translate(
        apiError({ code, message: `Discord code ${code}` }, { status }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe(kind);
      expect(result.discordCode).toBe(code);
      expect(result.message).toContain(fragment);
      expect(result.remediation.length).toBeGreaterThan(20);
    });
  }

  it("treats 50024 as wrong-channel-type, not hierarchy (plan §6 correction)", () => {
    const result = translate(
      apiError(
        { code: 50024, message: "Cannot execute action on this channel type" },
        { status: 400 },
      ),
    );
    expect(result.error).toBe("invalid_input");
    expect(result.remediation).toContain("manage_thread");
    expect(result.remediation).not.toMatch(/hierarch/i);
  });

  it("treats 50013 as the hierarchy/permission code (plan §6 correction)", () => {
    const result = translate(
      apiError(
        { code: 50013, message: "Missing Permissions" },
        { status: 403 },
      ),
    );
    expect(result.error).toBe("missing_permission");
    expect(result.remediation).toContain("role-hierarchy");
  });
});

describe("toWardenError — 10xxx Unknown X family", () => {
  it("maps Unknown Role (10011) to not_found naming the entity", () => {
    const result = translate(
      apiError({ code: 10011, message: "Unknown Role" }, { status: 404 }),
    );
    expect(result.error).toBe("not_found");
    expect(result.message).toContain("role");
    expect(result.message).toContain("10011");
    expect(result.remediation).toMatch(/re-check the id/i);
  });

  it("maps Unknown Ban (10026) to not_found with ban-specific remediation", () => {
    const result = translate(
      apiError({ code: 10026, message: "Unknown Ban" }, { status: 404 }),
    );
    expect(result.error).toBe("not_found");
    expect(result.remediation).toContain("list_bans");
  });

  it("maps Unknown Message (10008) to not_found naming the message", () => {
    const result = translate(
      apiError({ code: 10008, message: "Unknown Message" }, { status: 404 }),
    );
    expect(result.message).toContain("message");
  });

  it("names UnknownSKU (10027) an SKU, not a store listing", () => {
    // 10027 = UnknownSKU (monetization product); 10028 = UnknownStoreListing.
    // The two were conflated, so a SKU error used to say "Discord doesn't know
    // that store listing" with generic refresh advice.
    const sku = translate(
      apiError({ code: 10027, message: "Unknown SKU" }, { status: 404 }),
    );
    expect(sku.message).toContain("SKU");
    expect(sku.message).not.toContain("store listing");

    const listing = translate(
      apiError(
        { code: 10028, message: "Unknown Store Listing" },
        {
          status: 404,
        },
      ),
    );
    expect(listing.message).toContain("store listing");
  });
});

describe("toWardenError — status fallbacks", () => {
  it("uses the HTTP status when the code is unknown", () => {
    const result = translate(
      apiError(
        { code: 99999, message: "Weird Discord error" },
        { status: 404 },
      ),
    );
    expect(result.error).toBe("not_found");
    expect(result.details?.httpStatus).toBe(404);
    expect(result.discordCode).toBe(99999);
  });

  it("maps HTTP 429 without a code to rate_limited", () => {
    const result = translate(
      new HTTPError(
        429,
        "Too Many Requests",
        "POST",
        "/channels/1/messages",
        BODY,
      ),
    );
    expect(result.error).toBe("rate_limited");
    expect(result.details?.httpStatus).toBe(429);
  });

  it("maps HTTP 502 to discord_api, not internal", () => {
    const result = translate(
      new HTTPError(502, "Bad Gateway", "GET", "/guilds/1", BODY),
    );
    expect(result.error).toBe("discord_api");
    expect(result.message).toContain("HTTP 502");
    expect(result.error).not.toBe("internal");
  });

  it("maps HTTP 401 to a token remediation", () => {
    const result = translate(
      apiError({ code: 0, message: "401" }, { status: 401 }),
    );
    expect(result.error).toBe("discord_api");
    expect(result.remediation).toContain("DISCORD_BOT_TOKEN");
  });

  it("maps HTTP 413 to invalid_input, not to the bug-report fallback", () => {
    // A proxy in front of Discord can return 413 with no JSON body, so there
    // is no code 40005 to catch it — without a status entry it landed on
    // "This is a bug in Warden … report it", which is wrong on both counts.
    const result = translate(
      new HTTPError(
        413,
        "Payload Too Large",
        "POST",
        "/channels/1/messages",
        BODY,
      ),
    );
    expect(result.error).toBe("invalid_input");
    expect(result.message).toContain("HTTP 413");
    expect(result.remediation).not.toMatch(/bug in Warden/);
  });

  it("falls back to discord_api for a status with no entry and <500", () => {
    const result = translate(
      new HTTPError(418, "I'm a teapot", "GET", "/x", BODY),
    );
    expect(result.error).toBe("discord_api");
    expect(result.details?.httpStatus).toBe(418);
  });
});

describe("toWardenError — rate limit details", () => {
  it("surfaces retry_after from the Discord body", () => {
    const result = translate(
      apiError(
        {
          code: 0,
          message: "You are being rate limited.",
          retry_after: 1.5,
          global: false,
        },
        {
          status: 429,
          method: "POST",
          url: "/channels/100000000000000004/messages",
        },
      ),
    );
    expect(result.error).toBe("rate_limited");
    expect(result.details?.retry_after).toBe(1.5);
    expect(result.details?.discordCode).toBe(0);
    expect(result.details?.route).toBe(
      "POST /channels/100000000000000004/messages",
    );
  });
});

describe("toWardenError — validation field flattening", () => {
  it("flattens a single top-level field error", () => {
    const result = translate(
      apiError({
        code: 50035,
        message: "Invalid Form Body",
        errors: {
          content: {
            _errors: [
              { code: "BASE_TYPE_REQUIRED", message: "This field is required" },
            ],
          },
        },
      }),
    );
    expect(result.error).toBe("invalid_input");
    expect(result.details?.fields).toEqual(["content: This field is required"]);
  });

  it("flattens nested arrays with indexed paths", () => {
    const result = translate(
      apiError({
        code: 50035,
        message: "Invalid Form Body",
        errors: {
          embeds: [
            {
              description: {
                _errors: [
                  {
                    code: "BASE_TYPE_MAX_LENGTH",
                    message: "Must be 4096 or fewer",
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(result.details?.fields).toEqual([
      "embeds[0].description: Must be 4096 or fewer",
    ]);
  });

  it("flattens a body-level error under (body)", () => {
    const result = translate(
      apiError({
        code: 50035,
        message: "Invalid Form Body",
        errors: {
          _errors: [{ code: "FORM_BODY_ERROR", message: "Bad request" }],
        },
      }),
    );
    expect(result.details?.fields).toEqual(["(body): Bad request"]);
  });

  it("omits details.fields when there are no field errors", () => {
    const result = translate(
      apiError({ code: 50035, message: "Invalid Form Body" }),
    );
    expect(result.details?.fields).toBeUndefined();
  });

  it("bounds a pathologically deep error tree instead of recursing forever", () => {
    let deep: unknown = { _errors: [{ code: "X", message: "deep" }] };
    for (let i = 0; i < 60; i += 1) deep = { nested: deep };
    const result = translate(
      apiError({
        code: 5035 as never,
        message: "Invalid Form Body",
        errors: deep,
      }),
    );
    // Exactly empty — `toEqual([])` rather than a loose upper bound, because an
    // *unbounded* walk still reports this tree (once, with a 60-segment path),
    // and `length < 12` would pass while MAX_FIELD_DEPTH was a no-op.
    const fields = result.details?.fields as string[] | undefined;
    expect(fields ?? []).toEqual([]);
    expect(result.error).toBe("invalid_input");
  });

  it("does report a tree nested just inside the depth cap", () => {
    // The complement: proves the cap is a *cap* and not an unconditional stop.
    // `walkFieldErrors` enters at depth 0, so 5 wrappers put `_errors` at
    // depth 5 — inside MAX_FIELD_DEPTH (8).
    let deep: unknown = { _errors: [{ code: "X", message: "too deep" }] };
    for (let i = 0; i < 5; i += 1) deep = { nested: deep };
    const result = translate(
      apiError({ code: 50035, message: "Invalid Form Body", errors: deep }),
    );
    const fields = result.details?.fields as string[];
    expect(fields).toHaveLength(1);
    // Five wrappers, so `_errors` sits at depth 5 — reported with the full
    // path but no `(body)` prefix, since the walk only reaches `(body)` when
    // the error group itself is at the top level.
    expect(fields[0]).toBe("nested.nested.nested.nested.nested: too deep");
  });

  it("stops after MAX_FIELD_ERRORS on a wide error tree", () => {
    const errors: Record<string, unknown> = {};
    for (let i = 0; i < 500; i += 1) {
      errors[`field${i}`] = { _errors: [{ code: "X", message: `bad ${i}` }] };
    }
    const result = translate(
      apiError({ code: 50035, message: "Invalid Form Body", errors }),
    );
    const fields = result.details?.fields as string[];
    expect(fields.length).toBe(25);
    expect(fields[0]).toBe("field0: bad 0");
  });

  it("applies the same cap when the wide tree is an array", () => {
    // The object-key case above never enters the array branch: `errors` as an
    // array walks with `[index]` paths and needs its own bound, or a Discord
    // response carrying a long array of bad entries walks all of them.
    const errors = Array.from({ length: 500 }, (_, i) => ({
      _errors: [{ code: "X", message: `bad ${i}` }],
    }));
    const result = translate(
      apiError({ code: 50035, message: "Invalid Form Body", errors }),
    );
    const fields = result.details?.fields as string[];
    expect(fields.length).toBe(25);
    expect(fields[0]).toBe("[0]: bad 0");
    expect(fields[24]).toBe("[24]: bad 24");
  });

  it("checks the breadth cap before reading each array entry", () => {
    // Output is byte-identical either way — the guard at the function head
    // stops the recursion at 25 regardless — so no assertion on `fields` can
    // see this. What differs is how many entries are read: 25 with the in-loop
    // check, 500 without it, scaling with array size. Counting numeric index
    // reads through a Proxy is therefore the only way to pin the ~90× claim
    // the comment at `errors.ts:340-342` makes.
    const backing = Array.from({ length: 500 }, (_, i) => ({
      _errors: [{ code: "X", message: `bad ${i}` }],
    }));
    // Construct the error BEFORE attaching the spy: @discordjs/rest's
    // DiscordAPIError flattens the entire tree once to compose its own
    // message, and those 500 reads belong to the library, not to Warden.
    // Attaching afterwards isolates the count to `walkFieldErrors` — move the
    // spy above the constructor and the number becomes 525 (the library's 500
    // plus Warden's 25) and proves nothing.
    const error = apiError({
      code: 50035,
      message: "Invalid Form Body",
      errors: backing,
    });
    let reads = 0;
    const spy = new Proxy(backing, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) reads += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    (error.rawError as { errors: unknown }).errors = spy;

    const fields = (translate(error).details?.fields ?? []) as string[];
    // 25 is MAX_FIELD_ERRORS (`errors.ts:323`), pinned as a literal the way
    // the neighbouring cap tests do — a change to the constant should fail
    // loudly here rather than silently re-tune itself.
    expect(fields).toHaveLength(25);
    expect(reads).toBe(25);
  });
});

describe("toWardenError — route sanitisation", () => {
  it("redacts the webhook token segment from details.route", () => {
    const result = translate(
      apiError(
        { code: 0, message: "Webhook failed" },
        {
          status: 404,
          method: "POST",
          url: "/webhooks/1052345678901234562/abcDEF123-ghiJKL456_mnoPQR789?wait=true",
        },
      ),
    );
    const route = String(result.details?.route);
    expect(route).toContain("/webhooks/1052345678901234562/[redacted-secret]");
    expect(route).toContain("wait=true");
    expect(route).not.toContain("abcDEF123");
    expect(route).not.toContain("ghiJKL456");
  });

  it("redacts the interaction token segment too", () => {
    const result = translate(
      apiError(
        { code: 0, message: "Interaction failed" },
        {
          status: 404,
          method: "POST",
          url: "/interactions/1052345678901234562/zzzYYY999-aaaBBB888-cccDDD777",
        },
      ),
    );
    expect(String(result.details?.route)).toContain("[redacted-secret]");
    expect(String(result.details?.route)).not.toContain("zzzYYY999");
  });

  it("leaves ordinary routes untouched", () => {
    const result = translate(
      apiError(
        { code: 0, message: "nope" },
        { status: 404, method: "GET", url: "/guilds/1/bans" },
      ),
    );
    expect(result.details?.route).toBe("GET /guilds/1/bans");
  });

  it("handles the absolute URL @discordjs/rest actually passes", () => {
    // @discordjs/rest hands over the fully resolved URL, not the relative
    // path — the earlier tests only covered the relative form.
    const result = translate(
      apiError(
        { code: 0, message: "nope" },
        {
          status: 404,
          method: "GET",
          url: "https://discord.com/api/v10/guilds/1/bans?limit=1000",
        },
      ),
    );
    expect(result.details?.route).toBe(
      "GET https://discord.com/api/v10/guilds/1/bans?limit=1000",
    );
  });

  it("redacts BEFORE truncating, so a token at the cut point cannot survive", () => {
    // Position the token so it straddles char 500. If the slice ran first,
    // only part of it would remain and TOKEN_LIKE's three-segment shape would
    // no longer match — leaking the head of the bot token. `details.route`
    // carries the METHOD prefix, which is part of the slice budget, so the
    // padding has to be measured from the full route: with the wrong padding
    // the old order leaks only part of the head and `not.toContain(head)`
    // passes while the leak is live.
    const routePrefix = "GET /guilds/1/channels/2/messages?x=";
    const head = TOKEN.slice(0, TOKEN.indexOf("."));
    const filler = "a".repeat(500 - routePrefix.length - head.length);
    const url = `${routePrefix.slice(4)}${filler}${TOKEN}`;
    const result = translate(
      apiError(
        { code: 0, message: "nope" },
        { status: 404, method: "GET", url },
      ),
    );
    const route = String(result.details?.route);
    expect(route.startsWith(routePrefix)).toBe(true);
    expect(route.length).toBeLessThanOrEqual(500);
    expect(route).not.toContain(head);
    expect(route).not.toContain(TOKEN);
    // Proves the scrub actually ran rather than that nothing merely leaked.
    expect(route).toContain("[redacted-token]");
  });
});

describe("toWardenError — token leakage", () => {
  it("masks a bot token echoed in Discord's message", () => {
    const result = translate(
      apiError(
        { code: 50014, message: `Invalid token provided: ${TOKEN}` },
        { status: 401, method: "GET", url: "/users/@me" },
      ),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).toContain("[redacted-token]");
  });

  it("masks a bot token echoed in a field error", () => {
    const result = translate(
      apiError(
        {
          code: 50035,
          message: "Invalid Form Body",
          errors: {
            content: {
              _errors: [{ code: "X", message: `bad ${TOKEN} value` }],
            },
          },
        },
        { status: 400 },
      ),
    );
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe("toWardenError — Warden's own errors", () => {
  it("re-redacts an existing WardenError instead of trusting it", () => {
    // Identity is deliberately given up: guards build these out of
    // Discord-supplied text, so nothing that arrives here is assumed clean.
    const original: WardenError = {
      ok: false,
      error: "role_hierarchy",
      message: "target above bot",
      remediation: "raise the role",
      discordCode: 50013,
    };
    const result = toWardenError(original);
    expect(result).toEqual(original);
    expect(result).not.toBe(original);
  });

  it("scrubs a token that a caller-supplied WardenError is carrying", () => {
    // TOKEN_LIKE is three dot-separated segments of 18+/4+/20+ chars, so the
    // fixture below is shaped like a real Discord token. Assembled like TOKEN
    // above rather than written out in one piece: GitHub push protection
    // matches that shape, and this is a synthetic value used to prove
    // redaction works — not a secret.
    const looseToken = `${Buffer.from("999999999999999998", "utf8").toString(
      "base64url",
    )}.GhIkLm.NpQrStUvWxYz0123456789abcdef`;
    const result = toWardenError({
      ok: false,
      error: "missing_permission",
      message: `could not post using ${TOKEN}`,
      remediation:
        "see https://discord.com/api/webhooks/1052345678901234562/abcDEF123ghiJKL456_mno",
      details: {
        reason: `audit log said ${looseToken}`,
        nested: { path: [looseToken] },
        count: 7,
      },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    // Webhook URLs are not bot-token shaped, so they need the path-shape scrub
    // as well as TOKEN_LIKE.
    expect(JSON.stringify(result)).not.toContain("abcDEF123ghiJKL456_mno");
    expect(result.remediation).toContain(
      "/webhooks/1052345678901234562/[redacted-secret]",
    );
    expect(JSON.stringify(result)).not.toContain(
      looseToken.slice(0, looseToken.indexOf(".")),
    );
    // Non-string leaves survive untouched.
    expect(result.details?.count).toBe(7);
  });

  it("scrubs Discord-supplied names in EVERY field, not just message", () => {
    // The regression this guards: the passthrough used to re-scrub only
    // `message`/`remediation`/`details`, leaving `bot.role`, `target.role` and
    // `missingPermissions` — precisely where guards put role and member names
    // — exactly as the caller supplied them.
    const result = toWardenError({
      ok: false,
      error: "role_hierarchy",
      message: "target above bot",
      remediation: "raise the role",
      missingPermissions: [TOKEN],
      bot: { role: TOKEN, position: 3 },
      target: { role: TOKEN, position: 9 },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(result.missingPermissions).toEqual(["[redacted-token]"]);
    expect(result.bot).toEqual({ role: "[redacted-token]", position: 3 });
    expect(result.target).toEqual({ role: "[redacted-token]", position: 9 });
    // Structured fields survive the rebuild intact.
    expect(result.ok).toBe(false);
    expect(result.error).toBe("role_hierarchy");
  });

  it("replaces a container past the depth cap rather than emitting it raw", () => {
    // The cap must bound traversal, never exempt content: returning the raw
    // object at depth 6 would print every string inside it unscrubbed.
    let deep: unknown = { token: TOKEN };
    for (let level = 0; level < 8; level += 1)
      deep = { [`level${level}`]: deep };
    const result = toWardenError({
      ok: false,
      error: "internal",
      message: "x",
      remediation: "y",
      details: deep as Record<string, unknown>,
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).toContain("[depth-limit]");
  });

  it("keeps Date and Error leaves readable instead of collapsing them to {}", () => {
    // `Object.entries` on either class yields nothing useful — an Error's
    // `message`/`stack` are own-but-non-enumerable and a Date's value is a
    // getter — so both used to rebuild as an empty object.
    const result = toWardenError({
      ok: false,
      error: "internal",
      message: "x",
      remediation: "y",
      details: {
        at: new Date("2024-05-06T07:08:09.000Z"),
        invalidDate: new Date("nope"),
        broken: new Error(`bad ${TOKEN}`),
      },
    });
    expect(result.details?.at).toBe("2024-05-06T07:08:09.000Z");
    expect(result.details?.invalidDate).toBeNull();
    expect(result.details?.broken).toEqual({
      name: "Error",
      message: "bad [redacted-token]",
      stack: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("maps WardenNotReadyError → not_ready", () => {
    const result = toWardenError(
      new WardenNotReadyError("gateway not connected"),
    );
    expect(result.error).toBe("not_ready");
    expect(result.message).toBe("gateway not connected");
    expect(result.remediation).toContain("get_bot_status");
  });

  it("maps discord.js TokenInvalid → discord_api with token remediation", () => {
    const error = new Error("An invalid token was provided.") as Error & {
      code?: string;
    };
    // discord.js sets `name = "DiscordjsError [TokenInvalid]"`, not the bare
    // kind — a fixture that used the fictional shape would pin a string the
    // library never emits.
    error.name = "DiscordjsError [TokenInvalid]";
    error.code = "TokenInvalid";
    const result = toWardenError(error);
    expect(result.error).toBe("discord_api");
    expect(result.remediation).toContain("DISCORD_BOT_TOKEN");
    expect(result.details?.name).toBe("DiscordjsError [TokenInvalid]");
  });

  it("reaches the branch by name suffix alone when the error has no code", () => {
    // The condition is `code === "TokenInvalid" || name.endsWith(…)`; every
    // other TokenInvalid test sets both, so the `||` short-circuits and the
    // suffix alternative is never evaluated. Real discord.js errors do carry
    // `code`, but an Error carrying only the name must still be recognised —
    // set `code` to nothing here and this is the only path through.
    const error = new Error("An invalid token was provided.");
    error.name = "DiscordjsError [TokenInvalid]";
    const result = toWardenError(error);
    expect(result.error).toBe("discord_api");
    expect(result.remediation).toContain("DISCORD_BOT_TOKEN");
    expect(result.details?.name).toBe("DiscordjsError [TokenInvalid]");
  });

  it("maps a plain Error → internal and never claims it is Discord's", () => {
    const result = toWardenError(new Error("something exploded"));
    expect(result.error).toBe("internal");
    expect(result.message).toContain("something exploded");
    expect(result.remediation).toContain("bug in Warden");
    expect(result.details?.name).toBe("Error");
    expect(typeof result.details?.stack).toBe("string");
  });

  it("scrubs a token out of error.name in the TokenInvalid arm", () => {
    // `details.name` is emitted straight from an Error's own property, so the
    // `scrub()` there is load-bearing. The fixtures in the neighbouring tests
    // use clean names ("DiscordjsError [TokenInvalid]", "Error") and pass even
    // if the call is deleted. This one reaches the branch through `code`; the
    // `name.endsWith("[TokenInvalid]")` alternative is pinned separately above.
    const error = new Error("An invalid token was provided.") as Error & {
      code?: string;
    };
    error.name = `${TOKEN}[TokenInvalid]`;
    error.code = "TokenInvalid";
    const result = toWardenError(error);
    expect(result.error).toBe("discord_api");
    expect(result.details?.name).toBe("[redacted-token][TokenInvalid]");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("scrubs a token out of error.name in the generic internal arm", () => {
    // Same for the second emission site; the stack below carries the name too,
    // so this also proves `details.stack` is scrubbed independently.
    const error = new Error("boom");
    error.name = `Woof ${TOKEN}`;
    const result = toWardenError(error);
    expect(result.error).toBe("internal");
    expect(result.details?.name).toBe("Woof [redacted-token]");
    expect(JSON.stringify(result.details?.stack)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("scrubs a stack BEFORE truncating it, so a token at the cut cannot survive", () => {
    // This pins the `internal` arm's stack; `redactDeep`'s Error branch had
    // the identical bug and is pinned by its own test just below. Both used to
    // slice first, which is the exact trap `sanitizeRoute()` documents: cutting
    // a token in half pushes its head below TOKEN_LIKE's {18,} floor, so the
    // regex misses it and the fragment is emitted raw. Pad so the token sits at
    // ~char 1977 — inside the 2000 cut, and long enough that the surviving
    // fragment would be recognisable.
    const error = new Error("boom");
    error.stack = `E ${"x".repeat(1975)}${TOKEN}TAIL`;
    const result = toWardenError(error);
    expect(result.error).toBe("internal");
    const stack = String(result.details?.stack);
    expect(stack.length).toBeLessThanOrEqual(2000);
    expect(stack).not.toContain(TOKEN.slice(0, 20));
    expect(stack).not.toContain(TOKEN);
    // Proves the scrub ran rather than that nothing merely leaked.
    expect(stack).toContain("[redacted-token]");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("scrubs a nested Error's stack BEFORE truncating it too", () => {
    // The sibling of the `internal`-arm test below: both stack emissions had
    // the same slice-then-scrub bug, and this one is only reachable through a
    // caller-supplied WardenError carrying an Error in `details`, so it needs
    // its own fixture rather than a `new Error` thrown at the top level.
    const inner = new Error("boom");
    inner.stack = `E ${"x".repeat(1975)}${TOKEN}TAIL`;
    const result = toWardenError({
      ok: false,
      error: "internal",
      message: "x",
      remediation: "y",
      details: { broken: inner } as Record<string, unknown>,
    });
    const stack = String(
      (result.details?.broken as { stack?: string } | undefined)?.stack,
    );
    expect(stack.length).toBeLessThanOrEqual(2000);
    // Fails on the surviving 20-char head, not merely on length.
    expect(stack).not.toContain(TOKEN.slice(0, 20));
    expect(stack).toContain("[redacted-token]");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("maps a thrown non-Error value → internal", () => {
    const result = toWardenError("just a string");
    expect(result.error).toBe("internal");
    expect(result.message).toContain("just a string");
    expect(result.details?.name).toBeUndefined();
  });

  it("maps a non-Error with a token-shaped message to internal without leaking it", () => {
    const result = toWardenError(`${TOKEN} exploded`);
    expect(result.error).toBe("internal");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
