import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKEN_LIKE, createLogger, redact } from "../src/logger.js";

const BOT_ID = "1052345678901234562";
const TOKEN = `${Buffer.from(BOT_ID, "utf8").toString("base64url")}.GhIkLm.NpQrStUvWxYz0123456789abcdefghijklmnop`;

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => void lines.push(line) };
}

describe("createLogger", () => {
  it("writes one JSON line per event to the sink", () => {
    const sink = capture();
    const logger = createLogger("info", sink.write);
    logger.warn("gateway reconnecting", { attempt: 2 });

    expect(sink.lines).toHaveLength(1);
    const parsed = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    expect(parsed.level).toBe("warn");
    expect(parsed.msg).toBe("gateway reconnecting");
    expect(parsed.attempt).toBe(2);
    expect(typeof parsed.ts).toBe("string");
  });

  it("gates on level: info is suppressed at warn", () => {
    const sink = capture();
    const logger = createLogger("warn", sink.write);
    logger.info("quiet");
    logger.debug("quieter");
    logger.error("loud");
    expect(sink.lines).toHaveLength(1);
    expect((JSON.parse(sink.lines[0]!) as { level: string }).level).toBe(
      "error",
    );
  });

  it("keeps the envelope authoritative: fields cannot spoof level/msg/ts", () => {
    const sink = capture();
    createLogger("error", sink.write).error("REAL MESSAGE", {
      level: "debug",
      msg: "SPOOFED",
      ts: "nope",
    });
    const parsed = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    expect(parsed.level).toBe("error");
    expect(parsed.msg).toBe("REAL MESSAGE");
    expect(parsed.ts).not.toBe("nope");
  });

  it("redacts secrets by field name and token-shaped values in text", () => {
    const sink = capture();
    const logger = createLogger("error", sink.write);
    logger.error("discord rejected us", {
      DISCORD_BOT_TOKEN: TOKEN,
      authorization: "Bearer abc",
      note: `retrying with ${TOKEN}`,
    });

    const line = sink.lines[0]!;
    expect(line).not.toContain(TOKEN);
    expect(line).toContain("[redacted");
    expect(line).toContain("discord rejected us");
    // still valid JSON with the useful bits intact
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.DISCORD_BOT_TOKEN).toBe("[redacted]");
  });

  it("masks private keys and bearer credentials by field name", () => {
    const sink = capture();
    createLogger("error", sink.write).error("keys", {
      privateKey: "super-secret-value",
      bearer: "abc.def.ghi",
    });
    const line = sink.lines[0]!;
    expect(line).not.toContain("super-secret-value");
    expect(line).not.toContain("abc.def.ghi");
    expect(line).toContain("[redacted]");
  });

  it("redacts tokens inside Error messages and stacks", () => {
    const sink = capture();
    const err = new Error(`discord 401 for ${TOKEN}`);
    createLogger("error", sink.write).error("failed", { err });

    const line = sink.lines[0]!;
    expect(line).not.toContain(TOKEN);
    const parsed = JSON.parse(line) as {
      err: { name: string; message: string };
    };
    expect(parsed.err.name).toBe("Error");
    expect(parsed.err.message).toContain("[redacted-token]");
  });

  it("merges child fields into every line", () => {
    const sink = capture();
    const logger = createLogger("info", sink.write).child({
      guildId: "123456789012345678",
      level: "child-spoof",
    });
    logger.info("hello", { msg: "field-spoof" });
    const parsed = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    expect(parsed.guildId).toBe("123456789012345678");
    // neither child() baseFields nor per-call fields may rewrite the envelope
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello");
  });

  it("serializes a shared (non-cyclic) object both times, not just the first", () => {
    const sink = capture();
    const shared = { x: 1 };
    createLogger("debug", sink.write).debug("dup", { a: shared, b: shared });
    const parsed = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    expect(parsed.a).toEqual({ x: 1 });
    expect(parsed.b).toEqual({ x: 1 });
  });

  it("does not blow up on circular or BigInt fields", () => {
    const sink = capture();
    const logger = createLogger("debug", sink.write);
    const circular: Record<string, unknown> = { id: 1n };
    circular.self = circular;
    expect(() => logger.debug("loop", { circular })).not.toThrow();
    expect(sink.lines).toHaveLength(1);
    expect(() => JSON.parse(sink.lines[0]!)).not.toThrow();
  });

  it("emits valid JSON for sparse arrays (holes become null)", () => {
    const sink = capture();
    const sparse = new Array<unknown>(3);
    sparse[1] = 1;
    createLogger("error", sink.write).error("sparse", { sparse });
    const parsed = JSON.parse(sink.lines[0]!) as { sparse: unknown[] };
    expect(parsed.sparse).toEqual([null, 1, null]);
  });

  it("loses one field, not the whole line, when a getter throws", () => {
    const sink = capture();
    const booby = {
      ok: "kept",
      get boom(): string {
        throw new Error("getter exploded");
      },
    };
    createLogger("error", sink.write).error("discord 401 for guild X", {
      booby,
    });

    const parsed = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    expect(parsed.level).toBe("error");
    expect(parsed.msg).toBe("discord 401 for guild X"); // line keeps the truth
    const boobyField = parsed.booby as Record<string, unknown>;
    expect(boobyField.ok).toBe("kept");
    expect(boobyField.boom).toBe("[unserializable]");
  });

  it("truncates huge strings instead of stalling on the token regex", () => {
    const sink = capture();
    const huge = "A".repeat(50_000);
    createLogger("debug", sink.write).debug("blob", { huge });
    expect(sink.lines).toHaveLength(1);
    const parsed = JSON.parse(sink.lines[0]!) as { huge: string };
    expect(parsed.huge.length).toBeLessThan(50_000);
    expect(parsed.huge).toContain("[truncated");
  });

  it("never emits any part of a token straddling the truncation cut", () => {
    const sink = capture();
    // token starts before the 8192 cut (8150/8182/8191), after it (8200 —
    // the preceding base64url run absorbs into seg1, so the regex match
    // itself still begins before the cut), and at 8215 where the near-cut
    // marker overhangs the cut and redact()'s output clip kicks in
    for (const start of [8150, 8182, 8191, 8200, 8215]) {
      const value = "x".repeat(start) + TOKEN + "y".repeat(20_000);
      createLogger("error", sink.write).error("straddle", { value });
      const line = sink.lines[sink.lines.length - 1]!;
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(TOKEN.split(".")[0]!); // no raw prefix fragment
      // clip contract: kept text ≤ 8192, only the short truncated-suffix adds on
      const parsed = JSON.parse(line) as { value: string };
      expect(parsed.value).toContain("[truncated");
      expect(parsed.value.length).toBeLessThanOrEqual(8192 + 40);
    }
  });

  it("redacts token-shaped field names", () => {
    const sink = capture();
    const weird: Record<string, unknown> = {};
    weird[TOKEN] = 1;
    createLogger("error", sink.write).error("keys", { weird });
    const line = sink.lines[0]!;
    expect(line).not.toContain(TOKEN);
    expect(line).toContain("[redacted-token]");
  });

  it("omits a key whose toJSON returns undefined (JSON.stringify parity)", () => {
    const sink = capture();
    createLogger("error", sink.write).error("t", {
      gone: { toJSON: () => undefined },
    });
    const parsed = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    expect("gone" in parsed).toBe(false);
  });

  it("caps array breadth instead of OOMing on a huge array", () => {
    const sink = capture();
    const big = new Array<string>(5000).fill("a");
    createLogger("error", sink.write).error("big", { big });
    const parsed = JSON.parse(sink.lines[0]!) as { big: unknown[] };
    expect(parsed.big.length).toBe(2001); // 2000 kept + trailing count marker
    expect(String(parsed.big[2000])).toContain("more items");
  });

  it("keeps array siblings when one element's getter throws", () => {
    const sink = capture();
    const arr: unknown[] = ["first"];
    // getter on a real *index* (JSON only walks index properties)
    Object.defineProperty(arr, 1, {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("nope");
      },
    });
    arr[2] = "last";
    createLogger("error", sink.write).error("arr", { arr });
    const parsed = JSON.parse(sink.lines[0]!) as { arr: unknown[] };
    expect(parsed.arr[0]).toBe("first");
    expect(parsed.arr[1]).toBe("[unserializable]");
    expect(parsed.arr[2]).toBe("last");
  });

  it("emits nothing below its level", () => {
    const sink = capture();
    const logger = createLogger("error", sink.write);
    logger.info("no");
    logger.warn("no");
    logger.debug("no");
    expect(sink.lines).toHaveLength(0);
  });

  it("default sink writes to stderr only — stdout is the JSON-RPC channel", () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as never);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as never);

    createLogger("error").error("boom", { DISCORD_BOT_TOKEN: TOKEN });

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
    const line = String(stderrSpy.mock.calls[0]?.[0]);
    expect(line).toContain("boom");
    expect(line).not.toContain(TOKEN);
    vi.restoreAllMocks();
  });
});

