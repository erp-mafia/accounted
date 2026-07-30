import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The settlement account the reconciliation defaults to when a caller does not
 * name one. Always a string: BAS codes are identifiers, never numbers.
 */
export const DEFAULT_SETTLEMENT_ACCOUNT = '1930'

/**
 * The trailing arguments getReconciliationStatus / runReconciliation need in
 * order to reconcile ONE cash account instead of every same-currency one.
 */
export interface CashAccountScope {
  /**
   * The BAS account the GL side is filtered on. Equals the requested account
   * when one was found, the primary cash account's ledger_account when the
   * default '1930' had no row, and '1930' when nothing resolved at all.
   */
  accountNumber: string
  currency: string
  cashAccountId: string | undefined
  includeUnassigned: boolean
  /**
   * false = no cash_accounts row was resolved. That means exactly one thing
   * here: the company genuinely has no such row. A failed lookup THROWS (see
   * below), it never degrades into found: false.
   */
  found: boolean
}

interface CashAccountRow {
  id: string
  currency: string | null
  is_primary: boolean | null
  ledger_account: string
}

/**
 * Boolean(), not `row !== null`: a client that resolves without a `data` key
 * leaves row undefined, which `!== null` would report as FOUND. Callers use
 * `found` to reject an unknown account number, so a truthy-by-accident value
 * would turn "Okänt kassakonto 9999" into a status labelled 9999 whose bank
 * side is every SEK transaction of the company.
 */
function toScope(row: CashAccountRow | null | undefined, accountNumber: string): CashAccountScope {
  return {
    accountNumber: row?.ledger_account ?? accountNumber,
    currency: row?.currency ?? 'SEK',
    cashAccountId: row?.id,
    // Only the company's primary cash account claims rows with a NULL
    // cash_account_id; moot when no row exists, since scopeTransactionsToAccount
    // ignores the flag on the unscoped path.
    //
    // Known residual, NOT closed by #1290 and tracked as issue #1299: on a
    // primary row this still pulls every booked NULL-cash_account_id transaction
    // into the bank total, including ones whose verifikat has no line on this
    // account at all (own-account transfers the cash_account_id backfill
    // skipped). Measured on prod 2026-07-30 over all time, for the companies
    // with >= 2 SEK cash accounts and a primary 1930: 294 booked
    // NULL-cash_account_id SEK rows, 22 of them on verifikat with no 1930 line,
    // across 4 companies, net -4170.31 kr but with monthly swings from
    // -18055.82 kr (2026-07) to +38086.00 kr (2026-06). Those have no
    // counterpart on the GL side, so a smaller phantom difference survives for
    // companies with unbackfilled rows, still with count 0. Fixing it means
    // finishing the cash_account_id backfill, not widening or narrowing this
    // flag.
    includeUnassigned: row ? Boolean(row.is_primary) : true,
    found: Boolean(row),
  }
}

async function lookupByLedgerAccount(
  supabase: SupabaseClient,
  companyId: string,
  accountNumber: string,
): Promise<CashAccountRow | null | undefined> {
  // (company_id, ledger_account) is UNIQUE (migration 20260519110000), so
  // maybeSingle is exact and index-backed.
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('id, currency, is_primary, ledger_account')
    .eq('company_id', companyId)
    .eq('ledger_account', accountNumber)
    .maybeSingle()

  // Fail CLOSED. A swallowed error yields cashAccountId: undefined, which is
  // exactly the unscoped pooling path this helper exists to remove, so a
  // transient DB failure or an RLS denial would silently re-create the #1290
  // phantom difference and hand the user a blocker with nothing to match.
  // Throwing is the contract PR #1295 established for the MCP call site and it
  // now holds for every caller.
  if (error) throw new Error(`Kunde inte hämta kassakonto ${accountNumber}`)

  return data as CashAccountRow | null | undefined
}

async function lookupPrimary(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CashAccountRow | null | undefined> {
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('id, currency, is_primary, ledger_account')
    .eq('company_id', companyId)
    .eq('is_primary', true)
    .maybeSingle()

  if (error) throw new Error('Kunde inte hämta företagets primära kassakonto')

  return data as CashAccountRow | null | undefined
}

/**
 * Resolve a settlement account to its cash_accounts row and return the scope
 * arguments the reconciliation functions take.
 *
 * Why this is shared: calling getReconciliationStatus with only
 * (supabase, companyId, from, to) leaves cashAccountId undefined, and
 * scopeTransactionsToAccount then falls back to a currency-only filter. The
 * bank side sums EVERY SEK cash account while the GL side stays on one account,
 * so a company with a savings account gets a nonzero difference with zero
 * unmatched transactions and zero unmatched GL lines to point at (#1290).
 *
 * Two resolution modes, deliberately different:
 *
 * - `accountNumber` given (a caller naming an account, e.g. the MCP tool's
 *   account_number argument): resolve exactly that account, no fallback. An
 *   unknown account must stay unknown so callers can reject it.
 * - `accountNumber` omitted (the checks that just want "the company's bank"):
 *   try '1930', and if the company has no 1930 row fall back to its PRIMARY
 *   cash account. Without that fallback the caller compares the company's whole
 *   SEK bank volume against an empty 1930 GL side: measured on prod, 2 companies
 *   have no 1930 row while running two SEK cash accounts each (1935+1936 and
 *   1932+1935) and zero journal_entry_lines on 1930, so they got a
 *   bank_unreconciled blocker worth their entire bank volume with 0 unmatched
 *   items. cash_accounts allows at most one primary row per company (partial
 *   unique index idx_cash_accounts_one_primary_per_company, migration
 *   20260519110000), so maybeSingle is exact here too. For the 1367 companies
 *   that do have a 1930 row the fallback never runs, so nothing changes for
 *   them, including the 5 whose 1930 row is not the primary one.
 *
 * Lookup failures throw; they never degrade into the unscoped path.
 *
 * NOT a description of every caller in the codebase: the hand-rolled lookups in
 * app/api/reconciliation/bank/status/route.ts and .../run/route.ts use
 * `Boolean(cashAccount?.is_primary)`, i.e. includeUnassigned = FALSE when no row
 * exists, where this helper says true. The difference is inert (with no row
 * there is no cashAccountId, and scopeTransactionsToAccount ignores the flag on
 * that path), and those routes are deliberately left alone here to keep this
 * change scoped to #1290.
 */
export async function resolveCashAccountScope(
  supabase: SupabaseClient,
  companyId: string,
  accountNumber?: string,
): Promise<CashAccountScope> {
  const requested = accountNumber ?? DEFAULT_SETTLEMENT_ACCOUNT

  const row = await lookupByLedgerAccount(supabase, companyId, requested)
  if (row) return toScope(row, requested)

  if (accountNumber === undefined) {
    const primary = await lookupPrimary(supabase, companyId)
    if (primary) return toScope(primary, requested)
  }

  return toScope(null, requested)
}
