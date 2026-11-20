/**
 * The arrival of one WhatsApp media message.
 *
 * The receipt itself is filed through the shared inbox funnel; this records
 * the message it came in: the linked sender (masked number, never the number
 * itself) and a pointer to the whatsapp_messages row. No message text and no
 * original: both are chat transcript, which the RoPA purges after 90 days
 * (whatsapp-inbox/lib/retention.ts), so neither is copied into the seven-year
 * arrival. The caption stays where it already lives, in the inbox item.
 *
 * Best effort: never throws, never changes what the bot does.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { linkArrivalOutputs, recordArrival } from '@/lib/intake/arrivals'
import type { WhatsAppMessage, WhatsAppPhoneLink } from '@/types'

const log = createLogger('whatsapp-inbox/arrival')

/** When Meta says the message was sent (unix seconds), else when we received it. */
function receivedAt(row: WhatsAppMessage): string {
  const ts = Number((row.raw_payload as { timestamp?: unknown } | null)?.timestamp)
  if (Number.isFinite(ts) && ts > 0) return new Date(ts * 1000).toISOString()
  return row.created_at
}

export async function recordWhatsAppArrival(
  supabase: SupabaseClient,
  params: {
    row: WhatsAppMessage
    link: Pick<WhatsAppPhoneLink, 'id' | 'user_id' | 'phone_masked'>
    companyId: string
    /** The archived receipt: the new document, or the one this duplicate matched. */
    documentId: string
    inboxItemId?: string | null
  },
): Promise<void> {
  const { row, link, companyId } = params
  try {
    const sourceRef = row.wamid || row.id
    const recorded = await recordArrival(supabase, {
      companyId,
      source: 'whatsapp',
      sourceRef,
      receivedAt: receivedAt(row),
      sender: {
        phone_masked: link.phone_masked,
        phone_link_id: link.id,
        user_id: link.user_id,
      },
      // Chat text is transcript: purged after 90 days, never kept for seven years here.
      messageText: null,
      fetchedBy: { type: 'webhook', label: 'whatsapp-inbound' },
      sourceMeta: {
        original_missing: 'chat_transcript_not_kept',
        whatsapp_message_id: row.id,
        message_type: row.message_type,
        media_id: row.media_id,
        media_mime: row.media_mime,
        media_sha256: row.media_sha256,
        media_filename: row.media_filename,
        conversation_id: row.conversation_id,
      },
    })
    if (!recorded) return
    await linkArrivalOutputs(supabase, recorded.arrival, [
      { kind: 'document', id: params.documentId, role: 'attachment' },
      ...(params.inboxItemId ? [{ kind: 'inbox_item' as const, id: params.inboxItemId, role: 'attachment' as const }] : []),
    ])
  } catch (err) {
    log.error('WhatsApp arrival failed', err, { companyId, entityId: row.id })
  }
}
