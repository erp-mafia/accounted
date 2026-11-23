/**
 * The match suggestions an open bank row carries, as Bankrader shows them:
 * the invoice, supplier invoice, verifikat or ROT/RUT begäran the matcher
 * pointed the row at (revalidated here, since a pointer is never revisited
 * once written), and the person whose utlägg an outflow repays. Read by
 * Bankrader and by Att bokföra, so both lists name the same suggestion.
 */
import type { SupabaseDataClient } from '@/lib/supabase/data-client'
import { loadOpenRotRutPayoutRequests } from '@/lib/invoices/open-rot-rut-payout-requests'
import { matchTransactionsToRotRutPayoutSets } from '@/lib/invoices/rot-rut-payout-set-matching'
import {
  groupExpenseClaimsByPerson,
  matchTransactionsToExpensePayouts,
} from '@/lib/expenses/expense-payout-candidates'
import { listExpenseClaimsAwaitingPayout } from '@/lib/salary/expense-claim-payout-state'
import {
  MATCHABLE_INVOICE_STATUSES,
  MATCHABLE_SUPPLIER_INVOICE_STATUSES,
} from '@/lib/bookkeeping/matchable-statuses'
import type { ExpensePayoutDue } from '@/lib/worklist/types'
import type { Invoice, Customer, SupplierInvoice, Supplier } from '@/types'
import type {
  PotentialVoucher,
  PotentialRotRutPayout,
  PotentialRotRutPayoutRequest,
  TransactionWithInvoice,
} from './transaction-types'

export type InvoiceWithCustomer = Invoice & { customer?: Customer }
export type SupplierInvoiceWithSupplier = SupplierInvoice & { supplier?: Supplier }

/**
 * The dialog a row's suggested match is confirmed in: the invoice match
 * (customer or supplier), the ROT/RUT payout's own, the utlägg repayment's
 * own, or none when the row carries no suggestion. An invoice wins when
 * several are present, as on the row's button.
 */
export function suggestedMatchDialog(
  tx: Pick<
    TransactionWithInvoice,
    'potential_invoice' | 'potential_supplier_invoice' | 'potential_rot_rut_payout' | 'potential_expense_payout'
  >,
): 'invoice' | 'rot_rut' | 'expense_payout' | null {
  if (tx.potential_invoice || tx.potential_supplier_invoice) return 'invoice'
  if (tx.potential_rot_rut_payout) return 'rot_rut'
  if (tx.potential_expense_payout) return 'expense_payout'
  return null
}

export function buildInvoiceMap(rows: InvoiceWithCustomer[] | null): Record<string, InvoiceWithCustomer> {
  if (!rows) return {}
  return rows.reduce<Record<string, InvoiceWithCustomer>>((acc, inv) => {
    acc[inv.id] = inv
    return acc
  }, {})
}

export function buildSupplierInvoiceMap(
  rows: SupplierInvoiceWithSupplier[] | null,
): Record<string, SupplierInvoiceWithSupplier> {
  if (!rows) return {}
  return rows.reduce<Record<string, SupplierInvoiceWithSupplier>>((acc, inv) => {
    acc[inv.id] = inv
    return acc
  }, {})
}

// Pair unbooked outflows with the person whose utlägg they repay in full
// (lib/expenses/expense-payout-candidates). Read-time: the claims that wait
// for a payout are the candidate pool (a claim on a salary run is not one),
// so this is one small query and nothing for the companies without any.
// Non-fatal like fetchPotentialMatches.
export async function fetchExpensePayoutMatches(
  supabase: SupabaseDataClient,
  companyId: string | null,
  rows: { id: string; amount: number; currency: string | null; is_business: boolean | null; journal_entry_id: string | null }[],
): Promise<{ byTransaction: Map<string, ExpensePayoutDue>; people: ExpensePayoutDue[] }> {
  const out = new Map<string, ExpensePayoutDue>()
  if (!companyId || rows.length === 0) return { byTransaction: out, people: [] }
  let claimRows: Parameters<typeof groupExpenseClaimsByPerson>[0]
  try {
    claimRows = await listExpenseClaimsAwaitingPayout(supabase, companyId)
  } catch (error) {
    console.error('[fetchExpensePayoutMatches] expense_claims query failed', error)
    return { byTransaction: out, people: [] }
  }
  const people = groupExpenseClaimsByPerson(claimRows)
  for (const [txId, m] of matchTransactionsToExpensePayouts(rows, people)) out.set(txId, m.person)
  return { byTransaction: out, people }
}

