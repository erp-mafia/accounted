/**
 * Arrivals for inbox items filed before arrivals existed.
 *
 * Pure planning: given inbox rows (and the WhatsApp messages and documents
 * they point at) it says which arrivals to record and what each produced.
 * scripts/backfill-arrivals.ts does the reading and the writing.
 *
 * What a backfilled arrival can know is what the inbox row kept: a mail's
 * sender, subject and text but not the whole message (Resend's raw copy was
 * never fetched), a WhatsApp caption but never the chat payload (transcripts
 * are purged at 90 days), the archived XML of an e-invoice, the uploaded file
 * itself. Every planned arrival carries source_meta.backfilled = true and
 * says what is missing.
 */
import type {
  ArrivalActor,
  ArrivalOriginalRef,
  ArrivalOutputInput,
  ArrivalSource,
} from './arrivals'

export interface BackfillInboxItem {
  id: string
  company_id: string
  user_id: string | null
  source: string
  document_id: string | null
  created_at: string
  email_from: string | null
  email_subject: string | null
  email_received_at: string | null
  email_body_text: string | null
  resend_email_id: string | null
  resend_attachment_id: string | null
  raw_email_payload: Record<string, unknown> | null
  whatsapp_message_id: string | null
  channel_context: Record<string, unknown> | null
}

export interface BackfillWhatsAppMessage {
  id: string
  wamid: string | null
  body_text: string | null
  raw_payload: Record<string, unknown> | null
  created_at: string
  phone_link_id: string | null
  message_type: string | null
  media_mime: string | null
}

export interface BackfillDocument {
  id: string
  storage_path: string | null
  sha256_hash: string | null
  mime_type: string | null
  file_size_bytes: number | null
  file_name: string | null
  upload_source: string | null
}

export interface PlannedArrival {
  /** company|source|source_ref: the arrival's idempotency key. */
  key: string
  companyId: string
  source: ArrivalSource
  sourceRef: string
  receivedAt: string
  sender: Record<string, unknown>
  subject: string | null
  messageText: string | null
  fetchedBy: ArrivalActor
  sourceMeta: Record<string, unknown>
  originalRef?: ArrivalOriginalRef
  outputs: ArrivalOutputInput[]
}

export type BackfillSkipReason =
  | 'email_without_resend_id'
  | 'whatsapp_without_message'
  | 'peppol_without_document_id'
  | 'mail_hunt_without_message_id'
  | 'upload_without_document'
  | 'unknown_source'

