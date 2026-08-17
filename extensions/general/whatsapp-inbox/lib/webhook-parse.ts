/**
 * Zod parser for the Meta Cloud API webhook envelope (already signature
 * verified). Extracts messages[] and statuses[] from
 * entry[].changes[].value and flattens them for the dispatcher.
 *
 * Contract: NEVER throws. Anything that does not match the envelope parses to
 * an empty result; any single message that does not match a known shape
 * becomes type 'unknown' (a safe skip) rather than failing the batch. Meta
 * adds message types over time and a new type must not take down intake for
 * the whole webhook delivery.
 */

import { z } from 'zod'

const MediaSchema = z.object({
  id: z.string().min(1),
  mime_type: z.string().max(120).optional(),
  sha256: z.string().max(200).optional(),
  filename: z.string().max(500).optional(),
  caption: z.string().max(4096).optional(),
  voice: z.boolean().optional(),
})

const InteractiveReplySchema = z.object({
  id: z.string().min(1).max(256),
  title: z.string().max(1024).optional(),
})

// Permissive per-message schema: `type` is an open string and per-type payloads
// are all optional, so an unexpected combination degrades instead of failing.
const MessageSchema = z.object({
  from: z.string().min(1).max(30),
  id: z.string().min(1).max(200),
  timestamp: z.string().max(30).optional(),
  type: z.string().max(40),
  text: z.object({ body: z.string().max(65536) }).optional(),
  image: MediaSchema.optional(),
  document: MediaSchema.optional(),
  audio: MediaSchema.optional(),
  video: MediaSchema.optional(),
  sticker: MediaSchema.optional(),
  interactive: z
    .object({
      type: z.string().max(40).optional(),
      button_reply: InteractiveReplySchema.optional(),
      list_reply: InteractiveReplySchema.optional(),
    })
    .optional(),
  context: z.object({ id: z.string().max(200).optional() }).optional(),
})

const StatusSchema = z.object({
  id: z.string().min(1).max(200),
  status: z.string().max(40),
  // Present on 'failed' statuses: the only record of WHY a message never
  // reached the recipient (undeliverable, blocked, re-engagement needed).
  errors: z
    .array(
      z.object({
        code: z.union([z.number(), z.string()]).optional(),
        title: z.string().max(300).optional(),
        message: z.string().max(300).optional(),
      }),
    )
    .optional(),
})

const ContactSchema = z.object({
  wa_id: z.string().max(30).optional(),
  profile: z.object({ name: z.string().max(200).optional() }).optional(),
})

const EnvelopeSchema = z.object({
  object: z.string().optional(),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              field: z.string().optional(),
              value: z
                .object({
                  messages: z.array(z.unknown()).optional(),
                  statuses: z.array(z.unknown()).optional(),
                  contacts: z.array(z.unknown()).optional(),
                })
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
})

export type ParsedMessageType =
  | 'text'
  | 'image'
  | 'document'
  | 'audio'
  | 'video'
  | 'sticker'
  | 'location'
  | 'contacts'
  | 'interactive'
  | 'unknown'

export interface ParsedMedia {
  id: string
  mime: string | null
  sha256: string | null
  filename: string | null
  voice: boolean
}

export interface ParsedInboundMessage {
  wamid: string
  from: string
  timestamp: string | null
  type: ParsedMessageType
  /** Body for text messages. */
  text: string | null
  /** Caption for media messages. */
  caption: string | null
  media: ParsedMedia | null
  /** Interactive answer payload: the tapped button's/row's id (company_id). */
  interactiveReplyId: string | null
  /** Quoted-reply target (context.id), when present. */
  contextWamid: string | null
  profileName: string | null
  /** The raw value.messages[i] object, persisted verbatim for known senders. */
  raw: unknown
}

export interface ParsedStatus {
  wamid: string
  status: string
  /** Compact "code: title" from the first status error, when Meta sent one. */
  errorDetail: string | null
}

export interface ParsedWebhook {
  messages: ParsedInboundMessage[]
  statuses: ParsedStatus[]
}

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  'text',
  'image',
  'document',
  'audio',
  'video',
  'sticker',
  'location',
  'contacts',
  'interactive',
])

function toParsedMessage(
  raw: unknown,
  profileNames: Map<string, string>,
): ParsedInboundMessage | null {
  const parsed = MessageSchema.safeParse(raw)
  if (!parsed.success) return null
  const msg = parsed.data

  const type: ParsedMessageType = KNOWN_TYPES.has(msg.type)
    ? (msg.type as ParsedMessageType)
    : 'unknown'

  const mediaSource =
    type === 'image'
      ? msg.image
      : type === 'document'
        ? msg.document
        : type === 'audio'
          ? msg.audio
          : type === 'video'
            ? msg.video
            : type === 'sticker'
              ? msg.sticker
              : undefined

  return {
    wamid: msg.id,
    from: msg.from,
    timestamp: msg.timestamp ?? null,
    type,
    text: type === 'text' ? (msg.text?.body ?? null) : null,
    caption: mediaSource?.caption ?? null,
    media: mediaSource
      ? {
          id: mediaSource.id,
          mime: mediaSource.mime_type ?? null,
          sha256: mediaSource.sha256 ?? null,
          filename: mediaSource.filename ?? null,
          voice: mediaSource.voice === true,
        }
      : null,
    interactiveReplyId:
      type === 'interactive'
        ? (msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id ?? null)
        : null,
    contextWamid: msg.context?.id ?? null,
    profileName: profileNames.get(msg.from) ?? null,
    raw,
  }
}

/**
 * Parse a verified webhook body. Returns flattened messages and statuses in
 * arrival order. Never throws; unparseable input yields empty arrays.
 */
export function parseWebhookEnvelope(body: unknown): ParsedWebhook {
  const result: ParsedWebhook = { messages: [], statuses: [] }

  const envelope = EnvelopeSchema.safeParse(body)
  if (!envelope.success) return result

  for (const entry of envelope.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value
      if (!value) continue

      const profileNames = new Map<string, string>()
      for (const rawContact of value.contacts ?? []) {
        const contact = ContactSchema.safeParse(rawContact)
        if (contact.success && contact.data.wa_id && contact.data.profile?.name) {
          profileNames.set(contact.data.wa_id, contact.data.profile.name)
        }
      }

      for (const rawMessage of value.messages ?? []) {
        const parsed = toParsedMessage(rawMessage, profileNames)
        if (parsed) result.messages.push(parsed)
      }

      for (const rawStatus of value.statuses ?? []) {
        const parsed = StatusSchema.safeParse(rawStatus)
        if (!parsed.success) continue
        const firstError = parsed.data.errors?.[0]
        const errorDetail = firstError
          ? [firstError.code, firstError.title ?? firstError.message]
              .filter((part) => part != null && String(part).length > 0)
              .join(': ')
              .slice(0, 300) || null
          : null
        result.statuses.push({ wamid: parsed.data.id, status: parsed.data.status, errorDetail })
      }
    }
  }

  return result
}
