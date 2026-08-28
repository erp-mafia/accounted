import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import type { Transaction, ReconciliationMethod } from '@/types'
import { eventBus } from '@/lib/events/bus'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { hasLiveJournalEntryLink } from '@/lib/transactions/link-journal-entry'
import {
  ledgerLineAmountIn,
  type LedgerLineAmount,
} from '@/lib/bookkeeping/ledger-line-amount'
import {
  describeCashAccountSiblings,
  shouldRepointToSibling,
  type CashAccountSiblings,
} from '@/lib/cash-accounts/service'
import { createLogger } from '@/lib/logger'

const log = createLogger('reconciliation.bank')

// `ledgerLineAmountIn` moved to lib/bookkeeping/ledger-line-amount.ts verbatim
// so the invoice / supplier-invoice voucher matchers share the one rule instead
// of re-implementing it. Re-exported here unchanged: this module stayed its
// public home for bank reconciliation and its importers.
export { ledgerLineAmountIn }
export type { LedgerLineAmount }

// ============================================================
// Types
// ============================================================

/** A posted journal entry line on account 1930 not yet linked to any transaction */
export interface UnlinkedGLLine {
  line_id: string
  journal_entry_id: string
  debit_amount: number
  credit_amount: number
  line_description: string | null
  entry_date: string
  voucher_number: number
  voucher_series: string
  entry_description: string
  source_type: string
  /** How many bank transactions already point at this entry. Present only on
   *  rows from get_account_gl_lines_for_matching (the N:1 candidate fetch);
   *  undefined on the unmatched-only path, where it is always implicitly 0. */
  linked_transaction_count?: number
  /** FX metadata, see {@link ledgerLineAmountIn}. Optional because the two
   *  candidate RPCs (get_unlinked_gl_lines, get_account_gl_lines_for_matching)
   *  do not project these columns; callers that read journal_entry_lines
   *  directly do supply them. Absent means "no foreign amount on this row",
   *  which is treated as not-comparable, never as SEK. */
  currency?: string | null
  amount_in_currency?: number | string | null
}

export interface ReconciliationMatch {
  transaction: Transaction
  glLine: UnlinkedGLLine
  method: ReconciliationMethod
  confidence: number
}

export interface ReconciliationRunResult {
  matches: ReconciliationMatch[]
  applied: number
  errors: number
  /**
   * Matches the matcher proposed but the apply loop skipped because their
   * confidence fell below the caller's confidenceThreshold. They stay in
   * `matches` (reported, not silently dropped) so the caller can surface them
   * for human review. Always 0 on dry runs and when no threshold was given.
   */
  skippedBelowThreshold: number
  /**
   * Below-threshold matches persisted as suggestions on the transaction
   * (potential_journal_entry_id + method + confidence) for the review surface.
   * Always 0 unless persistSuggestions was set on a non-dry apply run with a
   * confidence threshold.
   */
  suggested: number
  /**
   * Unmatched, non-ignored transactions the run considered (the candidate pool
   * on the bank side). Lets callers report "X av Y matchade" without a second
   * count query.
   */
  candidates: number
}

/**
 * Confidence floor for UNATTENDED auto-apply (nightly enable-banking sync,
 * cron). Mirrors the default of the gnubok_auto_match_period MCP tool (0.9):
 * high enough that auto_fuzzy (0.75) and auto_date_range (0.85) matches are
 * never committed without human review, while auto_exact (0.95) and
 * auto_reference (0.90) still apply.
 */
export const DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD = 0.9

export interface ReconciliationStatus {
  /**
   * The currency EVERY monetary field in this object is expressed in: the
   * reconciled cash account's own currency. A EUR account is reconciled in EUR,
   * against the EUR amounts recorded on its ledger lines: amounts in different
   * currencies are never summed into one scalar. 'SEK' for the 95% case, where
   * this is a no-op and every figure below is exactly what it always was.
   */
  currency: string
  /**
   * Sum of the window's bank-feed transactions EXCLUDING ignored rows: the
   * bank side of the reconciliation. Ignored rows (feed duplicates from a
   * PSD2 reconnect, non-business noise) never get a ledger counterpart, so
   * counting them here manufactured a permanent unfixable difference; they are
   * surfaced separately below instead, mirroring how the opening balance is
   * excluded-but-shown.
   */
  bank_transaction_total: number
  /** Gross inflow (sum of positive amounts) behind bank_transaction_total; informational, for the page's "in · ut · antal" line. */
  bank_transaction_inflow: number
  /** Gross outflow (sum of negative amounts, itself negative) behind bank_transaction_total. */
  bank_transaction_outflow: number
  /** Number of non-ignored bank transactions in the window. */
  bank_transaction_count: number
  /** Sum of ignored bank transactions in the window. NOT part of
   *  bank_transaction_total or difference; informational, like the IB. */
  ignored_transaction_total: number
  /** Number of ignored bank transactions in the window. */
  ignored_transaction_count: number
  /**
   * The real ledger balance on the bank account, incl. IB: computed from the
   * SAME `['posted','reversed']` lines the trial balance and balance sheet sum.
   * On a SEK account this value is therefore identical to what the balansräkning
   * reports for this account. On a foreign account it is the balance in THAT
   * currency; the SEK carrying amount on the balance sheet differs by the
   * unrealised kursdifferens and is revalued separately. (Use
   * `gl_1930_period_movement` for the reconciliation diff, since this figure
   * still includes the opening balance.)
   */
  gl_1930_balance: number
  /** Ledger movement on the bank account excluding only opening_balance: i.e.
   *  the ledger balance minus IB. Storno/correction lines ARE included here
   *  (they're part of the balance), so a corrected bank line reconciles against
   *  its re-pointed feed transaction. This is what `difference` compares against. */
  gl_1930_period_movement: number
  /** IB on the bank account within the date range: surfaced separately so
   *  reconciliation doesn't treat it as an unmatched bank transaction. */
  gl_1930_opening_balance: number
  /** Net of posted storno/correction lines on the bank account within the date
   *  range. INFORMATIONAL ONLY: it is part of the ledger balance and is included
   *  in gl_1930_period_movement, not subtracted from it. Surfaced so the UI can
   *  show how much of the period's movement came from corrections. */
  gl_1930_correction_adjustment: number
  /** bankTotal − gl_1930_period_movement, both in `currency`. Zero when every
   *  period transaction is matched. Meaningless while
   *  `not_reconcilable_reason` is set: it is then computed over the subset of
   *  ledger lines that could be expressed in `currency` at all. */
  difference: number
  /**
   * The account is avstämt: the ledger movement equals the bank movement AND
   * every bank transaction in the window is accounted for by a verifikation.
   *
   * BOTH conditions are required. A net-zero difference on its own is not a
   * reconciliation: two unmatched transactions that happen to offset each other
   * net to zero while both remain unbooked affärshändelser (BFL 5 kap 1-2 §,
   * each requiring its own verifikation identifying belopp and motpart), and
   * ÅRL 2 kap's individuell värdering and bruttoredovisning say exactly that
   * offsetting two unknowns is not the same as knowing either one.
   */
  is_reconciled: boolean
  matched_count: number
  unmatched_transaction_count: number
  /**
   * Sum of the unmatched bank transactions behind `unmatched_transaction_count`,
   * in `currency`. Together with {@link unmatched_gl_line_total} this decomposes
   * `difference` into the two work lists the user can actually open, instead of
   * leaving it an unexplained scalar.
   */
  unmatched_transaction_total: number
  unmatched_gl_line_count: number
  /**
   * Sum of the unmatched ledger lines behind `unmatched_gl_line_count`, in
   * `currency`, signed like a bank movement (+ in, - out).
   *
   * `null` when at least one of those lines carries no amount in `currency`:
   * the two candidate RPCs project neither `currency` nor `amount_in_currency`,
   * so on a foreign account every line is unconvertible and there is no honest
   * sum to report. Reporting 0 there would claim the vouchers net to nothing.
   * Always a number on a SEK account (see {@link ledgerLineAmountIn}).
   */
  unmatched_gl_line_total: number | null
  /**
   * What is left of `difference` once both work lists are accounted for:
   * `difference - unmatched_transaction_total + unmatched_gl_line_total`.
   *
   * `difference` is merely how far apart the two sides currently stand; mid-year
   * it is expected to be large and it is fully explained as long as every krona
   * of it sits in one of the two lists. The residual is what does NOT.
   *
   * It reduces to (sum of matched transactions - sum of the ledger lines they
   * settle), so it is non-zero when a matched pair disagrees in amount, when one
   * voucher carries several lines on this account, or when a ledger line the
   * candidate RPC hides has no bank counterpart. That last cause dominates:
   * `get_account_gl_lines_for_matching` returns only `status='posted'` entries
   * and excludes storno / correction outright, so an unlinked storno moves this
   * account's movement while staying invisible in "Omatchade verifikationer".
   * Measured on prod 2026-08-20 over the 206 single-1930-account companies with
   * >=10 transactions: 136 reconcile to exactly 0,00, 63 land >=100 kr out, and
   * the unlinked-hidden-line buckets behind that are posted/storno (127
   * companies), reversed/bank_transaction (66) and posted/correction (49).
   *
   * A non-zero residual is therefore a real finding but usually NOT user error,
   * so the UI states it factually rather than in destructive red.
   *
   * `null` whenever `unmatched_gl_line_total` is null: no honest residual
   * exists then either.
   */
  unexplained_difference: number | null
  /** Counted ledger lines on the account that carry no amount in `currency`
   *  (see {@link ledgerLineAmountIn}). Always 0 on a SEK account. */
  unconvertible_gl_line_count: number
  /**
   * Machine-readable reason the window cannot be reconciled at all, or null
   * when it can. Currently the single code `gl_lines_missing_currency_amount`:
   * a foreign-currency account whose ledger lines hold only SEK figures with no
   * per-row rate. There is nothing to convert with, so no difference is
   * reported as if it meant something and `is_reconciled` is forced false.
   */
  not_reconcilable_reason: string | null
}

