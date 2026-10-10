/**
 * Messages and the shapes they carry: embeds, attachments and polls.
 *
 * The trimmest serializer in the set — a message is the one payload agents
 * fetch in bulk, so it keeps id/content/author/attachments/embeds/mentions
 * and drops the rest.
 */

import { iso, toHexColor, valuesOf } from "./internal.js";
import type { SerializedUser, UserLike } from "./members.js";
import { serializeUser } from "./members.js";
import type { BitFieldSource, CacheLike } from "./shared.js";
import { idList, serializeBitField } from "./shared.js";

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

export interface EmbedAuthorLike {
  name?: string;
  url?: string | null;
  iconURL?: string | null;
}

export interface EmbedFooterLike {
  text?: string;
  iconURL?: string | null;
}

export interface EmbedAssetLike {
  url?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface EmbedFieldLike {
  name?: string;
  value?: string;
  inline?: boolean;
}

export interface EmbedLike {
  title?: string | null;
  description?: string | null;
  url?: string | null;
  color?: number | null;
  hexColor?: string | null;
  timestamp?: string | null;
  author?: EmbedAuthorLike | null;
  footer?: EmbedFooterLike | null;
  image?: EmbedAssetLike | null;
  thumbnail?: EmbedAssetLike | null;
  video?: EmbedAssetLike | null;
  provider?: { name?: string; url?: string | null } | null;
  fields?: readonly EmbedFieldLike[];
}

export interface SerializedEmbed {
  title: string | null;
  description: string | null;
  url: string | null;
  color: number | null;
  hexColor: string | null;
  timestamp: string | null;
  author: { name: string; url: string | null; iconUrl: string | null } | null;
  footer: { text: string; iconUrl: string | null } | null;
  image: { url: string; width: number | null; height: number | null } | null;
  thumbnail: {
    url: string;
    width: number | null;
    height: number | null;
  } | null;
  video: { url: string; width: number | null; height: number | null } | null;
  provider: { name: string | null; url: string | null } | null;
  fields: { name: string; value: string; inline: boolean }[];
}

function serializeEmbedAsset(
  asset: EmbedAssetLike | null | undefined,
): SerializedEmbed["image"] {
  if (!asset) return null;
  return {
    url: asset.url ?? "",
    width: asset.width ?? null,
    height: asset.height ?? null,
  };
}

/** Embed summary — the raw APIEmbed is small, but its proxy URLs and null padding are not. */
export function serializeEmbed(embed: EmbedLike): SerializedEmbed {
  const author = embed.author;
  const footer = embed.footer;
  const provider = embed.provider;
  return {
    title: embed.title ?? null,
    description: embed.description ?? null,
    url: embed.url ?? null,
    color: embed.color ?? null,
    hexColor: embed.hexColor ?? toHexColor(embed.color),
    timestamp: iso(embed.timestamp) ?? null,
    author: author
      ? {
          name: author.name ?? "",
          url: author.url ?? null,
          iconUrl: author.iconURL ?? null,
        }
      : null,
    footer: footer
      ? { text: footer.text ?? "", iconUrl: footer.iconURL ?? null }
      : null,
    image: serializeEmbedAsset(embed.image),
    thumbnail: serializeEmbedAsset(embed.thumbnail),
    video: serializeEmbedAsset(embed.video),
    provider: provider
      ? { name: provider.name ?? null, url: provider.url ?? null }
      : null,
    fields: (embed.fields ?? []).map((field) => ({
      name: field.name ?? "",
      value: field.value ?? "",
      inline: field.inline ?? false,
    })),
  };
}

export interface AttachmentLike {
  id: string;
  name?: string;
  size?: number;
  url?: string;
  proxyURL?: string;
  contentType?: string | null;
  width?: number | null;
  height?: number | null;
  description?: string | null;
  ephemeral?: boolean;
  duration?: number | null;
}

export interface SerializedAttachment {
  id: string;
  filename: string | null;
  size: number | null;
  url: string | null;
  proxyUrl: string | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  description: string | null;
  ephemeral: boolean | null;
  duration: number | null;
}

export function serializeAttachment(
  attachment: AttachmentLike,
): SerializedAttachment {
  return {
    id: attachment.id,
    // discord.js calls it `name`; Discord's attachment object calls it `filename`.
    filename: attachment.name ?? null,
    size: attachment.size ?? null,
    url: attachment.url ?? null,
    proxyUrl: attachment.proxyURL ?? null,
    contentType: attachment.contentType ?? null,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    description: attachment.description ?? null,
    ephemeral: attachment.ephemeral ?? null,
    duration: attachment.duration ?? null,
  };
}

export interface PollAnswerLike {
  id?: number;
  text?: string | null;
  voteCount?: number;
}

export interface PollLike {
  question?: { text?: string | null } | null;
  answers?: CacheLike;
  expiresTimestamp?: number | null;
  allowMultiselect?: boolean;
  layoutType?: number;
  resultsFinalized?: boolean;
}

export interface SerializedPoll {
  question: string | null;
  answers: { id: number | null; text: string | null; votes: number | null }[];
  expiresAt: string | null;
  allowMultiselect: boolean | null;
  layoutType: number | null;
  finalized: boolean | null;
}

export function serializePoll(poll: PollLike): SerializedPoll {
  const answers = valuesOf(poll.answers).map((value) => {
    const answer = (value ?? {}) as PollAnswerLike;
    return {
      id: answer.id ?? null,
      text: answer.text ?? null,
      votes: answer.voteCount ?? null,
    };
  });
  return {
    question: poll.question?.text ?? null,
    answers,
    expiresAt: iso(poll.expiresTimestamp) ?? null,
    allowMultiselect: poll.allowMultiselect ?? null,
    layoutType: poll.layoutType ?? null,
    finalized: poll.resultsFinalized ?? null,
  };
}

export interface MessageMentionsLike {
  everyone?: boolean;
  users?: CacheLike;
  roles?: CacheLike;
  channels?: CacheLike;
  repliedUser?: UserLike | null;
}

export interface MessageLike {
  id: string;
  channelId: string;
  guildId?: string | null;
  type?: number | null;
  createdTimestamp?: number | null;
  editedTimestamp?: number | null;
  author?: UserLike | null;
  content?: string | null;
  pinned?: boolean | null;
  tts?: boolean | null;
  webhookId?: string | null;
  flags?: BitFieldSource;
  attachments?: CacheLike;
  embeds?: readonly EmbedLike[];
  mentions?: MessageMentionsLike;
  stickers?: CacheLike;
  reference?: {
    messageId?: string | null;
    channelId?: string;
    guildId?: string | null;
  } | null;
  poll?: PollLike | null;
}

/**
 * Trimmed message (plan §7.3). Everything Discord reports as `null` stays
 * `null` — that is how discord.js renders a partial (uncached) message too,
 * so a `messageDelete` payload never invents content it doesn't have.
 */
export interface SerializedMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  type: number | null;
  timestamp: string | null;
  editedTimestamp: string | null;
  author: SerializedUser | null;
  content: string | null;
  pinned: boolean | null;
  tts: boolean | null;
  webhookId: string | null;
  flags: string[];
  attachments: SerializedAttachment[];
  embeds: SerializedEmbed[];
  mentions: {
    everyone: boolean;
    users: string[];
    roles: string[];
    channels: string[];
    repliedUserId: string | null;
  };
  stickers: string[];
  reference: {
    messageId: string | null;
    channelId: string | null;
    guildId: string | null;
  } | null;
  poll: SerializedPoll | null;
}

