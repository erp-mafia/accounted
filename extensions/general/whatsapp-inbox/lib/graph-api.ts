/**
 * Meta Cloud API (Graph v26.0) client for the WhatsApp channel.
 *
 * Plain HTTPS via fetchWithTimeout, deliberately no SDK: the surface we need
 * is four endpoints, and the AGPL dependency budget is audited (CLAUDE.md).
 *
 * Every message send persists an outbound whatsapp_messages row through the
 * caller's service client (wamid from the send response). Sends are
 * best-effort: a failed send logs + records a failed row but never throws,
 * because a reply must never take down webhook acking or intake processing.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchWithTimeout, TimeoutError } from '@/lib/http/fetch-with-timeout'
import { createLogger } from '@/lib/logger'
import type { TemplateId } from './messages'

const log = createLogger('whatsapp-inbox/graph-api')

const GRAPH_BASE = 'https://graph.facebook.com/v26.0'
const SEND_TIMEOUT_MS = 10_000
const MEDIA_LOOKUP_TIMEOUT_MS = 10_000
const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000

/** WhatsApp caps inbound images at 5 MB and documents at 100 MB; our inbox
 *  pipeline caps everything at 10 MB (matches invoice-inbox MAX_FILE_SIZE). */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024

export class GraphApiError extends Error {
  readonly name = 'GraphApiError'
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

function getAccessToken(): string {
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  if (!token) throw new GraphApiError('WHATSAPP_ACCESS_TOKEN is not configured')
  return token
}

function getPhoneNumberId(): string {
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID
  if (!id) throw new GraphApiError('WHATSAPP_PHONE_NUMBER_ID is not configured')
  return id
}

export interface SendMessageBase {
  /** Recipient: E.164 digits, no '+' (Meta's wa_id format). */
  to: string
  /** Template id stamped into raw_payload for throttle checks and audit. */
  template: TemplateId
  senderPhoneHash?: string | null
  phoneLinkId?: string | null
  conversationId?: string | null
  correlationId?: string | null
  /** Underlag item this outbound message concerns (ack/question sends).
   *  Lets a quoted reply resolve back to its receipt. */
  inboxItemId?: string | null
}

export interface SendTextArgs extends SendMessageBase {
  body: string
}

/**
 * How a send failed. Two different worlds hide behind ok:false, and callers
 * that resend on failure must tell them apart (#2062):
 *  - http_rejected: Meta answered with a non-2xx status. No wamid was issued
 *    and nothing reached the phone, so a different payload can safely be
 *    tried (the numbered-text fallback for a rejected interactive message).
 *  - transport_error: the request threw (timeout, connection reset). Meta may
 *    have accepted the message before the failure surfaced, so a resend can
 *    put a second copy on the phone. Callers treat this as "unknown", never
 *    as "not delivered".
 */
export type SendFailureKind = 'http_rejected' | 'transport_error'

export interface SendTextResult {
  ok: boolean
  wamid: string | null
  /** Why the send failed, for the outbound row (#1552). Null on success. */
  errorDetail: string | null
  /** Typed twin of errorDetail for control flow. Null on success. */
  failure: SendFailureKind | null
}

/** POST one message payload to the Graph API. Never throws. */
async function postToGraph(
  payload: Record<string, unknown>,
  template: TemplateId,
): Promise<SendTextResult> {
  let wamid: string | null = null
  let ok = false
  let errorDetail: string | null = null
  let failure: SendFailureKind | null = null

  try {
    const response = await fetchWithTimeout(
      `${GRAPH_BASE}/${getPhoneNumberId()}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
      { timeoutMs: SEND_TIMEOUT_MS, description: 'WhatsApp send' },
    )

    if (response.ok) {
      const body = (await response.json().catch(() => null)) as {
        messages?: Array<{ id?: string }>
      } | null
      wamid = body?.messages?.[0]?.id ?? null
      ok = true
    } else {
      const detail = await response.text().catch(() => '')
      errorDetail = `Send failed (HTTP ${response.status}): ${detail.slice(0, 250)}`
      failure = 'http_rejected'
      log.warn('WhatsApp send failed', {
        status: response.status,
        template,
        detail: detail.slice(0, 300),
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    errorDetail = `Send errored: ${message.slice(0, 250)}`
    failure = 'transport_error'
    log.warn('WhatsApp send errored', { template, error: message })
  }

  return { ok, wamid, errorDetail, failure }
}

/** Persist the outbound message row. Never throws. */
async function persistOutbound(
  supabase: SupabaseClient,
  args: SendMessageBase & { bodyText: string; messageType: string },
  result: SendTextResult,
): Promise<void> {
  try {
    await supabase.from('whatsapp_messages').insert({
      direction: 'outbound',
      wamid: result.wamid,
      sender_phone_hash: args.senderPhoneHash ?? null,
      phone_link_id: args.phoneLinkId ?? null,
      conversation_id: args.conversationId ?? null,
      message_type: args.messageType,
      body_text: args.bodyText,
      raw_payload: { template: args.template },
      // Outbound rows are not jobs: mark done so the sweep never claims them.
      processing_status: 'done',
      delivery_status: result.ok ? 'sent' : 'failed',
      // A failed reply used to be indistinguishable from a delivered one at
      // the row level (#1552): keep the Graph error on the record.
      error_message: result.ok ? null : (result.errorDetail ?? 'Send failed'),
      correlation_id: args.correlationId ?? null,
      inbox_item_id: args.inboxItemId ?? null,
    })
  } catch (err) {
    log.error('Failed to persist outbound WhatsApp message row', err)
  }
}

/**
 * Send a plain text message and persist the outbound row. Never throws.
 */
export async function sendText(
  supabase: SupabaseClient,
  args: SendTextArgs,
): Promise<SendTextResult> {
  const result = await postToGraph(
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: args.to,
      type: 'text',
      text: { body: args.body },
    },
    args.template,
  )
  await persistOutbound(supabase, { ...args, bodyText: args.body, messageType: 'text' }, result)
  return result
}

// ── Interactive messages (company choice) ────────────────────

export interface ChoiceOption {
  /** Sent back verbatim in the interactive reply payload (company_id here). */
  id: string
  title: string
}

/** WhatsApp hard limits: button titles 20 chars, list row titles 24. */
export const BUTTON_TITLE_MAX = 20
export const LIST_ROW_TITLE_MAX = 24
export const MAX_REPLY_BUTTONS = 3
export const MAX_LIST_ROWS = 10

/**
 * Truncate a display title cleanly: prefer cutting at a word boundary when
 * one sits in the second half, and mark the cut with a single ellipsis.
 */
export function truncateTitle(name: string, max: number): string {
  const trimmed = name.trim()
  if (trimmed.length <= max) return trimmed
  const slice = trimmed.slice(0, max - 1)
  const lastSpace = slice.lastIndexOf(' ')
  const cut = lastSpace >= Math.floor(max / 2) ? slice.slice(0, lastSpace) : slice
  return `${cut.trimEnd()}…`
}

/**
 * Truncate every title to `max` and make the results unique. Meta rejects an
 * interactive payload whose buttons or rows share a title (HTTP 400, error
 * #131009 "Duplicate button title"), which happens when a sender belongs to
 * two same-named companies or when two long names truncate to the same
 * prefix. Colliding entries (compared case-insensitively) get their 1-based
 * position appended: the same digit the numbered text variant and the
 * typed-digit answer path use, so a "Bolag AB 2" button and a "2" reply mean
 * the same option. The result never exceeds `max`.
 */
export function uniqueTitles(titles: string[], max: number): string[] {
  const truncated = titles.map((t) => truncateTitle(t, max))
  const occurrences = new Map<string, number>()
  for (const title of truncated) {
    const key = title.toLowerCase()
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1)
  }
  return truncated.map((title, i) => {
    if ((occurrences.get(title.toLowerCase()) ?? 0) < 2) return title
    const suffix = ` ${i + 1}`
    return `${truncateTitle(titles[i], max - suffix.length)}${suffix}`
  })
}

export interface SendReplyButtonsArgs extends SendMessageBase {
  body: string
  /** At most MAX_REPLY_BUTTONS options; extras are dropped defensively. */
  buttons: ChoiceOption[]
}

/**
 * Send an interactive reply-buttons message (max 3). Never throws.
 */
export async function sendReplyButtons(
  supabase: SupabaseClient,
  args: SendReplyButtonsArgs,
): Promise<SendTextResult> {
  const buttons = args.buttons.slice(0, MAX_REPLY_BUTTONS)
  const titles = uniqueTitles(
    buttons.map((b) => b.title),
    BUTTON_TITLE_MAX,
  )
  const result = await postToGraph(
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: args.to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: args.body },
        action: {
          buttons: buttons.map((b, i) => ({
            type: 'reply',
            reply: { id: b.id, title: titles[i] },
          })),
        },
      },
    },
    args.template,
  )
  await persistOutbound(
    supabase,
    {
      ...args,
      bodyText: `${args.body}\n[${buttons.map((b) => b.title).join(' | ')}]`,
      messageType: 'interactive',
    },
    result,
  )
  return result
}

export interface SendListArgs extends SendMessageBase {
  body: string
  /** Label on the list-opening button (<= 20 chars after truncation). */
  buttonLabel: string
  /** At most MAX_LIST_ROWS options; extras are dropped defensively. */
  rows: ChoiceOption[]
}

/**
 * Send an interactive list message (max 10 rows). Never throws.
 */
export async function sendList(
  supabase: SupabaseClient,
  args: SendListArgs,
): Promise<SendTextResult> {
  const rows = args.rows.slice(0, MAX_LIST_ROWS)
  const titles = uniqueTitles(
    rows.map((r) => r.title),
    LIST_ROW_TITLE_MAX,
  )
  const result = await postToGraph(
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: args.to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: args.body },
        action: {
          button: truncateTitle(args.buttonLabel, BUTTON_TITLE_MAX),
          sections: [
            {
              rows: rows.map((r, i) => ({
                id: r.id,
                title: titles[i],
              })),
            },
          ],
        },
      },
    },
    args.template,
  )
  await persistOutbound(
    supabase,
    {
      ...args,
      bodyText: `${args.body}\n[${rows.map((r) => r.title).join(' | ')}]`,
      messageType: 'interactive',
    },
    result,
  )
  return result
}

/**
 * Mark an inbound message read and show the typing indicator. Best-effort:
 * cosmetic, so failures are logged and swallowed.
 */
export async function markReadWithTyping(wamid: string): Promise<void> {
  try {
    const response = await fetchWithTimeout(
      `${GRAPH_BASE}/${getPhoneNumberId()}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: wamid,
          typing_indicator: { type: 'text' },
        }),
      },
      { timeoutMs: SEND_TIMEOUT_MS, description: 'WhatsApp mark-read' },
    )
    if (!response.ok) {
      log.warn('WhatsApp mark-read failed', { status: response.status })
    }
  } catch (err) {
    log.warn('WhatsApp mark-read errored', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** The instant "received" signal on accepted media (U+2705 check mark).
 *  Built via fromCharCode so no literal emoji byte can be mangled in transit. */
export const RECEIVED_REACTION_EMOJI = String.fromCharCode(0x2705)

/**
 * React to an inbound message with an emoji. This is the instant "your
 * receipt reached us" signal, sent from the webhook itself: reactions attach
 * to the sender's own bubble and add no message of their own, so the
 * debounced combined ack (M4/M5) stays the ONE message per burst. Best-effort
 * and cosmetic exactly like markReadWithTyping: a failure is logged and
 * swallowed, no outbound whatsapp_messages row is persisted (a reaction is
 * not a message in the conversation model), and intake is unaffected.
 */
export async function sendReaction(
  to: string,
  wamid: string,
  emoji: string = RECEIVED_REACTION_EMOJI,
): Promise<void> {
  try {
    const response = await fetchWithTimeout(
      `${GRAPH_BASE}/${getPhoneNumberId()}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'reaction',
          reaction: { message_id: wamid, emoji },
        }),
      },
      { timeoutMs: SEND_TIMEOUT_MS, description: 'WhatsApp reaction' },
    )
    if (!response.ok) {
      log.warn('WhatsApp reaction failed', { status: response.status })
    }
  } catch (err) {
    log.warn('WhatsApp reaction errored', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export interface DownloadedMedia {
  buffer: ArrayBuffer
  mime: string | null
  fileSize: number
}

/**
 * Download a media item: resolve the media id to a fresh short-lived URL
 * (TTL ~5 min, re-resolvable for days, so retries work), then fetch the bytes
 * with the same Bearer token. Enforces MAX_MEDIA_BYTES twice: via the
 * content-length header before reading, and while streaming the body (a
 * missing or lying header must not let an oversized file through).
 *
 * Throws GraphApiError / TimeoutError: the caller owns error handling here,
 * unlike sends, because a failed download IS a failed intake.
 */
export async function downloadMedia(mediaId: string): Promise<DownloadedMedia> {
  const token = getAccessToken()

  const lookupResponse = await fetchWithTimeout(
    `${GRAPH_BASE}/${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(getPhoneNumberId())}`,
    { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    { timeoutMs: MEDIA_LOOKUP_TIMEOUT_MS, description: 'WhatsApp media lookup' },
  )
  if (!lookupResponse.ok) {
    throw new GraphApiError(`Media lookup failed (${lookupResponse.status})`, lookupResponse.status)
  }
  const lookup = (await lookupResponse.json().catch(() => null)) as {
    url?: string
    mime_type?: string
    file_size?: number
  } | null
  if (!lookup?.url) {
    throw new GraphApiError('Media lookup returned no download URL')
  }
  if (typeof lookup.file_size === 'number' && lookup.file_size > MAX_MEDIA_BYTES) {
    throw new GraphApiError('Media exceeds the size limit')
  }

  const download = await fetchWithTimeout(
    lookup.url,
    { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    { timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS, description: 'WhatsApp media download' },
  )
  if (!download.ok) {
    throw new GraphApiError(`Media download failed (${download.status})`, download.status)
  }

  const declaredLength = Number.parseInt(download.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MEDIA_BYTES) {
    throw new GraphApiError('Media exceeds the size limit')
  }

  // Stream with a running byte count so a body larger than its content-length
  // header is rejected without buffering the whole thing first.
  const chunks: Uint8Array[] = []
  let total = 0
  if (download.body) {
    const reader = download.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > MAX_MEDIA_BYTES) {
          await reader.cancel().catch(() => undefined)
          throw new GraphApiError('Media exceeds the size limit')
        }
        chunks.push(value)
      }
    }
  }

  const buffer = new ArrayBuffer(total)
  const view = new Uint8Array(buffer)
  let offset = 0
  for (const chunk of chunks) {
    view.set(chunk, offset)
    offset += chunk.byteLength
  }

  return {
    buffer,
    mime: lookup.mime_type ?? download.headers.get('content-type'),
    fileSize: total,
  }
}

// ── Display number (for the wa.me deep link) ─────────────────
//
// WHATSAPP_PHONE_NUMBER_ID is a Graph object id, not the phone number, and the
// env contract for this extension is fixed at six vars. The wa.me link needs
// the real number, so resolve it once from the Graph API and cache in module
// scope. On failure the panel simply gets no deep link (code still works).

let cachedDisplayNumber: { value: string; fetchedAt: number } | null = null
const DISPLAY_NUMBER_TTL_MS = 60 * 60 * 1000

export async function getDisplayPhoneNumber(): Promise<string | null> {
  if (cachedDisplayNumber && Date.now() - cachedDisplayNumber.fetchedAt < DISPLAY_NUMBER_TTL_MS) {
    return cachedDisplayNumber.value
  }
  try {
    const response = await fetchWithTimeout(
      `${GRAPH_BASE}/${getPhoneNumberId()}?fields=display_phone_number`,
      { method: 'GET', headers: { Authorization: `Bearer ${getAccessToken()}` } },
      { timeoutMs: MEDIA_LOOKUP_TIMEOUT_MS, description: 'WhatsApp number lookup' },
    )
    if (!response.ok) return null
    const payload = (await response.json().catch(() => null)) as {
      display_phone_number?: string
    } | null
    const digits = payload?.display_phone_number?.replace(/\D/g, '') ?? ''
    if (!digits) return null
    cachedDisplayNumber = { value: digits, fetchedAt: Date.now() }
    return digits
  } catch (err) {
    if (!(err instanceof TimeoutError)) {
      log.warn('WhatsApp display number lookup errored', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return null
  }
}

/** Test-only: reset the module-level display-number cache. */
export function resetDisplayNumberCacheForTests(): void {
  cachedDisplayNumber = null
}