export interface ReconciliationOptions {
  dateFrom?: string
  dateTo?: string
  dryRun?: boolean
  /**
   * Settlement account number to reconcile against (e.g. '1930' for SEK,
   * '1932' for EUR). Defaults to '1930' so existing callers stay correct.
   * The cash_accounts table is the source of truth for which BAS codes are
   * routable for a given company.
   */
  accountNumber?: string
  /**
   * Currency to filter transactions on. Defaults to 'SEK' for back-compat;
   * future multi-currency reconciliation passes the currency of the selected
   * cash account so EUR transactions reconcile against 1932 etc.
   */
  currency?: string
  /**
   * cash_accounts.id of the selected account. When set, transactions are
   * scoped to this exact account (with a currency fallback for legacy rows
   * whose cash_account_id hasn't been backfilled yet) instead of being matched
   * by currency alone: this is what stops two same-currency accounts (e.g.
   * checking 1930 + savings 1931) from pooling together. Omit for the legacy
   * currency-only behaviour.
   */
  cashAccountId?: string
  /**
   * Whether this account claims rows with a NULL cash_account_id (legacy /
   * unassigned). Only the company's primary cash account should: see
   * scopeTransactionsToAccount. Defaults to true for back-compat with the
   * currency-only callers (where cashAccountId is omitted and this is moot).
   */
  includeUnassigned?: boolean
  /**
   * Apply only these transaction↔journal-entry pairs (ignored on dry runs).
   * The UI's dry-run preview lets the user untick suspicious matches; a
   * subsequent apply passes the ticked pairs here so the server never commits
   * a match the user excluded, and never commits a pair the matcher itself
   * didn't propose on the re-run, since the filter intersects with the fresh
   * match set rather than trusting the client's pairs blindly.
   */
  applyOnly?: Array<{ transactionId: string; journalEntryId: string }>
  /**
   * Server-side confidence floor for the apply path (0..1; out-of-range values
   * are clamped, mirroring gnubok_auto_match_period). Matches below it are NOT
   * applied: they stay in `matches` and are counted in skippedBelowThreshold.
   * Ignored on dry runs (the preview always returns every proposal). Omit for
   * the legacy behavior: apply every proposed match, including auto_fuzzy at
   * 0.75. Unattended callers must pass a floor (see
   * DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD) so fuzzy matches are never
   * committed without human review.
   */
  confidenceThreshold?: number
  /**
   * Persist below-threshold matches (the 0.75-0.89 band: auto_fuzzy,
   * auto_date_range) onto the transaction's potential_journal_entry_id /
   * potential_match_method / potential_match_confidence columns instead of
   * dropping them, so the review surface can offer them for confirmation.
   * Only meaningful together with confidenceThreshold on a non-dry apply run;
   * ignored otherwise. Suggestions are soft data: the same optimistic
   * `.is('journal_entry_id', null)` guard as the apply path, plus DB triggers
   * that clear them when the row is booked/ignored or the entry is consumed
   * or reversed.
   */
  persistSuggestions?: boolean
}

/**
 * Scope a transactions query builder to a single cash account, tolerating
 * legacy rows that predate the cash_account_id backfill.
 *
 * The applied filter is one of:
 *   includeUnassigned=true:   currency = cur AND (cash_account_id = X OR cash_account_id IS NULL)
 *   includeUnassigned=false:  currency = cur AND cash_account_id = X
 *   no cashAccountId:         currency = cur                       (legacy currency-only path)
 *
 * Why `includeUnassigned` exists: a NULL cash_account_id row belongs to exactly
 * ONE account, but the query can't tell which: these are unbooked rows in
 * companies with ≥2 same-currency accounts (the backfill refuses to guess
 * between checking + savings) and booked own-account transfers the backfill
 * deliberately skips (>1 bank-class line). Attributing them to EVERY
 * same-currency account double-counts them: a 1931 savings account would pull in
 * 1930's unassigned rows, so Bankavstämning reported a large bogus difference
 * for 1931 while 1930 itself still reconciled. The fix: only the company's
 * PRIMARY cash account (cash_accounts.is_primary, exactly one per company)
 * claims NULL rows; every other account scopes strictly to its own id. Callers
 * pass `includeUnassigned = <this account is_primary>`. When cashAccountId is
 * omitted (single-account companies with no row, the '1930' fallback) the pure
 * currency filter is used and includeUnassigned is moot.
 *
 * Account-scoped callers must resolve the row FIRST (see resolveCashAccountScope
 * in lib/reconciliation/cash-account-scope.ts). Omitting cashAccountId is the
 * legacy fallback for a company with no cash_accounts row at all; doing it on a
 * company that HAS several is issue #1290: the transaction side pools every
 * same-currency account while the GL side stays on one account, producing a
 * difference with nothing unmatched to point at.
 *
 * Not every remaining unscoped caller is intentional. The post-sync sweeps in
 * app/api/extensions/enable-banking/sync/cron/route.ts and
 * extensions/general/enable-banking/index.ts call runReconciliation without a
 * scope, which is a known open defect rather than a supported mode: they need
 * one run per cash account, not one pooled run. Tracked as issue #1298;
 * warnIfUnscopedAcrossCashAccounts below makes both visible in the logs until
 * that is fixed.
 *
 * The earlier nested `or(cash_account_id.eq.X,and(cash_account_id.is.null,currency.eq.cur))`
 * form is intentionally avoided: it silently returned ZERO rows mid-backfill.
 * A cash account has exactly one currency, so the flat two-term `or` is reliable.
 */
export function scopeTransactionsToAccount<Q extends {
  or(filters: string): Q
  eq(column: string, value: string): Q
}>(query: Q, cashAccountId: string | undefined, currency: string, includeUnassigned = true): Q {
  // Both values are interpolated into a raw PostgREST filter string below. They
  // are DB-derived in every caller (cash_accounts.id / .currency, or the 'SEK'
  // default), never raw user input, but assert their shape anyway so a future
  // caller cannot thread an unsanitized value through into the filter.
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`scopeTransactionsToAccount: invalid currency ${JSON.stringify(currency)}`)
  }
  if (cashAccountId) {
    if (!/^[0-9a-fA-F-]{36}$/.test(cashAccountId)) {
      throw new Error('scopeTransactionsToAccount: invalid cashAccountId (expected UUID)')
    }
    if (includeUnassigned) {
      return query
        .eq('currency', currency)
        .or(`cash_account_id.eq.${cashAccountId},cash_account_id.is.null`)
    }
    // Non-primary account: strict; never claim the company's unassigned NULL rows.
    return query.eq('currency', currency).eq('cash_account_id', cashAccountId)
  }
  return query.eq('currency', currency)
}

/**
 * Emit a warning when a run left cashAccountId undefined AND the rows it
 * fetched really do span more than one cash account.
 *
 * That combination is the #1290 shape: the transaction side pools every
 * same-currency account while the GL side stays on a single accountNumber. On a
 * read (getReconciliationStatus) it manufactures a difference with nothing
 * unmatched behind it; on a WRITE (runReconciliation, which applies matches
 * unless dryRun) it can auto-link a savings-account transaction to an unlinked
 * 1930 voucher, i.e. persist a wrong journal_entry_id.
 *
 * It warns rather than throwing because single-account companies with no
 * cash_accounts row still legitimately take the currency-only path, and they
 * never trip this condition (0 or 1 distinct id). The fix for anything this
 * logs is always at the CALL SITE: resolve the row with resolveCashAccountScope
 * (lib/reconciliation/cash-account-scope.ts) and pass the scope through.
 */
function warnIfUnscopedAcrossCashAccounts(
  operation: string,
  rows: { cash_account_id?: string | null }[],
  ctx: {
    cashAccountId: string | undefined
    companyId: string
    accountNumber: string
    currency: string
  },
): void {
  if (ctx.cashAccountId) return
  const distinct = new Set(
    rows.map((r) => r.cash_account_id).filter((id): id is string => Boolean(id)),
  )
  if (distinct.size <= 1) return
  log.warn(`${operation} ran unscoped across several cash accounts`, {
    companyId: ctx.companyId,
    operation,
    entityType: 'cash_account',
    details: {
      accountNumber: ctx.accountNumber,
      currency: ctx.currency,
      distinctCashAccounts: distinct.size,
    },
  })
}

