/**
 * What a user can do to an invoice-inbox item (invoice_inbox_items, the
 * Underlag inbox): list and read items, correct the reading's fields,
 * release a transaction match, and discard an item. One implementation
 * behind the invoice-inbox extension routes
 * (/api/extensions/ext/invoice-inbox/items/**) and the v1 operations
 * (lib/operations/inbox-items.ts), so every door applies the same rules:
 *
 *   - an item converted to a supplier invoice is frozen: its reading cannot
 *     be edited and it cannot be deleted;
 *   - a booked item (created_journal_entry_id) cannot be deleted;
 *   - field edits merge into the reading (never drop fields the edit did not
 *     name) under optimistic concurrency on updated_at;
 *   - releasing a transaction match clears the transaction's document pin
 *     only when it is still this item's document.
 *
 * Personal data: lists carry a summary of the reading (vendor, total,
 * dates), never the e-mail body or the full extracted_data; a single item's
 * read carries both, as the dashboard's detail rail does.
 *
 * A dry run reads and checks; it writes nothing.
 */
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { decodeDefaultCursor, encodeDefaultCursor } from '@/lib/api/v1/pagination'
import { UUID_RE } from '@/lib/invariants/uuid'
import {
  resolveBookedJournalEntryIds,
  resolveUnderlagAnchoring,
  type UnderlagAnchoring,
  type UnderlagAnchoringResult,
} from '@/lib/transactions/inbox-underlag'
import type { InvoiceExtractionResult } from '@/types'
import { INBOX_DOCUMENT_KINDS } from '@/lib/documents/inbox-kind'
import { recordInboxDecision, snapshotInboxExtraction } from '@/lib/suggestion-log/inbox'
import { passed } from '@/lib/suggestion-log/checks'
import { intakeSourceForInboxItem, type IntakeSourceId } from '@/lib/intake/sources'
import { mirrorCorrectedReadingToDocument } from '@/lib/documents/reading-correction'
import { correctionPaths, withPersonFields } from '@/lib/documents/person-corrections'
import { resolveInboxPurchaseCategories, type InboxPurchaseCategory } from '@/lib/categories/inbox-purchase-category'
import type { DocumentReadingLoader } from '@/lib/documents/reading/load'
import type { ReadingItemRow } from '@/lib/documents/reading/resolve'
import type { DocumentReading } from '@/lib/documents/reading/types'
import { readInboxBankMatch, type BankMatch, type BankMatchItemRow } from '@/lib/documents/inbox-bank-match'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

const NOT_FOUND: Failure = { ok: false, code: 'INBOX_ITEM_NOT_FOUND' }

function failed(error: unknown): Failure {
  return { ok: false, code: 'UNKNOWN_ERROR', error }
}

/** Per-item underlag verdict (#1548), or 'unknown' when the document row could not be read. */
export type UnderlagStatus = UnderlagAnchoring | 'unknown'

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

interface InboxItemSummaryRow {
  id: string
  status: string
  source: string
  created_at: string
  document_id: string | null
  extracted_data: Record<string, unknown> | null
  matched_supplier_id: string | null
  matched_transaction_id: string | null
  created_supplier_invoice_id: string | null
  created_journal_entry_id: string | null
  email_from: string | null
  email_subject: string | null
  email_received_at: string | null
  error_message: string | null
  kind_hint: string | null
}

export interface InboxItemSummary {
  inbox_item_id: string
  status: string
  source: string
  created_at: string
  document_id: string | null
  kind_hint: string | null
  vendor_name: string | null
  amount: number | null
  currency: string | null
  invoice_date: string | null
  processed: boolean
  matched_supplier_id: string | null
  matched_transaction_id: string | null
  matched_transaction_journal_entry_id: string | null
  created_supplier_invoice_id: string | null
  created_journal_entry_id: string | null
  underlag_status: UnderlagStatus | null
  email_from: string | null
  email_subject: string | null
  email_received_at: string | null
  error_message: string | null
}

function readingSummary(extracted: Record<string, unknown> | null) {
  const supplier = (extracted?.supplier ?? undefined) as Record<string, unknown> | undefined
  const invoice = (extracted?.invoice ?? undefined) as Record<string, unknown> | undefined
  const totals = (extracted?.totals ?? undefined) as Record<string, unknown> | undefined
  return {
    vendor_name: typeof supplier?.name === 'string' && supplier.name ? supplier.name : null,
    amount: typeof totals?.total === 'number' ? totals.total : null,
    currency: typeof invoice?.currency === 'string' && invoice.currency ? invoice.currency : null,
    invoice_date: typeof invoice?.invoiceDate === 'string' && invoice.invoiceDate ? invoice.invoiceDate : null,
  }
}