export function serializeMessage(message: MessageLike): SerializedMessage {
  const mentions = message.mentions;
  const reference = message.reference;
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId ?? null,
    type: message.type ?? null,
    timestamp: iso(message.createdTimestamp) ?? null,
    editedTimestamp: iso(message.editedTimestamp) ?? null,
    author: message.author ? serializeUser(message.author) : null,
    content: message.content ?? null,
    pinned: message.pinned ?? null,
    tts: message.tts ?? null,
    webhookId: message.webhookId ?? null,
    flags: serializeBitField(message.flags),
    attachments: valuesOf(message.attachments).flatMap((value) => {
      const attachment = value as AttachmentLike | undefined;
      return attachment === undefined || typeof attachment.id !== "string"
        ? []
        : [serializeAttachment(attachment)];
    }),
    embeds: (message.embeds ?? []).map((embed) => serializeEmbed(embed)),
    mentions: {
      everyone: mentions?.everyone ?? false,
      users: idList(mentions?.users),
      roles: idList(mentions?.roles),
      channels: idList(mentions?.channels),
      repliedUserId: mentions?.repliedUser?.id ?? null,
    },
    stickers: idList(message.stickers),
    reference: reference
      ? {
          messageId: reference.messageId ?? null,
          channelId: reference.channelId ?? null,
          guildId: reference.guildId ?? null,
        }
      : null,
    poll: message.poll ? serializePoll(message.poll) : null,
  };
}
