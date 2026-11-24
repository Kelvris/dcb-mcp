# Warden Discord MCP — Full Implementation Plan

> **Package:** `warden-discord-mcp` (npm, free name) · **bin:** `warden-discord-mcp`
> **What:** A self-hosted, open-source (MIT) MCP server that gives an agent CLI full
> control of a Discord server over stdio, with honest capability reporting — when something
> is out of its power (role hierarchy, missing permissions), it says exactly why, and how
> to fix it.
> **Auth:** Requires the user's own Discord **bot token** (self-hosted; we never see it).

---

## 1. Decisions (locked)

| Topic | Decision |
|---|---|
| Name | **Warden** (product), npm package `warden-discord-mcp` |
| Language | TypeScript, strict, ESM, Node ≥ 20 |
| Transport | **stdio** (launched by the MCP client as a subprocess) |
| Install | **npx** one-liner in client config; published to npm when ready |
| License | **Open source — MIT** (LICENSE, CONTRIBUTING, no telemetry) |
| Tool granularity | **Grouped by domain** (~60 tools) so the agent isn't overwhelmed |
| Events to agent | **Pull model**: ring buffer + cursor-based `watch` sessions + one-shot `wait_for_event` |
| Slash commands | **MCP-only** — no preset commands registered; the agent is the interface |
| Naming of failures | Structured JSON errors: `{ error, message, remediation, ... }` |

---

## 2. Tech stack

| Piece | Choice | Notes |
|---|---|---|
| MCP SDK | `@modelcontextprotocol/server` **^2.3.0** (current v2; verified at install) | `McpServer` + `registerTool` from the root; **`serveStdio` from the `/stdio` subpath** (`import { serveStdio } from "@modelcontextprotocol/server/stdio"` — not exported at root). Fallback if needed: `@modelcontextprotocol/sdk` ^1.32 (`McpServer` + `StdioServerTransport`) |
| Validation | `zod` ^4.6 | One schema lib for env, tool inputs, event filters |
| Discord | `discord.js` ^14.27 | Full gateway coverage, REST, permission bitfields |
| Build | `tsc` → `dist/` | `files: ["dist"]`, `exports` + `bin` |
| Tests | `vitest` | Guards/hierarchy matrix, event buffer, watch cursors, error mapping |
| Lint | `eslint` + `typescript-eslint` (flat config) | + `prettier` default style |
| CI (later) | GitHub Actions: typecheck + lint + test on push | open-source hygiene |

**Zero runtime deps beyond** `@modelcontextprotocol/server`, `discord.js`, `zod`.
(no express — stdio only; no dotenv — client config passes env).

---

## 3. Repository layout

```
warden-discord-mcp/
├── plan.md                     # this file
├── package.json                # name, bin, files=[dist], engines, scripts
├── tsconfig.json               # strict, NodeNext ESM, outDir dist
├── eslint.config.js
├── .gitignore                  # dist, node_modules, .env, *.log
├── .env.example                # DISCORD_BOT_TOKEN=  (documented, never committed)
├── LICENSE                     # MIT
├── README.md                   # full setup + tool & event catalog
├── CONTRIBUTING.md
├── src/
│   ├── index.ts                # entry: parse env → build server → serveStdio
│   ├── config.ts               # zod env schema (fail fast, never print secrets)
│   ├── server.ts               # createWarden(): wires client, bus, guards, all tools
│   ├── logger.ts               # stderr-only structured logger via process.stderr.write (stdout is JSON-RPC!)
│   ├── discord/
│   │   ├── client.ts           # Client(all intents), ready-wait, reconnect, ws ping
│   │   ├── guards.ts           # ★ preflight: permission + hierarchy + structural checks
│   │   ├── errors.ts           # DiscordAPIError → WardenError JSON (codes 50013, 50001, …)
│   │   └── serializers/        # discord.js objects → compact JSON (stripped/curated)
│   │       ├── index.ts        #   the barrel — tools import this, not a single domain
│   │       ├── shared.ts       #   public primitives (compact, idList, bit-field readers)
│   │       ├── internal.ts     #   private helpers; deliberately not re-exported
│   │       ├── members.ts      #   users, members, roles
│   │       ├── channels.ts     #   channels + overwrites, forum tags, default reaction
│   │       ├── guilds.ts       #   guild + expressions, invites, webhooks, bans
│   │       ├── messages.ts     #   messages + embeds, attachments, polls
│   │       └── presence.ts     #   presences, activities, voice states
│   ├── events/
│   │   ├── types.ts            # NormalizedEvent, EventFilter, Watch
│   │   ├── normalize.ts        # every ClientEvent → NormalizedEvent
│   │   ├── bus.ts              # ring buffer (default 2000), monotonic seq
│   │   └── watches.ts          # named watches with per-watch cursors
│   ├── tools/
│   │   ├── index.ts            # registerAll(server, ctx)
│   │   ├── observe.ts          # events/watches/wait tools + get_bot_status
│   │   ├── guild.ts            # server info + update_server + widget/vanity/onboarding/…
│   │   ├── channels.ts         # list/get/manage + permissions + follow
│   │   ├── threads.ts          # manage_thread
│   │   ├── messages.ts         # send/edit/delete/bulk/crosspost/pins/reactions/history/search
│   │   ├── members.ts          # list/get/update/kick/timeout/prune/bans
│   │   ├── roles.ts            # manage_role/assign_roles/reorder_roles
│   │   ├── moderation.ts       # ban/bulk_ban/unban/list_bans/automod
│   │   ├── webhooks.ts         # manage_webhook/execute_webhook
│   │   ├── expressions.ts      # emojis/stickers/soundboard
│   │   ├── invites.ts          # manage_invites
│   │   ├── scheduled-events.ts # manage_scheduled_event
│   │   ├── stage.ts            # manage_stage_instance
│   │   ├── templates.ts     # manage_guild_templates
│   │   ├── integrations.ts  # manage_integration
│   │   └── bot-account.ts   # manage_bot_account, manage_my_guilds, send_dm, set_own_nickname
│   └── shared/
│       ├── result.ts           # ok()/fail() result builders (uniform JSON payloads)
│       └── ids.ts              # snowflake parsing/defaults
└── test/
    ├── guards.test.ts          # hierarchy & permission matrix (mock guild fixtures)
    ├── bus.test.ts             # ring buffer, seq, filters
    ├── watches.test.ts         # cursors, block_ms, idle-empty reads
    ├── errors.test.ts          # DiscordAPIError → structured mapping
    └── normalize.test.ts       # every event type produces valid NormalizedEvent
```

---

## 4. Configuration & environment

Passed by the MCP client in its config block. Validated by zod at startup; missing
`DISCORD_BOT_TOKEN` → exit 1 with a clear stderr message (never a stack trace dump).

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | **yes** | — | Bot token from the Discord developer portal |
| `DISCORD_APPLICATION_ID` | no | derived from token | Needed for a few REST routes / self-identification |
| `WARDEN_GUILD_ID` | no | — | Default guild id; lets tools omit `guild_id` on single-server setups |
| `WARDEN_MAX_EVENTS` | no | `2000` | Ring-buffer size |
| `WARDEN_MAX_WATCHES` | no | `20` | Cap on concurrent watch sessions |
| `WARDEN_LOG_LEVEL` | no | `warn` | `error\|warn\|info\|debug` — **stderr only** (stdout is the JSON-RPC channel) |
| `WARDEN_DRY_RUN` | no | `false` | When true, every mutation runs its preflight and returns `would_perform` without calling Discord |

