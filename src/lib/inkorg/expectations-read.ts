/**
 * The reads behind the Inkorg's expectations (expectations.ts holds the
 * logic): the company's bank outflows and registered supplier invoices over
 * the lookback, then the few documents behind the regular counterparties'
 * latest occurrences, for where they came from.
 *
 * Read only. Every query filters by company_id beside RLS, and every read
 * pages through fetchAllRows: PostgREST answers 1000 rows and no more.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { addMonthsIso } from '@/lib/dates/iso'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { readCompanyPortals } from '@/lib/receipt-hunt/company-portals-read'
import {
  HISTORY_MONTHS,
  documentEvidence,
  evidenceDocumentIds,
  expectationsFrom,
  findPatterns,
  type EvidenceDocument,
  type EvidenceInboxItem,
  type ExpectationHistory,
  type HistoryPayment,
  type HistorySupplier,
  type HistorySupplierInvoice,
  type HistoryTransaction,
  type PatternExpectation,
} from './expectations'

/** Ids per `.in()` filter, so the request line stays well inside URL limits. */
const ID_CHUNK = 100

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += ID_CHUNK) out.push(items.slice(i, i + ID_CHUNK))
  return out
}

/**
 * The history the cadence is read from: money out on the company's accounts
 * (not ignored, not called private) and its supplier invoices (no credit
 * notes, nothing reversed), with the suppliers' names and the payments that
 * tie an invoice to its bank row.
 */
export async function readExpectationHistory(
  supabase: SupabaseClient,
  companyId: string,
  today: string,
): Promise<ExpectationHistory> {
  const since = addMonthsIso(today, -HISTORY_MONTHS)

  const [transactions, supplierInvoices, payments] = await Promise.all([
    fetchAllRows<HistoryTransaction>(({ from, to }) =>
      supabase
        .from('transactions')
        .select('id, date, amount, currency, amount_sek, exchange_rate, merchant_name, description, document_id')
        .eq('company_id', companyId)
        .eq('is_ignored', false)
        // is_business IS DISTINCT FROM false: only an explicit false is private.
        .not('is_business', 'is', false)
        .lt('amount', 0)
        .gte('date', since)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<HistorySupplierInvoice>(({ from, to }) =>
      supabase
        .from('supplier_invoices')
        .select('id, supplier_id, invoice_date, total, total_sek, currency, exchange_rate, document_id')
        .eq('company_id', companyId)
        .eq('is_credit_note', false)
        .neq('status', 'reversed')
        .gte('invoice_date', since)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<HistoryPayment>(({ from, to }) =>
      supabase
        .from('supplier_invoice_payments')
        .select('supplier_invoice_id, transaction_id')
        .eq('company_id', companyId)
        .not('transaction_id', 'is', null)
        .gte('payment_date', since)
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ])

  const supplierIds = [...new Set(supplierInvoices.map((i) => i.supplier_id))]
  const suppliers: HistorySupplier[] = []
  for (const ids of chunks(supplierIds)) {
    suppliers.push(
      ...(await fetchAllRows<HistorySupplier>(({ from, to }) =>
        supabase
          .from('suppliers')
          .select('id, name')
          .eq('company_id', companyId)
          .in('id', ids)
          .order('id', { ascending: true })
          .range(from, to),
      )),
    )
  }

  return { transactions, supplierInvoices, suppliers, payments }
}

/** The documents by id, and the inbox items they arrived as. */
export async function readDocumentEvidence(
  supabase: SupabaseClient,
  companyId: string,
  documentIds: readonly string[],
): Promise<{ documents: EvidenceDocument[]; items: EvidenceInboxItem[] }> {
  const documents: EvidenceDocument[] = []
  const items: EvidenceInboxItem[] = []
  for (const ids of chunks(documentIds)) {
    const [docs, arrivals] = await Promise.all([
      fetchAllRows<EvidenceDocument>(({ from, to }) =>
        supabase
          .from('document_attachments')
          .select('id, upload_source, file_name, created_at')
          .eq('company_id', companyId)
          .in('id', ids)
          .order('id', { ascending: true })
          .range(from, to),
      ),
      fetchAllRows<EvidenceInboxItem>(({ from, to }) =>
        supabase
          .from('invoice_inbox_items')
          .select('document_id, source, channel_context, created_at')
          .eq('company_id', companyId)
          .in('document_id', ids)
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ])
    documents.push(...docs)
    items.push(...arrivals)
  }
  return { documents, items }
}

/**
 * Every regular counterparty with how its documents usually arrive. The
 * documents are read only for the patterns found, and only for their latest
 * occurrences, so the second read stays small whatever the history holds.
 * The company's own portals are read once, beside the history, and decide
 * with the directory which counterparties have a portal.
 */
export async function loadExpectations(
  supabase: SupabaseClient,
  companyId: string,
  today: string,
): Promise<PatternExpectation[]> {
  const [history, companyPortals] = await Promise.all([
    readExpectationHistory(supabase, companyId, today),
    readCompanyPortals(supabase, companyId),
  ])
  const patterns = findPatterns(history, today, companyPortals)
  if (patterns.length === 0) return []
  const ids = evidenceDocumentIds(patterns)
  const { documents, items } = ids.length > 0 ? await readDocumentEvidence(supabase, companyId, ids) : { documents: [], items: [] }
  return expectationsFrom(patterns, documentEvidence(documents, items), companyPortals)
}
