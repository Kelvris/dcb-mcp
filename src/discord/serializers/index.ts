/**
 * discord.js objects → compact JSON (plan §7.3): full objects for the small
 * entities (role, emoji, invite), trimmed ones for the big ones (message keeps
 * id/content/author/attachments/embeds/mentions, member keeps
 * id/user/roles/nick/joinedAt, voice state keeps its full triple).
 *
 * One module per domain, with `shared.ts` holding the primitives every entity
 * serializer needs. The dependency direction is strictly one-way — entity
 * modules import `shared.ts`, three of them also import `members.ts`, and none
 * reaches into another's internals — which is what lets this file re-export
 * all of them without a cycle.
 *
 * `internal.ts` holds the remaining helpers (`iso`, `valuesOf`, `channelCounts`,
 * …). It is deliberately **not** re-exported here: it is how the serializers
 * are built, not an API a caller should reach for. The only two names allowed
 * out are `BitFieldSource` and `CacheLike`, because they appear in public
 * signatures — `shared.ts` re-exports those.
 *
 * Two contracts keep the set honest *and* testable without a gateway:
 *
 * - Inputs are structural `*Like` shapes rather than discord.js classes, so a
 *   freshly constructed discord.js instance and a hand-written fixture both
 *   satisfy them. The tests deliberately pass real discord.js objects: that
 *   is what pins every field name here to the library instead of to whatever
 *   the fixtures happen to repeat.
 * - Output keys are Discord-API camelCase. `null` means "Discord says none"
 *   (discord.js itself reports missing message fields as `null`, so a partial
 *   delete and a real empty field are not confused), while a key that does
 *   not apply to the object at all — a `topic` on a voice channel — is
 *   dropped by {@link compact} instead of being reported as a value.
 *
 * Secrets never leave the set: webhook `token` and `url` are omitted, and the
 * URL would be just as bad because it embeds the token.
 */

export * from "./channels.js";
export * from "./guilds.js";
export * from "./members.js";
export * from "./messages.js";
export * from "./presence.js";
export * from "./shared.js";
