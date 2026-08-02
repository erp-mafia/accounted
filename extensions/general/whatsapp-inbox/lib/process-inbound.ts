/**
 * Deferred intake worker: one inbound media message -> one Underlag item.
 *
 * The webhook persists the message row and 200s fast; this worker runs via
 * the after() idiom (lib/webhooks/dispatch-kick.ts) on the same instance.
 * The whatsapp_messages row IS the durable job record: the atomic claim
 * (UPDATE ... WHERE processing_status='received' RETURNING) makes redelivered
 * webhooks and the PR4 sweep cron safe to race.
 *
 * Failure policy: NOTHING here returns a retryable status to Meta. Rejected
 * and rate-limited content acks in chat and lands as 'skipped'; real failures
 * land as 'error' + error_message with a single M18 to the user.
 */

import { after } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { checkInboxUploadRateLimit } from '@/lib/rate-limits/inbox'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { computeSHA256 } from '@/lib/core/documents/document-service'
import { createLogger } from '@/lib/logger'
import { uploadAndExtract } from '@/extensions/general/invoice-inbox/lib/upload-and-extract'
import type { InvoiceExtractionResult, WhatsAppMessage, WhatsAppPhoneLink } from '@/types'
import { sendText, markReadWithTyping, downloadMedia, GraphApiError } from './graph-api'
import { botCopy, TEMPLATE } from './messages'

const log = createLogger('whatsapp-inbox/process-inbound')

/** Chat intake accepts what phones actually produce. Narrower than the upload
 *  allowlist on purpose: WhatsApp transcodes photos to JPEG, so HEIC never
 *  arrives, and everything else gets the M15 nudge. */
export const CHAT_ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
])

/** M17 is sent at most once per this window per sender, not once per file. */
const RATE_LIMIT_NOTICE_WINDOW_MS = 10 * 60 * 1000

const EXTENSION_FOR_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

function fallbackFilename(mime: string): string {
  const ext = EXTENSION_FOR_MIME[mime] ?? 'bin'
  return `whatsapp-${new Date().toISOString().slice(0, 10)}.${ext}`
}

function formatSek(amount: number): string {
  return `${new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount)} kr`
}

async function loadRow(
  supabase: SupabaseClient,
  messageId: string,
): Promise<WhatsAppMessage | null> {
  const { data } = await supabase
    .from('whatsapp_messages')
    .select('*')
    .eq('id', messageId)
    .maybeSingle()
  return (data as WhatsAppMessage | null) ?? null
}

async function loadLink(
  supabase: SupabaseClient,
  phoneLinkId: string,
): Promise<WhatsAppPhoneLink | null> {
  const { data } = await supabase
    .from('whatsapp_phone_links')
    .select('*')
    .eq('id', phoneLinkId)
    .maybeSingle()
  return (data as WhatsAppPhoneLink | null) ?? null
}

/**
 * Resolve which company the receipt lands in (PR3 ladder: default company if
 * still a member -> sole membership -> null). The PR4 conversation pin slots
 * in above default when it exists.
 */
async function resolveCompanyId(
  supabase: SupabaseClient,
  link: WhatsAppPhoneLink,
): Promise<string | null> {
  if (link.default_company_id) {
    const { data: membership } = await supabase
      .from('company_members')
      .select('company_id')
      .eq('user_id', link.user_id)
      .eq('company_id', link.default_company_id)
      .maybeSingle()
    if (membership) return link.default_company_id
  }

  const { data: memberships } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', link.user_id)
  const companyIds = [...new Set((memberships ?? []).map((m) => m.company_id as string))]
  if (companyIds.length === 1) return companyIds[0]
  return null
}

/** True when an M17 notice already went to this sender inside the window. */
async function rateLimitNoticeAlreadySent(
  supabase: SupabaseClient,
  senderPhoneHash: string,
): Promise<boolean> {
  const since = new Date(Date.now() - RATE_LIMIT_NOTICE_WINDOW_MS).toISOString()
  const { data } = await supabase
    .from('whatsapp_messages')
    .select('id')
    .eq('direction', 'outbound')
    .eq('sender_phone_hash', senderPhoneHash)
    .eq('raw_payload->>template', TEMPLATE.m17RateLimited)
    .gte('created_at', since)
    .limit(1)
    .maybeSingle()
  return data != null
}

