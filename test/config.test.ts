import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  deriveApplicationId,
  loadConfig,
  loadConfigOrExit,
} from "../src/config.js";

const BOT_ID = "1052345678901234562";
/** Realistic-looking but fake token — used only to prove it never leaks. */
const TOKEN = `${Buffer.from(BOT_ID, "utf8").toString("base64url")}.GhIkLm.NpQrStUvWxYz0123456789abcdefghijklmnop`;

function env(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return { DISCORD_BOT_TOKEN: TOKEN, ...overrides };
}

function issuesFrom(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return [...error.issues];
    throw error;
  }
  throw new Error("expected loadConfig to throw ConfigError");
}

describe("loadConfig", () => {
  it("parses a minimal valid env and applies defaults", () => {
    const config = loadConfig(env());
    expect(config.DISCORD_BOT_TOKEN).toBe(TOKEN);
    expect(config.WARDEN_MAX_EVENTS).toBe(2000);
    expect(config.WARDEN_MAX_WATCHES).toBe(20);
    expect(config.WARDEN_LOG_LEVEL).toBe("warn");
    expect(config.WARDEN_DRY_RUN).toBe(false);
    expect(config.WARDEN_GUILD_ID).toBeUndefined();
  });

  it("derives DISCORD_APPLICATION_ID from the token (plan §4 default)", () => {
    expect(loadConfig(env()).DISCORD_APPLICATION_ID).toBe(BOT_ID);
    expect(deriveApplicationId(TOKEN)).toBe(BOT_ID);
    expect(deriveApplicationId("not-a-token")).toBeUndefined();
    expect(deriveApplicationId("")).toBeUndefined();
  });

  it("lets an explicit DISCORD_APPLICATION_ID win over derivation", () => {
    const explicit = "987654321098765432";
    expect(
      loadConfig(env({ DISCORD_APPLICATION_ID: explicit }))
        .DISCORD_APPLICATION_ID,
    ).toBe(explicit);
  });

  it("strips unknown environment keys", () => {
    const config = loadConfig(
      env({ PATH: "/usr/bin", HOME: "/home/codespace" }),
    );
    expect(Object.keys(config).sort()).toEqual([
      "DISCORD_APPLICATION_ID",
      "DISCORD_BOT_TOKEN",
      "WARDEN_DRY_RUN",
      "WARDEN_LOG_LEVEL",
      "WARDEN_MAX_EVENTS",
      "WARDEN_MAX_WATCHES",
    ]);
  });

  it("fails fast when DISCORD_BOT_TOKEN is missing", () => {
    const issues = issuesFrom(() => loadConfig({}));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("DISCORD_BOT_TOKEN");
    expect(issues[0]).toContain("MCP client config");
  });

  it("rejects a whitespace-only token and trims a padded one", () => {
    const blank = issuesFrom(() => loadConfig({ DISCORD_BOT_TOKEN: "   " }));
    expect(blank).toHaveLength(1);
    expect(blank[0]).toContain("DISCORD_BOT_TOKEN");
    expect(blank[0]).toContain("is required");
    // padded token is trimmed, not forwarded verbatim to Discord login (401 bait)
    expect(
      loadConfig(env({ DISCORD_BOT_TOKEN: `  ${TOKEN}\n` })).DISCORD_BOT_TOKEN,
    ).toBe(TOKEN);
  });

  it("never echoes a token-shaped value pasted into the wrong variable", () => {
    // Assembled like TOKEN above: GitHub push protection matches the Discord
    // bot-token shape, and this is a synthetic value, not a secret.
    const otherToken = `${Buffer.from(
      "abcdefghijklmnopqrstuvwxyz123456",
      "utf8",
    ).toString("base64url")}.QUJDREU.FmdoaWprbG1ub3BxcnN0dXZ3eHl6YWJjZGVmZ2g`;
    const issues = issuesFrom(() =>
      loadConfig(env({ WARDEN_MAX_EVENTS: otherToken })),
    );
    expect(issues[0]).toContain("WARDEN_MAX_EVENTS");
    expect(issues.join("\n")).not.toContain(otherToken);
  });

  it("never echoes the token value in a failure message", () => {
    const issues = issuesFrom(() =>
      loadConfig(env({ WARDEN_LOG_LEVEL: "loud" })),
    );
    const text = issues.join("\n");
    expect(text).toContain("WARDEN_LOG_LEVEL");
    expect(text).not.toContain(TOKEN);
  });

  it("assembles a redacted, actionable ConfigError.message (no stack dump)", () => {
    try {
      loadConfig(env({ WARDEN_LOG_LEVEL: "loud" }));
      expect.fail("loadConfig should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain("WARDEN_LOG_LEVEL");
      expect(message).toContain("README.md");
      expect(message).not.toContain(TOKEN);
      expect(message).not.toMatch(/\n\s+at /); // no stack frames
    }
  });

  it("validates snowflake ids", () => {
    expect(
      issuesFrom(() => loadConfig(env({ WARDEN_GUILD_ID: "abc" })))[0],
    ).toContain("WARDEN_GUILD_ID");
    expect(
      loadConfig(env({ WARDEN_GUILD_ID: "123456789012345678" }))
        .WARDEN_GUILD_ID,
    ).toBe("123456789012345678");
  });

  it("trims pasted whitespace around ids and level names", () => {
    expect(
      loadConfig(env({ WARDEN_GUILD_ID: " 123456789012345678 " }))
        .WARDEN_GUILD_ID,
    ).toBe("123456789012345678");
    expect(
      loadConfig(env({ WARDEN_LOG_LEVEL: " WARN " })).WARDEN_LOG_LEVEL,
    ).toBe("warn");
    expect(loadConfig(env({ WARDEN_LOG_LEVEL: "Info" })).WARDEN_LOG_LEVEL).toBe(
      "info",
    );
  });

  it("treats empty strings as unset (client configs often pass VAR=)", () => {
    const config = loadConfig(
      env({ WARDEN_GUILD_ID: "", DISCORD_APPLICATION_ID: "" }),
    );
    expect(config.WARDEN_GUILD_ID).toBeUndefined();
    // blank explicit id falls back to the derived one
    expect(config.DISCORD_APPLICATION_ID).toBe(BOT_ID);
  });

  it("coerces numeric vars and enforces bounds", () => {
    expect(
      loadConfig(env({ WARDEN_MAX_EVENTS: "500" })).WARDEN_MAX_EVENTS,
    ).toBe(500);
    expect(
      issuesFrom(() => loadConfig(env({ WARDEN_MAX_EVENTS: "0" })))[0],
    ).toContain("WARDEN_MAX_EVENTS");
    expect(
      issuesFrom(() => loadConfig(env({ WARDEN_MAX_EVENTS: "lots" })))[0],
    ).toContain("WARDEN_MAX_EVENTS");
    // ring buffer must stay a sane memory footprint
    expect(
      issuesFrom(() => loadConfig(env({ WARDEN_MAX_EVENTS: "100001" })))[0],
    ).toContain("WARDEN_MAX_EVENTS");
  });

  it("coerces WARDEN_DRY_RUN from common boolean spellings", () => {
    expect(loadConfig(env({ WARDEN_DRY_RUN: "true" })).WARDEN_DRY_RUN).toBe(
      true,
    );
    expect(loadConfig(env({ WARDEN_DRY_RUN: "1" })).WARDEN_DRY_RUN).toBe(true);
    expect(loadConfig(env({ WARDEN_DRY_RUN: "yes" })).WARDEN_DRY_RUN).toBe(
      true,
    );
    expect(loadConfig(env({ WARDEN_DRY_RUN: "off" })).WARDEN_DRY_RUN).toBe(
      false,
    );
    const issues = issuesFrom(() =>
      loadConfig(env({ WARDEN_DRY_RUN: "maybe" })),
    );
    expect(issues[0]).toContain("WARDEN_DRY_RUN");
  });

  it("reports every problem at once, not just the first", () => {
    const issues = issuesFrom(() =>
      loadConfig({
        DISCORD_BOT_TOKEN: TOKEN,
        WARDEN_GUILD_ID: "nope",
        WARDEN_MAX_WATCHES: "-3",
        WARDEN_LOG_LEVEL: "loud",
      }),
    );
    expect(issues).toHaveLength(3);
    expect(issues.join("\n")).toContain("WARDEN_GUILD_ID");
    expect(issues.join("\n")).toContain("WARDEN_MAX_WATCHES");
    expect(issues.join("\n")).toContain("WARDEN_LOG_LEVEL");
  });
});

describe("loadConfigOrExit", () => {
  let stderrLines: string[];
  let stdoutLines: string[];

  beforeEach(() => {
    stderrLines = [];
    stdoutLines = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints a clear redacted message to stderr, never stdout, and exits 1", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    loadConfigOrExit(env({ WARDEN_LOG_LEVEL: "loud" }));

    expect(exitSpy).toHaveBeenCalledWith(1);
    const text = stderrLines.join("");
    expect(text).toContain("WARDEN_LOG_LEVEL");
    expect(text).toContain("README.md");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toMatch(/\n\s+at /); // no stack trace dump
    expect(stdoutLines.join("")).toBe(""); // stdout is the JSON-RPC channel
  });

  it("handles a fully missing env without a stack dump", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    loadConfigOrExit({});

    expect(exitSpy).toHaveBeenCalledWith(1);
    const text = stderrLines.join("");
    expect(text).toContain("DISCORD_BOT_TOKEN");
    expect(text).not.toMatch(/\n\s+at /); // no stack trace dump
    expect(stdoutLines.join("")).toBe("");
  });
});
