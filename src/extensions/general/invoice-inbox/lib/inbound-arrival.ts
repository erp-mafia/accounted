/**
 * The arrival of one inbound mail (Resend), per company it reached.
 *
 * The webhook files attachments and the body as underlag; this records the
 * mail itself: who sent it to whom, the subject and text, trimmed headers,
 * and the whole message as it came (.eml, through Resend's raw download), so
 * the Inkorg can show the original and an agent can read all of it. A
 * forwarded message/rfc822 attachment is inside that .eml too.
 *
 * Best effort throughout: a failure here never changes what the webhook
 * answers or files (lib/intake/arrivals.ts never throws).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import {
  linkArrivalOutputs,
  recordArrival,
  type ArrivalOriginalBytes,
  type ArrivalOutputInput,
  type ArrivalOutputRole,
} from '@/lib/intake/arrivals'
import type { ResendReceivedEmail } from './resend-inbound'

const log = createLogger('invoice-inbox/inbound-arrival')

/** Above any real supplier mail; Resend's own inbound limit is lower. */
export const MAX_RAW_EMAIL_BYTES = 40 * 1024 * 1024
const RAW_DOWNLOAD_TIMEOUT_MS = 20_000

const MAX_HEADERS = 60
const MAX_HEADER_VALUE_CHARS = 1_000

/**
 * Transport signatures and provider tracking: bulk without meaning to a
 * reader. They stay in the .eml.
 */
const DROPPED_HEADER_RE =
  /^(dkim-signature|arc-seal|arc-message-signature|arc-authentication-results|x-google-dkim-signature|x-gm-message-state|x-google-smtp-source|x-received|x-ms-exchange-.*|x-forefront-.*|x-microsoft-antispam.*)$/i

/** The headers worth reading next to the mail, capped. */
export function trimEmailHeaders(headers: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  let kept = 0
  for (const [name, value] of Object.entries(headers)) {
    if (kept >= MAX_HEADERS) break
    const key = name.toLowerCase()
    if (DROPPED_HEADER_RE.test(key)) continue
    out[key] = String(value ?? '').slice(0, MAX_HEADER_VALUE_CHARS)
    kept += 1
  }
  return out
}

/**
 * Download the whole received message. Null when Resend offers no raw copy,
 * or when it is missing, too large or unreachable: the arrival is recorded
 * without its original then, and says so in source_meta.
 */
export async function downloadRawEmail(
  email: Pick<ResendReceivedEmail, 'id' | 'raw'>,
): Promise<ArrivalOriginalBytes | null> {
  const url = email.raw?.download_url
  if (!url) return null
  const response = await fetch(url, { signal: AbortSignal.timeout(RAW_DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`raw download returned ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_RAW_EMAIL_BYTES) throw new Error(`raw message too large (${declared} bytes)`)
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > MAX_RAW_EMAIL_BYTES) throw new Error(`raw message too large (${bytes.byteLength} bytes)`)
  if (bytes.byteLength === 0) return null
  return { bytes, filename: `${email.id}.eml`, mime: 'message/rfc822' }
}

/** What the webhook did for one company: the parts of its outcome this needs. */
export interface InboundMailTargetOutcome {
  companyId: string
  inboxId: string | null
  tags: string[]
  reason?: string
  /** The body underlag (or its duplicate) when the body was filed. */
  inbox_item_id?: string
  attachments: Array<{ id: string; outcome: string; inbox_item_id?: string }>
}

const BODY_REASONS = new Set(['email_body', 'email_body_duplicate'])

/**
 * Record the mail's arrival for each company that took it in, and link the
 * inbox items it produced and their documents. A rate-limited drop is not an
 * arrival (nothing entered); fan-out-capped companies never reach here.
 */
export async function recordInboundMailArrivals(
  supabase: SupabaseClient,
  params: {
    email: ResendReceivedEmail
    event: { email_id: string; from: string; to: string[]; subject: string | null; message_id: string | null; created_at: string }
    targets: InboundMailTargetOutcome[]
  },
): Promise<void> {
  const { email, event } = params
  // One download for the mail, however many companies it reached, and none
  // when every arrival is already recorded (a Resend redelivery).
  let raw: Promise<ArrivalOriginalBytes | null> | undefined
  const fetchRaw = () => (raw ??= downloadRawEmail(email))

  for (const target of params.targets) {
    if (target.reason === 'rate_limited') continue
    try {
      const recorded = await recordArrival(supabase, {
        companyId: target.companyId,
        source: 'intake_email',
        sourceRef: event.email_id,
        receivedAt: event.created_at || email.created_at,
        sender: {
          from: email.from ?? event.from,
          to: email.to ?? event.to,
          cc: email.cc ?? [],
          reply_to: email.reply_to ?? [],
        },
        subject: email.subject ?? event.subject,
        messageText: email.text ?? null,
        fetchedBy: { type: 'webhook', label: 'resend-inbound' },
        sourceMeta: {
          message_id: email.message_id ?? event.message_id,
          inbox_id: target.inboxId,
          tags: target.tags,
          headers: trimEmailHeaders(email.headers),
          has_html: typeof email.html === 'string' && email.html.length > 0,
          attachments: (email.attachments ?? []).map((a) => ({
            id: a.id,
            filename: a.filename,
            content_type: a.content_type,
            size: a.size,
          })),
          ...(email.raw?.download_url ? {} : { original_missing: 'no_raw_from_provider' }),
        },
        original: fetchRaw,
      })
      if (!recorded) continue

      // The inbox items this mail produced, each with its document.
      const roles = new Map<string, ArrivalOutputRole>()
      if (target.inbox_item_id && BODY_REASONS.has(target.reason ?? '')) roles.set(target.inbox_item_id, 'body')
      for (const attachment of target.attachments) {
        if (attachment.inbox_item_id && !roles.has(attachment.inbox_item_id)) {
          roles.set(attachment.inbox_item_id, 'attachment')
        }
      }
      if (roles.size === 0) continue

      const { data: items, error } = await supabase
        .from('invoice_inbox_items')
        .select('id, document_id')
        .eq('company_id', target.companyId)
        .in('id', [...roles.keys()])
      if (error) throw new Error(error.message)
      const documentOf = new Map(
        ((items as Array<{ id: string; document_id: string | null }> | null) ?? []).map((i) => [i.id, i.document_id]),
      )

      const outputs: ArrivalOutputInput[] = []
      let position = 0
      for (const [itemId, role] of roles) {
        const documentId = documentOf.get(itemId)
        if (documentId) outputs.push({ kind: 'document', id: documentId, role, position })
        outputs.push({ kind: 'inbox_item', id: itemId, role, position })
        position += 1
      }
      await linkArrivalOutputs(supabase, recorded.arrival, outputs)
    } catch (err) {
      log.error('inbound mail arrival failed', err, { companyId: target.companyId, entityId: event.email_id })
    }
  }
}
