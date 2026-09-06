/**
 * Per-category worklist queries: the single owner of every pending-work
 * predicate. Surfaces (dashboard, sidebar badges, /api/worklist, MCP tools)
 * must call these instead of inlining their own Supabase queries; see
 * lib/worklist/types.ts for each category's pending/done definition.
 *
 * Counts soft-fail to 0 with a logged error: a broken badge must never take
 * down the dashboard layout or the home page.
 */

import {
  OPEN_ROT_RUT_PAYOUT_STATUSES,
  expectedRotRutPayoutAmount,
  isMatchableRotRutPayoutRequest,
} from '@/lib/invoices/rot-rut-payout-matching'
import { loadOpenRotRutPayoutRequests } from '@/lib/invoices/rot-rut-payout-candidates'
import { matchTransactionsToRotRutPayoutSets } from '@/lib/invoices/rot-rut-payout-set-matching'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  groupExpenseClaimsByPerson,
  matchTransactionsToExpensePayouts,
} from '@/lib/expenses/expense-payout-candidates'
import {
  MATCHABLE_INVOICE_STATUSES,
  MATCHABLE_SUPPLIER_INVOICE_STATUSES,
} from '@/lib/invoices/matchable-statuses'
import type { ExpensePayoutDue, SuggestedMatch } from './types'

// Canonical home is lib/worklist/types.ts (dependency-free, client-safe);
// re-exported here so existing server-side imports keep working.
export { NEEDS_DOC_SOURCE_TYPES } from './types'

const log = createLogger('worklist')

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
 * Unbooked bank transactions: the canonical "att bokföra" predicate.
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
 * Unbooked skattekonto rows: every Skatteverket-side event the Transaktioner
 * inbox lists (status = 'booked', i.e. "tidigare") that has no verifikat and
 * was not ignored. `status` is Skatteverket's status, not booking status:
 * 'upcoming' rows are future charges with nothing to book. journal_entry_id
 * is the booked marker here (unlike bank transactions, which use is_business).
 */