export interface BackfillPlan {
  planned: PlannedArrival[]
  skipped: Partial<Record<BackfillSkipReason, number>>
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function docRef(doc: BackfillDocument | undefined): ArrivalOriginalRef | undefined {
  if (!doc?.storage_path) return undefined
  return { path: doc.storage_path, sha256: doc.sha256_hash, mime: doc.mime_type, size: doc.file_size_bytes }
}

function itemOutputs(item: BackfillInboxItem, role: ArrivalOutputInput['role'], position: number): ArrivalOutputInput[] {
  return [
    ...(item.document_id ? [{ kind: 'document' as const, id: item.document_id, role, position }] : []),
    { kind: 'inbox_item', id: item.id, role, position },
  ]
}

/**
 * Plan the arrivals for a page of inbox items. Items of one delivery (the
 * attachments and body of one mail, the attachments of one hunted message)
 * become one arrival; recording is idempotent, so a delivery split across
 * two pages ends up as one arrival with every output linked.
 */
export function planArrivals(
  items: BackfillInboxItem[],
  lookups: {
    whatsapp: Map<string, BackfillWhatsAppMessage>
    documents: Map<string, BackfillDocument>
  },
): BackfillPlan {
  const byKey = new Map<string, PlannedArrival>()
  const skipped: BackfillPlan['skipped'] = {}
  const skip = (reason: BackfillSkipReason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }
  // Items per arrival so far: an item's position among its delivery's outputs.
  const itemCount = new Map<string, number>()
  const add = (arrival: Omit<PlannedArrival, 'key' | 'outputs'>, outputs: (position: number) => ArrivalOutputInput[]) => {
    const key = `${arrival.companyId}|${arrival.source}|${arrival.sourceRef}`
    const position = itemCount.get(key) ?? 0
    itemCount.set(key, position + 1)
    const existing = byKey.get(key)
    if (existing) {
      existing.outputs.push(...outputs(position))
      return
    }
    byKey.set(key, { ...arrival, key, outputs: outputs(position) })
  }

  for (const item of items) {
    const ctx = item.channel_context ?? {}
    switch (item.source) {
      case 'email': {
        if (!item.resend_email_id) {
          skip('email_without_resend_id')
          break
        }
        const isBody = item.resend_attachment_id == null
        add(
          {
            companyId: item.company_id,
            source: 'intake_email',
            sourceRef: item.resend_email_id,
            receivedAt: item.email_received_at ?? item.created_at,
            sender: { from: item.email_from },
            subject: item.email_subject,
            messageText: item.email_body_text,
            fetchedBy: { type: 'webhook', label: 'resend-inbound' },
            sourceMeta: {
              backfilled: true,
              original_missing: 'backfilled_without_raw',
              message_id: str(item.raw_email_payload?.messageId),
            },
          },
          (position) => itemOutputs(item, isBody ? 'body' : 'attachment', position),
        )
        break
      }
      case 'whatsapp': {
        const message = item.whatsapp_message_id ? lookups.whatsapp.get(item.whatsapp_message_id) : undefined
        if (!message) {
          skip('whatsapp_without_message')
          break
        }
        const ref = message.wamid || message.id
        const ts = Number((message.raw_payload as { timestamp?: unknown } | null)?.timestamp)
        add(
          {
            companyId: item.company_id,
            source: 'whatsapp',
            sourceRef: ref,
            receivedAt: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : message.created_at,
            sender: { phone_link_id: message.phone_link_id, user_id: item.user_id },
            subject: null,
            // The caption survives on the item; the transcript is purged at 90 days.
            messageText: str(ctx.caption) ?? message.body_text,
            fetchedBy: { type: 'webhook', label: 'whatsapp-inbound' },
            sourceMeta: {
              backfilled: true,
              whatsapp_message_id: message.id,
              message_type: message.message_type,
              media_mime: message.media_mime,
              original_missing: 'chat_transcript_not_kept',
            },
          },
          (position) => itemOutputs(item, 'attachment', position),
        )
        break
      }
      case 'peppol': {
        const providerId = str(ctx.peppol_document_id)
        if (!providerId) {
          skip('peppol_without_document_id')
          break
        }
        const xmlId = str(ctx.peppol_xml_document_id)
        const xml = xmlId ? lookups.documents.get(xmlId) : undefined
        const shown = item.document_id && xmlId && item.document_id !== xmlId ? 'rendering' : 'xml'
        add(
          {
            companyId: item.company_id,
            source: 'peppol',
            sourceRef: providerId,
            receivedAt: item.email_received_at ?? item.created_at,
            sender: { name: item.email_from, endpoint: str(ctx.peppol_sender_endpoint) },
            subject: null,
            messageText: null,
            fetchedBy: { type: 'system', label: 'peppol-inbound' },
            sourceMeta: {
              backfilled: true,
              provider: str(ctx.peppol_provider),
              document_type: str(ctx.peppol_document_type),
              xml_document_id: xmlId,
            },
            originalRef: docRef(xml),
          },
          (position) => [
            ...(xmlId && xmlId !== item.document_id ? [{ kind: 'document' as const, id: xmlId, role: 'xml' as const, position }] : []),
            ...itemOutputs(item, shown, position),
          ],
        )
        break
      }
      case 'mail_hunt': {
        const messageId = str(ctx.mail_message_id)
        if (!messageId) {
          skip('mail_hunt_without_message_id')
          break
        }
        add(
          {
            companyId: item.company_id,
            source: 'mailbox',
            sourceRef: messageId,
            receivedAt: str(ctx.mail_received_at) ?? item.email_received_at ?? item.created_at,
            sender: { from: str(ctx.mail_from) ?? item.email_from },
            subject: str(ctx.mail_subject) ?? item.email_subject,
            messageText: null,
            fetchedBy: { type: 'system', label: 'receipt-hunt' },
            sourceMeta: {
              backfilled: true,
              provider: str(ctx.mail_provider),
              mailbox: str(ctx.mail_mailbox),
              original_missing: 'hunt_keeps_no_mail_body',
            },
          },
          (position) => itemOutputs(item, 'attachment', position),
        )
        break
      }
      case 'upload': {
        const doc = item.document_id ? lookups.documents.get(item.document_id) : undefined
        if (!doc) {
          skip('upload_without_document')
          break
        }
        // A legacy MCP upload archived with upload_source 'api'; the rest came
        // through the Inkorg.
        const source: ArrivalSource = doc.upload_source === 'api' ? 'mcp' : 'upload'
        add(
          {
            companyId: item.company_id,
            source,
            sourceRef: doc.id,
            receivedAt: item.created_at,
            sender: {},
            subject: null,
            messageText: null,
            fetchedBy: item.user_id ? { type: 'user', user_id: item.user_id } : { type: 'system', label: 'backfill' },
            sourceMeta: { backfilled: true, document_id: doc.id, file_name: doc.file_name, upload_source: doc.upload_source },
            originalRef: docRef(doc),
          },
          (position) => itemOutputs(item, 'attachment', position),
        )
        break
      }
      default:
        skip('unknown_source')
    }
  }

  return { planned: [...byKey.values()], skipped }
}

/** The document ids a page needs read: uploads and archived Peppol XML. */
export function documentIdsToRead(items: BackfillInboxItem[]): string[] {
  const ids = new Set<string>()
  for (const item of items) {
    if (item.source === 'upload' && item.document_id) ids.add(item.document_id)
    const xmlId = str(item.channel_context?.peppol_xml_document_id)
    if (item.source === 'peppol' && xmlId) ids.add(xmlId)
  }
  return [...ids]
}

/** The WhatsApp message ids a page needs read. */
export function whatsappIdsToRead(items: BackfillInboxItem[]): string[] {
  return [...new Set(items.filter((i) => i.source === 'whatsapp' && i.whatsapp_message_id).map((i) => i.whatsapp_message_id!))]
}