/** The columns the booked-state enrichment reads. */
export type InboxBookedStateRow = Pick<
  InboxItemSummaryRow,
  'id' | 'document_id' | 'matched_transaction_id' | 'created_journal_entry_id' | 'created_supplier_invoice_id'
>

export interface InboxBookedState {
  /** The verifikat that books the item's matched transaction, when it is booked. */
  journalEntryId: string | null
  /** Whether THIS item's document reached that verifikat; null when nothing to judge. */
  underlag: UnderlagStatus | null
}

/**
 * The booked-state enrichment every inbox list and detail applies (the
 * dashboard routes and the v1 operations): a matched but unstamped item whose
 * transaction is booked reports that verifikat, and whether THIS item's
 * document actually reached it (#1548).
 *
 * created_journal_entry_id is UNIQUE per verifikat, so on a samlingsverifikat
 * only one of N items can carry it: deriving "booked" from the transaction's
 * own state is what lets the rest leave the active inbox. The transaction
 * being booked says a verifikat exists, not that this item's underlag reached
 * it, so a document whose link failed or that is anchored to another
 * verifikat keeps the item in "Att göra". Absent from the anchoring read
 * means the document row could not be read: 'unknown', which the UI treats
 * like a divergent item. Never booked on a guess.
 */
export async function resolveInboxBookedState(
  supabase: SupabaseClient,
  companyId: string,
  rows: InboxBookedStateRow[],
): Promise<Map<string, InboxBookedState>> {
  const out = new Map<string, InboxBookedState>()
  const unresolved = rows.filter(
    (r) => r.matched_transaction_id && !r.created_journal_entry_id && !r.created_supplier_invoice_id,
  )
  const txIds = Array.from(new Set(unresolved.map((r) => r.matched_transaction_id as string)))
  const bookedByTx = txIds.length > 0
    ? await resolveBookedJournalEntryIds(supabase, companyId, txIds)
    : new Map<string, string>()
  const toAnchor = unresolved
    .filter((r) => bookedByTx.has(r.matched_transaction_id as string))
    .map((r) => ({
      id: r.id,
      document_id: r.document_id,
      journalEntryId: bookedByTx.get(r.matched_transaction_id as string) as string,
    }))
  const anchoring = toAnchor.length > 0
    ? await resolveUnderlagAnchoring(supabase, companyId, toAnchor)
    : new Map<string, UnderlagAnchoringResult>()
  for (const r of rows) {
    const derived = r.matched_transaction_id ? bookedByTx.get(r.matched_transaction_id) ?? null : null
    // Only unstamped items were sent to the anchoring read; a stamped sibling
    // is booked by its own column and gets no verdict here.
    const unstamped = !r.created_journal_entry_id && !r.created_supplier_invoice_id
    out.set(r.id, {
      journalEntryId: derived,
      underlag: derived && unstamped ? anchoring.get(r.id)?.status ?? 'unknown' : null,
    })
  }
  return out
}

function toSummary(
  row: InboxItemSummaryRow,
  extra: InboxBookedState | undefined,
): InboxItemSummary {
  return {
    inbox_item_id: row.id,
    status: row.status,
    source: row.source,
    created_at: row.created_at,
    document_id: row.document_id ?? null,
    kind_hint: row.kind_hint ?? null,
    ...readingSummary(row.extracted_data),
    // Processed = any terminal link, the same semantics gnubok_list_inbox_items uses.
    processed: !!(row.matched_transaction_id || row.created_supplier_invoice_id || row.created_journal_entry_id),
    matched_supplier_id: row.matched_supplier_id ?? null,
    matched_transaction_id: row.matched_transaction_id ?? null,
    matched_transaction_journal_entry_id: extra?.journalEntryId ?? null,
    created_supplier_invoice_id: row.created_supplier_invoice_id ?? null,
    created_journal_entry_id: row.created_journal_entry_id ?? null,
    underlag_status: extra?.underlag ?? null,
    email_from: row.email_from ?? null,
    email_subject: row.email_subject ?? null,
    email_received_at: row.email_received_at ?? null,
    error_message: row.error_message ?? null,
  }
}