describe("redact", () => {
  it("masks token-shaped substrings", () => {
    expect(redact(`bad gateway for ${TOKEN} sorry`)).toBe(
      "bad gateway for [redacted-token] sorry",
    );
  });

  it("leaves ordinary text untouched", () => {
    expect(redact("channel 123456789012345678 is fine")).toBe(
      "channel 123456789012345678 is fine",
    );
  });

  it("handles 100 KB of opaque text fast and cut (wall-clock guard)", () => {
    // Catches catastrophic blowups in THIS path (e.g. exponential backtracking,
    // or unbounded quantifiers + a dropped pre-match cut ≈ 34 s). Honest scope:
    // it does NOT catch dropping the pre-cut alone (~47 ms with today's
    // bounded quantifiers) nor widening quantifiers alone (~224 ms over the
    // 8352-char scan window) — those two are pinned structurally instead:
    // see the TOKEN_LIKE quantifier test and TOKEN_MAX_LEN coupling.
    const started = performance.now();
    const result = redact("A".repeat(100_000));
    const elapsed = performance.now() - started;
    expect(result).toContain("[truncated");
    expect(result.length).toBeLessThan(9000);
    expect(elapsed).toBeLessThan(500);
  });

  it("keeps TOKEN_LIKE quantifiers bounded (quadratic-backtracking guard)", () => {
    // `{n,}` unbounded quantifiers backtrack quadratically on opaque base64.
    // This is the structural enforcement the wall-clock test can't provide.
    expect(TOKEN_LIKE.source).not.toMatch(/\{\d+,\}/);
    expect(TOKEN_LIKE.source).toMatch(/\{\d+,\d+\}/); // sanity: bounds exist
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
