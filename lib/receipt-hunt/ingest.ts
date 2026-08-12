/**
 * Turning a mailbox hit into an underlag the user can approve.
 *
 * Lives in core rather than in the mail extension because it writes documents
 * and inbox items, and an extension may never import another extension. The
 * mail extension only ever hands over bytes.
 *
 * The hunt does NOT book anything and does not link anything by itself: it
 * stores the receipt, records where it came from, and stages the pairing. The
 * document becomes räkenskapsinformation only when a human approves.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { getMailSearchService, type MailCandidate } from '@/lib/mail-search/service'
import { createLogger } from '@/lib/logger'

const log = createLogger('receipt-hunt-ingest')

/**
 * What the bytes actually are, rather than what the mail claims.
 *
 * A mail's declared content type is untrusted metadata. Forwarded receipts
 * routinely arrive as `application/octet-stream` whatever they really are, and
 * uploadDocument validates the content against the type it is given, so
 * trusting the mail means every such receipt is rejected at the door. Measured
 * on a real mailbox: the first live fetch, an Elgiganten PDF, failed exactly
 * this way.
 *
 * Magic bytes first, then the filename, then whatever the mail said.
 */
export function sniffMimeType(bytes: Buffer, declared: string, filename: string): string {
  const head = bytes.subarray(0, 12)
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf'
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n') return 'image/png'
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }

  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  const byExt: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  }
  if (ext && byExt[ext]) return byExt[ext]

  return declared
}

/** Largest attachment worth pulling. Receipts are small; anything larger is a report. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

export interface IngestedReceipt {
  documentId: string
  inboxItemId: string
  fileName: string
  mailbox: string
}

/**
 * Provenance written onto the inbox item.
 *
 * Deliberately in `channel_context` and not in `extracted_data`: retrying
 * extraction overwrites extracted_data wholesale, and the record of which
 * mailbox a receipt came from must survive that. Same rule the WhatsApp intake
 * follows.
 */
function buildChannelContext(candidate: MailCandidate, attachmentId: string) {
  return {
    channel: 'mail_hunt',
    mail_message_id: candidate.messageId,
    mail_attachment_id: attachmentId,
    // Message + attachment, because one forward can carry receipts for several
    // different purchases and each must be able to land separately. Taken from
    // the attachment being stored, not from index 0: filing a later attachment
    // under its sibling's key would block the sibling from ever landing.
    mail_file_key: `${candidate.messageId}::${attachmentId}`,
    mail_mailbox: candidate.mailbox,
    mail_provider: candidate.provider,
    mail_subject: candidate.subject,
    mail_from: candidate.from,
    mail_received_at: candidate.receivedAt,
    fetched_at: new Date().toISOString(),
  }
}

/**
 * Fetch the first usable attachment on a candidate and file it as an inbox item.
 *
 * Returns null when there is nothing to store (body-only receipt, oversized
 * attachment, or a duplicate we have already ingested). Never throws for one
 * bad message: a single unreadable attachment must not abort a night's hunt.
 */
