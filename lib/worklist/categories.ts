/**
 * Per-category worklist queries — the single owner of every pending-work
 * predicate. Surfaces (dashboard, sidebar badges, /api/worklist, MCP tools)
 * must call these instead of inlining their own Supabase queries; see
 * lib/worklist/types.ts for each category's pending/done definition.
 *
 * Counts soft-fail to 0 with a logged error: a broken badge must never take
 * down the dashboard layout or the home page.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import type { SuggestedMatch } from './types'

const log = createLogger('worklist')

/**
 * Journal-entry source types that require underlag (BFL 5 kap 7§). Source
 * types representing system-generated entries (VAT settlement, year-end,
 * currency revaluation, …) are exempt by omission.
 */
export const NEEDS_DOC_SOURCE_TYPES = [
  'manual',
  'bank_transaction',
  'supplier_invoice_registered',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
  'import',
] as const

/**
 * Upper bound on the unconsumed-inbox scan in countInboxDocuments. An inbox
 * with more than this many unhandled items is pathological; the count clamps
 * there rather than scanning unbounded rows on every badge render.
 */
const INBOX_SCAN_CAP = 1000

/**
 * Max ids per PostgREST .in() filter. Ids travel in the GET query string;
 * 150 UUIDs ≈ 5.6 KB, comfortably under common 8 KB proxy URL limits.
 */
const IN_CLAUSE_CHUNK = 150

function logAndZero(
  category: string,
  companyId: string,
  error: { message?: string } | null,
): number {
  // companyId is a structured field so repeated failures can be correlated
  // to a tenant in monitoring.
  log.error(`worklist count failed: ${category}`, { companyId, reason: error?.message })
  return 0
}

/**
 * Unbooked bank transactions — the canonical "att bokföra" predicate.
 * All booking flows (incl. the bulk-book RPCs) set is_business = true, so
 * is_business IS NULL is sufficient; is_ignored excludes the user's
 * explicitly-suppressed rows. Served by the partial index
 * idx_transactions_company_unbooked.
 */
export async function countUnbookedTransactions(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .is('is_business', null)
    .eq('is_ignored', false)
  if (error) return logAndZero('book_transaction', companyId, error)
  return count ?? 0
}

/**
 * Unconsumed inbox documents. Mirrors /api/documents/inbox-available:
 * items with a file that have not become a supplier invoice, a journal
 * entry, or a transaction match — and whose document is still unlinked
 * (the stale-column backstop).
 */
export async function countInboxDocuments(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  const { data: rows, error } = await supabase
    .from('invoice_inbox_items')
    .select('id, document_id')
    .eq('company_id', companyId)
    .not('document_id', 'is', null)
    .is('created_supplier_invoice_id', null)
    .is('created_journal_entry_id', null)
    .is('matched_transaction_id', null)
    .limit(INBOX_SCAN_CAP)
  if (error) return logAndZero('inbox_document', companyId, error)

  const docIds = [
    ...new Set(
      (rows ?? [])
        .map((r) => r.document_id as string | null)
        .filter((id): id is string => !!id),
    ),
  ]
  if (docIds.length === 0) return 0

  // PostgREST serialises .in() into the GET query string — chunk the id list
  // so a large inbox can't push the URL past proxy limits (HTTP 414, which
  // would silently zero the badge via the error branch).
  let total = 0
  for (let i = 0; i < docIds.length; i += IN_CLAUSE_CHUNK) {
    const { count, error: docError } = await supabase
      .from('document_attachments')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('id', docIds.slice(i, i + IN_CLAUSE_CHUNK))
      .is('journal_entry_id', null)
      .eq('is_current_version', true)
    if (docError) return logAndZero('inbox_document', companyId, docError)
    total += count ?? 0
  }
  return total
}

/** Shared predicate for transactions carrying a match hint. */
const SUGGESTED_MATCH_OR =
  'potential_invoice_id.not.is.null,potential_supplier_invoice_id.not.is.null'

/** Unbooked transactions with an invoice/supplier-invoice match hint. */
export async function countSuggestedMatches(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .is('is_business', null)
    .eq('is_ignored', false)
    .or(SUGGESTED_MATCH_OR)
  if (error) return logAndZero('suggested_match', companyId, error)
  return count ?? 0
}

/** Supplier invoices awaiting approval ("attestera"). */
export async function countSupplierInvoicesAwaitingApproval(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('supplier_invoices')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'registered')
  if (error) return logAndZero('supplier_invoice_approval', companyId, error)
  return count ?? 0
}

/**
 * Posted verifikat without underlag: posted entries of document-requiring
 * source types that have neither a current-version document nor a
 * journal_entry_no_doc_required exemption.
 *
 * Delegates to the verifikat_without_documents RPC — the SAME predicate the
 * MCP surfaces use (single truth in SQL; the RPC's needs-doc source-type
 * list mirrors NEEDS_DOC_SOURCE_TYPES, pinned by
 * tests/pg/document-surfaces-unification.pg.test.ts). Previously this
 * fetched three full id-column tables and set-differenced client-side.
 */
