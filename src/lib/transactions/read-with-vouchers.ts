import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { TRANSACTION_DETAIL_COLUMNS } from '@/lib/transactions/detail-columns'

/**
 * One bank transaction with everything that books it and every document
 * behind it, for a reader that holds only the transaction id (MCP
 * gnubok_get_transaction). A row is booked through any of three anchors
 * (lib/transactions/is-booked.ts): its own pointer, a
 * transaction_voucher_links row (a bulk-booked samlingsverifikat, a split,
 * a residual) or an invoice or supplier invoice payment of a batch
 * allocation. Reading only the pointer would show those rows as unbooked.
 *
 * Every query filters by company_id; the lines are embedded in the
 * company-scoped verifikat read. A failed read throws: an unread anchor must
 * never answer "not booked".
 */

/** Verifikat and documents per transaction at most: a row is booked by one, rarely a handful. */
const LIMIT = 50

export type VoucherAnchor = 'pointer' | 'bank_line' | 'clearing' | 'other' | 'invoice_payment' | 'supplier_invoice_payment'

export interface TransactionVerifikat {
  journal_entry_id: string
  voucher: string
  entry_date: string | null
  status: string | null
  description: string | null
  source_type: string | null
  /** How the transaction points at this verifikat. */
  anchored_by: VoucherAnchor[]
  lines: Array<{ account_number: string; debit_amount: number; credit_amount: number; line_description: string | null }>
}

export interface TransactionDocument {
  document_id: string
  file_name: string
  mime_type: string | null
  doc_type: string | null
  page_count: number | null
  /** The verifikat the document is underlag for; null for a pin only. */
  journal_entry_id: string | null
  /** The transaction's own pin (transactions.document_id). */
  pinned_to_transaction: boolean
}

/**
 * The transaction's own fields: every column the v1 detail endpoint returns
 * (TRANSACTION_DETAIL_COLUMNS), with id read as transaction_id.
 */
export interface TransactionWithVouchers {
  transaction_id: string
  date: string | null
  /** The bank's value date (valutadag); null when the feed sends none. */
  value_date: string | null
  description: string | null
  /** The bank's verbatim text: description is the working title, which a person may have renamed. */
  original_description: string | null
  amount: number | null
  currency: string | null
  amount_sek: number | null
  reference: string | null
  merchant_name: string | null
  counterparty_account: string | null
  /** The counterparty's IBAN as the bank sent it (a foreign payment's payee, the payer of an incoming transfer). */
  counterparty_iban: string | null
  counterparty_org_number: string | null
  instructed_amount: number | null
  instructed_currency: string | null
  balance_after: number | null
  is_enriched: boolean | null
  is_business: boolean | null
  /** null when the column holds its default 'uncategorized': the verifikat below is the booking truth. */
  category: string | null
  is_ignored: boolean
  /** The row's id at its source: a Stripe balance transaction (stripe_<account>_<txn>, _fee for its fee row), a bank feed or a file import. */
  external_id: string | null
  /** The bank's own id for the row (Open Payments, Enable Banking); external_id of a feed row is content-derived. */
  provider_transaction_id: string | null
  /** The payer's end-to-end reference (ISO 20022), when the bank passes it on. */
  end_to_end_id: string | null
  import_source: string | null
  reconciliation_method: string | null
  cash_account_id: string | null
  invoice_id: string | null
  supplier_invoice_id: string | null
  potential_invoice_id: string | null
  /** The supplier invoice the matcher suggests this row pays (the transactions page shows it). */
  potential_supplier_invoice_id: string | null
  /** The posted verifikat the bank matcher suggests this row is (potential_match_method says how). */
  potential_journal_entry_id: string | null
  potential_match_confidence: number | null
  potential_match_method: string | null
  /** The Riksbank SEK rate of a foreign-currency row, and its date. */
  exchange_rate: number | null
  exchange_rate_date: string | null
  /** The payment rail: card, transfer, fee, ... (null when unclassified). */
  transaction_method: string | null
  /** When a person renamed the title (description); original_description keeps the bank's text. */
  title_edited_at: string | null
  journal_entry_id: string | null
  document_id: string | null
  receipt_id: string | null
  created_at: string | null
  updated_at: string | null
  /** True when a live verifikat books the transaction (public.bank_row_anchors). */
  booked: boolean
  verifikat: TransactionVerifikat[]
  documents: TransactionDocument[]
}

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))

function rowsOf<T>(result: { data: unknown; error: unknown }): T[] {
  if (result.error) throw dbError(result.error)
  return Array.isArray(result.data) ? (result.data as T[]) : []
}