export interface ListInboxItemsFilters {
  status?: 'received' | 'error'
  unprocessed_only?: 'true' | 'false'
  cursor?: string
  limit?: number
}

/**
 * One page of inbox items, newest first, keyset on (created_at, id)
 * descending. unprocessed_only keeps items with no terminal link (no
 * transaction match, supplier invoice or verifikat). A cursor that does not
 * decode starts over.
 */
export async function listInboxItemsPage(
  ctx: OperationContext,
  filters: ListInboxItemsFilters,
): Promise<OperationOutcome<{ inbox_items: InboxItemSummary[]; next_cursor: string | null }>> {
  const limit = filters.limit ?? 50
  const decoded = decodeDefaultCursor(filters.cursor)
  let query = ctx.supabase
    .from('invoice_inbox_items')
    .select('id, status, source, created_at, document_id, extracted_data, matched_supplier_id, matched_transaction_id, created_supplier_invoice_id, created_journal_entry_id, email_from, email_subject, email_received_at, error_message, kind_hint')
    .eq('company_id', ctx.companyId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1)
  if (filters.status) query = query.eq('status', filters.status)
  if (filters.unprocessed_only === 'true') {
    query = query
      .is('matched_transaction_id', null)
      .is('created_supplier_invoice_id', null)
      .is('created_journal_entry_id', null)
  }
  if (decoded) {
    query = query.or(`created_at.lt.${decoded.ts},and(created_at.eq.${decoded.ts},id.lt.${decoded.id})`)
  }
  const { data, error } = await query
  if (error) return failed(error)
  const rows = (data ?? []) as unknown as InboxItemSummaryRow[]
  const page = rows.slice(0, limit)
  const extras = await resolveInboxBookedState(ctx.supabase, ctx.companyId, page)
  const last = page[page.length - 1]
  return {
    ok: true,
    data: {
      inbox_items: page.map((row) => toSummary(row, extras.get(row.id))),
      next_cursor: rows.length > limit && last ? encodeDefaultCursor(last) : null,
    },
  }
}

interface InboxItemDetailRow extends InboxItemSummaryRow {
  email_body_text: string | null
  extraction_skipped: boolean | null
  updated_at: string
  channel_context?: { intake_source?: unknown; channel?: unknown } | null
  routed_to_arkiv_at: string | null
  bank_match_transaction_id: string | null
  bank_match_basis: string | null
  bank_match_evidence_level: string | null
  bank_match_source_key: string | null
}

export interface InboxItemDetail extends InboxItemSummary {
  extracted_data: Record<string, unknown> | null
  /** What was bought, computed at read time (lib/categories/inbox-purchase-category.ts). */
  purchase_category: InboxPurchaseCategory | null
  extraction_skipped: boolean
  email_body_text: string | null
  file_name: string | null
  updated_at: string
  /** The canonical door it came through (lib/intake/sources.ts); null when nothing on the row names one. */
  intake_source: IntakeSourceId | null
  /** The one reading (lib/documents/reading), only when the caller asked for it. */
  reading?: DocumentReading
  /** Match on arrival: the bank row it looks already paid by, a proposal (lib/documents/inbox-bank-match.ts). */
  bank_match: BankMatch | null
}

/**
 * One item with its full reading and e-mail text. When the item has no
 * reading of its own the document's stands in, as on the dashboard (a receipt
 * routed from Dokument before its reading landed).
 */
