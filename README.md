# Warden — Discord MCP Server

**Self-hosted MCP server that gives an agent full control of a Discord server —
with honest capability reporting when something is out of its power.**

> Status: **under active construction** (Phase 1 of 12). The full setup guide,
> tool catalog, and event catalog land in Phase 11.

- **Package:** `warden-discord-mcp` · **bin:** `warden-discord-mcp`
- **Transport:** stdio (launched by your MCP client as a subprocess)
- **Auth:** your own Discord **bot token** — self-hosted, never shared
- **License:** MIT · no telemetry, no phone-home

## Quick start (once published)

```jsonc
// MCP client config (e.g. ~/.config/opencode/opencode.json or Claude Desktop)
{
  "mcpServers": {
    "warden": {
      "command": "npx",
      "args": ["-y", "warden-discord-mcp"],
      "env": { "DISCORD_BOT_TOKEN": "…", "WARDEN_GUILD_ID": "… (optional)" },
    },
  },
}
```

## Environment variables

| Var                      | Required | Default            | Purpose                                      |
| ------------------------ | -------- | ------------------ | -------------------------------------------- |
| `DISCORD_BOT_TOKEN`      | **yes**  | —                  | Bot token from the Discord developer portal  |
| `DISCORD_APPLICATION_ID` | no       | derived from token | Self-identification for a few REST routes    |
| `WARDEN_GUILD_ID`        | no       | —                  | Default guild id (tools may omit `guild_id`) |
| `WARDEN_MAX_EVENTS`      | no       | `2000`             | Event ring-buffer size (max 100000)          |
| `WARDEN_MAX_WATCHES`     | no       | `20`               | Cap on concurrent watch sessions (max 1000)  |
| `WARDEN_LOG_LEVEL`       | no       | `warn`             | `error\|warn\|info\|debug` — **stderr only** |
| `WARDEN_DRY_RUN`         | no       | `false`            | Preflight mutations without calling Discord  |

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest
npm run build       # tsc → dist/
```

Node ≥ 20 to run the server; the test toolchain (vitest 5, eslint 10) needs Node ≥ 22.13.

See `plan.md` in the repository for the full design.