// Fetch the potential invoice/supplier-invoice matches referenced by a page
// of transactions in one parallel round trip. A single-query PostgREST embed
// on potential_supplier_invoice_id is blocked until that FK exists in the
// prod schema cache (see DECISIONS.md archive 2026-07-06).
export async function fetchPotentialMatches(
  supabase: SupabaseDataClient,
  companyId: string | null,
  rows: {
    id: string
    amount: number
    currency: string | null
    description?: string | null
    merchant_name?: string | null
    is_business: boolean | null
    journal_entry_id: string | null
    potential_invoice_id: string | null
    potential_supplier_invoice_id: string | null
    potential_rot_rut_payout_request_id?: string | null
    potential_journal_entry_id?: string | null
  }[],
) {
  const potentialInvoiceIds = Array.from(
    new Set(rows.flatMap((t) => (t.potential_invoice_id ? [t.potential_invoice_id] : []))),
  )
  const potentialSupplierInvoiceIds = Array.from(
    new Set(rows.flatMap((t) => (t.potential_supplier_invoice_id ? [t.potential_supplier_invoice_id] : []))),
  )
  const potentialJournalEntryIds = Array.from(
    new Set(rows.flatMap((t) => (t.potential_journal_entry_id ? [t.potential_journal_entry_id] : []))),
  )

  // Chunked .in() lists (PostgREST .in() URL-length convention, same 150 as
  // the underlag-status effect below): the caller may pass the full pending
  // backlog, not just one page.
  const IN_CLAUSE_CHUNK = 150
  const chunks = <T,>(ids: T[]) => {
    const out: T[][] = []
    for (let i = 0; i < ids.length; i += IN_CLAUSE_CHUNK) out.push(ids.slice(i, i + IN_CLAUSE_CHUNK))
    return out
  }

  // The hint columns are never revisited once written, so an invoice settled
  // by a different transaction leaves a stale pointer behind. Revalidate here:
  // an unmatchable candidate must not reach the row or the match dialog, which
  // would otherwise compare the transaction against a 0 kr remaining balance
  // and call it a partial payment.
  const [invoiceResults, supplierInvoiceResults, voucherResults, rotRutResult] = await Promise.all([
    Promise.all(
      chunks(potentialInvoiceIds).map((ids) =>
        supabase
          .from('invoices')
          .select('*, customer:customers(*)')
          .in('id', ids)
          .in('status', [...MATCHABLE_INVOICE_STATUSES])
          .gt('remaining_amount', 0),
      ),
    ),
    Promise.all(
      chunks(potentialSupplierInvoiceIds).map((ids) =>
        supabase
          .from('supplier_invoices')
          .select('*, supplier:suppliers(*)')
          .in('id', ids)
          .in('status', [...MATCHABLE_SUPPLIER_INVOICE_STATUSES])
          .gt('remaining_amount', 0),
      ),
    ),
    // Journal-entry match suggestions (the sweep's 0.75-0.89 band). DB
    // triggers clear the pointer when the entry is consumed or reversed, but
    // the posted-status filter revalidates anyway: a suggestion that no
    // longer resolves to a live verifikat must not reach the review surface.
    Promise.all(
      chunks(potentialJournalEntryIds).map((ids) =>
        supabase
          .from('journal_entries')
          .select('id, voucher_series, voucher_number, entry_date, description')
          .in('id', ids)
          .eq('status', 'posted'),
      ),
    ),
    // Open ROT/RUT begäran (Skatteverkets utbetalning): the company's whole
    // open pool, not the hinted ids. It serves both the persisted 1:1 hint
    // (revalidated: a request settled by another row must not reach the
    // dialog) and the read-time covering set for a row Skatteverket paid
    // together with other beslut (#2239). Items ride along so the dialog can
    // list the covered invoices. A handful of rows per company.
    companyId
      ? loadOpenRotRutPayoutRequests(supabase, companyId)
      : Promise.resolve({ requests: [], error: null }),
  ])

  // Non-fatal: the transaction list still renders without match hints, but
  // log so a DB failure isn't mistaken for "no potential match".
  for (const r of invoiceResults) {
    if (r.error) console.error('[fetchPotentialMatches] invoices query failed', r.error)
  }
  for (const r of supplierInvoiceResults) {
    if (r.error) console.error('[fetchPotentialMatches] supplier_invoices query failed', r.error)
  }
  for (const r of voucherResults) {
    if (r.error) console.error('[fetchPotentialMatches] journal_entries query failed', r.error)
  }
  if (rotRutResult.error) {
    console.error('[fetchPotentialMatches] rot_rut_payout_requests query failed', rotRutResult.error)
  }

  const rotRutRequests: PotentialRotRutPayoutRequest[] = rotRutResult.requests
  const rotRutById = new Map(rotRutRequests.map((req) => [req.id, req] as const))
  // Per row: the persisted 1:1 hint when its begäran is still open, else the
  // exact covering set over the open pool (several begäran in one transfer).
  const rotRutByTransaction = new Map<string, PotentialRotRutPayout>()
  for (const row of rows) {
    const hinted = row.potential_rot_rut_payout_request_id
      ? rotRutById.get(row.potential_rot_rut_payout_request_id)
      : undefined
    if (hinted) rotRutByTransaction.set(row.id, { requests: [hinted] })
  }
  for (const [txId, match] of matchTransactionsToRotRutPayoutSets(rows, rotRutRequests)) {
    rotRutByTransaction.set(txId, { requests: match.requests })
  }

  const voucherMap: Record<string, PotentialVoucher> = {}
  for (const je of voucherResults.flatMap((r) => (r.data ?? []) as Array<{
    id: string
    voucher_series: string
    voucher_number: number
    entry_date: string
    description: string | null
  }>)) {
    voucherMap[je.id] = {
      journal_entry_id: je.id,
      voucher_series: je.voucher_series,
      voucher_number: je.voucher_number,
      entry_date: je.entry_date,
      description: je.description,
    }
  }

  return {
    invoiceMap: buildInvoiceMap(invoiceResults.flatMap((r) => r.data ?? [])),
    supplierInvoiceMap: buildSupplierInvoiceMap(supplierInvoiceResults.flatMap((r) => r.data ?? [])),
    voucherMap,
    rotRutByTransaction,
  }
}