**Security rules:** token is never logged, never included in tool results, never in
error payloads; all mutating calls attach `X-Audit-Log-Reason: warden:<tool>` (plus the
agent-supplied `reason`) so the Discord audit log shows exactly what Warden did and why.

---

## 5. Architecture & lifecycle

```
MCP client (opencode / Claude Desktop / …)
   │  spawns `npx -y warden-discord-mcp`, env: DISCORD_BOT_TOKEN
   ▼
index.ts ── zod-parse env ──► createWarden()
                                 │
                                 ├─ discord/client.ts  ──► Gateway connect (all intents)
                                 │      └─ on ready: cache warmed, ws ping tracked
                                 ├─ events/bus.ts      ◄── every ClientEvent (normalize → buffer)
                                 ├─ events/watches.ts  ◄── watch sessions (cursor per watch)
                                 └─ tools/*            ──► registerTool() for all ~60 tools
                                 │
                            serveStdio(server)  ◄────── JSON-RPC over stdin/stdout
```

* Startup: tools register **immediately**; Discord connection connects in parallel and
  tools return `{"error":"not_ready"}` until `ready` (agents get a sane message instead of a hang).
* Shutdown: SIGINT/SIGTERM → destroy client → flush → exit 0.
* discord.js auto-handles rate limits & reconnects; we surface `ws.ping` and `status` in `get_bot_status`.