export async function ingestMailCandidate(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  candidate: MailCandidate,
  /**
   * What this document is paperwork for, as the reading model saw it.
   *
   * Stored so a later run compares like with like. Deriving it again from the
   * extraction would compare the model's "Norwegian" against the PDF's
   * "Norwegian Air Shuttle AOC AS" and conclude they are two suppliers, which
   * is how an already-held receipt got fetched a second time.
   */
  receiptIdentity?: string,
): Promise<IngestedReceipt | null> {
  if (candidate.attachmentIds.length === 0) return null

  const service = getMailSearchService()

  for (const [index, attachmentId] of candidate.attachmentIds.entries()) {
    // Per attachment, not per message: the check has to name the file it is
    // about, and it sits inside the loop so trying a second attachment is not
    // suppressed by the first one already being filed.
    const fileKey = `${candidate.messageId}::${attachmentId}`
    const { data: existing } = await supabase
      .from('invoice_inbox_items')
      .select('id')
      .eq('company_id', companyId)
      .eq('source', 'mail_hunt')
      .eq('channel_context->>mail_file_key', fileKey)
      .maybeSingle()
    if (existing) continue

    let fetched
    try {
      fetched = await service.fetchAttachment(candidate.connectionId, candidate.messageId, attachmentId)
    } catch (error) {
      log.warn('could not fetch attachment', {
        messageId: candidate.messageId,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    if (!fetched) continue
    if (fetched.bytes.byteLength > MAX_ATTACHMENT_BYTES) continue

    try {
      // The name the search already reported beats the one the provider
      // re-derives on fetch: a second lookup can come back empty and fall back
      // to a generic "underlag.pdf", throwing away "2332687551.pdf".
      const knownName = candidate.attachmentNames?.[index]
      const fileName = knownName && knownName.length > 0 ? knownName : fetched.filename

      const document = await uploadDocument(
        supabase,
        userId,
        companyId,
        {
          name: fileName,
          buffer: fetched.bytes.buffer.slice(
            fetched.bytes.byteOffset,
            fetched.bytes.byteOffset + fetched.bytes.byteLength,
          ) as ArrayBuffer,
          type: sniffMimeType(fetched.bytes, fetched.mimeType, fileName),
        },
        { upload_source: 'mail_hunt', dedupeByContent: true },
      )

      // Content already archived for this company: the provenance key above
      // only catches the SAME message re-hunted, while this catches the same
      // receipt arriving through another inbox or channel (forwards are
      // common). Skip ONLY when an inbox item already carries the document:
      // then the receipt is in the Underlag flow (or handled). When the match
      // is a document that never passed the inbox (a manually attached copy,
      // an archival file), fall through and file an item for the EXISTING
      // document: silently dropping the receipt could leave a real
      // affärshändelse without underlag routing (BFL 5 kap).
      if (document.deduplicated) {
        const { data: dupItem, error: dupErr } = await supabase
          .from('invoice_inbox_items')
          .select('id')
          .eq('company_id', companyId)
          .eq('document_id', document.id)
          .limit(1)
          .maybeSingle()
        // Fail closed: a broken lookup must not file a second item.
        if (dupErr) throw new Error(dupErr.message)
        if (dupItem) {
          // Behandlingshistorik, not just an app log: the dedupe decision is
          // part of the auditable trail (BFNAR 2013:2 kap 8).
          try {
            await appendProcessingHistory({
              companyId,
              correlationId: crypto.randomUUID(),
              aggregateType: 'Document',
              aggregateId: document.id,
              eventType: 'DocumentDuplicateSkipped',
              // No mailbox address here: the processing-history payload
              // contract is pseudonymous IDs only (never emails). Which
              // mailbox first delivered the receipt is on the existing
              // item's channel_context.
              payload: {
                channel: 'mail_hunt',
                document_id: document.id,
                inbox_item_id: (dupItem as { id: string }).id,
                mail_message_id: candidate.messageId,
                reason: 'duplicate_content',
              },
              actor: { type: 'system', id: 'receipt-hunt' },
              occurredAt: new Date(),
            })
          } catch (histErr) {
            log.warn('could not append DocumentDuplicateSkipped', {
              error: histErr instanceof Error ? histErr.message : String(histErr),
            })
          }
          log.info('skipped duplicate attachment content', {
            messageId: candidate.messageId,
            documentId: document.id,
          })
          continue
        }
      }

      // uploadDocument emits document.uploaded and awaits its handlers, so the
      // extraction extension has already read the amount, date and vendor out
      // of this file by the time we get here. Copying it onto the inbox item is
      // what lets the deterministic matcher pair the receipt on its amount:
      // the pool is read from invoice_inbox_items, and a row with no
      // extracted_data can never match anything.
      const { data: extractedRow } = await supabase
        .from('document_attachments')
        .select('extracted_data')
        .eq('id', document.id)
        .maybeSingle()
      const extracted = (extractedRow as { extracted_data?: Record<string, unknown> } | null)
        ?.extracted_data

      const { data: item, error } = await supabase
        .from('invoice_inbox_items')
        .insert({
          company_id: companyId,
          user_id: userId,
          document_id: document.id,
          source: 'mail_hunt',
          status: 'received',
          email_from: candidate.from,
          email_subject: candidate.subject,
          email_received_at: candidate.receivedAt,
          extracted_data: extracted ?? null,
          channel_context: {
            ...buildChannelContext(candidate, attachmentId),
            ...(receiptIdentity ? { receipt_identity: receiptIdentity } : {}),
          },
        })
        .select('id')
        .single()

      if (error) {
        // 23505 is the partial unique index doing its job: another run got
        // there first, which is a success from the caller's point of view.
        if (error.code === '23505') return null
        throw new Error(error.message)
      }

      return {
        documentId: document.id,
        inboxItemId: (item as { id: string }).id,
        fileName,
        mailbox: candidate.mailbox,
      }
    } catch (error) {
      log.warn('could not store hunted receipt', {
        messageId: candidate.messageId,
        error: error instanceof Error ? error.message : String(error),
      })
      // Magic-byte rejection and the like: try the next attachment rather than
      // failing the whole candidate.
      continue
    }
  }

  return null
}
