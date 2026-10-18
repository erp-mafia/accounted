import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'

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

export interface TransactionWithVouchers {
  transaction_id: string
  date: string | null
  description: string | null
  amount: number | null
  currency: string | null
  amount_sek: number | null
  reference: string | null
  merchant_name: string | null
  counterparty_account: string | null
  counterparty_org_number: string | null
  is_business: boolean | null
  /** null when the column holds its default 'uncategorized': the verifikat below is the booking truth. */
  category: string | null
  is_ignored: boolean
  import_source: string | null
  cash_account_id: string | null
  invoice_id: string | null
  supplier_invoice_id: string | null
  journal_entry_id: string | null
  document_id: string | null
  /** True when a posted verifikat books the transaction: its pointer, a bank_line link or a payment. */
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
  const { data, error } = await supabase
    .from('transactions')
    .select('id, date, description, amount, currency, amount_sek, reference, merchant_name, counterparty_account, counterparty_org_number, is_business, category, is_ignored, import_source, cash_account_id, invoice_id, supplier_invoice_id, journal_entry_id, document_id')
    .eq('company_id', companyId)
    .eq('id', transactionId)
    .maybeSingle()
  if (error) throw dbError(error)
  if (!data) return null
  const tx = data as {
    id: string
    date: string | null
    description: string | null
    amount: unknown
    currency: string | null
    amount_sek: unknown
    reference: string | null
    merchant_name: string | null
    counterparty_account: string | null
    counterparty_org_number: string | null
    is_business: boolean | null
    category: string | null
    is_ignored: boolean | null
    import_source: string | null
    cash_account_id: string | null
    invoice_id: string | null
    supplier_invoice_id: string | null
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
      voucher: `${e.voucher_series ?? ''}${e.voucher_number ?? ''}`,
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

  return {
    transaction_id: tx.id,
    date: tx.date,
    description: tx.description,
    amount: num(tx.amount),
    currency: tx.currency,
    amount_sek: num(tx.amount_sek),
    reference: tx.reference,
    merchant_name: tx.merchant_name,
    counterparty_account: tx.counterparty_account,
    counterparty_org_number: tx.counterparty_org_number,
    is_business: tx.is_business,
    category: tx.category === 'uncategorized' ? null : tx.category,
    is_ignored: tx.is_ignored === true,
    import_source: tx.import_source,
    cash_account_id: tx.cash_account_id,
    invoice_id: tx.invoice_id,
    supplier_invoice_id: tx.supplier_invoice_id,
    journal_entry_id: tx.journal_entry_id,
    document_id: tx.document_id,
    // A residual or clearing link supplements a booking, it is not one (hasBankLineJunctionRow).
    booked: verifikat.some((v) => v.status === 'posted' && v.anchored_by.some((a) => a !== 'clearing' && a !== 'other')),
    verifikat,
    documents: [...documents.values()],
  }
}
