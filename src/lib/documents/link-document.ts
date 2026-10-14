/**
 * Linking an uploaded document (underlag) to a verifikat: the one rule set
 * behind every door that does it from a request, so the doors cannot drift
 * again. v1 POST /documents/{id}/link, the dashboard POST
 * /api/documents/{id}/link, the MCP link_document_to_voucher staging and the
 * link_document_to_voucher / link_documents_to_vouchers approvals all call
 * linkDocumentToVoucher; a door only parses its input and words the refusal
 * in its own envelope.
 *
 * Each door used to wrap linkToJournalEntry in checks of its own. v1 refused
 * only a POSTED holder (a draft or reversed holder passed its dry run and then
 * failed at the trigger with another code), never checked the period lock up
 * front, and stamped any inbox item named by inbox_item_id; the dashboard and
 * MCP never checked that journal_entry_line_id belongs to the verifikat; v1
 * and the dashboard left the inbox item carrying the document "unprocessed"
 * unless the caller named it. The rules, mirroring the database:
 *
 *   - the document and the verifikat belong to the company, and a line, when
 *     given, belongs to that verifikat (the FK checks existence only, and a
 *     wrong pin is permanent once set);
 *   - a set link never changes, whatever the holder's status
 *     (enforce_document_journal_entry_immutability, migration 20260705100000:
 *     journal_entry_id never moves off its holder, a set journal_entry_line_id
 *     never changes; BFL 5 kap 6-7 §§, 7 kap); re-linking to the same
 *     verifikat is a no-op or a line-level refinement and allowed;
 *   - a verifikat in a closed or locked period takes no underlag
 *     (enforce_period_lock_documents);
 *   - after the link, every inbox item that carries the document and is not
 *     yet handled is stamped with the verifikat (stampInboxItemsForLinkedDocument,
 *     CAS on both link columns, so a supplier-invoice item never gets a second
 *     link). An inbox_item_id the caller sends no longer decides which item is
 *     stamped: an item that does not carry the document is never touched.
 *
 * The triggers stay authoritative: a write that races past these checks is
 * still refused there, and linkToJournalEntry throws it typed
 * (DocumentAlreadyLinkedError) or as the trigger's text, which each door maps
 * as before.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { dbError } from '@/lib/errors/db-error'
import { isPeriodLocked } from '@/lib/documents/underlag-import'
import type { DocumentLinkHolder } from '@/lib/documents/link-holder'
import { stampInboxItemsForLinkedDocument } from '@/lib/transactions/inbox-underlag'
import type { DocumentAttachment } from '@/types'

export interface LinkDocumentInput {
  document_id: string
  journal_entry_id: string
  journal_entry_line_id?: string | null
  /**
   * The inbox item the caller says the document came from. It no longer
   * decides what is stamped (the items carrying the document are); it only
   * makes a link that stamped nothing worth a log line (see expectInboxItem).
   */
  inbox_item_id?: string | null
}

export interface LinkDocumentTarget {
  document: {
    id: string
    file_name: string
    mime_type: string | null
    journal_entry_id: string | null
    journal_entry_line_id: string | null
  }
  entry: {
    id: string
    entry_date: string
    description: string | null
    voucher_series: string | null
    voucher_number: number | null
    status: string
    fiscal_period_id: string | null
  }
}

/** The fiscal period a refused link targets, as fiscal_periods holds it. */
export interface LinkDocumentPeriod {
  id: string
  period_start: string
  is_closed: boolean
  locked_at: string | null
  closed_externally: boolean | null
  closing_entry_id: string | null
}

export type LinkDocumentRefusal =
  | {
      ok: false
      code: 'NOT_FOUND'
      details: { resource: 'document' | 'journal_entry' | 'journal_entry_line'; field?: string }
    }
  | {
      ok: false
      code: 'DOC_LINK_ALREADY_LINKED'
      details: {
        /** The verifikat holding the document, null when it cannot be read. */
        holder: DocumentLinkHolder | null
        current_journal_entry_id: string
        /** True when the holder is this verifikat and only the line would change. */
        line_change: boolean
      }
    }
  | { ok: false; code: 'PERIOD_LOCKED'; details: { period: LinkDocumentPeriod } }

export type LinkDocumentResult =
  | { ok: true; dryRun: true; target: LinkDocumentTarget }
  | { ok: true; dryRun: false; target: LinkDocumentTarget; document: DocumentAttachment }
  | LinkDocumentRefusal

/**
 * A lookup by id that failed only because no row can match: `.maybeSingle()`
 * found none (PGRST116) or the id is not a UUID (22P02). Any other database
 * failure is thrown with its SQLSTATE, so a timeout never reads as a wrong id.
 */
function isLookupMiss(error: { code?: string | null } | null): boolean {
  return !error || error.code === 'PGRST116' || error.code === '22P02'
}

/**
 * Every rule a link must pass, without writing anything: what a dry run, a
 * staging and the commit all ask first. Throws on a database failure.
 */
