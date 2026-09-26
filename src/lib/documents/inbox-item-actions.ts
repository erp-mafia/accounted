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
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { decodeDefaultCursor, encodeDefaultCursor } from '@/lib/api/v1/pagination'
import { UUID_RE } from '@/lib/invariants/uuid'
import {
  resolveBookedJournalEntryIds,
  resolveUnderlagAnchoring,
  type UnderlagAnchoring,
} from '@/lib/transactions/inbox-underlag'
import type { InvoiceExtractionResult } from '@/types'

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

/**
 * The booked-state enrichment the dashboard list and detail apply: a matched
 * but unstamped item whose transaction is booked reports that verifikat, and
 * whether THIS item's document actually reached it (#1548).
 */
async function enrich(
  ctx: OperationContext,
  rows: Array<Pick<InboxItemSummaryRow, 'id' | 'document_id' | 'matched_transaction_id' | 'created_journal_entry_id' | 'created_supplier_invoice_id'>>,
): Promise<Map<string, { journalEntryId: string | null; underlag: UnderlagStatus | null }>> {
  const out = new Map<string, { journalEntryId: string | null; underlag: UnderlagStatus | null }>()
  const unresolved = rows.filter(
    (r) => r.matched_transaction_id && !r.created_journal_entry_id && !r.created_supplier_invoice_id,
  )
  const txIds = Array.from(new Set(unresolved.map((r) => r.matched_transaction_id as string)))
  const bookedByTx = await resolveBookedJournalEntryIds(ctx.supabase, ctx.companyId, txIds)
  const anchoring = await resolveUnderlagAnchoring(
    ctx.supabase,
    ctx.companyId,
    unresolved
      .filter((r) => bookedByTx.has(r.matched_transaction_id as string))
      .map((r) => ({
        id: r.id,
        document_id: r.document_id,
        journalEntryId: bookedByTx.get(r.matched_transaction_id as string) as string,
      })),
  )
  for (const r of rows) {
    const derived = r.matched_transaction_id ? bookedByTx.get(r.matched_transaction_id) ?? null : null
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
  extra: { journalEntryId: string | null; underlag: UnderlagStatus | null } | undefined,
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
  const extras = await enrich(ctx, page)
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
}

export interface InboxItemDetail extends InboxItemSummary {
  extracted_data: Record<string, unknown> | null
  extraction_skipped: boolean
  email_body_text: string | null
  file_name: string | null
  updated_at: string
}

/**
 * One item with its full reading and e-mail text. When the item has no
 * reading of its own the document's stands in, as on the dashboard (a receipt
 * routed from Dokument before its reading landed).
 */
export async function getInboxItem(
  ctx: OperationContext,
  inboxItemId: string,
): Promise<OperationOutcome<InboxItemDetail>> {
  if (!UUID_RE.test(inboxItemId)) return NOT_FOUND
  const { data, error } = await ctx.supabase
    .from('invoice_inbox_items')
    .select('id, status, source, created_at, updated_at, document_id, extracted_data, extraction_skipped, matched_supplier_id, matched_transaction_id, created_supplier_invoice_id, created_journal_entry_id, email_from, email_subject, email_received_at, email_body_text, error_message, kind_hint')
    .eq('id', inboxItemId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) return failed(error)
  if (!data) return NOT_FOUND
  const row = data as unknown as InboxItemDetailRow

  let fileName: string | null = null
  if (row.document_id) {
    const { data: doc, error: docError } = await ctx.supabase
      .from('document_attachments')
      .select('id, file_name, extracted_data')
      .eq('id', row.document_id)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (docError) return failed(docError)
    const document = doc as { file_name?: string | null; extracted_data?: Record<string, unknown> | null } | null
    fileName = document?.file_name ?? null
    if (row.extracted_data == null && document?.extracted_data) {
      row.extracted_data = document.extracted_data
      row.extraction_skipped = false
    }
  }

  const extras = await enrich(ctx, [row])
  return {
    ok: true,
    data: {
      ...toSummary(row, extras.get(row.id)),
      extracted_data: row.extracted_data ?? null,
      extraction_skipped: row.extraction_skipped === true,
      email_body_text: row.email_body_text ?? null,
      file_name: fileName,
      updated_at: row.updated_at,
    },
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

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
    .select('id, document_id, created_supplier_invoice_id, created_journal_entry_id')
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
    return {
      ok: true,
      dryRun: true,
      preview: { inbox_item_id: item.id, document_id: item.document_id ?? null, would_delete: true },
    }
  }

  const { error } = await ctx.supabase
    .from('invoice_inbox_items')
    .delete()
    .eq('id', inboxItemId)
    .eq('company_id', ctx.companyId)
  if (error) return failed(error)
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
  return merged
}

/**
 * Apply a field correction. Optimistic concurrency on the trigger-maintained
 * updated_at: the write is read-merge-write over the whole jsonb, so a racing
 * save must not restore its stale copy of every field; zero rows updated
 * answers INBOX_ITEM_EDIT_CONFLICT and the caller re-reads.
 */
export async function updateInboxItemFields(
  ctx: OperationContext,
  inboxItemId: string,
  body: UpdateInboxItemFieldsInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ id: string; extracted_data: Record<string, unknown> }>> {
  const { data: item, error: fetchError } = await ctx.supabase
    .from('invoice_inbox_items')
    .select('id, extracted_data, created_supplier_invoice_id, updated_at')
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
  return {
    ok: true,
    data: { id: updated.id as string, extracted_data: updated.extracted_data as Record<string, unknown> },
  }
}