export async function countVerifikatMissingDocument(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  try {
    // p_limit only sizes the page — total_count is computed over the FULL
    // filtered set inside the RPC (independent CTE), so 1 is the cheapest
    // valid page size for a count-only call.
    const { data, error } = await supabase.rpc('verifikat_without_documents', {
      p_company_id: companyId,
      p_limit: 1,
      p_offset: 0,
    })
    if (error) return logAndZero('verifikat_missing_document', companyId, error)
    const result = data as { ok?: boolean; code?: string; total_count?: number } | null
    if (!result?.ok) {
      return logAndZero('verifikat_missing_document', companyId, {
        message: result?.code ?? 'rpc returned not-ok',
      })
    }
    return result.total_count ?? 0
  } catch (err) {
    return logAndZero(
      'verifikat_missing_document',
      companyId,
      err instanceof Error ? { message: err.message } : null,
    )
  }
}

/** Overdue customer invoices (not credited). */
export async function countOverdueInvoices(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'overdue')
    .is('credited_invoice_id', null)
  if (error) return logAndZero('overdue_invoice', companyId, error)
  return count ?? 0
}

/**
 * Deadlines needing attention — same predicate as
 * lib/deadlines/status-engine.ts getDeadlinesNeedingAttention(), as a
 * head-count so badges don't fetch rows.
 */
export async function countDeadlinesNeedingAction(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('deadlines')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('is_completed', false)
    .in('status', ['action_needed', 'overdue'])
  if (error) return logAndZero('deadline_action', companyId, error)
  return count ?? 0
}

/** Agent-staged operations awaiting review. */
export async function countPendingOperations(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('pending_operations')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'pending')
  if (error) return logAndZero('pending_operations', companyId, error)
  return count ?? 0
}

interface SuggestedMatchTxRow {
  id: string
  date: string
  description: string | null
  amount: number
  currency: string | null
  potential_invoice_id: string | null
  potential_supplier_invoice_id: string | null
}

/**
 * Suggested transaction↔invoice matches with enough candidate context for a
 * one-click confirm row. Confirm endpoints:
 *   kind 'invoice'           → POST /api/transactions/{id}/match-invoice
 *   kind 'supplier_invoice'  → POST /api/transactions/{id}/match-supplier-invoice
 */
export async function listSuggestedMatches(
  supabase: SupabaseClient,
  companyId: string,
  limit = 20,
): Promise<SuggestedMatch[]> {
  const { data: txRows, error } = await supabase
    .from('transactions')
    .select(
      'id, date, description, amount, currency, potential_invoice_id, potential_supplier_invoice_id',
    )
    .eq('company_id', companyId)
    .is('is_business', null)
    .eq('is_ignored', false)
    .or(SUGGESTED_MATCH_OR)
    .order('date', { ascending: false })
    .limit(limit)
  if (error) {
    log.error('worklist listSuggestedMatches failed', { reason: error.message })
    return []
  }

  const txs = (txRows ?? []) as SuggestedMatchTxRow[]
  const invoiceIds = txs.map((t) => t.potential_invoice_id).filter((x): x is string => !!x)
  const supplierInvoiceIds = txs
    .map((t) => t.potential_supplier_invoice_id)
    .filter((x): x is string => !!x)

  const [invoiceRes, supplierRes] = await Promise.all([
    invoiceIds.length > 0
      ? supabase
          .from('invoices')
          .select('id, invoice_number, total, customer:customers(name)')
          .eq('company_id', companyId)
          .in('id', invoiceIds)
      : Promise.resolve({ data: [], error: null }),
    supplierInvoiceIds.length > 0
      ? supabase
          .from('supplier_invoices')
          .select('id, supplier_invoice_number, total, supplier:suppliers(name)')
          .eq('company_id', companyId)
          .in('id', supplierInvoiceIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  type CandidateRow = {
    id: string
    invoice_number?: string | null
    supplier_invoice_number?: string | null
    total: number | null
    customer?: { name: string | null } | null
    supplier?: { name: string | null } | null
  }
  const invoiceById = new Map<string, CandidateRow>(
    ((invoiceRes.data ?? []) as unknown as CandidateRow[]).map((r) => [r.id, r]),
  )
  const supplierById = new Map<string, CandidateRow>(
    ((supplierRes.data ?? []) as unknown as CandidateRow[]).map((r) => [r.id, r]),
  )

  const matches: SuggestedMatch[] = []
  for (const tx of txs) {
    const base = {
      transaction_id: tx.id,
      transaction_date: tx.date,
      transaction_description: tx.description ?? '',
      transaction_amount: tx.amount,
      transaction_currency: tx.currency ?? 'SEK',
    }
    // Mirror the transactions page: an invoice hint wins over a supplier hint
    // when both are present (income matches are rarer and higher-signal).
    const invoice = tx.potential_invoice_id
      ? invoiceById.get(tx.potential_invoice_id)
      : undefined
    if (invoice) {
      matches.push({
        ...base,
        kind: 'invoice',
        candidate_id: invoice.id,
        candidate_number: invoice.invoice_number ?? null,
        counterparty_name: invoice.customer?.name ?? null,
        candidate_total: invoice.total ?? null,
      })
      continue
    }
    const supplierInvoice = tx.potential_supplier_invoice_id
      ? supplierById.get(tx.potential_supplier_invoice_id)
      : undefined
    if (supplierInvoice) {
      matches.push({
        ...base,
        kind: 'supplier_invoice',
        candidate_id: supplierInvoice.id,
        candidate_number: supplierInvoice.supplier_invoice_number ?? null,
        counterparty_name: supplierInvoice.supplier?.name ?? null,
        candidate_total: supplierInvoice.total ?? null,
      })
    }
    // Hint pointing at a deleted/foreign candidate → drop the row rather
    // than render an unconfirmable suggestion.
  }
  return matches
}