export async function checkDocumentLink(
  supabase: SupabaseClient,
  companyId: string,
  input: LinkDocumentInput,
): Promise<{ ok: true; target: LinkDocumentTarget } | LinkDocumentRefusal> {
  const [docRes, entryRes] = await Promise.all([
    supabase
      .from('document_attachments')
      .select('id, file_name, mime_type, journal_entry_id, journal_entry_line_id')
      .eq('id', input.document_id)
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('journal_entries')
      .select('id, entry_date, description, voucher_series, voucher_number, status, fiscal_period_id')
      .eq('id', input.journal_entry_id)
      .eq('company_id', companyId)
      .maybeSingle(),
  ])
  if (!isLookupMiss(docRes.error)) throw dbError(docRes.error, 'document link: document lookup failed')
  if (!isLookupMiss(entryRes.error)) throw dbError(entryRes.error, 'document link: journal entry lookup failed')
  const document = (docRes.error ? null : docRes.data) as LinkDocumentTarget['document'] | null
  const entry = (entryRes.error ? null : entryRes.data) as LinkDocumentTarget['entry'] | null
  if (!document) return { ok: false, code: 'NOT_FOUND', details: { resource: 'document' } }
  if (!entry) return { ok: false, code: 'NOT_FOUND', details: { resource: 'journal_entry', field: 'journal_entry_id' } }

  const lineId = input.journal_entry_line_id ?? null
  if (lineId) {
    // The verifikat is company-checked above, so a line on it is the company's.
    const { data: line, error: lineError } = await supabase
      .from('journal_entry_lines')
      .select('id')
      .eq('id', lineId)
      .eq('journal_entry_id', entry.id)
      .maybeSingle()
    if (!isLookupMiss(lineError)) throw dbError(lineError, 'document link: journal entry line lookup failed')
    if (lineError || !line) {
      return { ok: false, code: 'NOT_FOUND', details: { resource: 'journal_entry_line', field: 'journal_entry_line_id' } }
    }
  }

  const heldElsewhere = document.journal_entry_id != null && document.journal_entry_id !== entry.id
  const lineChange =
    document.journal_entry_id === entry.id &&
    document.journal_entry_line_id != null &&
    document.journal_entry_line_id !== lineId
  if (heldElsewhere || lineChange) {
    const holderId = document.journal_entry_id as string
    // Read only to name the holder: the refusal does not depend on it.
    const { data: holderRow, error: holderError } = await supabase
      .from('journal_entries')
      .select('status, voucher_series, voucher_number')
      .eq('id', holderId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!isLookupMiss(holderError)) throw dbError(holderError, 'document link: holder lookup failed')
    const holder = holderRow
      ? { journal_entry_id: holderId, ...(holderRow as Omit<DocumentLinkHolder, 'journal_entry_id'>) }
      : null
    return {
      ok: false,
      code: 'DOC_LINK_ALREADY_LINKED',
      details: { holder, current_journal_entry_id: holderId, line_change: lineChange },
    }
  }

  if (entry.fiscal_period_id) {
    const { data: period, error: periodError } = await supabase
      .from('fiscal_periods')
      .select('id, period_start, is_closed, locked_at, closed_externally, closing_entry_id')
      .eq('id', entry.fiscal_period_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!isLookupMiss(periodError)) throw dbError(periodError, 'document link: fiscal period lookup failed')
    const linkPeriod = (periodError ? null : period) as LinkDocumentPeriod | null
    if (linkPeriod && isPeriodLocked(linkPeriod)) {
      return { ok: false, code: 'PERIOD_LOCKED', details: { period: linkPeriod } }
    }
  }

  return { ok: true, target: { document, entry } }
}

/**
 * Link the document to the verifikat (and the line, when given), then stamp
 * the inbox items that carry the document. With `dryRun` every rule runs and
 * nothing is written. Throws when the write itself fails (a trigger that
 * refused a racing change, a database fault).
 *
 * `expectInboxItem`: log a link that stamped no inbox item. Defaults to
 * whether the caller named one; the MCP doors pass true, since a document an
 * agent uploads always gets an inbox item, while a document uploaded straight
 * to the archive has none and is the normal case on v1 and the dashboard.
 */
export async function linkDocumentToVoucher(
  supabase: SupabaseClient,
  companyId: string,
  input: LinkDocumentInput,
  options: { dryRun?: boolean; expectInboxItem?: boolean } = {},
): Promise<LinkDocumentResult> {
  const check = await checkDocumentLink(supabase, companyId, input)
  if (!check.ok) return check
  if (options.dryRun) return { ok: true, dryRun: true, target: check.target }

  const document = await linkToJournalEntry(
    supabase,
    companyId,
    input.document_id,
    input.journal_entry_id,
    input.journal_entry_line_id ?? undefined,
  )
  // Best effort: the link is committed and is the legally relevant write.
  await stampInboxItemsForLinkedDocument(supabase, companyId, input.document_id, input.journal_entry_id, {
    expectInboxItem: options.expectInboxItem ?? Boolean(input.inbox_item_id),
  })
  return { ok: true, dryRun: false, target: check.target, document }
}