// ============================================================
// In-memory matching: single transaction against GL line pool
// ============================================================

/**
 * Try to reconcile a single transaction against a pool of unlinked GL lines.
 * Returns the best match or null. Purely in-memory, no DB calls.
 *
 * `expectedCurrency` filters which transactions can match: defaults to 'SEK'
 * so existing callers behave identically.
 *
 * The currency check gates BOTH sides. Filtering only the transaction leaves
 * `transaction.amount` (in expectedCurrency) being compared against a ledger
 * amount that is always SEK, so a 100 EUR bank row happily "matched" an
 * unrelated 100 SEK ledger leg on the same date at 0.95 confidence. The ledger
 * side is resolved through ledgerLineAmountIn: a line with no amount in
 * expectedCurrency yields no match at all, rather than a same-magnitude
 * coincidence in the wrong unit.
 */
export function tryReconcileTransaction(
  transaction: Transaction,
  glLines: UnlinkedGLLine[],
  expectedCurrency: string = 'SEK',
): ReconciliationMatch | null {
  if (transaction.currency !== expectedCurrency) return null
  if (glLines.length === 0) return null

  const txAmount = transaction.amount
  const txDate = transaction.date
  const txReference = (transaction.reference || '').toLowerCase()

  let bestMatch: ReconciliationMatch | null = null

  for (const line of glLines) {
    const lineAmount = ledgerLineAmountIn(line, expectedCurrency)
    if (lineAmount === null) continue
    if (!isDirectionCompatible(txAmount, line)) continue

    const amountMatches = Math.abs(Math.abs(txAmount) - Math.abs(lineAmount)) < 0.005
    const fuzzyAmountMatches = Math.abs(Math.abs(txAmount) - Math.abs(lineAmount)) <= 0.01
    const exactDateMatch = txDate === line.entry_date
    const dateWithinRange = isDateWithinRange(txDate, line.entry_date, 3)
    // Reference matches require BOTH a real OCR/reference token AND a bounded
    // date window. Never description-only: that collides on recurring monthly
    // charges (same description, same amount, different year). Never cross-year.
    const referenceMatch =
      hasOcrReferenceMatch(txReference, line) &&
      isDateWithinRange(txDate, line.entry_date, 90)

    let method: ReconciliationMethod | null = null
    let confidence = 0

    // Pass 1: Exact amount + exact date
    if (amountMatches && exactDateMatch) {
      method = 'auto_exact'
      confidence = 0.95
    }
    // Pass 2: Exact amount + OCR/reference match within ±90 days
    else if (amountMatches && referenceMatch) {
      method = 'auto_reference'
      confidence = 0.90
    }
    // Pass 3: Exact amount + date within ±3 days
    else if (amountMatches && dateWithinRange) {
      method = 'auto_date_range'
      confidence = 0.85
    }
    // Pass 4: Fuzzy amount (±0.01) + exact date
    else if (fuzzyAmountMatches && exactDateMatch) {
      method = 'auto_fuzzy'
      confidence = 0.75
    }

    if (method && confidence > (bestMatch?.confidence ?? 0)) {
      bestMatch = { transaction, glLine: line, method, confidence }
    }
  }

  return bestMatch
}

// ============================================================
// Batch reconciliation
// ============================================================

/**
 * Run auto-reconciliation for all unmatched transactions.
 * Fetches data, runs 4-pass matching, optionally applies matches.
 */
export async function runReconciliation(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  options: ReconciliationOptions = {}
): Promise<ReconciliationRunResult> {
  const {
    dateFrom,
    dateTo,
    dryRun = false,
    accountNumber = '1930',
    currency = 'SEK',
    cashAccountId,
    includeUnassigned = true,
    applyOnly,
    confidenceThreshold,
    persistSuggestions = false,
  } = options

  // Fetch unlinked GL lines via RPC
  const glLines = await fetchUnlinkedGLLines(supabase, companyId, accountNumber, dateFrom, dateTo)

  // Fetch unmatched transactions, scoped to the selected cash account.
  // Paginated: a busy company can exceed PostgREST's silent 1000-row cap, which
  // would make the matcher skip transactions without any signal. Ordered on id
  // (unique) so pages never duplicate or skip rows.
  const transactions = await fetchAllRows<Transaction>(({ from, to }) => {
    let query = supabase
      .from('transactions')
      .select('*')
      .eq('company_id', companyId)
      .is('journal_entry_id', null)
      .eq('is_ignored', false)
    query = scopeTransactionsToAccount(query, cashAccountId, currency, includeUnassigned)
    if (dateFrom) query = query.gte('date', dateFrom)
    if (dateTo) query = query.lte('date', dateTo)
    return query.order('id').range(from, to)
  })

  // Same diagnostic as the read path, and it matters MORE here: an unscoped run
  // matches transactions from every same-currency account against unlinked GL
  // lines on accountNumber alone, and (dryRun aside) writes the resulting
  // journal_entry_id onto the transaction.
  warnIfUnscopedAcrossCashAccounts('runReconciliation', transactions, {
    cashAccountId,
    companyId,
    accountNumber,
    currency,
  })

  if (transactions.length === 0 || glLines.length === 0) {
    return {
      matches: [],
      applied: 0,
      errors: 0,
      skippedBelowThreshold: 0,
      suggested: 0,
      candidates: transactions.length,
    }
  }

  // Run greedy matching, highest confidence first
  let matches = greedyMatch(transactions, glLines, currency)

  if (dryRun) {
    return {
      matches,
      applied: 0,
      errors: 0,
      skippedBelowThreshold: 0,
      suggested: 0,
      candidates: transactions.length,
    }
  }

  // When the caller reviewed a dry-run and ticked a subset, apply ONLY pairs
  // that BOTH the user selected AND the fresh match run still proposes: the
  // intersection guards against data that changed between preview and apply.
  if (applyOnly) {
    const selected = new Set(applyOnly.map((p) => `${p.transactionId}:${p.journalEntryId}`))
    matches = matches.filter((m) =>
      selected.has(`${m.transaction.id}:${m.glLine.journal_entry_id}`),
    )
  }

  // Confidence floor: never auto-apply a match below the caller's threshold.
  // Skipped matches are not errors: they remain in `matches` (with their
  // confidence) so the caller can report them for human review, and are
  // counted separately. This is the server-side guardrail for unattended
  // callers (nightly sync / cron), where nobody reviews a dry-run first.
  let toApply = matches
  let belowThresholdMatches: ReconciliationMatch[] = []
  if (confidenceThreshold !== undefined) {
    const floor = Math.max(0, Math.min(1, confidenceThreshold))
    toApply = matches.filter((m) => m.confidence >= floor)
    belowThresholdMatches = matches.filter((m) => m.confidence < floor)
  }
  const skippedBelowThreshold = belowThresholdMatches.length

  // Apply matches
  let applied = 0
  let errors = 0

  for (const match of toApply) {
    try {
      // .is('journal_entry_id', null) is an optimistic-lock guard: if a
      // concurrent user (or another surface) linked this transaction between
      // the read above and this write, the update matches zero rows instead of
      // silently re-pointing an existing link. Same pattern as
      // lib/transactions/link-journal-entry.ts.
      const { data: updatedRows, error } = await supabase
        .from('transactions')
        .update({
          journal_entry_id: match.glLine.journal_entry_id,
          reconciliation_method: match.method,
          is_business: true,
        })
        .eq('id', match.transaction.id)
        .eq('company_id', companyId)
        .is('journal_entry_id', null)
        .select('id')

      if (error || !updatedRows || updatedRows.length === 0) {
        errors++
      } else {
        applied++
        // Behandlingshistorik (BFNAR 2013:2 kap 8, BFL 7:1): every auto-applied
        // link is a match event and must land in the append-only log, exactly
        // like the invoice-match and confirm-suggestion paths. The bus event
        // below goes to event_log (30-day TTL) and is NOT an audit record.
        await logMatchEvent(supabase, userId, match.transaction.id, 'matched', {
          matchConfidence: match.confidence,
          matchMethod: match.method,
          newState: {
            journal_entry_id: match.glLine.journal_entry_id,
            reconciliation_method: match.method,
          },
        })
        try {
          eventBus.emit({
            type: 'transaction.reconciled',
            payload: {
              transaction: match.transaction,
              journalEntryId: match.glLine.journal_entry_id,
              method: match.method,
              userId,
              companyId,
            },
          })
        } catch {
          // Event emission is non-critical
        }
      }
    } catch {
      errors++
    }
  }

  // Persist the below-threshold band as reviewable suggestions instead of
  // dropping it. Same optimistic-lock guard as the apply loop: a row that got
  // booked or linked between the read and this write matches zero rows, and
  // the DB trigger clears any suggestion the moment a link lands, so a stale
  // suggestion can never shadow a real link.
  let suggested = 0
  if (persistSuggestions) {
    for (const match of belowThresholdMatches) {
      try {
        const { data: suggestedRows, error } = await supabase
          .from('transactions')
          .update({
            potential_journal_entry_id: match.glLine.journal_entry_id,
            potential_match_method: match.method,
            potential_match_confidence: match.confidence,
          })
          .eq('id', match.transaction.id)
          .eq('company_id', companyId)
          .is('journal_entry_id', null)
          .select('id')

        if (!error && suggestedRows && suggestedRows.length > 0) {
          suggested++
          // Awaited: an unawaited promise can be frozen on serverless when the
          // response returns, silently dropping the audit row.
          await logMatchEvent(supabase, userId, match.transaction.id, 'auto_suggested', {
            matchConfidence: match.confidence,
            matchMethod: match.method,
            newState: { potential_journal_entry_id: match.glLine.journal_entry_id },
          })
        }
      } catch {
        // Suggestions are best-effort: never fail the run over one row.
      }
    }
  }

  return {
    matches,
    applied,
    errors,
    skippedBelowThreshold,
    suggested,
    candidates: transactions.length,
  }
}