export async function readTransactionWithVouchers(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
): Promise<TransactionWithVouchers | null> {
  // The v1 detail endpoint's column list, so the two doors cannot drift
  // apart again (crm#1347: this read never had external_id).
  const { data, error } = await supabase
    .from('transactions')
    .select(`${TRANSACTION_DETAIL_COLUMNS}, is_ignored, is_booked`)
    .eq('company_id', companyId)
    .eq('id', transactionId)
    .maybeSingle()
  if (error) throw dbError(error)
  if (!data) return null
  const tx = data as unknown as Record<string, unknown> & {
    id: string
    category: string | null
    is_ignored: boolean | null
    is_booked: boolean | null
    journal_entry_id: string | null
    document_id: string | null
  }

  const [links, invoicePayments, supplierPayments] = await Promise.all([
    supabase
      .from('transaction_voucher_links')
      .select('journal_entry_id, role')
      .eq('company_id', companyId)
      .eq('transaction_id', tx.id)
      .limit(LIMIT),
    supabase
      .from('invoice_payments')
      .select('journal_entry_id')
      .eq('company_id', companyId)
      .eq('transaction_id', tx.id)
      .limit(LIMIT),
    supabase
      .from('supplier_invoice_payments')
      .select('journal_entry_id')
      .eq('company_id', companyId)
      .eq('transaction_id', tx.id)
      .limit(LIMIT),
  ])

  const anchors = new Map<string, Set<VoucherAnchor>>()
  const anchor = (journalEntryId: string | null | undefined, by: VoucherAnchor) => {
    if (!journalEntryId) return
    const set = anchors.get(journalEntryId) ?? new Set<VoucherAnchor>()
    set.add(by)
    anchors.set(journalEntryId, set)
  }
  anchor(tx.journal_entry_id, 'pointer')
  for (const link of rowsOf<{ journal_entry_id: string; role: string | null }>(links)) {
    const role = (link.role ?? 'bank_line') as VoucherAnchor
    anchor(link.journal_entry_id, ['bank_line', 'clearing', 'other'].includes(role) ? role : 'bank_line')
  }
  for (const p of rowsOf<{ journal_entry_id: string | null }>(invoicePayments)) anchor(p.journal_entry_id, 'invoice_payment')
  for (const p of rowsOf<{ journal_entry_id: string | null }>(supplierPayments)) anchor(p.journal_entry_id, 'supplier_invoice_payment')

  const entryIds = [...anchors.keys()]
  const none = Promise.resolve({ data: [], error: null })
  const [entries, voucherDocs, pinnedDoc] = await Promise.all([
    entryIds.length > 0
      ? supabase
          .from('journal_entries')
          .select('id, voucher_series, voucher_number, entry_date, status, description, source_type, journal_entry_lines(account_number, debit_amount, credit_amount, line_description, sort_order)')
          .eq('company_id', companyId)
          .in('id', entryIds)
          .limit(LIMIT)
      : none,
    entryIds.length > 0
      ? supabase
          .from('document_attachments')
          .select('id, file_name, mime_type, doc_type, page_count, journal_entry_id')
          .eq('company_id', companyId)
          .eq('is_current_version', true)
          .in('journal_entry_id', entryIds)
          .limit(LIMIT)
      : none,
    tx.document_id
      ? supabase
          .from('document_attachments')
          .select('id, file_name, mime_type, doc_type, page_count, journal_entry_id')
          .eq('company_id', companyId)
          .eq('id', tx.document_id)
          .limit(1)
      : none,
  ])

  type EntryRow = {
    id: string
    voucher_series: string | null
    voucher_number: number | null
    entry_date: string | null
    status: string | null
    description: string | null
    source_type: string | null
    journal_entry_lines: Array<{ account_number: string; debit_amount: unknown; credit_amount: unknown; line_description: string | null; sort_order: number | null }> | null
  }
  const verifikat: TransactionVerifikat[] = rowsOf<EntryRow>(entries)
    .sort((a, b) => entryIds.indexOf(a.id) - entryIds.indexOf(b.id))
    .map((e) => ({
      journal_entry_id: e.id,
      voucher: formatVoucher(e),
      entry_date: e.entry_date,
      status: e.status,
      description: e.description,
      source_type: e.source_type,
      anchored_by: [...(anchors.get(e.id) ?? [])],
      lines: [...(e.journal_entry_lines ?? [])]
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((l) => ({
          account_number: String(l.account_number),
          debit_amount: Number(l.debit_amount ?? 0),
          credit_amount: Number(l.credit_amount ?? 0),
          line_description: l.line_description,
        })),
    }))

  type DocRow = { id: string; file_name: string; mime_type: string | null; doc_type: string | null; page_count: number | null; journal_entry_id: string | null }
  const documents = new Map<string, TransactionDocument>()
  for (const d of [...rowsOf<DocRow>(pinnedDoc), ...rowsOf<DocRow>(voucherDocs)]) {
    const seen = documents.get(d.id)
    if (seen) continue
    documents.set(d.id, {
      document_id: d.id,
      file_name: d.file_name,
      mime_type: d.mime_type,
      doc_type: d.doc_type,
      page_count: d.page_count,
      journal_entry_id: d.journal_entry_id,
      pinned_to_transaction: d.id === tx.document_id,
    })
  }

  // Every selected column passes through; only the id is renamed and the
  // numerics and the default category normalised.
  const { id, amount, amount_sek, instructed_amount, balance_after, exchange_rate, potential_match_confidence, category, is_ignored, is_booked, ...fields } = tx
  return {
    transaction_id: id,
    ...(fields as Omit<TransactionWithVouchers, 'transaction_id' | 'amount' | 'amount_sek' | 'instructed_amount' | 'balance_after' | 'exchange_rate' | 'potential_match_confidence' | 'category' | 'is_ignored' | 'booked' | 'verifikat' | 'documents'>),
    amount: num(amount),
    amount_sek: num(amount_sek),
    instructed_amount: num(instructed_amount),
    balance_after: num(balance_after),
    exchange_rate: num(exchange_rate),
    potential_match_confidence: num(potential_match_confidence),
    category: category === 'uncategorized' ? null : category,
    is_ignored: is_ignored === true,
    booked: is_booked === true,
    verifikat,
    documents: [...documents.values()],
  }
}
