import type { Client } from "discord.js";
import { Events, GatewayIntentBits, Partials, Status } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  createWardenDiscord,
  PRIVILEGED_INTENTS,
  WARDEN_INTENT_NAMES,
  WARDEN_INTENTS,
  WARDEN_PARTIALS,
} from "../src/discord/client.js";
import { toWardenError, WardenNotReadyError } from "../src/discord/errors.js";
import { createLogger, type Logger } from "../src/logger.js";

const BOT_ID = "1052345678901234562";
/** Realistic-looking but fake token — used only to prove it never leaks. */
const TOKEN = `${Buffer.from(BOT_ID, "utf8").toString("base64url")}.GhIkLm.NpQrStUvWxYz0123456789abcdefghijklmnop`;

/** Collects every log line instead of writing to stderr. */
function collectingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger("debug", (line) => lines.push(line)), lines };
}

function silentLogger(): Logger {
  return createLogger("error", () => {});
}

/** The exact list plan §7.1 spells out, in the plan's own order. */
const PLAN_INTENT_NAMES = [
  "Guilds",
  "GuildMembers",
  "GuildModeration",
  "GuildExpressions",
  "GuildIntegrations",
  "GuildWebhooks",
  "GuildInvites",
  "GuildVoiceStates",
  "GuildPresences",
  "GuildMessages",
  "GuildMessageReactions",
  "GuildMessageTyping",
  "DirectMessages",
  "DirectMessageReactions",
  "DirectMessageTyping",
  "MessageContent",
  "GuildScheduledEvents",
  "AutoModerationConfiguration",
  "AutoModerationExecution",
  "GuildMessagePolls",
  "DirectMessagePolls",
] as const;