export async function getInboxItem(
  ctx: OperationContext,
  inboxItemId: string,
  /** reading: the loader of the one reading (the inbox block's, passed in by the caller: the ledger may not import it). */
  options: { reading?: DocumentReadingLoader } = {},
): Promise<OperationOutcome<InboxItemDetail>> {
  if (!UUID_RE.test(inboxItemId)) return NOT_FOUND
  const { data, error } = await ctx.supabase
    .from('invoice_inbox_items')
    .select('id, status, source, created_at, updated_at, document_id, extracted_data, extraction_skipped, matched_supplier_id, matched_transaction_id, created_supplier_invoice_id, created_journal_entry_id, email_from, email_subject, email_received_at, email_body_text, error_message, kind_hint, channel_context, routed_to_arkiv_at, bank_match_transaction_id, bank_match_basis, bank_match_evidence_level, bank_match_source_key')
    .eq('id', inboxItemId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) return failed(error)
  if (!data) return NOT_FOUND
  const row = data as unknown as InboxItemDetailRow
  // As stored, before the document's reading stands in below: the reading tells the two apart itself.
  const storedItem = { ...row } as unknown as ReadingItemRow
  // The proposal is read from the row as stored too: it is a hint, so a failed read answers none.
  let bankMatch: BankMatch | null = null
  try {
    bankMatch = await readInboxBankMatch(ctx.supabase, ctx.companyId, { ...row } as BankMatchItemRow)
  } catch (err) {
    ctx.log.warn('inbox item bank match read failed', { inboxItemId, reason: err instanceof Error ? err.message : String(err) })
  }

  let fileName: string | null = null
  let uploadSource: string | null = null
  if (row.document_id) {
    const { data: doc, error: docError } = await ctx.supabase
      .from('document_attachments')
      .select('id, file_name, extracted_data, upload_source')
      .eq('id', row.document_id)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (docError) return failed(docError)
    const document = doc as { file_name?: string | null; extracted_data?: Record<string, unknown> | null; upload_source?: string | null } | null
    fileName = document?.file_name ?? null
    uploadSource = document?.upload_source ?? null
    if (row.extracted_data == null && document?.extracted_data) {
      row.extracted_data = document.extracted_data
      row.extraction_skipped = false
    }
  }

  let reading: DocumentReading | undefined
  if (options.reading) {
    try {
      reading = await options.reading(ctx.supabase, ctx.companyId, { item: storedItem })
    } catch (err) {
      return failed(err)
    }
  }

  const extras = await resolveInboxBookedState(ctx.supabase, ctx.companyId, [row])
  const purchaseCategories = await resolveInboxPurchaseCategories(ctx.supabase, ctx.companyId, [row])
  return {
    ok: true,
    data: {
      ...toSummary(row, extras.get(row.id)),
      extracted_data: row.extracted_data ?? null,
      purchase_category: purchaseCategories.get(row.id) ?? null,
      extraction_skipped: row.extraction_skipped === true,
      email_body_text: row.email_body_text ?? null,
      file_name: fileName,
      updated_at: row.updated_at,
      intake_source: intakeSourceForInboxItem({
        source: row.source,
        channel_context: row.channel_context ?? null,
        document_upload_source: uploadSource,
        document_file_name: fileName,
      }),
      ...(reading ? { reading } : {}),
      bank_match: bankMatch,
    },
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

interface DeletePreviewRow {
  id: string
  document_id: string | null
  extracted_data: Record<string, unknown> | null
  email_from: string | null
  email_subject: string | null
  created_at: string | null
}

/**
 * What approving a delete removes, and how the approver recognises the item
 * (crm#1411, crm#1412). The card in Granskning showed "Ta bort post ur
 * inkorgen" and nothing else, so the owner approved blind; and the preview
 * said `would_delete: true` beside the document id, which read as if the
 * file went too. It never does: the item goes, the document stays in the
 * archive, and the preview now says both outright, with the file name,
 * supplier, amount and sender to tell one item from another. A file name
 * that cannot be read is left out, never a reason to refuse.
 */
async function deletePreview(ctx: OperationContext, item: DeletePreviewRow): Promise<Record<string, unknown>> {
  let fileName: string | null = null
  if (item.document_id) {
    const { data: doc } = await ctx.supabase
      .from('document_attachments')
      .select('file_name')
      .eq('id', item.document_id)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    fileName = (doc as { file_name?: string | null } | null)?.file_name ?? null
  }
  const reading = readingSummary(item.extracted_data)
  return {
    inbox_item_id: item.id,
    document_id: item.document_id ?? null,
    inbox_item_deleted: true,
    document_kept: true,
    file_name: fileName,
    supplier_name: reading.vendor_name,
    amount: reading.amount,
    currency: reading.currency,
    invoice_date: reading.invoice_date,
    email_from: item.email_from ?? null,
    email_subject: item.email_subject ?? null,
    received_at: item.created_at ?? null,
  }
}

/**
 * Discard an inbox item. Refused once it became a supplier invoice or was
 * booked. The document it carried stays in the archive (a separate row with
 * its own deletion rule).
 */
export async function deleteInboxItem(
  ctx: OperationContext,
  inboxItemId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ id: string; deleted: true }>> {
  const { data: item, error: fetchError } = await ctx.supabase
    .from('invoice_inbox_items')
    .select('id, document_id, created_supplier_invoice_id, created_journal_entry_id, extracted_data, email_from, email_subject, created_at')
    .eq('id', inboxItemId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  // A failed read answers 404, as the dashboard route always has.
  if (fetchError || !item) return NOT_FOUND
  if (item.created_supplier_invoice_id) {
    return { ok: false, code: 'INBOX_ITEM_DELETE_CONVERTED', details: { supplier_invoice_id: item.created_supplier_invoice_id } }
  }
  if (item.created_journal_entry_id) {
    return { ok: false, code: 'INBOX_ITEM_DELETE_BOOKED', details: { journal_entry_id: item.created_journal_entry_id } }
  }

  if (options.dryRun) {
    return { ok: true, dryRun: true, preview: await deletePreview(ctx, item as DeletePreviewRow) }
  }

  // Deleting the item dismisses the model's reading of its underlag.
  const extractionSnapshot = await snapshotInboxExtraction(ctx.supabase, ctx.companyId, item)

  const { error } = await ctx.supabase
    .from('invoice_inbox_items')
    .delete()
    .eq('id', inboxItemId)
    .eq('company_id', ctx.companyId)
  if (error) return failed(error)
  // Deleting ran one guard: the item was neither converted nor booked.
  await recordInboxDecision(ctx.supabase, extractionSnapshot, null, ctx.userId, [passed('already_booked')])
  return { ok: true, data: { id: inboxItemId, deleted: true } }
}

// ---------------------------------------------------------------------------
// Release a transaction match
// ---------------------------------------------------------------------------

/**
 * Clear the item's transaction match (a wrong pairing, or to pair it again).
 * The transaction's document pin is cleared too, but only while it is still
 * this item's document: a document from another source stays.
 */
export async function unmatchInboxItemTransaction(
  ctx: OperationContext,
  inboxItemId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ id: string; matched_transaction_id: null; released_transaction_id: string | null }>> {
  const { supabase, companyId, log } = ctx
  const { data: existing, error: fetchError } = await supabase
    .from('invoice_inbox_items')
    .select('id, document_id, matched_transaction_id')
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (fetchError || !existing) return NOT_FOUND

  const releasedTransactionId = (existing.matched_transaction_id as string | null) ?? null

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        inbox_item_id: existing.id,
        released_transaction_id: releasedTransactionId,
        clears_transaction_document: releasedTransactionId != null && existing.document_id != null,
      },
    }
  }

  const { error: updateError } = await supabase
    .from('invoice_inbox_items')
    .update({ matched_transaction_id: null })
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
  if (updateError) return failed(updateError)

  // Mirror the release onto the transaction's pin, only when it still points
  // at this item's document (never a document from another source).
  // Best-effort: the item's own match is the primary effect.
  if (releasedTransactionId && existing.document_id) {
    const { error: txUpdateError } = await supabase
      .from('transactions')
      .update({ document_id: null })
      .eq('id', releasedTransactionId)
      .eq('company_id', companyId)
      .eq('document_id', existing.document_id)
    if (txUpdateError) {
      log.error('inbox unmatch: clearing the transaction document pin failed', txUpdateError as unknown as Error)
    }
  }

  return {
    ok: true,
    data: { id: inboxItemId, matched_transaction_id: null, released_transaction_id: releasedTransactionId },
  }
}