export async function countUnbookedSkattekontoRows(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('skattekonto_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'booked')
    .is('journal_entry_id', null)
    .eq('is_ignored', false)
  if (error) return logAndZero('book_skattekonto', companyId, error)
  return count ?? 0
}

/**
 * Unconsumed inbox documents. Mirrors /api/documents/inbox-available:
 * items with a file that have not become a supplier invoice, a journal
 * entry, or a transaction match, and whose document is still unlinked
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

  // PostgREST serialises .in() into the GET query string: chunk the id list
  // so a large inbox can't push the URL past proxy limits (HTTP 414, which
  // would silently zero the badge via the error branch).
  // The chunks are independent: one wave instead of N sequential round trips.
  const chunks: string[][] = []
  for (let i = 0; i < docIds.length; i += IN_CLAUSE_CHUNK) chunks.push(docIds.slice(i, i + IN_CLAUSE_CHUNK))
  const results = await Promise.all(
    chunks.map((ids) =>
      supabase
        .from('document_attachments')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .in('id', ids)
        .is('journal_entry_id', null)
        .eq('is_current_version', true),
    ),
  )
  let total = 0
  for (const { count, error: docError } of results) {
    if (docError) return logAndZero('inbox_document', companyId, docError)
    total += count ?? 0
  }
  return total
}

/** Shared predicate for transactions carrying a match hint. */
const SUGGESTED_MATCH_OR =
  'potential_invoice_id.not.is.null,potential_supplier_invoice_id.not.is.null,potential_rot_rut_payout_request_id.not.is.null'

/**
 * Cap on the hint scan behind countSuggestedMatches; clamps like
 * INBOX_SCAN_CAP. Above IN_CLAUSE_CHUNK on purpose: the candidate lookups it
 * feeds are chunked (fetchCandidatesChunked), so the URL length stays bounded
 * regardless of this number.
 */
export const SUGGESTED_MATCH_SCAN_CAP = 200

/**
 * Unbooked transactions with a still-actionable invoice/supplier-invoice match
 * hint.
 *
 * Delegates to listSuggestedMatches so the badge can never claim a number the
 * list cannot render: a head count over the raw hint columns still counts a
 * pointer at an invoice settled elsewhere (issue #1259), which is exactly the
 * divergence lib/worklist exists to prevent (see types.ts).
 */
export async function countSuggestedMatches(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  const matches = await listSuggestedMatches(supabase, companyId, SUGGESTED_MATCH_SCAN_CAP)
  return matches.length
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
    // A credit note is a reversal, never a payable: there is nothing to
    // attest on it and the detail page offers no attest button, so counting
    // one here made an item nobody could clear. The CHECK
    // supplier_invoices_credit_note_not_payable keeps credit notes out of
    // 'registered' since 20260904190000; the predicate states the rule where
    // the count is defined.
    .eq('is_credit_note', false)
  if (error) return logAndZero('supplier_invoice_approval', companyId, error)
  return count ?? 0
}

/**
 * Posted verifikat without underlag: posted entries of document-requiring
 * source types that have neither a current-version document nor a
 * journal_entry_no_doc_required exemption.
 *
 * Delegates to the verifikat_without_documents RPC: the SAME predicate the
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
    // p_limit only sizes the page: total_count is computed over the FULL
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
 * Deadlines needing attention: same predicate as
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
    .is('dismissed_at', null)
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
  potential_rot_rut_payout_request_id?: string | null
}

type PayoutCandidateRow = {
  id: string
  name: string
  requested_total: number | string
  decided_total: number | string | null
}

type CandidateRow = {
  id: string
  invoice_number?: string | null
  supplier_invoice_number?: string | null
  total: number | null
  customer?: { name: string | null } | null
  supplier?: { name: string | null } | null
}

/**
 * Run one candidate lookup over a chunked id list. PostgREST serialises .in()
 * into the GET query string, so a long list can push the URL past proxy limits
 * (HTTP 414) exactly as countInboxDocuments guards against. The first error
 * short-circuits: a partial candidate set would silently drop rows from the
 * list and, through countSuggestedMatches, from the badge.
 */
async function fetchCandidatesChunked(
  ids: string[],
  runChunk: (
    chunk: string[],
  ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>,
): Promise<{ rows: CandidateRow[]; error: { message?: string } | null }> {
  const rows: CandidateRow[] = []
  for (let i = 0; i < ids.length; i += IN_CLAUSE_CHUNK) {
    const { data, error } = await runChunk(ids.slice(i, i + IN_CLAUSE_CHUNK))
    if (error) return { rows: [], error }
    rows.push(...((data ?? []) as unknown as CandidateRow[]))
  }
  return { rows, error: null }
}

/**
 * Suggested transaction↔invoice matches with enough candidate context for a
 * one-click confirm row. Confirm endpoints:
 *   kind 'invoice'           → POST /api/transactions/{id}/match-invoice
 *   kind 'supplier_invoice'  → POST /api/transactions/{id}/match-supplier-invoice
 *
 * The hint columns are write-once suggestions: nothing revisits them when the
 * invoice is later settled by a DIFFERENT transaction (or by mark-paid, MCP,
 * bank reconciliation or a SIE import). So the candidate lookup revalidates
 * against MATCHABLE_*_STATUSES instead of trusting the pointer: an invoice
 * that has since been paid would otherwise render a one-click confirm row
 * whose endpoint can only answer ALREADY_PAID.
 *
 * Revalidation stays here, at read time, even though the high-traffic settle
 * paths now also retire sibling pointers
 * (lib/invoices/clear-settled-invoice-suggestions.ts, issue #1259): the settle
 * paths are many and a missed one leaks, while this check covers every route
 * into the list.
 */
export async function listSuggestedMatches(
  supabase: SupabaseClient,
  companyId: string,
  limit = 20,
): Promise<SuggestedMatch[]> {
  const { data: txRows, error } = await supabase
    .from('transactions')
    .select(
      'id, date, description, amount, currency, potential_invoice_id, potential_supplier_invoice_id, potential_rot_rut_payout_request_id',
    )
    .eq('company_id', companyId)
    .is('is_business', null)
    .eq('is_ignored', false)
    .or(SUGGESTED_MATCH_OR)
    .order('date', { ascending: false })
    .limit(limit)
  if (error) {
    // companyId matches logAndZero's convention so repeated failures can be
    // correlated to a tenant in monitoring.
    log.error('worklist listSuggestedMatches failed', { companyId, reason: error.message })
    return []
  }

  const txs = (txRows ?? []) as SuggestedMatchTxRow[]
  const invoiceIds = [
    ...new Set(txs.map((t) => t.potential_invoice_id).filter((x): x is string => !!x)),
  ]
  const supplierInvoiceIds = [
    ...new Set(txs.map((t) => t.potential_supplier_invoice_id).filter((x): x is string => !!x)),
  ]

  const payoutRequestIds = [
    ...new Set(
      txs.map((t) => t.potential_rot_rut_payout_request_id).filter((x): x is string => !!x),
    ),
  ]

  const [invoiceRes, supplierRes, payoutRes] = await Promise.all([
    fetchCandidatesChunked(invoiceIds, (chunk) =>
      supabase
        .from('invoices')
        .select('id, invoice_number, total, customer:customers(name)')
        .eq('company_id', companyId)
        .in('id', chunk)
        .in('status', [...MATCHABLE_INVOICE_STATUSES])
        .gt('remaining_amount', 0),
    ),
    fetchCandidatesChunked(supplierInvoiceIds, (chunk) =>
      supabase
        .from('supplier_invoices')
        .select('id, supplier_invoice_number, total, supplier:suppliers(name)')
        .eq('company_id', companyId)
        .in('id', chunk)
        .in('status', [...MATCHABLE_SUPPLIER_INVOICE_STATUSES])
        .gt('remaining_amount', 0),
    ),
    // Open, unsettled begäran only: a settled request must not render a
    // one-click confirm that the route can only answer with INVALID_STATE.
    fetchCandidatesChunked(payoutRequestIds, (chunk) =>
      supabase
        .from('rot_rut_payout_requests')
        .select('id, name, requested_total, decided_total')
        .eq('company_id', companyId)
        .in('id', chunk)
        .in('status', [...OPEN_ROT_RUT_PAYOUT_STATUSES])
        .is('settlement_journal_entry_id', null),
    ),
  ])

  // A failed candidate lookup must not pass for "nothing is matchable": that
  // would render an empty list and, through countSuggestedMatches, a silent
  // zero badge. Log it (with companyId) and bail, same as the tx query above.
  const candidateError = invoiceRes.error ?? supplierRes.error ?? payoutRes.error
  if (candidateError) {
    log.error('worklist listSuggestedMatches candidate lookup failed', {
      companyId,
      reason: candidateError.message,
    })
    return []
  }

  const invoiceById = new Map<string, CandidateRow>(invoiceRes.rows.map((r) => [r.id, r]))
  const supplierById = new Map<string, CandidateRow>(supplierRes.rows.map((r) => [r.id, r]))

  const payoutById = new Map(
    (payoutRes.rows as unknown as PayoutCandidateRow[]).map((r) => [r.id, r] as const),
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
      continue
    }
    const payoutRequest = tx.potential_rot_rut_payout_request_id
      ? payoutById.get(tx.potential_rot_rut_payout_request_id)
      : undefined
    if (payoutRequest) {
      matches.push({
        ...base,
        kind: 'rot_rut_payout',
        candidate_id: payoutRequest.id,
        candidate_number: payoutRequest.name,
        counterparty_name: 'Skatteverket',
        candidate_total: Number(payoutRequest.decided_total ?? payoutRequest.requested_total),
      })
    }
    // Hint pointing at a deleted, foreign or already-settled candidate → drop
    // the row rather than render an unconfirmable suggestion.
  }
  // Transfers that repay one person's registered utlägg. No hint column: the
  // pairing is recomputed from the open claims (cheap, and empty for the
  // companies without any). Confirm endpoint:
  //   kind 'expense_payout'    → POST /api/transactions/{id}/match-expense-payout
  const expenseMatches = await listExpensePayoutSuggestions(supabase, companyId, limit)
  const seen = new Set(matches.map((m) => m.transaction_id))
  for (const m of expenseMatches) {
    if (!seen.has(m.transaction_id)) matches.push(m)
  }
  // Skatteverket's bundled ROT/RUT payout (several begäran in one transfer):
  // no hint column either, recomputed from the open begäran. Confirm endpoint
  // is the same match-rot-rut-payout route, with request_ids.
  const setMatches = await listRotRutPayoutSetSuggestions(supabase, companyId, limit)
  for (const m of setMatches) {
    if (!seen.has(m.transaction_id)) {
      matches.push(m)
      seen.add(m.transaction_id)
    }
  }
  return matches
}

/** Newest unbooked income rows scanned for a bundled ROT/RUT payout. */
const ROT_RUT_SET_SCAN_LIMIT = 200

/**
 * Unbooked SEK income rows that equal the SUM of several open begäran:
 * Skatteverket bundles the beslut it pays that day into one transfer
 * (#2239). Read-time pairing over the open pool, like the expense payouts:
 * no hint column, and nothing at all for a company without two open
 * begäran. The rule lives in lib/invoices/rot-rut-payout-set-matching.ts;
 * a single-begäran hit is the persisted 1:1 hint's job and is not repeated
 * here.
 */
export async function listRotRutPayoutSetSuggestions(
  supabase: SupabaseClient,
  companyId: string,
  limit = 20,
): Promise<SuggestedMatch[]> {
  const pool = (await loadOpenRotRutPayoutRequests(supabase, companyId)).filter((request) =>
    isMatchableRotRutPayoutRequest(request),
  )
  if (pool.length < 2) return []
  const expected = pool.map((request) => expectedRotRutPayoutAmount(request))
  const minExpected = Math.min(...expected)
  const maxTotal = roundOre(expected.reduce((sum, amount) => sum + amount, 0))

  // An invoice hint wins over a begäran (same precedence as the hint path),
  // so rows carrying one are not candidates. Rows with a 1:1 begäran hint
  // ARE fetched: the matcher skips them but takes their begäran out of the
  // pool, so a set never offers a request another row is about to settle.
  const { data, error } = await supabase
    .from('transactions')
    .select(
      'id, date, description, merchant_name, amount, currency, is_business, journal_entry_id, potential_rot_rut_payout_request_id',
    )
    .eq('company_id', companyId)
    .is('is_business', null)
    .eq('is_ignored', false)
    .is('journal_entry_id', null)
    .is('potential_invoice_id', null)
    .gte('amount', minExpected)
    .lte('amount', maxTotal)
    .order('date', { ascending: false })
    .limit(ROT_RUT_SET_SCAN_LIMIT)
  if (error) {
    log.error('worklist listRotRutPayoutSetSuggestions failed', { companyId, reason: error.message })
    return []
  }
  type TxRow = {
    id: string
    date: string
    description: string | null
    merchant_name: string | null
    amount: number
    currency: string | null
    is_business: boolean | null
    journal_entry_id: string | null
    potential_rot_rut_payout_request_id: string | null
  }
  const txs = (data ?? []) as TxRow[]
  const paired = matchTransactionsToRotRutPayoutSets(txs, pool)
  const out: SuggestedMatch[] = []
  for (const tx of txs) {
    const m = paired.get(tx.id)
    if (!m || m.requests.length < 2) continue
    out.push({
      transaction_id: tx.id,
      transaction_date: tx.date,
      transaction_description: tx.description ?? '',
      transaction_amount: tx.amount,
      transaction_currency: tx.currency ?? 'SEK',
      kind: 'rot_rut_payout',
      candidate_id: m.requests[0].id,
      candidate_number: m.requests.map((request) => request.name).join(' + '),
      counterparty_name: 'Skatteverket',
      candidate_total: m.total,
      request_ids: m.requests.map((request) => request.id),
    })
    if (out.length >= limit) break
  }
  return out
}

/**
 * Accounts not signed off through the end of the previous month. Cheap by
 * construction (three small reads, no bridge computation) and zero for
 * companies that never signed off anything, so the Hem row only appears
 * once the ritual is adopted. Mirrors lib/reconciliation/service.ts's account
 * set: enabled cash accounts deduplicated per IBAN + currency, plus the
 * skattekonto when it has rows.
 */
export async function countReconciliationDue(
  supabase: SupabaseClient,
  companyId: string,
  today: Date = new Date(),
): Promise<number> {
  // Last day of the previous month, as ISO date (UTC: the day boundary only
  // needs to be stable, not local).
  const prevMonthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0))
    .toISOString()
    .slice(0, 10)

  const { data: signoffRows, error: signoffError } = await supabase
    .from('account_reconciliations')
    .select('account_key, through_date, reopened_at')
    .eq('company_id', companyId)
    .order('through_date', { ascending: false })
    .limit(500)
  if (signoffError) return logAndZero('reconciliation_due', companyId, signoffError)
  const signoffs = (signoffRows ?? []) as Array<{ account_key: string; through_date: string; reopened_at: string | null }>
  // Adoption gate: no sign-off ever (active or reopened) means no nudge.
  if (signoffs.length === 0) return 0
  const coveredKeys = new Set(
    signoffs.filter((s) => s.reopened_at === null && s.through_date >= prevMonthEnd).map((s) => s.account_key),
  )

  const { data: cashRows, error: cashError } = await supabase
    .from('cash_accounts')
    .select('id, iban, currency, updated_at')
    .eq('company_id', companyId)
    .eq('enabled', true)
  if (cashError) return logAndZero('reconciliation_due', companyId, cashError)
  const cash = (cashRows ?? []) as Array<{ id: string; iban: string | null; currency: string | null; updated_at: string | null }>
  // Reconnect duplicates (same IBAN + currency) count once: the newest row.
  const byIban = new Map<string, typeof cash[number]>()
  const keys: string[] = []
  for (const a of cash) {
    if (!a.iban) {
      keys.push(`bank:${a.id}`)
      continue
    }
    const k = `${a.iban}|${a.currency ?? 'SEK'}`
    const prev = byIban.get(k)
    if (!prev || (a.updated_at ?? '') > (prev.updated_at ?? '')) byIban.set(k, a)
  }
  for (const a of byIban.values()) keys.push(`bank:${a.id}`)

  const { count: skvCount, error: skvError } = await supabase
    .from('skattekonto_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
  if (skvError) return logAndZero('reconciliation_due', companyId, skvError)
  if ((skvCount ?? 0) > 0) keys.push('skattekonto')

  return keys.filter((k) => !coveredKeys.has(k)).length
}