// ============================================================
// Reconciliation status
// ============================================================

/**
 * Compare bank transaction totals vs GL bank account balance.
 *
 * `bankAccount` and `currency` must agree (e.g. 1932 + EUR). When the caller
 * omits currency it defaults to SEK for back-compat with the single-account
 * call sites that only ever reconciled 1930. Multi-currency callers must pass
 * both: comparing EUR GL movements against SEK transaction totals would
 * silently produce nonsense.
 */
export async function getReconciliationStatus(
  supabase: SupabaseClient,
  companyId: string,
  dateFrom?: string,
  dateTo?: string,
  bankAccount = '1930',
  currency: string = 'SEK',
  cashAccountId?: string,
  includeUnassigned: boolean = true,
): Promise<ReconciliationStatus> {
  // Get all transactions in range, scoped to the selected cash account. Ignored
  // rows are pulled too, but only to be COUNTED AND SUMMED separately: they are
  // excluded from the bank total, the difference and the matched/unmatched
  // counts below, because the user has explicitly said they are not something
  // to reconcile (duplicates, non-business noise). Scoping by cash account
  // (not just currency) is what stops a
  // second same-currency account from inflating bankTotal here.
  // Paginated (fetchAllRows): PostgREST silently caps un-ranged selects at 1000
  // rows, which would undercount bank_transaction_total for a busy company and
  // manufacture a phantom, unexplainable difference. Ordered on id (unique) so
  // pages never duplicate or skip rows across boundaries.
  type StatusTxRow = {
    id?: string | null
    date: string | null
    amount: number | string | null
    journal_entry_id: string | null
    reconciliation_method: string | null
    is_ignored: boolean | null
    cash_account_id: string | null
  }
  const transactions = await fetchAllRows<StatusTxRow>(({ from, to }) => {
    let txQuery = supabase
      .from('transactions')
      .select('id, date, amount, journal_entry_id, reconciliation_method, is_ignored, cash_account_id')
      .eq('company_id', companyId)
    txQuery = scopeTransactionsToAccount(txQuery, cashAccountId, currency, includeUnassigned)
    if (dateFrom) txQuery = txQuery.gte('date', dateFrom)
    if (dateTo) txQuery = txQuery.lte('date', dateTo)
    return txQuery.order('id').range(from, to)
  })

  warnIfUnscopedAcrossCashAccounts('getReconciliationStatus', transactions, {
    cashAccountId,
    companyId,
    accountNumber: bankAccount,
    currency,
  })

  // Transactions anchored through transaction_voucher_links (bulk-booked
  // samlingsverifikat, residual bookings) carry journal_entry_id = NULL on the
  // row itself. They are settled all the same, so the matched/unmatched split
  // below must see them; is_transaction_booked() is the SQL twin of this.
  const junctionLinkedTxIds = await fetchJunctionLinkedTxIds(
    supabase,
    companyId,
    transactions.map((tx) => tx.id).filter((id): id is string => typeof id === 'string'),
  )

  // Get GL bank-account lines. We fetch posted AND reversed entries and count
  // them TOGETHER: the exact inclusion rule the trial balance and balance sheet
  // use (see lib/reports/trial-balance.ts, which sums `['posted','reversed']`).
  // A reversed original stays in the ledger and is cancelled by its storno, so
  // both legs must be summed; counting only the storno would leave a dangling
  // half-correction. Using the identical rule here is what guarantees
  // gl_1930_balance can never disagree with the balansräkning for this account:
  // the headline bug this widget had (a corrected bank receipt showed one figure
  // here and a different one on the balance sheet). source_type is still pulled
  // so we can split out the opening balance and surface correction activity.
  type GlEntry = {
    id?: string | null
    status?: string | null
    source_type?: string | null
    entry_date?: string | null
  }
  type GlLineRow = LedgerLineAmount & {
    journal_entries: GlEntry | GlEntry[] | null
  }
  // Supabase typings sometimes widen embedded relations to arrays even when the
  // join is one-to-one. Handle both shapes defensively.
  function entryOf(line: GlLineRow): GlEntry | null {
    const je = line.journal_entries
    if (!je) return null
    return Array.isArray(je) ? je[0] ?? null : je
  }
  // Every ledger figure below is resolved in the ACCOUNT's own currency, the
  // same unit the bank side is already in (transactions are scoped by
  // `.eq('currency', currency)`, so tx.amount is always in `currency`). On SEK
  // this is debit - credit, exactly as before. On a foreign account it is the
  // line's amount_in_currency: summing SEK ledger legs against a EUR bank
  // statement produced a difference roughly the size of the exchange rate, so a
  // foreign cash account could never show is_reconciled.
  // Lines with no amount in `currency` resolve to null; they are counted (and
  // block reconciliation) rather than silently contributing zero.
  function lineAmount(line: GlLineRow): number {
    return ledgerLineAmountIn(line, currency) ?? 0
  }

  // posted + reversed = the ledger balance, exactly as the trial balance counts
  // it. The .in() filter on the query already excludes draft/cancelled.
  // Fetched via the two-step entry-lines helper (entries first, then lines
  // chunked by entry id, both paginated): a silently truncated GL side would
  // corrupt gl_1930_balance and the difference. See lib/bookkeeping/entry-lines.ts.
  const fetchedLines = await fetchEntryLines<GlLineRow>({
    supabase,
    entryColumns: 'id, company_id, entry_date, status, source_type',
    // currency + amount_in_currency: the foreign amount lives on the very lines
    // being summed, so a foreign account is reconciled in its own currency
    // instead of against an unconvertible SEK figure. See ledgerLineAmountIn.
    lineColumns: 'debit_amount, credit_amount, currency, amount_in_currency',
    filterEntries: (q: EntryLinesQuery) => {
      let glQuery = q.eq('company_id', companyId).in('status', ['posted', 'reversed'])
      if (dateFrom) glQuery = glQuery.gte('entry_date', dateFrom)
      if (dateTo) glQuery = glQuery.lte('entry_date', dateTo)
      return glQuery
    },
    filterLines: (q: EntryLinesQuery) => q.eq('account_number', bankAccount),
  })

  // Floor the window at the most recent opening-balance date on this account
  // (issue #751). Everything dated before that IB is prior history the IB entry
  // already summarises; if the window has no lower bound (the "full history"
  // default) it spans the fiscal-year boundary and pulls the prior period's real
  // movements (which net to exactly the IB) into the period movement, while the
  // bank feed only covers the current period. The IB *summary* is excluded below,
  // but the prior-period *detail* would otherwise remain, manufacturing a phantom
  // difference equal to the IB. effectiveFrom is the later of the caller's
  // dateFrom and that IB date; it only ever RAISES the lower bound, so the
  // dateFrom SQL pre-filter on both queries above stays valid. In normal use the
  // UI passes dateFrom = period_start = the IB date, so this is a no-op there.
  //
  // Only a POSTED opening balance is an IB. A stornerad IB (status 'reversed')
  // has been economically nulled by its storno: both lines still sit in
  // countedLines and cancel inside glBalance, exactly as on the balansräkning,
  // but neither may be treated as the period's IB. Counting the reversed one
  // here (and in glOpeningBalance below) re-added the cancelled amount once
  // more and manufactured a phantom difference equal to the IB after a
  // perfectly correct rättelse. Same rule the canonical opening-balance RPC
  // applies (compute_prior_opening_balances, 20260421180000).
  const isLiveOpeningBalanceLine = (l: GlLineRow): boolean => {
    const entry = entryOf(l)
    return entry?.source_type === 'opening_balance' && entry?.status === 'posted'
  }
  const ibDates = fetchedLines
    .filter(isLiveOpeningBalanceLine)
    .map((l) => entryOf(l)?.entry_date)
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
  // Take the LATEST IB date. The invariant is one opening_balance entry per
  // fiscal period (set_opening_balances / SIE import / year-end rollover all
  // create exactly one, dated period_start), so within a single-period window
  // there is only one. Across a multi-year window the most recent IB is the
  // correct floor: an earlier year's IB and the movements it summarises are
  // prior history we deliberately drop. Same-date duplicates are harmless: they
  // land in both countedLines and glOpeningBalance and cancel.
  const ibFloor = ibDates.length ? ibDates.reduce((a, b) => (a > b ? a : b)) : null
  const effectiveFrom =
    dateFrom && ibFloor ? (dateFrom > ibFloor ? dateFrom : ibFloor) : dateFrom || ibFloor || null
  // ISO yyyy-mm-dd compares lexically; undated rows (e.g. test fixtures) pass.
  const onOrAfterFloor = (d: string | null | undefined): boolean =>
    !effectiveFrom || typeof d !== 'string' ? true : d >= effectiveFrom

  // Clamp BOTH sides to the floor identically so they stay comparable. Lines and
  // transactions before the IB belong to a prior period's reconciliation.
  const countedLines = fetchedLines.filter((l) => onOrAfterFloor(entryOf(l)?.entry_date))
  const countedTx = (transactions || []).filter((tx) =>
    onOrAfterFloor((tx as { date?: string | null }).date),
  )

  // Bank side: every NON-IGNORED feed transaction in the (floored) window. We
  // deliberately do NOT special-case rows linked to a reversed entry any more.
  // Because the GL side now counts the reversed original, its storno AND the
  // correction together (just like the balance sheet), a corrected bank line nets
  // to its true amount on both sides and reconciles on its own: whether
  // correctEntry re-pointed the transaction to the live corrected entry or a
  // legacy row still points at the reversed original, the result is identical.
  // transactions.amount is denominated in transactions.currency, and
  // scopeTransactionsToAccount pinned that to `currency`, so this total is
  // already in the account's own currency: the unit lineAmount() resolves to.
  //
  // Ignored rows are EXCLUDED from the total, exactly as they are excluded from
  // the unmatched count: ignoring is the sanctioned handling for feed
  // duplicates (a reconnect re-importing history) and non-business noise, and
  // by definition an ignored row will never get a ledger counterpart. Counting
  // it in the bank total manufactured a permanent difference the user could
  // never book away: after a correct duplicate cleanup the card showed a
  // six-figure differens over a fully booked account, and is_reconciled was
  // unreachable forever. They are surfaced separately (count + sum) instead,
  // the same pattern as the opening balance, so nothing is silently hidden.
  const reconcilableTx = countedTx.filter((tx) => tx.is_ignored !== true)
  const ignoredTx = countedTx.filter((tx) => tx.is_ignored === true)
  const bankTotal = reconcilableTx.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0)
  const ignoredTotal = ignoredTx.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0)

  // Ledger lines the account's currency cannot express: a foreign account whose
  // lines hold only SEK figures with no per-row rate (SIE imports, pre-FX
  // bookings, an opening balance set in SEK). There is nothing honest to
  // convert with, so the window is reported as not-reconcilable-yet with a
  // reason instead of inventing a rate or pretending the SEK figure is EUR.
  // Always empty on a SEK account: ledgerLineAmountIn never returns null there.
  const unconvertibleLines = countedLines.filter((l) => ledgerLineAmountIn(l, currency) === null)

  // gl_1930_balance: the real ledger balance on this account incl. IB,
  // byte-for-byte the figure the balansräkning / saldobalans report.
  const glBalance = countedLines.reduce((sum, line) => sum + lineAmount(line), 0)
  // IB is last year's closing position, not a movement with a bank-feed
  // counterpart, surfaced separately and excluded from the period movement.
  // Posted IB lines only (see isLiveOpeningBalanceLine): a reversed IB and its
  // storno stay in glBalance where they net to zero.
  const glOpeningBalance = countedLines
    .filter(isLiveOpeningBalanceLine)
    .reduce((sum, line) => sum + lineAmount(line), 0)
  // Net storno/correction activity on the account this period. Surfaced for
  // transparency ONLY: it is part of the ledger balance and is INCLUDED in the
  // movement, never subtracted. (Subtracting it while still counting the
  // re-pointed bank transaction is exactly what produced the old phantom diff.)
  const glCorrectionAdjustment = countedLines
    .filter((l) => {
      const st = entryOf(l)?.source_type
      return st === 'storno' || st === 'correction'
    })
    .reduce((sum, line) => sum + lineAmount(line), 0)
  // Period movement = the ledger balance minus the opening balance. Everything
  // else (real bookings, stornos and corrections alike) has (or should have)
  // a bank-feed counterpart, so it stays in.
  const glPeriodMovement = glBalance - glOpeningBalance

  // Matched/unmatched partition the RECONCILABLE (non-ignored) set, so
  // matched_count + unmatched_transaction_count always equals the number of
  // rows behind bank_transaction_total.
  const isLinked = (tx: StatusTxRow): boolean =>
    tx.journal_entry_id !== null || (typeof tx.id === 'string' && junctionLinkedTxIds.has(tx.id))
  const matchedCount = reconcilableTx.filter(isLinked).length
  // The gross split behind the net: what the user actually recognises as
  // "what moved on the bank", so the page never has to explain "netto".
  const bankInflow = reconcilableTx.reduce((sum, tx) => sum + Math.max(Number(tx.amount) || 0, 0), 0)
  const bankOutflow = reconcilableTx.reduce((sum, tx) => sum + Math.min(Number(tx.amount) || 0, 0), 0)

  const unmatchedTx = reconcilableTx.filter((tx) => !isLinked(tx))
  const unmatchedTransactionCount = unmatchedTx.length
  const unmatchedTransactionTotal = unmatchedTx.reduce(
    (sum, tx) => sum + (Number(tx.amount) || 0),
    0
  )

  // Unmatched GL lines count (RPC excludes opening_balance, storno and correction
  // since 20260601120000_unlinked_gl_lines_exclude_storno_correction.sql).
  // Account-scoped since 20260723160000: a voucher whose links all sit on another
  // cash account (a transfer's other leg) counts as unmatched HERE, keeping this
  // number in agreement with the "Omatchade verifikationer" table the
  // reconciliation view derives from the same RPC.
  // effectiveFrom, NOT the caller's dateFrom: countedLines and countedTx are both
  // clamped to the IB floor above, and this list has to describe the SAME window
  // or the card contradicts itself. With the raw dateFrom, a window that opens
  // before the account's opening balance (the v1 endpoint's "company history"
  // default, or any multi-year range) counted vouchers from a period whose
  // movements the reconciliation deliberately drops: unmatched_gl_line_count was
  // inflated by prior-period history, and the bridge below could never close.
  const unlinkedLines = await fetchGLLinesForMatching(
    supabase,
    companyId,
    bankAccount,
    effectiveFrom ?? undefined,
    dateTo
  )

  const difference = Math.round((bankTotal - glPeriodMovement) * 100) / 100

  // The candidate RPCs project neither `currency` nor `amount_in_currency`, so
  // on a foreign account every line resolves to null and there is no sum to
  // report. Deliberately all-or-nothing: a partial sum silently understates the
  // side it is meant to explain. On SEK, ledgerLineAmountIn never returns null,
  // so this is always a number for the 95% case.
  const unmatchedGlAmounts = unlinkedLines.map((line) => ledgerLineAmountIn(line, currency))
  const unmatchedGlLineTotal = unmatchedGlAmounts.some((a) => a === null)
    ? null
    : roundOre(unmatchedGlAmounts.reduce((sum: number, a) => sum + (a ?? 0), 0))

  // difference - unmatched transactions + unmatched vouchers. See the field doc:
  // zero means every krona of the difference is identified and sitting in a list
  // the user can open.
  const unexplainedDifference =
    unmatchedGlLineTotal === null
      ? null
      : roundOre(difference - roundOre(unmatchedTransactionTotal) + unmatchedGlLineTotal)

  const notReconcilableReason =
    unconvertibleLines.length > 0 ? 'gl_lines_missing_currency_amount' : null

  return {
    currency,
    bank_transaction_total: Math.round(bankTotal * 100) / 100,
    bank_transaction_inflow: roundOre(bankInflow),
    bank_transaction_outflow: roundOre(bankOutflow),
    bank_transaction_count: reconcilableTx.length,
    ignored_transaction_total: roundOre(ignoredTotal),
    ignored_transaction_count: ignoredTx.length,
    gl_1930_balance: Math.round(glBalance * 100) / 100,
    gl_1930_period_movement: Math.round(glPeriodMovement * 100) / 100,
    gl_1930_opening_balance: Math.round(glOpeningBalance * 100) / 100,
    gl_1930_correction_adjustment: Math.round(glCorrectionAdjustment * 100) / 100,
    difference,
    // Avstämt requires BOTH sides to hold: the totals agree AND nothing is left
    // unidentified. A zero net difference alone is not a reconciliation, two
    // unmatched transactions that offset each other produce exactly that while
    // both remain unbooked affärshändelser owing a verifikation (BFL 5 kap
    // 1-2 §), and ÅRL 2 kap's individuell värdering / bruttoredovisning
    // forbid treating offset unknowns as knowledge. Unmatched GL lines are
    // deliberately NOT in this condition: unmatched_gl_line_count is scoped and
    // windowed differently (it counts vouchers not settled ON THIS account, so
    // the far leg of an own-account transfer shows up there by design).
    is_reconciled:
      notReconcilableReason === null &&
      Math.abs(difference) < 0.01 &&
      unmatchedTransactionCount === 0,
    matched_count: matchedCount,
    unmatched_transaction_count: unmatchedTransactionCount,
    unmatched_transaction_total: roundOre(unmatchedTransactionTotal),
    unmatched_gl_line_count: unlinkedLines.length,
    unmatched_gl_line_total: unmatchedGlLineTotal,
    unexplained_difference: unexplainedDifference,
    unconvertible_gl_line_count: unconvertibleLines.length,
    not_reconcilable_reason: notReconcilableReason,
  }
}

