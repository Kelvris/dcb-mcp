/**
 * Environment configuration — validated once at startup with zod.
 *
 * Rules:
 * - missing/invalid config fails fast with a clear, human-readable message;
 * - failures are printed to stderr (never stdout — that's the JSON-RPC channel);
 * - secrets are never echoed back: issue messages are built from our own
 *   copy plus a redaction pass, so the token can't leak into an error.
 *
 * DISCORD_APPLICATION_ID defaults to "derived from token" (plan §4): bot
 * tokens begin with base64url(<bot user id>), so we decode it ourselves
 * instead of waiting for an HTTP round-trip. An explicit value always wins.
 */

import { z } from "zod";
import { LOG_LEVELS, redact } from "./logger.js";

/** Discord ids are 17–20 digit snowflakes (length grew over the years). */
const SNOWFLAKE = /^\d{17,20}$/;

function snowflake(label: string): z.ZodString {
  const message = `${label} must be a Discord snowflake id (17-20 digits)`;
  return z.string({ error: message }).regex(SNOWFLAKE, { error: message });
}

/**
 * Trim whitespace and treat blank strings as "not set" — clients often pass
 * `VAR=` or accidentally include a trailing newline when pasting.
 */
const absent = (value: unknown): unknown => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

/** Like {@link absent}, but also lowercases (for enum-like vars). */
const absentLower = (value: unknown): unknown => {
  const normalized = absent(value);
  return typeof normalized === "string" ? normalized.toLowerCase() : normalized;
};

const positiveInt = (
  label: string,
  max: number,
  fallback: number,
): z.ZodType<number> =>
  z.preprocess(
    absent,
    z.coerce
      .number({ error: `${label} must be a number` })
      .int({ error: `${label} must be an integer` })
      .min(1, { error: `${label} must be >= 1` })
      .max(max, { error: `${label} must be <= ${max}` })
      .default(fallback),
  );

export const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.preprocess(
    absent, // trim paste-whitespace; blank → "required" message below
    z
      .string({
        error:
          'DISCORD_BOT_TOKEN is required — set it in the "env" block of your MCP client config (see README → Setup)',
      })
      // belt-and-braces: `absent` already maps "" to undefined (which yields
      // the "required" message above), so this only fires if preprocess changes
      .min(1, {
        error:
          "DISCORD_BOT_TOKEN is empty — copy the token from the Discord developer portal",
      }),
  ),

  DISCORD_APPLICATION_ID: z.preprocess(
    absent,
    snowflake("DISCORD_APPLICATION_ID").optional(),
  ),

  WARDEN_GUILD_ID: z.preprocess(
    absent,
    snowflake("WARDEN_GUILD_ID").optional(),
  ),

  // 100k events ≈ 50x the default — enough headroom, small enough that a
  // fat-fingered zero can't turn the ring buffer into an OOM.
  WARDEN_MAX_EVENTS: positiveInt("WARDEN_MAX_EVENTS", 100_000, 2000),

  WARDEN_MAX_WATCHES: positiveInt("WARDEN_MAX_WATCHES", 1000, 20),

  WARDEN_LOG_LEVEL: z.preprocess(
    absentLower,
    z
      .enum(LOG_LEVELS, {
        error: "WARDEN_LOG_LEVEL must be one of: error, warn, info, debug",
      })
      .default("warn"),
  ),

  WARDEN_DRY_RUN: z.preprocess(
    absent,
    z
      .stringbool({
        error: "WARDEN_DRY_RUN must be a boolean (true/false, 1/0, yes/no)",
      })
      .default(false),
  ),
});

export type Config = z.output<typeof envSchema>;

/** Validation failure with pre-formatted, redacted issue lines. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    const hint =
      "\nSee README.md → Setup for how to create a bot token and configure your MCP client.";
    super(
      `Warden configuration is invalid:\n${issues.map((issue) => `  - ${issue}`).join("\n")}${hint}`,
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(env)";
    return redact(`${path}: ${issue.message}`);
  });
}

/**
 * Discord bot tokens open with `base64url(<bot user id>).<ts>.<hmac>` — decode
 * the first segment to get the application id for free. Returns undefined
 * unless the input really is a 3-segment token decoding to a snowflake;
 * anything else (a pasted `Bearer …`, a half-copied secret) falls back to REST.
 * Node's base64url decoder accepts both alphabets and never throws on junk,
 * so one decode + the SNOWFLAKE check is the whole validation.
 */
export function deriveApplicationId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0]) return undefined;
  const decoded = Buffer.from(parts[0], "base64url").toString("utf8");
  return SNOWFLAKE.test(decoded) ? decoded : undefined;
}

/**
 * Parse and validate the environment. Throws {@link ConfigError} listing every
 * problem at once (not just the first) so operators can fix them in one pass.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) throw new ConfigError(formatIssues(result.error));
  const config = result.data;
  const applicationId =
    config.DISCORD_APPLICATION_ID ??
    deriveApplicationId(config.DISCORD_BOT_TOKEN);
  return { ...config, DISCORD_APPLICATION_ID: applicationId };
}

/** Startup wrapper: on failure print to stderr and exit 1 (no stack dump). */
export function loadConfigOrExit(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Config {
  try {
    return loadConfig(env);
  } catch (error) {
    const text =
      error instanceof ConfigError
        ? error.message
        : `Warden failed to start: ${String(error)}`;
    process.stderr.write(`${redact(text)}\n`);
    process.exit(1);
  }
}