> **Phase 4 implementation notes**, recorded while building `server.ts`/`index.ts` and the
> first two tools:
>
> * `get_bot_status` is the one tool that **succeeds while the gateway is down**: it answers
>   `ok:true` with `ready:false` and a note, instead of `not_ready`. It is the diagnostic
>   tool — reporting the state *is* its job — and the `not_ready` failure belongs to the
>   tools that actually need Discord. Every other tool keeps the plan's rule.
> * Neither phase-4 tool declares an `outputSchema`. The uniform envelope travels as
>   `content[0].text` (the payload as JSON) **plus the same object as `structuredContent`**;
>   the SDK validates structured content only when a schema is declared, so declaring one
>   would freeze the envelope's shape for a tool whose data is deliberately open —
>   uniformity comes from the §5 contract, applied in one place (`tools/context.ts`), not
>   from 60 per-tool schemas.
> * The version reported in the MCP handshake is read from the installed `package.json` at
>   startup: `dist/server.js` and `src/server.ts` both sit one directory below the package
>   root, so one relative URL resolves in dev, in the published tarball, and under `npx`.
>   An unreadable file degrades to a placeholder rather than taking startup down over a
>   cosmetic field.
> * Shutdown gained a **stdin trigger** alongside SIGINT/SIGTERM. The stdio transport closes
>   itself when the client ends stdin, but the Discord gateway socket keeps the event loop
>   alive — without the explicit exit the process outlives its client as a zombie.
> * A bad token never reaches `login()`'s promise the way a naive reading suggests: discord.js
>   fails during *connect* (`TokenInvalid`), so `createWarden()` treats login as
>   fire-and-forget and logs the mapped remediation; tools answer `not_ready` meanwhile.
>   Verified live: a bogus token yields `ready:false` from `get_bot_status`, a structured
>   `not_ready` from `get_server`, and the remediation line on stderr — with the token
>   absent from both streams.
>
> **Re-review notes** (after the Phase 4 review pass), each pinned by a test:
>
> * **The MCP server is per connection, not a singleton.** `serveStdio`'s factory runs on
>   every connection *phase* — a 2025-era opening probe can be discarded and re-served
>   through the legacy path — and `Server.connect` requires a separate instance per
>   connection. `Warden.createServer()` therefore builds and registers a fresh server
>   each call; the Discord client, config, logger (and later the event bus) are the
>   shared state built once in `createWarden()`.
> * **Exit flushes stderr first.** A client captures our stderr over a pipe, and Node
>   treats pipe writes as *asynchronous* on macOS — `process.exit()` can drop the last
>   diagnostic lines, so shutdown awaits a drain callback before exiting (this is the
>   "flush" §5 already promised). A repeat signal or a crash arriving mid-shutdown now
>   forces a **non-zero** exit instead of being swallowed by the in-progress guard.
> * **`get_bot_status` distinguishes "connecting" from "can never connect".**
>   `WardenDiscord.status()` now publishes the client's fatal latch (reason +
>   remediation), and the tool turns it into a note that names the fix — a reset token no
>   longer reads "call again in a few seconds" forever while the real answer sits on stderr.
> * **`ToolContext.config` is `Omit<Config, "DISCORD_BOT_TOKEN">`** — the tool layer
>   cannot name the secret at compile time (plan §4), and operator-authored free text in
>   *success* payloads (guild name/description, channel name/topic) goes through
>   `scrubText()` because `ok()` deliberately does not scrub.
> * One snowflake definition (`src/shared/ids.ts`, plan §3) now backs both the env
>   validator and every `*_id` tool input.
>
> **Third-pass notes** (shutdown hardening after the process-level review), each pinned
> by `test/shutdown.test.ts` or `test/process.test.ts`:
>
> * The shutdown orchestration lives in `src/shutdown.ts` (injectable hooks), because
>   the trigger rules are exactly where bugs hide and they must be unit-testable.
>   Escalation rule: a repeat *signal* or a *crash* during teardown forces a non-zero
>   exit, but a signal during a **client-initiated** (stdin) teardown does not — the
>   client is already gone, so that pass finishes normally (exit 0).
> * `process.stderr`/`process.stdout` get no-op `'error'` sinks in `index.ts`: a client
>   that closes its captured-stderr pipe would otherwise turn every log line (including
>   the uncaughtException handler's own output) into EPIPE — a self-sustaining loop that
>   never reaches the exit. `test/process.test.ts` reproduces it end to end.
> * `flushStderr` always writes the barrier (no `writableLength === 0` fast path — a
>   write already handed to the OS leaves the queue empty while its bytes are still in
>   flight) and is bounded at 500 ms; closing the transport is likewise raced against a
>   5 s bound so a wedged pipe cannot strand the gateway teardown.
> * `test/process.test.ts` spawns the built `dist/index.js` (self-rebuilding through
>   `npm run build` when stale), performs a real MCP initialize handshake, and asserts
>   exit 0 — no "forcing exit" line, token in no stream — for both the stdin-EOF and the
>   stderr-gone scenarios.
>
> **Fourth-pass notes** (escalation matrix completed; review verdict APPROVE WITH FIXES):
>
> * Absorptions are granted in **either** trigger order — at most one per teardown: the
>   first signal during a client-initiated (stdin) teardown, *or* a client disconnect
>   arriving during a signal teardown (`docker stop` / `systemd KillMode=mixed` signal
>   first, close stdin right after). The second signal always escalates — the
>   wedged-teardown escape hatch survives the absorption — and a crash always exits
>   non-zero.
> * A broken stdout is treated as "the client is gone": it routes through the same
>   deduplicated client-gone trigger as stdin EOF. The stream-error sinks absorb only
>   reader-gone codes (`EPIPE` and friends) and report anything else (full disk, bad fd)
>   once, so a persistently broken stream can neither loop nor fail silently.
> * The transport-close bound's timer is cleared when the transport wins the race, and
>   `flushStderr` resolves (never rejects) even if `write` throws synchronously — a
>   rejection there would surface as an unhandled rejection and force exit 1 on an
>   otherwise clean disconnect.
>
> **Phase 5 implementation notes** (the event system — `events/*` + the six observe tools):
>
> * **69 event specs = §7.2's inventory exactly** (count canary pinned in
>   `normalize.test.ts`; §12's "~67" rounds the table). Intentionally *not* subscribed:
>   `userUpdate` and entitlement events (not in §7.2), the deprecated `ready` spelling
>   (only `clientReady` → type `ready`, so READY is captured once) and deprecated
>   `webhooksUpdate`'s old name (`webhooksUpdate` itself is subscribed — it *is* the
>   inventory entry).
> * **Eight inventory events are captured from `Events.Raw`, not from discord.js**
>   because discord.js 14 never emits them: `applicationCommandCreate/Update/Delete`,
>   `integrationCreate/Update/Delete`, `voiceChannelStatusUpdate`,
>   `voiceChannelStartTimeUpdate`. The raw dispatch fires for *every* gateway packet
>   before handling, so the backstop is a single listener keyed by wire name — the
>   inventory is complete without waiting on the library.
> * **Canonical type = discord.js' camelCase listener name**, with two meta renames
>   (`READY` → `ready`, `shardResume`/`RESUMED` → `resumed`) and five wire aliases where
>   the library renamed the wire event (`GUILD_ROLE_*` → `role*`, `GUILD_EMOJIS_UPDATE`
>   → `emojiUpdate`, `GUILD_STICKERS_UPDATE` → `stickerUpdate`). `canonicalType()` at the
>   tool boundary accepts either spelling, so filters read the same either way (§7.2's
>   closing note).
> * **Scrub happens once, at ingest**: `bus.push()` deep-scrubs every payload string
>   before the event enters the ring. Message bodies, audit reasons and topics are
>   operator/user free text — exactly where a pasted token lives (§4) — and one choke
>   point means every consumer (tools, watches, waits, later phases) can echo stored
>   events verbatim without re-scrubbing.
> * **Unknown type names in a filter are `invalid_input`, never a silent empty result**:
>   a typo that matches nothing forever is indistinguishable from "no activity".
>   Wildcard prefixes are validated the same way (`xyz*` is rejected, `message*` passes).
>   `since_seq` and `since` together are also `invalid_input` — one cursor style at a
>   time (§8.1 documents both as alternatives).
> * **`get_events` has two read modes**: without a bound it returns the *tail* (newest
>   `limit`, oldest-first); with `since_seq`/`since` it pages forward ascending. A
>   wall-clock `since` is converted to a seq cursor first (`bus.cursorFor`), so paging
>   from it never skips the middle of a busy window the way a tail pull would.
> * **Watch lifecycle decisions**: the name *is* the `watch_id` (no id→name lookup to
>   get wrong); duplicate names are `invalid_input` (never silently replace a session
>   mid-read); reaching `WARDEN_MAX_WATCHES` is `invalid_input` with the env var named —
>   §9 has no capacity kind, so `invalid_input` + remediation is the documented fit;
>   expiry is lazy (30 min since last read, pruned on registry operations — no timer to
>   outlive its watch); an expired watch reads `not_found` with "create it again".
>   A fresh watch starts at the current head (future-only) unless `since_*` is given,
>   in which case the bound lives inside the filter and the first read returns the
>   matching buffered slice (§8.1's "initial cursor").
> * **`wait_for_event` is future-only** by construction (matches must have seq > the
>   call-time head) — history is `get_events`' job; timeout answers
>   `ok:true {timeout:true, event:null}` rather than a failure, because "nothing
>   happened" is a valid result.
> * **Event tools succeed while the gateway is down**, like `get_bot_status`: they read
>   process-local state, so failing them would break an agent following a watch through
>   a reconnect for no reason. Each adds a note saying the gateway is down instead;
>   `not_ready` stays reserved for tools that need Discord (§5's rule, unchanged).
> * **Annotations follow §8.1's legend**: `readOnlyHint:true` on the five 🟢 tools
>   (including `watch`/`read_watch`, which advance a process-local cursor but never
>   touch Discord), `false` only on `unwatch` (🔴*), and `openWorldHint:false` on all
>   six — no tool in this group performs server-side actions.
> * **§7.4's partial rule drives every extractor**: `?? null` reads throughout, so an
>   uncached `messageDelete`, a stripped thread member or an unavailable guild still
>   yields "id + whatever Discord gave us". Extraction failures are contained per event
>   (logged as type + error only — never the payload) so one shape discord.js changed
>   cannot take the pipeline down.
>
> **Phase 5 re-review notes** (after the review pass, each pinned by a test):
>
> * **`read_watch` reports ring eviction** (`evictedCount` → note): a busy guild can
>   push past `WARDEN_MAX_EVENTS` between two reads, and a silently truncated "live
>   follow" is exactly the failure §7.4's anti-hammering design must not have. `get_events`
>   already noted the buffer horizon; watches now do too.
> * **Wire-prefixed wildcards expand** — `GUILD_ROLE*`/`GUILD_EMOJIS*` camel-case to
>   nothing, so they resolve by matching every *wire* name under the prefix to its
>   canonical type (`GUILD_ROLE*` → `roleCreate roleUpdate roleDelete`). An agent
>   transcribing §7.2's own wire table is not rejected for the plan's spelling.
> * **`targetId` is reserved for subjects no other field names** (types.ts's promise):
>   channel/guild/stage-instance events no longer set it — their subject is already
>   `channelId`/`guildId`. Role/member/ban/sound/emoji/sticker/scheduled-event/automod-rule/
>   integration/application-command events keep it.
> * **`filter` echoes come back snake_case** (`watch`, `list_watches`), matching the input
>   schema, so an agent can round-trip a listed filter into a `filter` argument verbatim —
>   with the `since_seq`/`since` bounds travelling as top-level siblings of `filter`,
>   exactly where the input takes them. Eviction reporting covers a since-based watch's
>   *first* read too (a cursor-0 watch over a wrapped ring), not just mid-follow gaps.
> * Automod **rule** events carry `guildId` (`rule.guild`) — the family is guild-scoped,
>   and a `guild_id` filter must see it. Scrubbing at ingest also covers the stamped id
>   fields, not just `data`, so no future extractor can bypass the §4 choke point.

### Result contract (uniform for every tool)

```jsonc
// success
{ "ok": true, "performed": "member.kick", "data": { … }, "notes": ["…"] }

// failure (isError: true)
{ "ok": false, "error": "role_hierarchy",
  "message": "Cannot remove role 'Moderator' (@Moderator) from @user: its position (12) is above Warden's top role (8, \"Warden\").",
  "bot": { "role": "Warden", "position": 8 },
  "target": { "role": "Moderator", "position": 12 },
  "missingPermissions": [],
  "remediation": "Move the Warden role above @Moderator in Server Settings → Roles." }
```

---

## 6. ★ Capability preflight (`guards.ts`) — the flagship

Every **mutating** tool runs this **before** touching Discord. Layered checks:

1. **Intent/ready** — client connected? target guild cached?
2. **Permission** — `channel.permissionsFor(botMember)` / `botMember.permissions.has(flag)`
   for the exact required flags (per-channel, overwrite-aware; `Administrator` short-circuits).
3. **Role hierarchy**
   - bot top-role position vs **target role** position (edit/delete role, assign role, reorder),
   - bot top-role position vs **target member's highest role** (kick/timeout/nick/roles/voice);
     the same comparison also forbids touching anyone whose own highest role sits above Warden's,
   - cannot edit `@everyone` or managed/integration roles, cannot reorder below 0,
   - cannot act on the **guild owner** (kick/ban/nick/timeout),
   - cannot timeout/ban users **with Administrator** (Discord rejects the timeout half;
     the ban half is Warden policy, stricter than the API — see the clarification below),
   - cannot grant **permissions Warden itself lacks** (`ManageRoles` grant rule).
4. **Structural limits** — bulk-delete range (2–100, ≤ 2 weeks), prune dry-run first,
   slowmode 0–21600, timeout ≤ 28 days, emoji/sticker/soundboard file limits, thread archive
   durations, forum tag rules, etc.

> **Phase 3 clarifications**, recorded while implementing `guards.ts`:
>
> * `@everyone` and managed roles are refused for **every** caller, including a
>   guild-owner bot. The `@everyone` half is deliberately *stricter* than the API —
>   `Modify Guild Role` requires only `MANAGE_ROLES`, and because `@everyone` sits at the
>   bottom of the role list every bot with a real top role is above it. Warden refuses it
>   anyway so an agent's plan never has to branch on guild ownership. The managed half is
>   the opposite kind of rule: Discord itself refuses those for everyone.
> * No guild-owner exemption from the *position* rule. An earlier draft of this block
>   claimed one and cited a `compute_role_hierarchy` helper that exists nowhere in
>   discord.js 14.27. Discord's own Permission Hierarchy docs state the bot rules with no
>   owner carve-out, and the library agrees on roles — `Role#editable` is `managed → false`,
>   then `ManageRoles`, then `comparePositionTo(...) > 0`, with no owner branch anywhere.
>   On members the library *diverges*: `GuildMember#manageable` returns `true` immediately
>   when the client user owns the guild, so an owner bot skips the position comparison
>   there. Warden declines to model that divergence — over-refusing hands the agent an
>   actionable message, under-refusing is the raw 50013 this layer exists to pre-empt.
>   `Administrator` does **not** lift the position rule, so it remains a reported blocker
>   even for an admin bot.
> * The Administrator protection is action-specific, so Warden does not attribute it to
>   Discord uniformly. Timeout has a real Discord rule: `GuildMember#moderatable` is
>   `!Administrator && manageable && ModerateMembers`, and the docs for
>   `communication_disabled_until` say it 403s for an Administrator target. Ban has none —
>   `bannable` is just `manageable && BanMembers` — so refusing to ban an Administrator is
>   Warden policy, stricter than the API, in the same family as the `@everyone` refusal
>   above. Kick never passes the protection at all: `kickable` is hierarchy-only too, so
>   enabling it there would invent a restriction Discord does not have.
> * "cannot reorder below 0" is enforced by the `role.reorder` tool in Phase 7, not by this
>   layer: `Role#position` is recomputed from the cache and is never negative, so there is
>   no negative position here to observe. The negative value would arrive as the agent's
>   *requested* index, which belongs to the tool.

Any failure → the structured JSON above (`isError: true`). `errors.ts` is the safety net:
whatever DiscordAPIError still slips through (50013 Missing Permissions — which is also the code
Discord returns for role-hierarchy violations, since there is **no** distinct hierarchy code;
50001 Missing Access; 50024 wrong channel type; 40007 already banned; 40032 not in voice …) is
translated into the **same** shape, mapping error codes → `{error, message, remediation}`.
(Code meanings are grounded in `discord-api-types`' `RESTJSONErrorCodes` enum — see the table
in `src/discord/errors.ts`.)

**`dry_run`:** every mutating tool accepts optional `dry_run: true` (or honors
`WARDEN_DRY_RUN`) → runs the full preflight and returns `would_perform: {tool, params, checks: "all passed"}`
without executing. Agents can "ask first, act second".

---

## 7. Event system

### 7.1 Intents — ALL enabled

`Guilds, GuildMembers, GuildModeration, GuildExpressions, GuildIntegrations, GuildWebhooks,
GuildInvites, GuildVoiceStates, GuildPresences, GuildMessages, GuildMessageReactions,
GuildMessageTyping, DirectMessages, DirectMessageReactions, DirectMessageTyping,
MessageContent, GuildScheduledEvents, AutoModerationConfiguration, AutoModerationExecution,
GuildMessagePolls, DirectMessagePolls`

**Privileged intents** (`GuildMembers`, `Presence`, `MessageContent`) must be toggled in the
Discord developer portal → README walkthrough (with the >100-server verification warning).

### 7.2 Complete event inventory (~67 types — every one captured & normalized)

| Intent | Events |
|---|---|
| Meta | `READY`, `RESUMED`, `INTERACTION_CREATE`* , `APPLICATION_COMMAND_CREATE/UPDATE/DELETE` |
| GUILDS | `GUILD_CREATE`, `GUILD_UPDATE`, `GUILD_DELETE`, `GUILD_ROLE_CREATE`, `GUILD_ROLE_UPDATE`, `GUILD_ROLE_DELETE`, `CHANNEL_CREATE`, `CHANNEL_UPDATE`, `CHANNEL_DELETE`, `CHANNEL_PINS_UPDATE`, `THREAD_CREATE`, `THREAD_UPDATE`, `THREAD_DELETE`, `THREAD_LIST_SYNC`, `THREAD_MEMBER_UPDATE`, `THREAD_MEMBERS_UPDATE`, `STAGE_INSTANCE_CREATE`, `STAGE_INSTANCE_UPDATE`, `STAGE_INSTANCE_DELETE`, `VOICE_CHANNEL_STATUS_UPDATE`, `VOICE_CHANNEL_START_TIME_UPDATE` |
| GUILD_MEMBERS | `GUILD_MEMBER_ADD`, `GUILD_MEMBER_UPDATE`, `GUILD_MEMBER_REMOVE`, (+`THREAD_MEMBERS_UPDATE`) |
| GUILD_MODERATION | `GUILD_AUDIT_LOG_ENTRY_CREATE`, `GUILD_BAN_ADD`, `GUILD_BAN_REMOVE` |
| GUILD_EXPRESSIONS | `GUILD_EMOJIS_UPDATE`, `GUILD_STICKERS_UPDATE`, `GUILD_SOUNDBOARD_SOUND_CREATE`, `GUILD_SOUNDBOARD_SOUND_UPDATE`, `GUILD_SOUNDBOARD_SOUND_DELETE`, `GUILD_SOUNDBOARD_SOUNDS_UPDATE` |
| GUILD_INTEGRATIONS | `GUILD_INTEGRATIONS_UPDATE`, `INTEGRATION_CREATE`, `INTEGRATION_UPDATE`, `INTEGRATION_DELETE` |
| GUILD_WEBHOOKS | `WEBHOOKS_UPDATE` |
| GUILD_INVITES | `INVITE_CREATE`, `INVITE_DELETE` |
| GUILD_VOICE_STATES | `VOICE_STATE_UPDATE`, `VOICE_CHANNEL_EFFECT_SEND` |
| GUILD_PRESENCES | `PRESENCE_UPDATE` |
| GUILD_MESSAGES | `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE`, `MESSAGE_DELETE_BULK` |
| GUILD_MESSAGE_REACTIONS | `MESSAGE_REACTION_ADD`, `MESSAGE_REACTION_REMOVE`, `MESSAGE_REACTION_REMOVE_ALL`, `MESSAGE_REACTION_REMOVE_EMOJI` |
| GUILD_MESSAGE_TYPING | `TYPING_START` |
| DIRECT_MESSAGES | `MESSAGE_CREATE/UPDATE/DELETE`, `CHANNEL_PINS_UPDATE` (guildId = null) |
| DIRECT_MESSAGE_REACTIONS | `MESSAGE_REACTION_ADD/REMOVE/REMOVE_ALL/REMOVE_EMOJI` (DM) |
| DIRECT_MESSAGE_TYPING | `TYPING_START` (DM) |
| GUILD_SCHEDULED_EVENTS | `GUILD_SCHEDULED_EVENT_CREATE`, `…_UPDATE`, `…_DELETE`, `…_USER_ADD`, `…_USER_REMOVE` |
| AUTO_MODERATION_CONFIGURATION | `AUTO_MODERATION_RULE_CREATE`, `…_UPDATE`, `…_DELETE` |
| AUTO_MODERATION_EXECUTION | `AUTO_MODERATION_ACTION_EXECUTION` |
| POLLS | `MESSAGE_POLL_VOTE_ADD`, `MESSAGE_POLL_VOTE_REMOVE` (guild + DM) |

\* `INTERACTION_CREATE` is **observed only** (surfaced through the buffer so the agent can see
button/select submits happen) — Warden never responds to interactions (MCP-only decision).

discord.js emits camelCase names (`messageCreate`, `guildMemberAdd`, …); the normalizer
accepts both wire names and discord.js names so filters read naturally.

### 7.3 Normalized record

```jsonc
{ "seq": 1042, "id": "ev_1042", "at": "2026-09-27T16:20:11.412Z",
  "type": "messageCreate", "guildId": "…", "channelId": "…",
  "authorId": "…", "data": { /* compact payload: ids + content + key fields, no raw blobs */ } }
```

`serializers/` curates payload size: full objects for small ones (role, emoji, invite),
trimmed for big ones (message keeps id/content/author/attachments/embeds summary/mentions;
member keeps id/user/roles/nick/joinedAt; voice state keeps full triple).

### 7.4 Buffer + watches + waits (the anti-hammering design)

* **Ring buffer** (default 2000 events, `seq` monotonic) — covers bursts.
* **`watch`** creates a named session: `{name, filter, cursor=latestSeq}`.
  Filter: `types[]` (exact or `message*` wildcards), `guildId`, `channelId`, `authorId`,
  `targetId`, `messageId` (watch one specific message's edits/reactions/deletes),
  `sinceSeq`/`since` timestamp.
* **`read_watch`** returns only events `seq > cursor`, advances cursor, `[]` when idle —
  no repeated polling of unchanged data. Optional `block_ms` (≤ 25 000) long-polls until
  something matches or timeout (keeps every MCP client happy, well under 60 s timeouts).
* **`wait_for_event`** — one-shot: filter + `timeout_ms` (≤ 25 000) → first match or
  `{"timeout": true}`.
* **`get_events`** — non-blocking historical pull from the buffer with `sinceSeq`/`since`/`limit`
  — for "fetch what happened while I was away".
* Old history beyond the buffer → REST: `get_messages`, `search_messages`, `get_audit_log`.
* Watches are in-memory, auto-expire after 30 min idle, capped at `WARDEN_MAX_WATCHES`.

---

## 8. Complete tool catalog (~60 grouped tools)

Legend: 🟢 read-only · 🔴 mutation (preflight + optional `dry_run`) · all inputs zod-validated;
`guild_id` optional when `WARDEN_GUILD_ID` set; `reason` optional audit-log string on mutations.

### 8.1 Observe — `tools/observe.ts` (7)

| Tool | Op | Description / key inputs |
|---|---|---|
| `get_bot_status` | 🟢 | Gateway status, ws ping, ready-since, cached guilds, bot's top role per guild + **capability report**: permissions present, and known blockers (e.g. "role X above you") |
| `get_events` | 🟢 | Buffer pull: `filter`, `since_seq`/`since`, `limit` → events + `cursor` |
| `watch` | 🟢 | Create named watch: `name`, `filter` (types/guild/channel/author/messageId/…), `since?` → `watch_id`, initial cursor |
| `read_watch` | 🟢 | `watch_id`, `block_ms?`, `limit?` → new events only, advanced cursor, `idle: true` if none |
| `list_watches` | 🟢 | All watches: name, filter, cursor, last-read, idle time |
| `unwatch` | 🔴* | Remove a watch (`watch_id`) — *state change, not Discord |
| `wait_for_event` | 🟢 | One-shot blocking: `filter`, `timeout_ms ≤ 25000` |

### 8.2 Server & settings — `tools/guild.ts` + friends (10)

| Tool | Op | Description / key inputs |
|---|---|---|
| `get_server` | 🟢 | Guild overview: settings, features, counts, channels summary, vanity, mfa/nsfw level |
| `update_server` | 🔴 | PATCH guild: name, icon (base64), banner, description, afk timeout/channel, system channel + flags, verification level, default notifications, explicit content filter, discovery splash, etc. |
| `manage_vanity_url` | 🔴/🟢 | get/patch `vanity_url_code` (needs `MANAGE_GUILD` + feature) |
| `manage_welcome_screen` | 🔴/🟢 | get/patch: enabled, description, welcome_channels |
| `manage_onboarding` | 🔴/🟢 | get/put: prompts, default_channel_ids, enabled, mode (needs `MANAGE_GUILD`+`MANAGE_ROLES`) |
| `manage_widget` | 🟢/🔴 | get widget settings/JSON, patch enabled/channel |
| `manage_integration` | 🟢/🔴 | list guild integrations; delete one (twitch/youtube/…); `GUILD_INTEGRATIONS` events feed the buffer |
| `get_audit_log` | 🟢 | filters: `action_type`, `user_id`, `target_id`, `before` — map of Discord `AuditLogEvent` names provided in schema description |
| `manage_stage_instance` | 🔴/🟢 | create/update/close stage: channel, topic, privacy_level, discoverable |
| `manage_member_verification` | 🟢/🔴 | get/patch membership screening (verification gate): `enabled`, form `form_fields` — needs `MANAGE_GUILD` |

### 8.3 Channels — `tools/channels.ts` (4)

| Tool | Op | Description / key inputs |
|---|---|---|
| `manage_channel` | 🔴/🟢 | `action: list\|get\|create\|edit\|delete\|clone`. Create/edit fields for every type: text/forum/media/announcement/voice/stage/news — name, topic, position, parent, nsfw, slowmode, bitrate, user_limit, rtc_region (validated against `GET /voice/regions` fetched at startup), default_reaction_emoji, available_tags (forum), default_sort_order, permission_overwrites (on create), `invitable`, archived-thread edit; delete supports thread close |
| `manage_channel_permissions` | 🔴 | set/replace/delete overwrite for role or member: `allow[]`/`deny[]` as permission names (validated against `PermissionsBitField.Flags`) — preflight checks bot has those perms + role hierarchy of the overwrite target |
| `follow_channel` | 🔴 | announcement channel → follow into target channel (needs `MANAGE_WEBHOOKS` in target) |
| `set_voice_channel_status` | 🔴 | set/clear the voice channel's status text (`PUT /channels/{id}/voice-status`) — fires `VOICE_CHANNEL_STATUS_UPDATE` |

### 8.4 Threads — `tools/threads.ts` (1)

| Tool | Op | Description / key inputs |
|---|---|---|
| `manage_thread` | 🔴/🟢 | `action: create\|list\|list_archived\|edit\|delete\|join\|leave\|add_member\|remove_member\|get_member`. create: from_message_id \| standalone \| forum post (with message + applied_tags); edit: name, archived, locked, invitable, auto_archive_duration (60/1440/4320/10080), rate_limit_per_user, slowmode; list supports `public/private`, `archived`, `limit` |

### 8.5 Messages — `tools/messages.ts` (10)

| Tool | Op | Description / key inputs |
|---|---|---|
| `send_message` | 🔴 | content (≤2000), embeds (≤10), stickers[], allowed_mentions, tts, reply_to, nonce, **poll** (question, answers, duration, allow_multiselect), file `{name, media_type, base64}` attachments. *(components excluded — no interaction responder)* |
| `edit_message` | 🔴 | content/embeds/flags/attachments — original author or `MANAGE_MESSAGES`; poll close via flags |
| `delete_message` | 🔴 | own message or `MANAGE_MESSAGES`; supports threads/DMs |
| `bulk_delete_messages` | 🔴 | 2–100 ids, ≤ 2 weeks old (pre-check + clear 400 translation) |
| `crosspost_message` | 🔴 | announcement-channel fan-out |
| `manage_pins` | 🔴/🟢 | `action: pin\|unpin\|unpin_all\|list` (`get_pinned_messages` folded here — reads don't need preflight) |
| `manage_reactions` | 🔴/🟢 | `action: add\|remove\|remove_all\|remove_emoji` + `get_reaction_users` (user ids, paginate, filter guild/emoji) |
| `get_messages` | 🟢 | history: `before`/`after`/`around` snowflakes, `limit ≤ 100` — "fetch old messages" |
| `search_messages` | 🟢 | guild Content Search: `query`, `author_id`, `channel_id`, `offset`, `sort_by/sort_order`, `min_id/max_id` |
| `get_poll_results` | 🟢 | poll on a message: live answer counts, `expired`/`answered` state; optional `answer_id` → paginated list of voters (`GET …/polls/{id}/answers/{answer_id}`) |

### 8.6 Members — `tools/members.ts` (7)

| Tool | Op | Description / key inputs |
|---|---|---|
| `list_members` | 🟢 | pagination (`limit`, `after`), `query` (search endpoint), `role_id`, `in_voice`, `online` (via presence cache) |
| `get_member` | 🟢 | member detail + roles with positions + **effective permissions** + `hierarchy: {bot_vs_target}` verdict |
| `update_member` | 🔴 | nickname, avatar (base64), `voice_channel_id` (move / `null` = disconnect), deafen, mute — preflight: `MANAGE_MEMBERS`/`MOVE_MEMBERS` + hierarchy |
| `kick_member` | 🔴 | `MANAGE_MEMBERS` + hierarchy; owner/admin-protected |
| `timeout_member` | 🔴 | `action: set\|clear`, `duration_minutes ≤ 40320` (28d), reason — rejects Administrator targets, hierarchy-checked |
| `prune_members` | 🔴 | `days`, `roles[]`, `compute` (dry estimate) then `execute` — returns pruned count; preflight `KICK_MEMBERS` |
| `get_user` | 🟢 | global user object by id (REST, no guild needed) |

### 8.7 Bans — `tools/moderation.ts` (5)

| Tool | Op | Description / key inputs |
|---|---|---|
| `ban_member` | 🔴 | `delete_message_seconds ≤ 604800`, reason; preflight `BAN_MEMBERS` + hierarchy + owner check |
| `bulk_ban` | 🔴 | `user_ids[]` (≤ 100? Discord limit), shared message-deletion window → returns `banned_ids` / `failed_ids` |
| `unban_member` | 🔴 | by user id; `BAN_MEMBERS`; 404 → clear message |
| `list_bans` | 🟢 | paginated with user objects, `delete_message_seconds` |
| `manage_automod` | 🔴/🟢 | `action: list\|create\|edit\|delete`: name, enabled, `trigger_type` (KEYWORD/SPAM/KEYWORD_PRESET/MENTION_SPAM) + `trigger_metadata`, `actions[]` (BLOCK_MESSAGE/WARN/DELETE_MESSAGE/TIMEOUT/SEND_ALERT_MESSAGE/…), `exempt_roles/channels`, `event_types` — plus **execution events** visible via `get_events` (`autoModerationActionExecution`) |

### 8.8 Roles — `tools/roles.ts` (3)

| Tool | Op | Description / key inputs |
|---|---|---|
| `manage_role` | 🔴/🟢 | `action: list\|create\|edit\|delete` — name, colors (via `parseColor`/hex), hoist, mentionable, `permissions[]` (names), icon/unicode_emoji. Preflight: `MANAGE_ROLES`; cannot touch `@everyone`/managed; **cannot edit roles ≥ bot top position**; cannot grant perms Warden lacks |
| `assign_roles` | 🔴 | `action: add\|remove\|set` on a member — hierarchy: target's highest role vs bot's top role; self-role edge cases reported |
| `reorder_roles` | 🔴 | `positions: [{id, position}]` — cannot move above own top role |

### 8.9 Webhooks — `tools/webhooks.ts` (2)

| Tool | Op | Description / key inputs |
|---|---|---|
| `manage_webhook` | 🔴/🟢 | `action: list\|create\|edit\|delete` — name, avatar, channel; returns token only when Warden has `MANAGE_WEBHOOKS`; preflight per channel |
| `execute_webhook` | 🔴 | content/embeds/username/avatar_url/tts/`wait`, optional `thread_id` — no webhook token needed if Warden has `MANAGE_WEBHOOKS` |

### 8.10 Expressions — `tools/expressions.ts` (3)

| Tool | Op | Description / key inputs |
|---|---|---|
| `manage_emoji` | 🔴/🟢 | list/create (base64 image ≤256kb)/edit (name, roles)/delete — perms `CREATE_GUILD_EXPRESSION`/`MANAGE_GUILD_EXPRESSIONS` |
| `manage_sticker` | 🔴/🟢 | list/create (base64, name, description, tags, format_type)/edit/delete |
| `manage_soundboard` | 🔴/🟢 | `action: list\|create\|edit\|delete\|send` — data-uri sound ≤ 512kb / ≤ 5.2 s, volume, emoji; `send` posts a soundboard sound into a channel |

### 8.11 Invites — `tools/invites.ts` (1)

| Tool | Op | Description / key inputs |
|---|---|---|
| `manage_invites` | 🔴/🟢 | `action: list\|create\|delete\|get` — get: fetch any invite by code with counts/expiry (`GET /invites/{code}`); create: max_age, max_uses, temporary, target_type (stream/event/application), target_user_id, `role_ids[]` (community auto-assign), `with_counts`; delete needs `MANAGE_GUILD`/`MANAGE_CHANNELS` |

### 8.12 Scheduled events — `tools/scheduled-events.ts` (1)

| Tool | Op | Description / key inputs |
|---|---|---|
| `manage_scheduled_event` | 🔴/🟢 | `action: list\|get\|create\|edit\|delete\|start\|end\|subscribe\|unsubscribe\|list_users` — name, description, entity_type (STAGE/VOICE/EXTERNAL), channel, start/end time, location (external), cover image base64, privacy_level, `invite_user_id` for subscriber events; subscribe = track user RSVP; `list_users` = who's interested (`GET …/users`) — `GUILD_SCHEDULED_EVENT_USER_*` events also observed |

### 8.13 Templates — `tools/templates.ts` (1)

| Tool | Op | Description / key inputs |
|---|---|---|
| `manage_guild_templates` | 🔴/🟢 | `action: list\|create\|get\|edit\|delete\|sync` — name/description; sync pushes current guild state to template (owner-only) |

### 8.14 Bot's own account — `tools/bot-account.ts` (4)

| Tool | Op | Description / key inputs |
|---|---|---|
| `manage_bot_account` | 🟢/🔴 | `action: get\|update` — current user object (id, avatar, flags); update: username, avatar (base64), banner/color (self OAuth on the bot user) |
| `manage_my_guilds` | 🟢/🔴 | `action: list\|leave` — every guild the bot is in (id, name, owner, counts, permissions int); leave = `DELETE /users/@me/guilds/{id}` |
| `send_dm` | 🔴 | open (or reuse) the DM channel for `user_id` and send — content/embeds/file/poll same shape as `send_message`; fails clearly if the user blocks DMs (`cannot_send` with remediation) |
| `set_own_nickname` | 🔴 | change Warden's own nickname in a guild (`PATCH /guilds/{id}/members/@me`) — no permission required, **not** hierarchy-blocked; distinct from `update_member` (which edits others and is hierarchy-checked) |

**Tool count: 7 + 10 + 4 + 1 + 10 + 7 + 5 + 3 + 2 + 3 + 1 + 1 + 1 + 4 = 59**, plus any split during
implementation lands us ~59–63. Each tool schema carries a one-line description written for
*agents* (what it does, which permission it needs, common failure modes).

> **Phase 6 implementation notes** (the read half of this catalog — 8 → 17 registered tools):
>
> * **Shipped exactly the 🟢 halves**: `get_audit_log`, `manage_channel` (list|get),
>   `manage_thread` (list|list_archived|get_member), `manage_role` (list), `list_members`,
>   `get_member`, `get_user`, `get_messages`, `search_messages`. Every 🔴 action is its
>   later phase (7–10); `get_poll_results` is Phase 7's. Reads run no §6 preflight but do
>   use §6's resolvers, so an unknown guild/channel is the same structured `not_found`
>   a mutation would give.
> * **`readOk()` vs `ok()` (§4)**: every read success deep-scrubs *all* payload strings —
>   data **and** notes — then returns; `ok()` deliberately does not scrub, because success
>   payloads are meant to carry already-curated serializer output. Tests pin a
>   token-shaped channel topic / role name / message body coming out redacted on each new
>   read path. `attempt()` wraps every REST call so a throw lands as the uniform
>   `WardenError`, never as "the tool threw".
> * **`list_members` reads the gateway cache, `query` goes to REST** — `role_id`,
>   `in_voice` and `online` are cache-only predicates (Discord's list endpoint filters on
>   none of them). The partial-cache and cache-filter disclosures live in `notes`, which
>   is *mandatory* here: tests caught the array being built and never handed to `readOk`,
>   which would report a short list as complete — the exact failure the module header
>   forbids.
> * **One snowflake comparator for every id order** — `compareSnowflakes` in
>   `shared/ids.ts` (length-first, then lexicographic). The review caught the bug it
>   exists for: `list_members` sorted length-first but filtered `after` lexicographically,
>   so a page whose cursor started with a high digit silently dropped every id of a
>   different length — an agent reads that hole as "no more members". Sort *and* filter
>   (and `byNewest`, `newestFirst`, the search-path sort) now share it.
> * **Cursors are two shapes** (`optionalCursor`, the third zod field builder): a
>   snowflake for message/audit paging, an ISO8601 `archive_timestamp` for the
>   archived-thread routes — Discord does not agree with itself. `parseCursorTime` proves
>   *validity*, not just shape: `Date.parse` rolls impossible dates forward
>   (`2024-02-30` → March 1) and returns NaN otherwise, and the conversion ran outside
>   `attempt()` where a throw would escape unstructured.
> * **`list_archived` answers two discord.js traps in the payload** (file header has the
>   source): `before` is resolved by hand because discord.js *drops* an id it cannot
>   cache-lookup (`if (toUse) query.set(...)`) — a restart-era cursor would re-serve page
>   one forever, so a miss is an `invalid_input` naming `archiveTimestamp` instead; and
>   `private` passes `fetchAll: true` because the default route only lists threads the
>   *bot* joined. Results keep Discord's `archive_timestamp`-desc order (not id order —
>   the last element must be the page minimum) and carry `nextBefore` for paging.
> * **`get_audit_log` forwards `executorId` explicitly** — the serializer falls back to
>   the executor *object*, which is null for a user discord.js could not resolve; the id
>   is the one field whose job is "who did this" surviving a partial user. A review-found
>   regression test pins both directions (executor present / absent).
> * **`search_messages` is a raw-route adapter**: Discord has no discord.js wrapper for
>   guild search, so `toMessageLike` maps wire `APIMessage` → the structural shape the
>   existing serializers read (one mapping, one caller). `hits` are flat messages —
>   installed `discord-api-types` documents that a group's "surrounding context is no
>   longer returned", so match-vs-context is decided by the wire's `hit` marker when
>   present, never by position. `doing_deep_historical_index` becomes a note (partial
>   results must not read as complete), and the 202 index-not-ready body is a *success*
>   with `ready: false` + retry delay, not a failure and not "no matches".
> * **Test shape**: `test/read-tools.test.ts` stubs each REST read at its narrowest seam
>   (`rest.get`, `members.search`, `users.fetch`, `threads.fetchArchived`) against real
>   discord.js objects from `test/fixtures.ts` (extracted so both tool suites share one
>   guild world). The `list_archived` cursor tests exist because discord.js silently
>   drops a bad `before` — a happy-path suite would never notice.

> **Phase 6 re-review notes** (two review passes; each caught defect pinned by a test):
>
> * **The `after` pagination blocker**: `list_members` sorted length-first but filtered
>   lexicographically — a page whose cursor began with a high digit dropped every id of a
>   different length, reading as "end of list". `compareSnowflakes` (`shared/ids.ts`) is
>   now the one comparator for every id sort *and* filter; the regression test pages an
>   18-digit cursor past a 19-digit member.
> * **A shape-valid cursor could still throw**: `isCursor` proves shape, not date —
>   `Date.parse` rolls `2024-02-30` forward and answers NaN otherwise, and the conversion
>   ran outside `attempt()` where a `RangeError` escapes unstructured. `parseCursorTime`
>   does the round-trip check; both failure shapes assert `invalid_input` with the REST
>   spy never called.
> * **`list_archived`'s own note broke its paging contract**: results were re-sorted by
>   id while the note told agents to page by `archiveTimestamp` — the last element was
>   not the page minimum. Archive-desc order plus an explicit `nextBefore` field, and the
>   `list` "page is full" note now fires only on *truncation* (`matching > returned`),
>   never on a page that merely happens to be full.
> * **`search_messages` claimed context Discord no longer sends**: the installed types
>   document "surrounding context is no longer returned", so hits are flat messages with
>   the wire's `hit` marker preferred *per group* — a global marker rule would silently
>   drop unmarked groups, the blocker's shape again. `doing_deep_historical_index`
>   became a note instead of being ignored.
> * **A comment claimed microsecond cursor preservation the wire never gets**: discord.js'
>   `fetchArchived` re-encodes any non-snowflake `before` with `toISOString()`. Warden
>   passes cursors through untouched, but the ms ceiling sits at the library boundary —
>   the comments now say exactly that.
> * **Verdict**: round 1 REQUEST CHANGES (1 blocker + 5 should-fix) → all resolved →
>   round 2 **APPROVE WITH FIXES** (no blockers), its remaining items fixed above.
> * **§12 done-when met**: schema introspection green (17-tool canary + §11 tests) and
>   **live reads verified** against a real guild — every Phase 6 read answered with data
>   (channels, threads, roles, members, member/user, messages with the full-page note,
>   audit entries with executor ids), search seen in *both* its 202-indexing state and
>   `ready:true` (3756 results), `list_archived` exercised on a real parent, and
>   `get_member` returning §6's `target_protected` self-refusal live.

---

## 9. Error model (single source of truth)

```ts
type WardenError = {
  ok: false;
  error: 'not_ready' | 'missing_permission' | 'role_hierarchy' | 'target_protected'
       | 'invalid_input' | 'not_found' | 'rate_limited' | 'discord_api' | 'internal';
  message: string;             // human-readable, names names & positions
  discordCode?: number;         // raw Discord error code if any
  missingPermissions?: string[];
  bot?: { role: string; position: number };
  target?: { role: string; position: number } | { user: string; protected: string };
  remediation: string;          // what the operator should change
  details?: Record<string, unknown>;
};
```

Mapped from: preflight checks (primary) and DiscordAPIError (fallback). Unit-tested against
the known code table in `src/discord/errors.ts` (50001, 50013, 50014, 50021, 50024, 50035,
40007, 40032, 40033, 40058, 30033, 50007, …), every entry checked against `discord-api-types`'
`RESTJSONErrorCodes`. Two earlier plan-era entries were wrong and are gone: **30034** is
"too many application commands created", not "already banned" (that is 40007), and **50024** is
"wrong channel type", not hierarchy (hierarchy is reported as 50013).

---

## 10. Packaging & self-hosting (open source)

**package.json essentials**
```jsonc
{
  "name": "warden-discord-mcp",
  "version": "0.1.0",
  "type": "module",
  "bin": { "warden-discord-mcp": "dist/index.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc", "typecheck": "tsc --noEmit",
    "lint": "eslint .", "test": "vitest run",
    "dev": "tsc --watch", "prepublishOnly": "npm run typecheck && npm run lint && npm test && npm run build"
  }
}
```

**User setup (README walkthrough)**
1. Discord Developer Portal → New Application → Bot → **reset token** → copy token.
2. Enable privileged intents: *Server Members*, *Presence*, *Message Content*.
3. OAuth2 URL Generator: scopes `bot` (+`applications.commands` future-proofing) → invite with
   Administrator **or** the granular permission list Warden needs (list printed in README;
   Administrator recommended for "full control" with the hierarchy caveat explained).
4. Paste into MCP client config:

```jsonc
// opencode (~/.config/opencode/opencode.json) or Claude Desktop
{ "mcpServers": { "warden": {
    "command": "npx", "args": ["-y", "warden-discord-mcp"],
    "env": { "DISCORD_BOT_TOKEN": "…", "WARDEN_GUILD_ID": "… (optional)" } } } }
```

**Open-source hygiene:** MIT `LICENSE`, `README` (badges, screenshots/GIF later),
`CONTRIBUTING.md`, `.env.example`, no telemetry, no phone-home, conventional commits,
GitHub Actions CI, `npm pack` dry-run verified before publish. Publishing to npm = only when
you say so.

---

## 11. Testing strategy

| Layer | How |
|---|---|
| `guards.test.ts` | Table-driven matrix with mock `Guild`/`GuildMember`/`Role` fixtures: bot top role vs target role/member, owner, administrator target, managed roles, missing channel perms, overwrite nuances — assert exact `error` + `remediation` |
| `bus.test.ts` | ring wrap-around, monotonic seq, filter matching (wildcards, channel/guild/author/message), `since` semantics |
| `watches.test.ts` | cursor advance, no-double-delivery, idle empty reads, `block_ms` resolves early on match, expiry, max-watch cap |
| `errors.test.ts` | synthetic `DiscordAPIError`s → expected `WardenError` |
| `normalize.test.ts` | one fixture per event type (all 67) → valid `NormalizedEvent`, payload trimming rules |
| Tool schema tests | every `registerTool` has description + valid zod schema (introspection test) |
| Manual smoke | real token: status → send/edit/delete → role move attempt on higher role → **assert hierarchy error output** → watch a channel live |

---

## 12. Implementation phases

| # | Phase | Deliverables | Done when |
|---|---|---|---|
| 1 | **Scaffold** | package.json, tsconfig (strict/NodeNext), eslint, vitest, .gitignore, LICENSE (MIT), .env.example, logger.ts, config.ts | `npm run typecheck` passes on empty skeleton |
| 2 | **Discord core** | `discord/client.ts` (all intents, ready-wait, ping), `errors.ts`, `serializers/` | unit tests for errors pass; client connects with real token |
| 3 | **Guards** | `guards.ts` full preflight matrix + `shared/result.ts` | guard matrix tests green |
| 4 | **MCP skeleton** | `server.ts`, `index.ts`, `serveStdio`, tools `get_bot_status` + `get_server` | `npx` run in opencode shows status tool working |
| 5 | **Event system** | `events/*` (normalize all 67, bus, watches) + observe tools (7) | bus/watch/normalize tests green; live message appears in `read_watch` |
| 6 | **Read tools** | guild/channels/threads/roles/members/messages/audit (~14 tools) | schema introspection test green; live reads verified |
| 7 | **Messages & threads** | send/edit/delete/bulk/crosspost/pins/reactions/poll results/manage_thread (12) | live round-trip in a test channel |
| 8 | **Moderation** | kick/timeout/prune/bans/automod + update_member (8) | hierarchy errors verified live against higher role |
| 9 | **Structure** | roles/channels/permissions/voice-status/webhooks/follow (8) | overwrite + hierarchy cases tested |
| 10 | **Long tail** | expressions/soundboard/invites(+get)/scheduled events(+list_users)/stage/templates/integrations/vanity/welcome/onboarding/widget/member-verification/update_server + **bot account group** (profile, my guilds, DM, own nickname) (20) | schema + dry-run smoke each |
| 11 | **Docs & release** | README (setup, intents, tool catalog, event catalog, error contract), CONTRIBUTING, `npm pack` dry-run, CI workflow | pack contains only `dist` + docs; README walkthrough reproducible |
| 12 | **Verify** | full `typecheck` + `lint` + `vitest`, live smoke test with your token | all green |

**Out of scope (documented as future work):** HTTP/SSE transport · slash-command preset
registration & interaction responses (buttons/selects/modals) · voice audio streaming
(`@discordjs/voice`) — voice *state events* and member moves are in scope · sharding
(single-guild self-host doesn't need it) · persistent storage (all state is in-memory).

---

## 13. Final verification checklist

- [ ] `npm run typecheck` — 0 errors
- [ ] `npm run lint` — 0 errors
- [ ] `npm test` — all suites green (guards, bus, watches, errors, normalize, schemas)
- [ ] `npm pack --dry-run` — only dist + README + LICENSE
- [ ] Live: `get_bot_status` returns ready + capability report
- [ ] Live: `send_message` → `get_messages` round-trip
- [ ] Live: mutation against higher role → structured `role_hierarchy` error with remediation
- [ ] Live: `watch` → activity in channel → `read_watch` returns it once; second read idle
- [ ] Live: `wait_for_event` times out cleanly at `timeout_ms`
- [ ] Token never appears in any log line or tool output
- [ ] README walkthrough followed from a clean machine reaches "tools listed in client" 