// ---------------------------------------------------------------------------
// Correct the reading's fields
// ---------------------------------------------------------------------------

const NullableString = z.string().trim().max(500).nullable()
const NullableDate = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Invalid date: expected YYYY-MM-DD')
  // Catch impossible calendar dates like 2026-02-30 that pass the regex.
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid calendar date')
  .nullable()
const NullableNumber = z.number().nullable()

/**
 * The scalar fields a person corrects by hand. Line items and the VAT
 * breakdown stay with the reading and survive the merge.
 */
export const UpdateInboxItemFieldsSchema = z.object({
  // What the document is, as a person decides it: a reading that took a
  // normal invoice for a credit note (or the reverse) is corrected here.
  // Negative totals still read as a credit note until they are corrected.
  documentKind: z.enum(INBOX_DOCUMENT_KINDS).nullable().optional(),
  supplier: z
    .object({
      name: NullableString,
      orgNumber: NullableString,
      vatNumber: NullableString,
      address: NullableString,
      bankgiro: NullableString,
      plusgiro: NullableString,
    })
    .partial()
    .optional(),
  invoice: z
    .object({
      invoiceNumber: NullableString,
      invoiceDate: NullableDate,
      dueDate: NullableDate,
      paymentReference: NullableString,
      // On a credit note: the invoice number it credits (issue #2980).
      creditedInvoiceNumber: NullableString,
      // ISO 4217: a loose string would flow into the supplier invoice and
      // produce a faktura with an invalid currency (ML 17 kap 24 § p.9).
      currency: z.string().regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO 4217 code'),
    })
    .partial()
    .optional(),
  totals: z
    .object({
      subtotal: NullableNumber,
      vatAmount: NullableNumber,
      total: NullableNumber,
    })
    .partial()
    .optional(),
})