// ============================================================
// Manual link/unlink
// ============================================================

/**
 * Manually link a transaction to an existing journal entry.
 * Validates that the journal entry has a bank account line and amounts are directionally compatible.
 */
export async function manualLink(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
  journalEntryId: string,
  userId: string,
  accountNumber: string = '1930',
): Promise<{ success: boolean; error?: string }> {
  // Fetch transaction
  const { data: tx, error: txError } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()

  if (txError || !tx) {
    return { success: false, error: 'Transaktionen kunde inte hittas.' }
  }

  // Only a LIVE (posted) pointer blocks re-linking. A transaction still pointing
  // at a 'reversed' entry (storno/correction left the link behind) reads as
  // "utan koppling" in the UI, so it must be re-linkable to another verifikat
  // (issue #988). The stale pointer is overwritten by the locked UPDATE below.
  if (tx.journal_entry_id && (await hasLiveJournalEntryLink(supabase, companyId, tx.journal_entry_id))) {
    return { success: false, error: 'Transaktionen är redan kopplad till en verifikation.' }
  }

  // Fetch journal entry + verify it has a 1930 line
  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .select('id, company_id, status')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .single()

  if (entryError || !entry) {
    return { success: false, error: 'Verifikationen kunde inte hittas.' }
  }

  if (entry.status !== 'posted') {
    return { success: false, error: 'Verifikationen är inte bokförd ännu.' }
  }

  // Defense-in-depth: the transaction must belong to the account being
  // reconciled. A transaction bound to 1930 must not be linked against a 1931
  // voucher even if the caller passes accountNumber=1931. Legacy rows with no
  // cash_account_id fall through (the UI list already gates them by currency).
  //
  // Sibling ledgers of the SAME physical account (rows sharing the IBAN, in
  // the same currency) are additionally accepted for the voucher-line check
  // below: a transaction stranded on an orphaned reconnect row (e.g. 1931)
  // must be linkable to the verifikat booked on the live ledger of that same
  // account (e.g. 1940), issue #1643 problem 1. Unrelated accounts, and the
  // other currency pockets of a multi-currency account (same IBAN, other
  // currency), stay rejected.
  let allowedLineAccounts: string[] = [accountNumber]
  let siblingInfo: CashAccountSiblings | null = null
  if (tx.cash_account_id) {
    const { data: txCa } = await supabase
      .from('cash_accounts')
      .select('ledger_account')
      .eq('id', tx.cash_account_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (txCa?.ledger_account && txCa.ledger_account !== accountNumber) {
      return {
        success: false,
        error: `Transaktionen hör till ${txCa.ledger_account}, inte ${accountNumber}`,
      }
    }
    siblingInfo = await describeCashAccountSiblings(supabase, companyId, tx.cash_account_id)
    if (siblingInfo && siblingInfo.siblings.length > 0) {
      allowedLineAccounts = [
        ...new Set([accountNumber, ...siblingInfo.siblings.map((row) => row.ledger_account)]),
      ]
    }
  }

  // Check for a bank account line on the SELECTED settlement account (or a
  // sibling ledger of the same physical account, see above). The old
  // "any 19xx line" check let a 1930 transaction link to a voucher that only
  // touched 1931: a cross-account link that silently hides a real imbalance.
  const { data: lines } = await supabase
    .from('journal_entry_lines')
    .select('debit_amount, credit_amount, account_number')
    .eq('journal_entry_id', journalEntryId)
    .in('account_number', allowedLineAccounts)

  if (!lines || lines.length === 0) {
    return { success: false, error: `Verifikationen saknar rad på ${allowedLineAccounts.join(' eller ')}` }
  }

  // When the voucher's bank leg sits on a SIBLING ledger only, the row moves
  // to that sibling in the same write that links it: siblings are the same
  // physical account in the same currency, and the voucher is the source of
  // truth for where the money was booked. A cross-account link would leave
  // the money on one ledger while the voucher settles on the other, and the
  // account-keyed reconciliation would count it as an imbalance on BOTH
  // accounts. Same gate as PATCH /api/transactions/[id]/cash-account: the row
  // is unbooked by construction (the locked UPDATE below asserts that). This
  // covers the stranded row linking to the live ledger, two live twins of one
  // connection, and two demoted rows after a full disconnect. The decision
  // is about the DESTINATION: the row moves when the sibling is live, or
  // when its own holder is definitively gone (demoted to manual or revoked)
  // and no other sibling is live either. A row whose connection is merely
  // expired/error/pending is still the syncing account (re-auth renews it in
  // place), so a voucher booked ONLY on a dead sibling is REFUSED (round 4):
  // the voucher is what is wrong, moving the row would strand it on the
  // orphan the moment consent is renewed, and writing the link anyway would
  // be the cross-account link the line check above exists to refuse (the
  // REST and MCP callers reach this directly, without the unmatched-entries
  // filter that hides such vouchers from the dialog). The same rule keeps a
  // live row from being parked on a row no connection can sync again.
  // A voucher touching several sibling ledgers (an old "transfer" between
  // two rows of one physical account) is judged on the best of them, never
  // on whichever line the query happened to return first: a live sibling
  // wins, else the first sibling the row may move to.
  const typedLines = lines as Array<{ account_number: string }>
  let repointCashAccountId: string | null = null
  if (!typedLines.some((line) => line.account_number === accountNumber)) {
    const siblingLedgers = [...new Set(typedLines.map((line) => line.account_number))]
    const candidates = siblingLedgers
      .map((ledger) => siblingInfo?.siblings.find((row) => row.ledger_account === ledger) ?? null)
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .filter((row) => siblingInfo !== null && shouldRepointToSibling(siblingInfo, row))
    const destination = candidates.find((row) => row.live) ?? candidates[0] ?? null
    if (destination) {
      repointCashAccountId = destination.id
    } else {
      log.warn('manualLink: refused a link to a voucher booked only on a dead sibling ledger', {
        companyId,
        transactionId,
        accountNumber,
        siblingLedgers,
      })
      return {
        success: false,
        error: `Verifikationen är bokförd på ${siblingLedgers.join(' och ')}, som inte är transaktionens konto (${accountNumber}). Rätta verifikationen eller flytta transaktionen först.`,
      }
    }
  }

  // N:1 is intentionally allowed: several bank transactions may settle ONE
  // verifikat (a salary run paid out in multiple transfers, a supplier invoice
  // paid in instalments). The voucher's bank line is counted once in the period
  // movement while each transaction sums on the bank side, so correctly-summing
  // links net to zero and any mis-link surfaces as a non-zero difference on the
  // status card: there's no need to forbid a second link here. (A given
  // transaction still can't be double-linked: the tx.journal_entry_id guard
  // above already blocks that.) The candidate list surfaces a voucher already
  // settled on THIS account only when the user opts in via "Visa även matchade
  // verifikationer"; a voucher whose links all sit on another cash account (the
  // second leg of an own-account transfer, issue #1026) surfaces by default,
  // which is exactly the N:1-across-accounts case this permits.

  // Apply link. The write re-checks the pointer we validated inside the write
  // itself (the read above is advisory): null for a free row, or the exact
  // stale 'reversed'-entry id we're detaching from. Locking on the known value
  // lets the stale-pointer overwrite through while a concurrent re-link becomes
  // a no-op (0 rows → the "redan kopplad" branch below). Same optimistic-lock
  // pattern as lib/transactions/link-journal-entry.ts.
  const previousJournalEntryId = (tx.journal_entry_id as string | null) ?? null
  const linkUpdate = supabase
    .from('transactions')
    .update({
      journal_entry_id: journalEntryId,
      reconciliation_method: 'manual' as ReconciliationMethod,
      is_business: true,
      ...(repointCashAccountId ? { cash_account_id: repointCashAccountId } : {}),
    })
    .eq('id', transactionId)
    .eq('company_id', companyId)
  const { data: updatedRows, error: updateError } = await (previousJournalEntryId === null
    ? linkUpdate.is('journal_entry_id', null)
    : linkUpdate.eq('journal_entry_id', previousJournalEntryId)
  ).select('id')

  if (updateError) {
    return { success: false, error: 'Kunde inte koppla transaktionen. Försök igen.' }
  }
  if (!updatedRows || updatedRows.length === 0) {
    return { success: false, error: 'Transaktionen är redan kopplad till en verifikation.' }
  }

  try {
    eventBus.emit({
      type: 'transaction.reconciled',
      payload: {
        transaction: tx as Transaction,
        journalEntryId,
        method: 'manual' as ReconciliationMethod,
        userId,
        companyId,
      },
    })
  } catch {
    // Non-critical
  }

  return { success: true }
}

/**
 * Remove a reconciliation link.
 * Only allowed when reconciliation_method IS NOT NULL (prevents unlinking categorization-created entries).
 */
export async function unlinkReconciliation(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
  userId: string,
): Promise<{ success: boolean; error?: string }> {
  // Fetch transaction
  const { data: tx, error: txError } = await supabase
    .from('transactions')
    .select('id, journal_entry_id, reconciliation_method')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()

  if (txError || !tx) {
    return { success: false, error: 'Transaction not found' }
  }

  if (!tx.journal_entry_id) {
    return { success: false, error: 'Transaction is not linked to any journal entry' }
  }

  if (!tx.reconciliation_method) {
    return { success: false, error: 'Cannot unlink a categorization-created entry. Use storno to reverse it instead.' }
  }

  const { error: updateError } = await supabase
    .from('transactions')
    .update({
      journal_entry_id: null,
      reconciliation_method: null,
      is_business: null,
    })
    .eq('id', transactionId)
    .eq('company_id', companyId)

  if (updateError) {
    return { success: false, error: 'Failed to unlink transaction' }
  }

  // A residual booking (or a bulk-book) anchors the same transaction through
  // transaction_voucher_links as well; "koppla bort" means every anchor goes.
  await supabase
    .from('transaction_voucher_links')
    .delete()
    .eq('company_id', companyId)
    .eq('transaction_id', transactionId)

  logMatchEvent(supabase, userId, transactionId, 'unmatched', {
    previousState: {
      journal_entry_id: tx.journal_entry_id,
      reconciliation_method: tx.reconciliation_method,
    },
  })

  return { success: true }
}

/** Float tolerance for matching a bank line to a verifikat (0.5 öre). */
const VOUCHER_LINK_AMOUNT_TOLERANCE = 0.005

/** A bank line settling a verifikat sits within a few days of the voucher's
 *  entry_date. Kept tight so the single-candidate rule below stays meaningful. */
const VOUCHER_LINK_DATE_WINDOW_DAYS = 7

/** Shift an ISO 'YYYY-MM-DD' date by ±days, returning the same string shape. */
function shiftIsoDate(date: string, days: number): string {
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return date
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

interface CashAccountInfo {
  id: string | null
  currency: string
  isPrimary: boolean
}

/**
 * Reconcile the single unbooked bank transaction that corresponds to a verifikat
 * the user just linked to an invoice from the invoice page: the symmetric move
 * to the transactions-side match, closing the gap where linkInvoiceToVoucher /
 * linkSupplierInvoiceToVoucher advanced the invoice but left the bank line
 * sitting in the Transactions inbox (still journal_entry_id = null).
 *
 * Deliberately conservative: it only acts when the link is unambiguous:
 *   • the voucher has NO bank transaction reconciled to it yet (never adds a
 *     second one automatically: that N:1 case must be an explicit choice in
 *     Bankavstämning),
 *   • the voucher touches exactly ONE cash-account line (a transfer hitting two
 *     bank accounts, or an AR/AP reclass with none, is left alone), and
 *   • exactly ONE unbooked, non-ignored transaction on that account matches the
 *     bank movement (same amount within tolerance, same direction) inside a
 *     tight date window.
 * Anything else is left untouched: the user can still match it by hand from the
 * Transactions list. The link itself uses manualLink (no new journal entry, no
 * JE mutation), so this is a reconciliation link, never a second booking.
 *
 * Best-effort by contract: returns the linked transaction id or null, and the
 * caller treats a throw as "nothing linked" because the invoice link has already
 * committed.
 */
export async function autoReconcileTransactionForLinkedVoucher(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  journalEntryId: string,
  options: {
    invoiceId?: string
    supplierInvoiceId?: string
    dateWindowDays?: number
  } = {},
): Promise<{ linkedTransactionId: string } | null> {
  const windowDays = options.dateWindowDays ?? VOUCHER_LINK_DATE_WINDOW_DAYS

  // 1. If a bank transaction already points at this voucher, the bank side is
  //    settled: don't attach another one behind the user's back.
  const { data: alreadyLinked } = await supabase
    .from('transactions')
    .select('id')
    .eq('company_id', companyId)
    .eq('journal_entry_id', journalEntryId)
    .limit(1)
  if (alreadyLinked && alreadyLinked.length > 0) return null

  // 2. Load the voucher (must be posted) and its lines.
  const { data: entry } = await supabase
    .from('journal_entries')
    .select('id, entry_date, status')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!entry || entry.status !== 'posted' || !entry.entry_date) return null

  // currency + amount_in_currency: this path PERSISTS a reconciliation link, so
  // the bank movement it compares against must be in the cash account's own
  // currency. Without them a 100 EUR voucher leg was compared as its 1150 SEK
  // debit figure, and any unbooked 1150 EUR row on the account looked like the
  // settlement. See ledgerLineAmountIn.
  const { data: lines } = await supabase
    .from('journal_entry_lines')
    .select('account_number, debit_amount, credit_amount, currency, amount_in_currency')
    .eq('journal_entry_id', journalEntryId)
  if (!lines || lines.length === 0) return null

  // 3. Which BAS codes carry a bank feed? cash_accounts is the source of truth.
  const { data: cashAccounts } = await supabase
    .from('cash_accounts')
    .select('id, ledger_account, currency, is_primary')
    .eq('company_id', companyId)

  const cashByAccount = new Map<string, CashAccountInfo>()
  for (const raw of (cashAccounts ?? []) as Array<{
    id: string
    ledger_account: string | null
    currency: string | null
    is_primary: boolean | null
  }>) {
    if (raw.ledger_account) {
      cashByAccount.set(raw.ledger_account, {
        id: raw.id,
        currency: raw.currency ?? 'SEK',
        isPrimary: raw.is_primary ?? false,
      })
    }
  }
  // Companies created before cash_accounts seeding reconcile against 1930/SEK.
  if (cashByAccount.size === 0) {
    cashByAccount.set('1930', { id: null, currency: 'SEK', isPrimary: true })
  }

  const cashLines = (lines as Array<LedgerLineAmount & { account_number: string }>).filter((l) =>
    cashByAccount.has(l.account_number),
  )

  // Exactly one bank movement → exactly one bank transaction to attach.
  if (cashLines.length !== 1) return null

  const cashLine = cashLines[0]
  const accountNumber = cashLine.account_number
  const cashAccount = cashByAccount.get(accountNumber)!
  // + money in, − money out, in the cash account's OWN currency: the same unit
  // as the candidate transactions' `amount` below, which scopeTransactionsToAccount
  // pins to cashAccount.currency. null means the voucher's bank leg carries no
  // amount in that currency, so there is nothing safe to compare: leave it for
  // the user to match by hand rather than persist a guess.
  const movement = ledgerLineAmountIn(cashLine, cashAccount.currency)
  if (movement === null) return null
  if (Math.abs(movement) <= VOUCHER_LINK_AMOUNT_TOLERANCE) return null

  // 4. Unbooked, non-ignored candidate transactions on that account, scoped the
  //    same way Bankavstämning scopes (handles legacy NULL cash_account_id rows).
  const fromDate = shiftIsoDate(entry.entry_date, -windowDays)
  const toDate = shiftIsoDate(entry.entry_date, windowDays)
  let candQuery = supabase
    .from('transactions')
    .select('id, amount')
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .eq('is_ignored', false)
    .gte('date', fromDate)
    .lte('date', toDate)
  candQuery = scopeTransactionsToAccount(
    candQuery,
    cashAccount.id ?? undefined,
    cashAccount.currency,
    cashAccount.isPrimary,
  )
  const { data: candidates } = await candQuery

  const matches = ((candidates ?? []) as Array<{ id: string; amount: number }>).filter((tx) => {
    const amt = Number(tx.amount)
    if (Math.abs(Math.abs(amt) - Math.abs(movement)) > VOUCHER_LINK_AMOUNT_TOLERANCE) return false
    return Math.sign(amt) === Math.sign(movement)
  })

  // Two same-amount unbooked lines near the same date → don't guess.
  if (matches.length !== 1) return null
  const transactionId = matches[0].id

  // 5. Reconcile via the exact path Bankavstämning uses (manualLink re-validates
  //    posted status, the cash-account line, and the not-already-linked guard,
  //    then sets journal_entry_id + reconciliation_method + is_business). No new
  //    journal entry is created.
  const linkResult = await manualLink(
    supabase,
    companyId,
    transactionId,
    journalEntryId,
    userId,
    accountNumber,
  )
  if (!linkResult.success) return null

  // Tag the transaction with the (supplier) invoice for traceability + parity
  // with the transactions-side match. is_business is already set by manualLink,
  // so the row has already dropped out of the inbox regardless of this update.
  const tag: Record<string, unknown> = { potential_invoice_id: null }
  if (options.invoiceId) tag.invoice_id = options.invoiceId
  if (options.supplierInvoiceId) {
    tag.supplier_invoice_id = options.supplierInvoiceId
    tag.potential_supplier_invoice_id = null
  }
  if (Object.keys(tag).length > 1) {
    await supabase
      .from('transactions')
      .update(tag)
      .eq('id', transactionId)
      .eq('company_id', companyId)
  }

  logMatchEvent(supabase, userId, transactionId, 'linked_to_existing_voucher', {
    invoiceId: options.invoiceId,
    supplierInvoiceId: options.supplierInvoiceId,
    matchMethod: 'invoice_voucher_link',
    newState: {
      journal_entry_id: journalEntryId,
      reconciliation_method: 'manual',
    },
  })

  return { linkedTransactionId: transactionId }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Fetch unlinked GL lines for a settlement account. `accountNumber` defaults to
 * '1930' for back-compat; multi-account customers (Plusgiro 1920, kreditkort
 * 1940, EUR-konto 1932, etc.) pass the BAS code of the account they're
 * reconciling. The CashAccountSelector populates this from cash_accounts.
 */
export async function fetchUnlinkedGLLines(
  supabase: SupabaseClient,
  companyId: string,
  accountNumber: string = '1930',
  dateFrom?: string,
  dateTo?: string,
): Promise<UnlinkedGLLine[]> {
  // Paginated: the RPC returns SETOF and is subject to the same silent
  // 1000-row PostgREST cap as table selects; truncation here would hide match
  // candidates and undercount unmatched_gl_line_count. The .order() chain
  // preserves the RPC's chronological order for consumers (the UI table, the
  // picker) while the unique line_id tiebreaker keeps pages stable: several
  // lines of one entry share entry_date/voucher_number. Errors keep the legacy
  // contract: callers get [] rather than a throw.
  try {
    return await fetchAllRows<UnlinkedGLLine>(({ from, to }) =>
      supabase
        .rpc('get_unlinked_gl_lines', {
          p_company_id: companyId,
          p_account_number: accountNumber,
          p_date_from: dateFrom || null,
          p_date_to: dateTo || null,
        })
        .order('entry_date')
        .order('voucher_number')
        .order('line_id')
        .range(from, to),
    )
  } catch {
    return []
  }
}

/**
 * Ids of the given transactions that are anchored to a verifikat through
 * transaction_voucher_links (journal_entry_id NULL on the row itself). Chunked
 * on the id list so a busy window never pushes the .in() past URL limits;
 * a failed read returns the empty set rather than throwing, mirroring
 * fetchUnlinkedGLLines' legacy contract.
 */
export async function fetchJunctionLinkedTxIds(
  supabase: SupabaseClient,
  companyId: string,
  transactionIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>()
  const CHUNK = 150
  for (let i = 0; i < transactionIds.length; i += CHUNK) {
    const chunk = transactionIds.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from('transaction_voucher_links')
      .select('transaction_id')
      .eq('company_id', companyId)
      .in('transaction_id', chunk)
    if (error) return out
    for (const row of (data ?? []) as Array<{ transaction_id: string }>) out.add(row.transaction_id)
  }
  return out
}

/** A match candidate that carries how many transactions already point at it. */
export interface GLLineForMatching extends UnlinkedGLLine {
  /** Transactions settling this entry ON THE REQUESTED ACCOUNT (plus legacy
   *  rows with no cash_account_id, which count everywhere). A transaction on
   *  another cash account, e.g. the outgoing leg of an own-account transfer,
   *  does not mark the voucher as matched here (issue #1026). */
  linked_transaction_count: number
}

/**
 * Fetch GL lines on a settlement account as match candidates. With
 * `includeMatched=false` this returns vouchers not yet settled on the requested
 * account: unlike fetchUnlinkedGLLines, a voucher whose only links are
 * transactions on ANOTHER cash account (the second leg of an own-account
 * transfer) still surfaces, since from this account's perspective it is
 * unmatched (issue #1026). With `includeMatched=true` it also returns vouchers
 * already settled on this account, each carrying `linked_transaction_count`, so
 * a second/third bank transaction can be attached to the same verifikat (N:1,
 * a salary run paid in several transfers, a supplier invoice paid in
 * instalments). Server-only: like the rest of this module it must never reach
 * the client bundle.
 */
export async function fetchGLLinesForMatching(
  supabase: SupabaseClient,
  companyId: string,
  accountNumber: string = '1930',
  dateFrom?: string,
  dateTo?: string,
  includeMatched: boolean = false,
): Promise<GLLineForMatching[]> {
  // Paginated + ordered chronologically with the unique line_id tiebreaker,
  // for the same reasons as fetchUnlinkedGLLines.
  let data: GLLineForMatching[]
  try {
    data = await fetchAllRows<GLLineForMatching>(({ from, to }) =>
      supabase
        .rpc('get_account_gl_lines_for_matching', {
          p_company_id: companyId,
          p_account_number: accountNumber,
          p_date_from: dateFrom || null,
          p_date_to: dateTo || null,
          p_include_matched: includeMatched,
        })
        .order('entry_date')
        .order('voucher_number')
        .order('line_id')
        .range(from, to),
    )
  } catch {
    return []
  }
  // count(*) can arrive as a bigint string over the wire: coerce defensively.
  return data.map((line) => ({
    ...line,
    linked_transaction_count: Number(line.linked_transaction_count) || 0,
  }))
}

/**
 * Check direction compatibility:
 * - Income (tx.amount > 0) matches debit on 1930 (money coming in to bank)
 * - Expense (tx.amount < 0) matches credit on 1930 (money going out of bank)
 */
function isDirectionCompatible(txAmount: number, line: UnlinkedGLLine): boolean {
  if (txAmount > 0 && line.debit_amount > 0) return true
  if (txAmount < 0 && line.credit_amount > 0) return true
  return false
}

/**
 * OCR/reference-number match. Requires a non-trivial reference token (≥4 chars)
 * on the transaction that appears in the GL line/entry description. Description
 * substring matching is intentionally NOT done here: that collided on recurring
 * monthly charges across years (same description, same amount, different year).
 */
function hasOcrReferenceMatch(txReference: string, line: UnlinkedGLLine): boolean {
  if (!txReference || txReference.length < 4) return false
  const lineDesc = (line.line_description || '').toLowerCase()
  const entryDesc = (line.entry_description || '').toLowerCase()
  return lineDesc.includes(txReference) || entryDesc.includes(txReference)
}

/** Check if two dates are within ±dayRange of each other */
function isDateWithinRange(date1: string, date2: string, dayRange: number): boolean {
  const d1 = new Date(date1)
  const d2 = new Date(date2)
  const diffMs = Math.abs(d1.getTime() - d2.getTime())
  const diffDays = diffMs / (1000 * 60 * 60 * 24)
  return diffDays <= dayRange
}

/**
 * Greedy matching: run 4-pass matching, each pass at a specific confidence level.
 * Track used GL lines and transactions to prevent double-matching.
 */
function greedyMatch(
  transactions: Transaction[],
  glLines: UnlinkedGLLine[],
  expectedCurrency: string = 'SEK',
): ReconciliationMatch[] {
  const usedTransactions = new Set<string>()
  const usedGLLines = new Set<string>()
  const allMatches: ReconciliationMatch[] = []

  // Collect all candidate matches with confidence
  const candidates: ReconciliationMatch[] = []

  for (const tx of transactions) {
    if (tx.currency !== expectedCurrency) continue

    for (const line of glLines) {
      const match = tryReconcileTransaction(tx, [line], expectedCurrency)
      if (match) {
        candidates.push(match)
      }
    }
  }

  // Sort by confidence descending, then by date proximity
  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence
    // Prefer closer dates
    const dateDistA = Math.abs(
      new Date(a.transaction.date).getTime() - new Date(a.glLine.entry_date).getTime()
    )
    const dateDistB = Math.abs(
      new Date(b.transaction.date).getTime() - new Date(b.glLine.entry_date).getTime()
    )
    return dateDistA - dateDistB
  })

  // Greedily assign matches
  for (const candidate of candidates) {
    const txId = candidate.transaction.id
    const lineId = candidate.glLine.line_id

    if (usedTransactions.has(txId) || usedGLLines.has(lineId)) continue

    usedTransactions.add(txId)
    usedGLLines.add(lineId)
    allMatches.push(candidate)
  }

  return allMatches
}