describe("WARDEN_INTENTS (plan §7.1)", () => {
  it("enables every intent the plan lists, in the plan's order", () => {
    expect(WARDEN_INTENT_NAMES).toEqual([...PLAN_INTENT_NAMES]);
    expect(WARDEN_INTENT_NAMES).toHaveLength(21);
  });

  it("contains no duplicate intent bits", () => {
    // The gateway rejects a duplicated bit outright — and two of the plan's
    // names (GuildBans, GuildEmojisAndStickers) ARE aliases of bits we already
    // send, so "just add what the plan says" would break identify().
    expect(new Set(WARDEN_INTENTS).size).toBe(WARDEN_INTENTS.length);
  });

  it("keeps the deprecated aliases out", () => {
    expect(WARDEN_INTENT_NAMES).not.toContain("GuildBans");
    expect(WARDEN_INTENT_NAMES).not.toContain("GuildEmojisAndStickers");
    // Proof they really are aliases (same bit) rather than separate intents…
    expect(GatewayIntentBits.GuildBans).toBe(GatewayIntentBits.GuildModeration);
    expect(GatewayIntentBits.GuildEmojisAndStickers).toBe(
      GatewayIntentBits.GuildExpressions,
    );
    // …and that the canonical name wins the bit→name mapping.
    expect(WARDEN_INTENT_NAMES).toContain("GuildModeration");
    expect(WARDEN_INTENT_NAMES).toContain("GuildExpressions");
  });

  it("resolves every bit to a canonical name", () => {
    for (const name of WARDEN_INTENT_NAMES) {
      expect(name).not.toMatch(/^unknown\(/);
    }
  });

  it("sends exactly the three privileged intents the portal must toggle", () => {
    expect([...PRIVILEGED_INTENTS]).toEqual([
      "GuildMembers",
      "GuildPresences",
      "MessageContent",
    ]);
    for (const name of PRIVILEGED_INTENTS) {
      expect(WARDEN_INTENT_NAMES).toContain(name);
    }
  });
});

describe("WARDEN_PARTIALS", () => {
  it("enables all ten partial types with no duplicates", () => {
    expect(WARDEN_PARTIALS).toHaveLength(10);
    expect(new Set(WARDEN_PARTIALS).size).toBe(WARDEN_PARTIALS.length);
    expect([...WARDEN_PARTIALS]).toEqual([
      Partials.User,
      Partials.Channel,
      Partials.GuildMember,
      Partials.Message,
      Partials.Reaction,
      Partials.GuildScheduledEvent,
      Partials.ThreadMember,
      Partials.SoundboardSound,
      Partials.Poll,
      Partials.PollAnswer,
    ]);
  });
});

describe("discord.js client wiring", () => {
  it("passes the intents and partials straight through to the discord.js client", () => {
    const warden = createWardenDiscord(silentLogger());
    expect([...(warden.client.options.partials ?? [])]).toEqual([
      ...WARDEN_PARTIALS,
    ]);
    // Exactly the union of WARDEN_INTENTS — nothing added, nothing dropped.
    // (IntentsBitField's Type is `number`; every intent bit fits under 2^31.)
    const expectedBitfield = WARDEN_INTENTS.reduce((sum, bit) => sum | bit, 0);
    expect(warden.client.options.intents.bitfield).toBe(expectedBitfield);
    for (const bit of WARDEN_INTENTS) {
      expect(warden.client.options.intents.has(bit)).toBe(true);
    }
  });
});

describe("status() before login", () => {
  it("never reports ready, ping, or a user it doesn't have", () => {
    const warden = createWardenDiscord(silentLogger());
    const status = warden.status();
    expect(status.ready).toBe(false);
    expect(warden.isReady()).toBe(false);
    expect(status.wsStatus).toBe("Idle");
    // discord.js reports NaN ping before the first connect — null, not NaN,
    // is what reaches the agent.
    expect(status.wsPingMs).toBeNull();
    expect(status.readyAt).toBeNull();
    expect(status.guildCount).toBe(0);
    expect(status.user).toBeNull();
    expect(status.reconnects).toBe(0);
    expect(status.disconnects).toBe(0);
    expect(status.lastCloseCode).toBeNull();
  });

  it("keeps the token off the wrapper entirely", () => {
    const warden = createWardenDiscord(silentLogger());
    expect(Object.keys(warden).sort()).toEqual([
      "client",
      "destroy",
      "isReady",
      "login",
      "status",
      "waitForReady",
    ]);
    expect(JSON.stringify(warden.status())).not.toMatch(/token/i);
  });
});

describe("waitForReady()", () => {
  it("rejects with WardenNotReadyError once the timeout elapses", async () => {
    const warden = createWardenDiscord(silentLogger());
    await expect(warden.waitForReady(15)).rejects.toBeInstanceOf(
      WardenNotReadyError,
    );
  });

  it("names the timeout in the message and maps to the not_ready kind", async () => {
    const warden = createWardenDiscord(silentLogger());
    const error = await warden
      .waitForReady(15)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WardenNotReadyError);
    expect((error as Error).message).toContain("15 ms");
    const wardenError = toWardenError(error);
    expect(wardenError.error).toBe("not_ready");
    expect(wardenError.remediation).toContain("get_bot_status");
  });

  it("resolves immediately when the client is already ready", async () => {
    const warden = createWardenDiscord(silentLogger());
    warden.client.ws.status = Status.Ready;
    expect(warden.isReady()).toBe(true);
    await expect(warden.waitForReady(10_000)).resolves.toBeUndefined();
  });

  it("resolves when discord.js emits clientReady", async () => {
    const { logger } = collectingLogger();
    const warden = createWardenDiscord(logger);
    const waiting = warden.waitForReady(10_000);

    // Mirror WebSocketManager.triggerClientReady(): manager status first,
    // then readyTimestamp, then the event — that is the order discord.js
    // itself uses, so `waitForReady()` resolving implies `isReady()`.
    const readyClient = warden.client as unknown as Client<true>;
    warden.client.ws.status = Status.Ready;
    readyClient.readyTimestamp = Date.now();
    warden.client.emit(Events.ClientReady, readyClient);

    await expect(waiting).resolves.toBeUndefined();
    const status = warden.status();
    expect(status.ready).toBe(true);
    expect(status.wsStatus).toBe("Ready");
    expect(status.readyAt).toBeTypeOf("string");
    expect(() => new Date(status.readyAt ?? "").toISOString()).not.toThrow();
  });

  it("rejects pending waiters when the client is destroyed", async () => {
    const warden = createWardenDiscord(silentLogger());
    const waiting = warden.waitForReady(30_000);
    await warden.destroy();
    await expect(waiting).rejects.toBeInstanceOf(WardenNotReadyError);
  });

  it("rejects new waiters after destroy without waiting for a timeout", async () => {
    const warden = createWardenDiscord(silentLogger());
    await warden.destroy();
    const started = Date.now();
    await expect(warden.waitForReady(30_000)).rejects.toBeInstanceOf(
      WardenNotReadyError,
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("fails a wait immediately when login fails, instead of burning its timeout", async () => {
    // discord.js calls `destroy()` internally when login fails, but that never
    // reaches the wrapper — without the fatal latch, a waiter issued before or
    // during login would sit for the full timeout and then report a timeout,
    // hiding the real cause (a bad token).
    const warden = createWardenDiscord(silentLogger());
    const during = warden.waitForReady(30_000);
    await expect(warden.login("")).rejects.toThrow();

    const started = Date.now();
    await expect(during).rejects.toThrow(/login failed/i);
    await expect(warden.waitForReady(30_000)).rejects.toThrow(/login failed/i);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("reports not-ready after an unrecoverable close while discord.js still says Ready", () => {
    // The exact divergence `ready()` exists for: discord.js' `isReady()` is
    // `!ws.destroyed && ws.status === Status.Ready`, and neither flag moves on
    // an unrecoverable close — so it keeps answering yes for a connection that
    // died. `ws.status` is set up front for the same reason as above: without
    // it discord.js already says "not ready" and this test would pass even if
    // `ready()` were reverted to `client.isReady()`.
    const warden = createWardenDiscord(silentLogger());
    warden.client.ws.status = Status.Ready;
    expect(warden.client.isReady()).toBe(true); // setup: discord.js agrees
    expect(warden.isReady()).toBe(true);

    warden.client.emit(
      Events.ShardDisconnect,
      { wasClean: false, code: 4013, reason: "" },
      0,
    );

    expect(warden.client.isReady()).toBe(true); // unchanged — that is the bug
    expect(warden.isReady()).toBe(false);
    expect(warden.status().ready).toBe(false);
  });

  it("clears the fatal latch when a later ClientReady arrives", () => {
    // A multi-shard gateway can recover, so the latch must not wedge
    // `isReady()` for the rest of the process.
    const warden = createWardenDiscord(silentLogger());
    warden.client.emit(
      Events.ShardDisconnect,
      { wasClean: false, code: 4013, reason: "" },
      0,
    );
    expect(warden.isReady()).toBe(false);

    const readyClient = warden.client as unknown as Client<true>;
    warden.client.ws.status = Status.Ready;
    readyClient.readyTimestamp = Date.now();
    warden.client.emit(Events.ClientReady, readyClient);

    expect(warden.isReady()).toBe(true);
    expect(warden.status().ready).toBe(true);
  });

  it("fails the next wait immediately after an unrecoverable close", async () => {
    // discord.js only emits ShardDisconnect for the six unrecoverable codes,
    // so a later waiter can never succeed — it must learn the close code now
    // rather than burn its timeout and then report a plain timeout.
    // The sentinel is deliberately short: without the latch this rejects with
    // the *timeout* wording after 1 s and fails fast, instead of hanging here.
    const SENTINEL_MS = 1_000;
    const warden = createWardenDiscord(silentLogger());
    warden.client.emit(
      Events.ShardDisconnect,
      { wasClean: false, code: 4013, reason: "" },
      0,
    );
    const started = Date.now();
    await expect(warden.waitForReady(SENTINEL_MS)).rejects.toThrow(/4013/);
    // Rejected by the latch, not by the timer: the sentinel never elapsed.
    expect(Date.now() - started).toBeLessThan(SENTINEL_MS);
  });
});

describe("lifecycle counters", () => {
  it("counts an unrecoverable close, records its code, and logs the fix", async () => {
    const { logger, lines } = collectingLogger();
    const warden = createWardenDiscord(logger);
    const waiting = warden.waitForReady(30_000);

    warden.client.emit(
      Events.ShardDisconnect,
      { wasClean: false, code: 4004, reason: "" },
      0,
    );

    // Waiters fail immediately rather than sitting out their timeout with a
    // misleading "not ready yet".
    await expect(waiting).rejects.toBeInstanceOf(WardenNotReadyError);

    const status = warden.status();
    expect(status.disconnects).toBe(1);
    expect(status.lastCloseCode).toBe(4004);

    const line = lines.find((entry) => entry.includes("gateway disconnected"));
    expect(line).toBeDefined();
    expect(line).toContain("4004");
    expect(line).toContain("DISCORD_BOT_TOKEN");
  });

  it("gives 4014 the privileged-intent remediation", () => {
    const { logger, lines } = collectingLogger();
    const warden = createWardenDiscord(logger);
    warden.client.emit(
      Events.ShardDisconnect,
      { wasClean: false, code: 4014, reason: "" },
      1,
    );
    const line =
      lines.find((entry) => entry.includes("gateway disconnected")) ?? "";
    expect(line).toContain("Message Content Intents");
    expect(warden.status().lastCloseCode).toBe(4014);
    expect(warden.status().disconnects).toBe(1);
  });

  it("logs the intent-set remediation for close code 4013", () => {
    const { logger, lines } = collectingLogger();
    const warden = createWardenDiscord(logger);
    warden.client.emit(
      Events.ShardDisconnect,
      { wasClean: false, code: 4013, reason: "" },
      0,
    );
    const line =
      lines.find((entry) => entry.includes("gateway disconnected")) ?? "";
    expect(line).toContain("intent set");
    expect(JSON.parse(line).shardId).toBe(0);
  });

  it("falls back to a generic remediation for an unlisted close code", () => {
    const { logger, lines } = collectingLogger();
    const warden = createWardenDiscord(logger);
    // 9000 is not one of discord.js' UNRECOVERABLE_CLOSE_CODES, so this is the
    // only way to reach the `??` branch below the remediation map.
    warden.client.emit(
      Events.ShardDisconnect,
      { wasClean: false, code: 9000, reason: "mystery" },
      2,
    );
    const line =
      lines.find((entry) => entry.includes("gateway disconnected")) ?? "";
    expect(line).toContain("9000");
    expect(line).toContain("WARDEN_LOG_LEVEL=debug");
    expect(JSON.parse(line).shardId).toBe(2);
  });

  it("maps every close code discord.js treats as unrecoverable", () => {
    // Asserts that the six codes discord.js treats as unrecoverable are all
    // mapped — it does NOT detect a future widening of that set (the list is
    // hardcoded here, so a seventh code would pass silently).
    const { logger, lines } = collectingLogger();
    const warden = createWardenDiscord(logger);
    for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
      lines.length = 0;
      warden.client.emit(
        Events.ShardDisconnect,
        { wasClean: false, code, reason: "" },
        0,
      );
      const line =
        lines.find((entry) => entry.includes("gateway disconnected")) ?? "";
      expect(line, `code ${code} has no mapped remediation`).not.toContain(
        "WARDEN_LOG_LEVEL=debug",
      );
    }
  });

  it("counts reconnects separately from disconnects", () => {
    const { logger, lines } = collectingLogger();
    const warden = createWardenDiscord(logger);
    warden.client.emit(Events.ShardReconnecting, 0);
    warden.client.emit(Events.ShardReconnecting, 0);
    expect(warden.status().reconnects).toBe(2);
    expect(warden.status().disconnects).toBe(0);
    expect(
      lines.filter((entry) => entry.includes("reconnecting")),
    ).toHaveLength(2);
  });

  it("is safe to destroy twice", async () => {
    const warden = createWardenDiscord(silentLogger());
    await expect(warden.destroy()).resolves.toBeUndefined();
    await expect(warden.destroy()).resolves.toBeUndefined();
    expect(warden.status().ready).toBe(false);
  });
});

describe("login()", () => {
  it("rejects an empty token with discord.js' TokenInvalid", async () => {
    const warden = createWardenDiscord(silentLogger());
    // An empty token is rejected synchronously — no gateway round trip, so
    // this test is offline-safe.
    await expect(warden.login("")).rejects.toMatchObject({
      code: "TokenInvalid",
    });
  });

  it("maps that failure to the token remediation, not to `internal`", async () => {
    const warden = createWardenDiscord(silentLogger());
    const error = await warden.login("").catch((caught: unknown) => caught);
    const wardenError = toWardenError(error);
    expect(wardenError.error).toBe("discord_api");
    expect(wardenError.remediation).toContain("DISCORD_BOT_TOKEN");
    expect(wardenError.error).not.toBe("internal");
    expect(wardenError.remediation).not.toContain("bug in Warden");
  });

  it("never writes the token to the log, even when the failure quotes it", async () => {
    const { logger, lines } = collectingLogger();
    const warden = createWardenDiscord(logger);
    // Simulate discord.js echoing the token back inside the login error —
    // the one moment a real token is in the same process as a log call.
    vi.spyOn(warden.client, "login").mockRejectedValue(
      new Error(`An invalid token was provided: ${TOKEN}`),
    );

    await expect(warden.login(TOKEN)).rejects.toThrow();

    expect(lines.length).toBeGreaterThan(1);
    const joined = lines.join("\n");
    expect(joined).not.toContain(TOKEN);
    expect(joined).toContain("[redacted-token]");
    vi.restoreAllMocks();
  });

  it("logs the connection attempt with its intent footprint", async () => {
    const { logger, lines } = collectingLogger();
    const warden = createWardenDiscord(logger);
    vi.spyOn(warden.client, "login").mockRejectedValue(new Error("nope"));
    await warden.login("unused").catch(() => undefined);
    const line =
      lines.find((entry) => entry.includes("connecting to Discord")) ?? "";
    expect(JSON.parse(line).intents).toBe(21);
    expect(JSON.parse(line).privilegedIntents).toEqual([
      "GuildMembers",
      "GuildPresences",
      "MessageContent",
    ]);
    vi.restoreAllMocks();
  });
});