export type UpdateInboxItemFieldsInput = z.infer<typeof UpdateInboxItemFieldsSchema>

/**
 * Merge a correction into the item's reading. The spread of the current
 * reading comes first on purpose: naming surviving keys one by one once
 * wiped documentKind, merchantCategory, legibility and more on the first
 * manual edit. A hand-set TOTALT stops being a promoted prominent amount.
 * The paths the correction names are recorded beside the reading
 * (personFields, lib/documents/person-corrections.ts), so a new reading
 * never overwrites them.
 */
export function mergeInboxItemFields(
  current: InvoiceExtractionResult,
  body: UpdateInboxItemFieldsInput,
): InvoiceExtractionResult {
  const merged: InvoiceExtractionResult = {
    ...current,
    supplier: { ...current.supplier, ...body.supplier },
    invoice: { ...current.invoice, ...body.invoice },
    totals: { ...current.totals, ...body.totals },
    lineItems: current.lineItems ?? [],
    vatBreakdown: current.vatBreakdown ?? [],
    confidence: current.confidence ?? 0,
  }
  if (body.totals && 'total' in body.totals) {
    merged.totalSource = null
  }
  if (body.documentKind !== undefined) {
    merged.documentKind = body.documentKind
  }
  return withPersonFields(merged, correctionPaths(body))
}

/**
 * Apply a field correction. Optimistic concurrency on the trigger-maintained
 * updated_at: the write is read-merge-write over the whole jsonb, so a racing
 * save must not restore its stale copy of every field; zero rows updated
 * answers INBOX_ITEM_EDIT_CONFLICT and the caller re-reads.
 *
 * The corrected reading is then mirrored onto the document's extracted_data
 * (mirrorCorrectedReadingToDocument), best effort: a document in a locked
 * period, or a failed write, is logged and the edit still stands.
 */
export async function updateInboxItemFields(
  ctx: OperationContext,
  inboxItemId: string,
  body: UpdateInboxItemFieldsInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ id: string; extracted_data: Record<string, unknown> }>> {
  const { data: item, error: fetchError } = await ctx.supabase
    .from('invoice_inbox_items')
    .select('id, document_id, extracted_data, created_supplier_invoice_id, updated_at')
    .eq('id', inboxItemId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (fetchError || !item) return NOT_FOUND
  if (item.created_supplier_invoice_id) {
    return { ok: false, code: 'INBOX_ITEM_EDIT_LOCKED', details: { supplier_invoice_id: item.created_supplier_invoice_id } }
  }

  const current = (item.extracted_data ?? {}) as InvoiceExtractionResult
  const merged = mergeInboxItemFields(current, body)

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: { inbox_item_id: item.id, extracted_data: merged as unknown as Record<string, unknown> },
    }
  }

  const { data: updated, error: updateError } = await ctx.supabase
    .from('invoice_inbox_items')
    .update({ extracted_data: merged as unknown as Record<string, unknown> })
    .eq('id', inboxItemId)
    .eq('company_id', ctx.companyId)
    .eq('updated_at', (item as { updated_at: string }).updated_at)
    .select('id, extracted_data')
    .maybeSingle()
  if (updateError) return failed(updateError)
  if (!updated) return { ok: false, code: 'INBOX_ITEM_EDIT_CONFLICT' }
  await mirrorCorrectedReadingToDocument({
    documentId: (item as { document_id?: string | null }).document_id,
    companyId: ctx.companyId,
    reading: updated.extracted_data as Record<string, unknown>,
  })
  return {
    ok: true,
    data: { id: updated.id as string, extracted_data: updated.extracted_data as Record<string, unknown> },
  }
}