async function markStatus(
  supabase: SupabaseClient,
  messageId: string,
  status: 'skipped' | 'error' | 'done',
  extra: { errorMessage?: string | null; inboxItemId?: string | null } = {},
): Promise<void> {
  // Literal payload (no spread) so the phantom-column scanner can verify it.
  // Writing null where the caller passed nothing matches the columns' actual
  // state on every path that reaches here.
  await supabase
    .from('whatsapp_messages')
    .update({
      processing_status: status,
      error_message: extra.errorMessage ?? null,
      inbox_item_id: extra.inboxItemId ?? null,
    })
    .eq('id', messageId)
}

/**
 * Process one inbound media message end to end. Never throws.
 */
export async function processInboundMessage(
  supabase: SupabaseClient,
  messageId: string,
): Promise<void> {
  const row = await loadRow(supabase, messageId)
  if (!row) return

  // Atomic claim: only a row still in 'received' can be taken, so a webhook
  // redelivery racing this worker (or the PR4 sweep) claims exactly once.
  const { data: claimed } = await supabase
    .from('whatsapp_messages')
    .update({ processing_status: 'processing', attempts: row.attempts + 1 })
    .eq('id', messageId)
    .eq('processing_status', 'received')
    .select('id')
    .maybeSingle()
  if (!claimed) return

  const attempt = row.attempts + 1
  const copy = botCopy('sv')
  const to = extractRecipient(row)

  const replyBase = {
    senderPhoneHash: row.sender_phone_hash,
    phoneLinkId: row.phone_link_id,
    conversationId: row.conversation_id,
    correlationId: row.correlation_id,
  }

  try {
    if (!row.phone_link_id || !row.media_id || !to) {
      await markStatus(supabase, messageId, 'error', {
        errorMessage: 'Message row is missing link or media reference',
      })
      return
    }

    if (row.wamid) await markReadWithTyping(row.wamid)

    const link = await loadLink(supabase, row.phone_link_id)
    if (!link || link.revoked_at) {
      await markStatus(supabase, messageId, 'skipped', {
        errorMessage: 'Phone link revoked before processing',
      })
      return
    }

    // ── Company resolution ─────────────────────────────────
    const companyId = await resolveCompanyId(supabase, link)
    if (!companyId) {
      await sendText(supabase, { to, body: copy.m6NoDefaultCompany(), template: TEMPLATE.m6NoDefaultCompany, ...replyBase })
      await markStatus(supabase, messageId, 'skipped', {
        errorMessage: 'No default company set for multi-company sender',
      })
      return
    }

    // ── Per-company intake quota (ack-and-drop, never retryable) ──
    const limit = await checkInboxUploadRateLimit(supabase, companyId)
    if (!limit.ok) {
      try {
        await appendProcessingHistory({
          companyId,
          correlationId: row.correlation_id ?? messageId,
          aggregateType: 'System',
          aggregateId: messageId,
          eventType: 'RateLimitedDropped',
          payload: {
            channel: 'whatsapp',
            scope: limit.scope,
            retry_after_sec: limit.retryAfterSec,
            whatsapp_message_id: messageId,
          },
          actor: { type: 'system', id: 'whatsapp-inbound' },
          occurredAt: new Date(),
        })
      } catch (err) {
        log.error('RateLimitedDropped append failed', err)
      }
      if (row.sender_phone_hash && !(await rateLimitNoticeAlreadySent(supabase, row.sender_phone_hash))) {
        await sendText(supabase, { to, body: copy.m17RateLimited({}), template: TEMPLATE.m17RateLimited, ...replyBase })
      }
      await markStatus(supabase, messageId, 'skipped', { errorMessage: 'Rate limited' })
      return
    }

    // ── MIME allowlist ─────────────────────────────────────
    const mime = (row.media_mime ?? '').split(';')[0].trim().toLowerCase()
    if (!CHAT_ALLOWED_MIME_TYPES.has(mime)) {
      await sendText(supabase, { to, body: copy.m15Unsupported(), template: TEMPLATE.m15Unsupported, ...replyBase })
      await markStatus(supabase, messageId, 'skipped', {
        errorMessage: `Unsupported media type: ${mime || 'unknown'}`,
      })
      return
    }

    // ── Download (fresh URL per media id; 10 MB stream-checked cap) ──
    const media = await downloadMedia(row.media_id)

    // ── Exact duplicate check within the company ───────────
    const sha256 = await computeSHA256(media.buffer)
    const { data: duplicate } = await supabase
      .from('document_attachments')
      .select('id')
      .eq('company_id', companyId)
      .eq('sha256_hash', sha256)
      .limit(1)
      .maybeSingle()
    if (duplicate) {
      await sendText(supabase, { to, body: copy.m4Duplicate(), template: TEMPLATE.m4Duplicate, ...replyBase })
      await markStatus(supabase, messageId, 'skipped', { errorMessage: 'Duplicate document (sha256)' })
      return
    }

    // ── Upload + extract (the shared invoice-inbox funnel) ──
    const result = await uploadAndExtract(
      supabase,
      link.user_id,
      companyId,
      { name: row.media_filename || fallbackFilename(mime), buffer: media.buffer, type: mime },
      'whatsapp',
      undefined,
      undefined,
      {
        channelMeta: { whatsappMessageId: messageId, caption: row.body_text ?? null },
        actorId: 'whatsapp-inbound',
      },
    )

    await markStatus(supabase, messageId, 'done', {
      inboxItemId: result.inbox_item_id,
    })

    // ── Receipt ack ────────────────────────────────────────
    const extracted = result.extracted_data as InvoiceExtractionResult | undefined
    const total = extracted?.totals?.total ?? null
    if (total != null) {
      await sendText(supabase, {
        to,
        body: copy.m4Ack({
          merchant: extracted?.supplier?.name ?? null,
          amount: formatSek(total),
          date: extracted?.invoice?.invoiceDate ?? null,
        }),
        template: TEMPLATE.m4Ack,
        ...replyBase,
      })
    } else {
      await sendText(supabase, { to, body: copy.m4AckEmpty(), template: TEMPLATE.m4AckEmpty, ...replyBase })
    }
  } catch (err) {
    const message =
      err instanceof GraphApiError || err instanceof Error ? err.message : String(err)
    log.error('WhatsApp intake processing failed', err, { messageId })
    try {
      await markStatus(supabase, messageId, 'error', { errorMessage: message.slice(0, 500) })
      // M18 once per message: only on the first attempt, so a PR4 sweep
      // re-claim of the same row never spams the sender.
      if (to && attempt <= 1) {
        await sendText(supabase, { to, body: botCopy('sv').m18Error(), template: TEMPLATE.m18Error, ...replyBase })
      }
    } catch (innerErr) {
      log.error('Failed to record WhatsApp processing error', innerErr, { messageId })
    }
  }
}

/**
 * The recipient phone (E.164 digits) for replies. The raw inbound payload is
 * persisted verbatim for linked senders, so `from` is read back from it: the
 * row itself never stores the raw number outside raw_payload/phone_enc.
 */
function extractRecipient(row: WhatsAppMessage): string | null {
  const raw = row.raw_payload as { from?: unknown } | null
  return raw && typeof raw.from === 'string' && raw.from.length > 0 ? raw.from : null
}

/**
 * Schedule processing of freshly persisted message rows after the webhook
 * response is sent. Exact dispatch-kick idiom: never awaited by the caller,
 * never throws, falls back to a microtask outside a request scope (tests).
 */
export function kickInboundProcessing(messageIds: string[]): void {
  if (messageIds.length === 0) return

  const run = async (): Promise<void> => {
    try {
      const supabase = createServiceClientNoCookies()
      for (const id of messageIds) {
        await processInboundMessage(supabase, id)
      }
    } catch (err) {
      // The PR4 sweep cron re-claims 'received' rows: a failed kick is a
      // latency regression, never a lost message.
      log.warn('deferred WhatsApp processing failed; sweep will retry', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  try {
    after(() => run())
  } catch {
    queueMicrotask(() => void run())
  }
}