/**
 * People owed for registered, unpaid utlägg, newest debt last. The canonical
 * "att betala ut" predicate: expense_claims.status = 'registered'. Grouped
 * here (not in SQL) because the owner has no employee row: two owner claims
 * with the same claimant_name are one person, one transfer.
 */
export async function listExpensePayoutsDue(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ExpensePayoutDue[]> {
  type ClaimRow = {
    id: string
    employee_id: string | null
    claimant_name: string
    liability_account: string
    amount_sek: number | string
    expense_date: string
  }
  let rows: ClaimRow[]
  try {
    // Every registered claim, paginated past the PostgREST row cap: a person
    // omitted or a total understated here is money the company owes someone.
    rows = await fetchAllRows<ClaimRow>(({ from, to }) =>
      supabase
        .from('expense_claims')
        .select('id, employee_id, claimant_name, liability_account, amount_sek, expense_date')
        .eq('company_id', companyId)
        .eq('status', 'registered')
        .order('expense_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    )
  } catch (err) {
    logAndZero('expense_payout', companyId, err as { message?: string })
    return []
  }
  return groupExpenseClaimsByPerson(rows)
}

/** Number of people owed for unpaid utlägg (see listExpensePayoutsDue). */
export async function countExpensePayoutsDue(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  return (await listExpensePayoutsDue(supabase, companyId)).length
}

/**
 * Unbooked SEK outflows whose amount equals one person's outstanding utlägg
 * to the öre. Read-time pairing over the open claims: the candidate pool is
 * empty for most companies, so this costs one head-count-sized query and
 * nothing else there. See lib/expenses/expense-payout-candidates.ts for the
 * matching rule.
 */
export async function listExpensePayoutSuggestions(
  supabase: SupabaseClient,
  companyId: string,
  limit = 20,
): Promise<SuggestedMatch[]> {
  const people = await listExpensePayoutsDue(supabase, companyId)
  if (people.length === 0) return []
  const amounts = [...new Set(people.map((p) => -p.total_sek))]
  const { data, error } = await supabase
    .from('transactions')
    .select('id, date, description, amount, currency, is_business, journal_entry_id')
    .eq('company_id', companyId)
    .is('is_business', null)
    .eq('is_ignored', false)
    .in('amount', amounts)
    .order('date', { ascending: false })
    .limit(limit)
  if (error) {
    log.error('worklist listExpensePayoutSuggestions failed', { companyId, reason: error.message })
    return []
  }
  type TxRow = {
    id: string
    date: string
    description: string | null
    amount: number
    currency: string | null
    is_business: boolean | null
    journal_entry_id: string | null
  }
  const txs = (data ?? []) as TxRow[]
  const paired = matchTransactionsToExpensePayouts(txs, people)
  const out: SuggestedMatch[] = []
  for (const tx of txs) {
    const m = paired.get(tx.id)
    if (!m) continue
    out.push({
      transaction_id: tx.id,
      transaction_date: tx.date,
      transaction_description: tx.description ?? '',
      transaction_amount: tx.amount,
      transaction_currency: tx.currency ?? 'SEK',
      kind: 'expense_payout',
      candidate_id: m.person.key,
      candidate_number: null,
      counterparty_name: m.person.claimant_name,
      candidate_total: m.person.total_sek,
      claim_ids: m.person.claim_ids,
    })
  }
  return out
}
