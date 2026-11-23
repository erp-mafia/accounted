import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import type { Transaction, ReconciliationMethod } from '@/types'
import { eventBus } from '@/lib/events/bus'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { descriptionMentionsReference, normalizeOcrReference } from '@/lib/invariants/reference-number'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { dbError } from '@/lib/errors/db-error'
import {
  hasLiveJournalEntryLink,
  isBankMovementEntry,
  prepareBankLink,
  writeBankLink,
  type BankLinkRefusalCode,
} from '@/lib/transactions/bank-link'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import { holdersOnAccount, readBankLegHolders, type BankLegHolder } from '@/lib/transactions/voucher-bank-leg'
import {
  ledgerLineAmountIn,
  type LedgerLineAmount,
} from '@/lib/bookkeeping/ledger-line-amount'
import { createLogger } from '@/lib/logger'
import { chunk } from '@/lib/utils'
import { mapWithConcurrency } from '@/lib/concurrency'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import { resolveLedgerSettlements } from './ledger-settlement-store'
import { findOpeningBalanceFloor, sumAccountBalance } from './gl-balance'
import { ID_READ_CHUNK, MAX_BANK_ROW_SPLIT } from './limits'
import { DEFAULT_SETTLEMENT_ACCOUNT } from './cash-account-scope'
import { linkBasisForReconciliationMethod, type LinkEvidence } from '@/lib/links/link-basis'
import { linkBasisColumns, type LinkBasisInput } from '@/lib/links/stamp'
import { learnFromBankLink, learnFromBankLinks, type BankLinkToLearn } from '@/lib/transactions/link-learning'

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
  /** Set (on every line of the verifikat) when 1:N bank_line slices on this
   *  SEK account settle part of the verifikat: its net on the account minus
   *  those slices, debit positive, in SEK (20261006121002). Null when the
   *  verifikat has no junction link, so its lines are the open amount. See
   *  {@link openAmountByEntry}. */
  remaining_amount?: number | string | null
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

/**
 * How many days a bank row may lie from a verifikat's date and still be
 * proposed on amount alone (auto_date_range). A caller that runs the matcher
 * for one verifikat reads its window from here, so the window is the reach of
 * the rule and never a second number.
 */
export const MATCH_DATE_RANGE_DAYS = 3

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
  /** Ledger movement on the bank account excluding opening_balance: i.e.
   *  the ledger balance minus IB, less the verifikat dated before the bank's
   *  history (before_history_total, see history_start). Storno/correction
   *  lines ARE included here (they're part of the balance), so a corrected
   *  bank line reconciles against its re-pointed feed transaction. This is
   *  what `difference` compares against. */
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
   * Verifikat in the window that are settled against verifikat dated OUTSIDE
   * it (a wrong verifikat whose hand-made rättelse was booked the month
   * after, lib/reconciliation/ledger-settlement.ts). They are explained, so
   * they are not in `unmatched_gl_line_count`, but their amounts do not net to
   * zero inside the window. A settlement that lies wholly inside the window
   * counts nowhere: its verifikat take each other out.
   */
  settled_gl_entry_count: number
  /** Sum of those verifikat on the account, signed like a bank movement. Zero
   *  when no settlement crosses the window's edge. */
  settled_gl_line_total: number
  /**
   * What is left of `difference` once both work lists are accounted for:
   * `difference - unmatched_transaction_total + unmatched_gl_line_total +
   * settled_gl_line_total`. Settling verifikat never moves this figure: it
   * only moves their amounts from the second term to the third.
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
   * and excludes storno outright, so an unlinked storno moves this account's
   * movement while staying invisible in "Omatchade verifikationer".
   * Measured 2026-08-20 over 206 single-1930-account ledgers with
   * >=10 transactions: 136 reconcile to exactly 0,00, 63 land >=100 kr out, and
   * the unlinked-hidden-line buckets behind that are posted/storno (127
   * companies), reversed/bank_transaction (66) and posted/correction (49). The
   * correction bucket is gone since 20260923150000: an unlinked rättelse is the
   * live booking of a bank movement and is now listed (and matchable).
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
  /**
   * The first day the bank side covers on this account: the date of its
   * earliest bank row (feed, imported bank file or created row, ignored rows
   * included), whatever the window. Null when the account has no rows.
   * Importing older history as a bank file moves it earlier by itself.
   */
  history_start: string | null
  /**
   * Verifikat on the account dated inside the window but before
   * history_start that no bank row is linked to (crm#1221): bokfört före
   * bankens historik. The bank has nothing to compare them with, so they are
   * outside `difference`, the unmatched counts and `unexplained_difference`,
   * and the comparison starts at history_start (see splitBeforeBankHistory).
   * 0 when history_start is not inside the window.
   */
  before_history_count: number
  /** Their open amounts on the account, signed like a bank movement. 0 when none. */
  before_history_total: number
  /**
   * The ledger balance on the account just before the comparison starts:
   * the opening balance plus the verifikat before the bank's history.
   * Verifikat dated before history_start that a bank row is linked to belong
   * to the comparison, as on the skattekonto. Null without a split, or when
   * the balance before the window cannot be read.
   */
  ledger_balance_before_start: number | null
  /**
   * The bank's own saldo when its history starts: the balance it last
   * reported less every non-ignored bank row up to that day. Null without a
   * split, or when the bank reports no balance (a file-fed account).
   */
  saldo_at_start: number | null
  /**
   * saldo_at_start - ledger_balance_before_start: whether the books before
   * the bank's history end where the bank starts. Informational, shown once:
   * it is in neither `difference` nor `is_reconciled`, because the reported
   * balance is a point-in-time figure (the same reason the bank block keeps
   * it out of external_balance, lib/reconciliation/service.ts). Null when
   * either side is unknown.
   */
  opening_difference: number | null
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
   * Keep only the matches of these verifikat, and of those only the ones
   * nothing rivals. The matcher still runs over every open row and every
   * unlinked verifikat in the window; the filter comes after it. A named
   * verifikat then keeps its row only when no other open row fits its line
   * as well and no other unlinked verifikat fits that row as well
   * (isUnrivalledMatch): a sweep over a whole history may pair equal rows in
   * ledger order, a run for one verifikat a person just posted never guesses
   * which of two rows, or which of two verifikat, was meant. For the run a
   * door makes when it posts one typed verifikat
   * (lib/reconciliation/voucher-bank-link.ts).
   */
  onlyJournalEntryIds?: readonly string[]
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
  assertTransactionScope(cashAccountId, currency)
  if (cashAccountId) {
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
 * The shape check scopeTransactionsToAccount makes before it builds a filter,
 * shared with the reads that pass the same scope to an RPC: an ISO currency
 * code and, when given, a UUID cash account id.
 */
export function assertTransactionScope(cashAccountId: string | undefined, currency: string): void {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`scopeTransactionsToAccount: invalid currency ${JSON.stringify(currency)}`)
  }
  if (cashAccountId && !/^[0-9a-fA-F-]{36}$/.test(cashAccountId)) {
    throw new Error('scopeTransactionsToAccount: invalid cashAccountId (expected UUID)')
  }
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
  logIfUnscopedAcrossCashAccounts(operation, distinct.size, ctx)
}

/** The warning above, from a count of distinct cash accounts the read already made. */
function logIfUnscopedAcrossCashAccounts(
  operation: string,
  distinctCashAccounts: number,
  ctx: {
    cashAccountId: string | undefined
    companyId: string
    accountNumber: string
    currency: string
  },
): void {
  if (ctx.cashAccountId) return
  if (distinctCashAccounts <= 1) return
  log.warn(`${operation} ran unscoped across several cash accounts`, {
    companyId: ctx.companyId,
    operation,
    entityType: 'cash_account',
    details: {
      accountNumber: ctx.accountNumber,
      currency: ctx.currency,
      distinctCashAccounts,
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
    const dateWithinRange = isDateWithinRange(txDate, line.entry_date, MATCH_DATE_RANGE_DAYS)
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
    accountNumber = DEFAULT_SETTLEMENT_ACCOUNT,
    currency = 'SEK',
    cashAccountId,
    includeUnassigned = true,
    applyOnly,
    onlyJournalEntryIds,
    confidenceThreshold,
    persistSuggestions = false,
  } = options

  // Fetch unlinked GL lines via RPC. A partially allocated verifikat (1:N
  // slices settle part of it, remaining_amount set) is listed for the user,
  // never auto-linked: its lines carry the full amount, not the open part.
  // A verifikat labelled opening_balance off a year start is listed too, but
  // no link may name it (isBankMovementEntry), so it is no match candidate.
  const glLines = (await fetchUnlinkedGLLines(supabase, companyId, accountNumber, dateFrom, dateTo)).filter(
    (line) => line.remaining_amount == null && isBankMovementEntry(line),
  )

  // Fetch unmatched transactions, scoped to the selected cash account.
  // Paginated: a busy company can exceed PostgREST's silent 1000-row cap, which
  // would make the matcher skip transactions without any signal. Ordered on id
  // (unique) so pages never duplicate or skip rows. Open work only: a pointer
  // written on a row booked through a link would anchor it to a second
  // verifikat, unattended on the nightly sweep. The pointer filter stays for the
  // write below, whose compare-and-set takes a free row: a stale pointer waits
  // for a person.
  const transactions = await fetchAllRows<Transaction>(({ from, to }) => {
    let query = supabase
      .from('open_bank_rows')
      .select('*')
      .eq('company_id', companyId)
      .is('journal_entry_id', null)
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

  // A verifikat settled against another verifikat (a wrong booking and its
  // hand-made rättelse, crm#1074) is explained already: the matcher must not
  // hand it to a bank row that happens to carry the same amount.
  const settlements = await resolveLedgerSettlements(
    supabase,
    companyId,
    accountNumber,
    openAmountByEntry(glLines, currency),
    async (from, to) =>
      openAmountByEntry(await fetchUnlinkedGLLines(supabase, companyId, accountNumber, from, to), currency),
  )
  const candidateLines = glLines.filter((line) => !settlements.settled.has(line.journal_entry_id))

  // Run greedy matching, highest confidence first
  let matches = greedyMatch(transactions, candidateLines, currency)

  // A run for named verifikat keeps their matches only, after the full run
  // has assigned every row, and none that a row or a verifikat rivals: see
  // onlyJournalEntryIds.
  if (onlyJournalEntryIds) {
    const wanted = new Set(onlyJournalEntryIds)
    matches = matches.filter(
      (m) => wanted.has(m.glLine.journal_entry_id) && isUnrivalledMatch(m, transactions, candidateLines, currency),
    )
  }

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
  const appliedLinks: BankLinkToLearn[] = []

  for (const match of toApply) {
    try {
      // .is('journal_entry_id', null) is an optimistic-lock guard: if a
      // concurrent user (or another surface) linked this transaction between
      // the read above and this write, the update matches zero rows instead of
      // silently re-pointing an existing link. Same pattern as
      // lib/transactions/link-journal-entry.ts.
      // The matcher chose the pair, unless the caller reviewed a dry run and
      // ticked it (applyOnly): then a person confirmed it and the matcher is
      // the evidence.
      const evidence: LinkEvidence = {
        rule_id: match.method,
        score: match.confidence,
        ...(match.method === 'auto_reference' && match.transaction.reference
          ? { reference: String(match.transaction.reference).slice(0, 200) }
          : {}),
      }
      const { data: updatedRows, error } = await supabase
        .from('transactions')
        .update({
          journal_entry_id: match.glLine.journal_entry_id,
          reconciliation_method: match.method,
          is_business: true,
          ...linkBasisColumns(applyOnly ? 'user_confirmed' : linkBasisForReconciliationMethod(match.method), evidence),
        })
        .eq('id', match.transaction.id)
        .eq('company_id', companyId)
        .is('journal_entry_id', null)
        .select('id')

      if (error || !updatedRows || updatedRows.length === 0) {
        errors++
      } else {
        applied++
        appliedLinks.push({ transactionId: match.transaction.id, journalEntryId: match.glLine.journal_entry_id })
        // Behandlingshistorik (BFNAR 2013:2 kap 8, BFL 7:1): every auto-applied
        // link is a match event and must land in the append-only log, exactly
        // like the invoice-match and confirm-suggestion paths. The bus event
        // below goes to event_log, which is NOT an audit record.
        await logMatchEvent(supabase, userId, match.transaction.id, 'matched', {
          matchConfidence: match.confidence,
          matchMethod: match.method,
          newState: {
            journal_entry_id: match.glLine.journal_entry_id,
            reconciliation_method: match.method,
          },
        })
        try {
          await eventBus.emit({
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

  // The applied links teach their bank texts (crm#1746), in one batch. The
  // matcher chose every pair, a reviewed and ticked dry run included, so a
  // text is learned only once it repeats. Never fails the run.
  await learnFromBankLinks(supabase, companyId, appliedLinks, 'automatic')

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
  bankAccount = DEFAULT_SETTLEMENT_ACCOUNT,
  currency: string = 'SEK',
  cashAccountId?: string,
  includeUnassigned: boolean = true,
): Promise<ReconciliationStatus> {
  // One read answers every set the status is built from (the bank rows of
  // the window aligned to their verifikat, the ledger sums, the opening
  // balance floor, the bank's history and the ledger-only verifikat): see
  // get_bank_reconciliation_facts (20261023094100). It used to page every
  // bank row and every ledger line of the window through PostgREST, which
  // took seconds for a busy year; the rules below are the same ones, and the
  // comments on each figure say what it counts.
  assertTransactionScope(cashAccountId, currency)
  const facts = await fetchBankReconciliationFacts(supabase, {
    companyId,
    bankAccount,
    currency,
    cashAccountId,
    includeUnassigned,
    dateFrom: dateFrom ?? null,
    dateTo: dateTo ?? null,
  })

  logIfUnscopedAcrossCashAccounts('getReconciliationStatus', facts.read_window_cash_accounts ?? 0, {
    cashAccountId,
    companyId,
    accountNumber: bankAccount,
    currency,
  })

  // The ledger side counts posted AND reversed entries TOGETHER: the exact
  // inclusion rule the trial balance and balance sheet use (see
  // lib/reports/trial-balance.ts, which sums `['posted','reversed']`). A
  // reversed original stays in the ledger and is cancelled by its storno, so
  // both legs must be summed; counting only the storno would leave a dangling
  // half-correction. Using the identical rule here is what guarantees
  // gl_1930_balance can never disagree with the balansräkning for this
  // account. Every ledger figure is resolved in the ACCOUNT's own currency,
  // the same unit the bank side is in (ledgerLineAmountIn): on SEK it is
  // debit - credit; on a foreign account the line's amount_in_currency, and a
  // line with no amount in that currency is counted in
  // unconvertible_line_count instead of contributing zero.
  //
  // The window is floored at the most recent POSTED opening balance on this
  // account (issue #751): everything dated before that IB is prior history
  // the IB entry already summarises. effectiveFrom is the later of the
  // caller's dateFrom and that IB date; it only ever RAISES the lower bound.
  // A stornerad IB (status 'reversed') is no floor: both of its lines stay in
  // the balance and cancel there, as on the balansräkning (same rule as
  // compute_prior_opening_balances, 20260421180000).
  const ibFloor = facts.ib_floor
  const effectiveFrom = facts.effective_from

  // The ledger-only verifikat on the account over the floored window, from
  // get_account_gl_lines_for_matching (RPC excludes the storno and an
  // opening_balance verifikat on a fiscal year's first day, the IB; one
  // labelled so on any other day is ledger-only since 20261122160000;
  // posted correction vouchers are candidates since 20260923150000,
  // a linked one drops out through its link like any other voucher).
  // Account-scoped since 20260723160000: a voucher whose links all sit on
  // another cash account (a transfer's other leg) counts as unmatched HERE,
  // keeping this number in agreement with the "Omatchade verifikationer"
  // table. Direction-aware since 20260828220000 for the NULL-cash_account
  // shape of an own-account transfer. effectiveFrom, NOT the caller's
  // dateFrom: the counted lines and rows are clamped to the IB floor, and
  // this list has to describe the SAME window or the card contradicts itself.
  const unlinkedLines: GLLineForMatching[] = facts.candidates.map((line) => ({
    ...line,
    // count(*) can arrive as a bigint string over the wire: coerce defensively.
    linked_transaction_count: Number(line.linked_transaction_count) || 0,
  }))

  // Verifikat settled against each other (a wrong verifikat and the rättelse
  // booked by hand, crm#1074) are explained, not open work. A settlement is
  // honoured only while it still holds (see ledger-settlement-store.ts), and
  // its verifikat move from one explained term of the bridge to another,
  // never out of it.
  const openByEntry = openAmountByEntry(unlinkedLines, currency)
  const settlements = await resolveLedgerSettlements(
    supabase,
    companyId,
    bankAccount,
    openByEntry,
    async (from, to) =>
      openAmountByEntry(await fetchGLLinesForMatching(supabase, companyId, bankAccount, from, to), currency),
  )

  // The bank's history (crm#1221): the first day the bank side covers on this
  // account, ignored rows included. A company that imported its books and
  // then connected the bank has verifikat on the account from before that
  // day: the bank has no row for them, so they move out of the comparison,
  // which then starts at history_start, the model the skattekonto has
  // (skattekonto-reconciliation.ts).
  const historyStart = facts.bank.history_start
  const beforeHistory = splitBeforeBankHistory({
    historyStart,
    windowFrom: effectiveFrom,
    windowTo: dateTo ?? null,
    lines: unlinkedLines,
    openByEntry,
    settledEntryIds: new Set(settlements.settled.keys()),
    // A foreign account's candidate lines carry no amount in its currency:
    // the read answers each candidate verifikat's own amount on the account.
    // On SEK the candidate lines are all of the verifikat's lines on it.
    entryAmount: (entryId) => {
      if (facts.entry_amounts) {
        const amount = facts.entry_amounts[entryId]
        return amount === null ? null : roundOre(Number(amount ?? 0))
      }
      let sum = 0
      for (const line of unlinkedLines) {
        if (line.journal_entry_id !== entryId) continue
        const amount = ledgerLineAmountIn(line, currency)
        if (amount === null) return null
        sum += amount
      }
      return roundOre(sum)
    },
  })
  const beforeHistoryTotal = beforeHistory.total
  const openLines = unlinkedLines.filter(
    (line) => !settlements.settled.has(line.journal_entry_id) && !beforeHistory.entryIds.has(line.journal_entry_id),
  )

  // Bank side: every NON-IGNORED bank row of the (floored) window. An
  // unlinked row counts on its own date, a linked row on the date of the
  // latest live verifikat with a line on the account that it is linked to,
  // through its pointer or transaction_voucher_links (so each row lands in
  // exactly one window): windowing each half of a linked pair on its own
  // date split a deposit dated before the first fiscal year from the
  // verifikat that books it inside the year. Rows linked to a reversed entry are not special-cased:
  // the ledger side counts the reversed original, its storno AND the
  // correction together, so a corrected bank line nets to its true amount on
  // both sides. Ignored rows (feed duplicates, non-business noise) are
  // EXCLUDED from the total, exactly as from the unmatched count, and
  // surfaced separately (count + sum), like the opening balance.
  // Matched/unmatched partition the reconcilable rows: a row is matched by
  // its pointer or through transaction_voucher_links (bulk-booked
  // samlingsverifikat, residual bookings), is_transaction_booked()'s rule.
  const bankTotal = Number(facts.bank.total)
  const ignoredTotal = Number(facts.bank.ignored_total)
  const bankInflow = Number(facts.bank.inflow)
  const bankOutflow = Number(facts.bank.outflow)
  const matchedCount = Number(facts.bank.matched_count)
  const unmatchedTransactionCount = Number(facts.bank.unmatched_count)
  const unmatchedTransactionTotal = Number(facts.bank.unmatched_total)

  // gl_1930_balance: the real ledger balance on this account incl. IB,
  // byte-for-byte the figure the balansräkning / saldobalans report. The IB
  // (posted IB lines only) is surfaced separately and excluded from the
  // period movement. Storno/correction activity is surfaced for transparency
  // ONLY: it is part of the ledger balance and is INCLUDED in the movement,
  // never subtracted.
  const glBalance = Number(facts.gl.balance)
  const glOpeningBalance = Number(facts.gl.opening_balance)
  const glCorrectionAdjustment = Number(facts.gl.correction_adjustment)
  const unconvertibleLineCount = Number(facts.gl.unconvertible_line_count)
  // Period movement = the ledger balance minus the opening balance, less the
  // verifikat before the bank's history (beforeHistoryTotal, 0 without a
  // split).
  const glPeriodMovement = glBalance - glOpeningBalance - beforeHistoryTotal

  const difference = Math.round((bankTotal - glPeriodMovement) * 100) / 100

  // The candidate RPCs project neither `currency` nor `amount_in_currency`, so
  // on a foreign account every line resolves to null and there is no sum to
  // report. Deliberately all-or-nothing: a partial sum silently understates the
  // side it is meant to explain. On SEK, ledgerLineAmountIn never returns null,
  // so this is always a number for the 95% case. Per verifikat: a partially
  // allocated one counts only the remainder its 1:N slices leave open.
  // Summed over EVERY ledger-only verifikat, settled or not, exactly as before
  // settlements existed: this is the figure the unexplained difference is
  // built from, so settling verifikat cannot move it.
  const ledgerOnlyAmounts = [...openByEntry.values()]
  const ledgerOnlyTotal = ledgerOnlyAmounts.some((a) => a === null)
    ? null
    : roundOre(ledgerOnlyAmounts.reduce((sum: number, a) => sum + (a ?? 0), 0))
  // The settled verifikat whose counterpart lies outside the window: their
  // amounts stay in the period's difference and are carried on their own line.
  const settledOutside = [...settlements.settled.values()].filter((entry) => entry.outside_window)
  const settledGlLineTotal = roundOre(settledOutside.reduce((sum, entry) => sum + entry.amount, 0))
  // The verifikat before the bank's history left the movement above, so they
  // leave the ledger-only total here too: the unexplained difference is the
  // same figure with or without the split.
  const ledgerOnlyInHistory = ledgerOnlyTotal === null ? null : roundOre(ledgerOnlyTotal - beforeHistoryTotal)
  const unmatchedGlLineTotal =
    ledgerOnlyInHistory === null ? null : roundOre(ledgerOnlyInHistory - settledGlLineTotal)

  // difference - unmatched transactions + ledger-only vouchers (unmatched plus
  // settled). See the field doc: zero means every krona of the difference is
  // identified and sitting in a list the user can open.
  const unexplainedDifference =
    ledgerOnlyInHistory === null
      ? null
      : roundOre(difference - roundOre(unmatchedTransactionTotal) + ledgerOnlyInHistory)

  // Where the books before the bank's history end against where the bank
  // starts: shown once, outside the bridge (see opening_difference).
  const opening = beforeHistory.splitAt
    ? await bankOpeningComparison({
        supabase,
        companyId,
        bankAccount,
        currency,
        cashAccountId,
        historyStart: beforeHistory.splitAt,
        windowFrom: effectiveFrom,
        ibFloor,
        openingBalanceInWindow: roundOre(glOpeningBalance),
        beforeHistoryTotal,
        saldo: facts.saldo,
      })
    : { ledger_balance_before_start: null, saldo_at_start: null, opening_difference: null }

  const notReconcilableReason =
    unconvertibleLineCount > 0 ? 'gl_lines_missing_currency_amount' : null

  return {
    currency,
    bank_transaction_total: Math.round(bankTotal * 100) / 100,
    bank_transaction_inflow: roundOre(bankInflow),
    bank_transaction_outflow: roundOre(bankOutflow),
    bank_transaction_count: Number(facts.bank.count),
    ignored_transaction_total: roundOre(ignoredTotal),
    ignored_transaction_count: Number(facts.bank.ignored_count),
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
    unmatched_gl_line_count: openLines.length,
    unmatched_gl_line_total: unmatchedGlLineTotal,
    settled_gl_entry_count: settledOutside.length,
    settled_gl_line_total: settledGlLineTotal,
    unexplained_difference: unexplainedDifference,
    unconvertible_gl_line_count: unconvertibleLineCount,
    not_reconcilable_reason: notReconcilableReason,
    history_start: historyStart,
    before_history_count: beforeHistory.entryIds.size,
    before_history_total: beforeHistoryTotal,
    ...opening,
  }
}

/** The saldo inputs get_bank_reconciliation_facts reads off the cash account. */
interface BankSaldoFacts {
  balance: number | string | null
  balance_updated_at: string | null
  /** balance_updated_at as a Stockholm calendar date. */
  balance_date: string | null
  /** Non-ignored bank rows from the window's start through balance_date. */
  rows_total: number | string | null
}

/** What get_bank_reconciliation_facts answers for one account and window. */
interface BankReconciliationFacts {
  ib_floor: string | null
  effective_from: string | null
  gl: {
    balance: number | string
    opening_balance: number | string
    correction_adjustment: number | string
    unconvertible_line_count: number | string
  }
  bank: {
    count: number | string
    total: number | string
    inflow: number | string
    outflow: number | string
    ignored_count: number | string
    ignored_total: number | string
    matched_count: number | string
    unmatched_count: number | string
    unmatched_total: number | string
    history_start: string | null
  }
  /** Distinct cash accounts among the rows read on their own date; set only on an unscoped call. */
  read_window_cash_accounts: number | null
  saldo: BankSaldoFacts | null
  candidates: GLLineForMatching[]
  /** Per candidate verifikat, its amount in the account's currency (null: not expressible). Foreign accounts only. */
  entry_amounts: Record<string, number | string | null> | null
}

async function fetchBankReconciliationFacts(
  supabase: SupabaseClient,
  input: {
    companyId: string
    bankAccount: string
    currency: string
    cashAccountId: string | undefined
    includeUnassigned: boolean
    dateFrom: string | null
    dateTo: string | null
  },
): Promise<BankReconciliationFacts> {
  const { data, error } = await supabase.rpc('get_bank_reconciliation_facts', {
    p_company_id: input.companyId,
    p_account_number: input.bankAccount,
    p_currency: input.currency,
    p_cash_account_id: input.cashAccountId ?? null,
    // Only an account-scoped read can claim or refuse unassigned rows.
    p_include_unassigned: input.includeUnassigned,
    p_date_from: input.dateFrom || null,
    p_date_to: input.dateTo || null,
  })
  if (error) throw dbError(error, null)
  const facts = data as BankReconciliationFacts | null
  if (!facts || !facts.gl || !facts.bank) {
    throw new Error('get_bank_reconciliation_facts returned no answer')
  }
  return { ...facts, candidates: facts.candidates ?? [] }
}

// ============================================================
// The bank's history (crm#1221)
// ============================================================

export interface BankHistorySplit {
  /** history_start when it lies inside the window: the comparison starts there. Null otherwise. */
  splitAt: string | null
  /** The verifikat dated before splitAt that no bank row is linked to and no settlement explains. */
  entryIds: Set<string>
  /** Their open amounts on the account, signed like a bank movement. 0 without a split. */
  total: number
}

/**
 * Which ledger-only verifikat lie before the bank's history.
 *
 * Only when history_start falls inside the window (after its lower bound,
 * on or before its end): a window that already starts inside the history
 * has nothing before it, and a window that ends before the history has no
 * bank side at all, so its verifikat stay listed as missing on the bank,
 * the true state of a period no bank row covers.
 *
 * A verifikat before history_start that a bank row is linked to stays in
 * the comparison with its row (a payment booked the day before the first
 * bank row), and so does one a ledger-only settlement explains: only open
 * verifikat move, at their open amount. An amount the account's currency
 * cannot express leaves the whole window in the comparison.
 */
export function splitBeforeBankHistory(input: {
  historyStart: string | null
  windowFrom: string | null
  windowTo: string | null
  lines: Array<Pick<UnlinkedGLLine, 'journal_entry_id' | 'entry_date'>>
  openByEntry: Map<string, number | null>
  settledEntryIds: Set<string>
  /** The verifikat's amount on the account from the counted lines, for an open amount that is null. */
  entryAmount: (entryId: string) => number | null
}): BankHistorySplit {
  const none: BankHistorySplit = { splitAt: null, entryIds: new Set(), total: 0 }
  const { historyStart, windowFrom, windowTo } = input
  if (!historyStart) return none
  if (windowFrom && historyStart <= windowFrom) return none
  if (windowTo && historyStart > windowTo) return none
  const entryIds = new Set<string>()
  for (const line of input.lines) {
    if (line.entry_date >= historyStart || input.settledEntryIds.has(line.journal_entry_id)) continue
    entryIds.add(line.journal_entry_id)
  }
  let total = 0
  for (const id of entryIds) {
    const amount = input.openByEntry.get(id) ?? input.entryAmount(id)
    if (amount === null || amount === undefined) return none
    total += amount
  }
  return { splitAt: historyStart, entryIds, total: roundOre(total) }
}

type OpeningComparison = Pick<
  ReconciliationStatus,
  'ledger_balance_before_start' | 'saldo_at_start' | 'opening_difference'
>

/**
 * The ledger balance on the account before the window starts. 0 when the
 * window has no lower bound (the counted lines are all history) or starts at
 * the account's opening balance (the IB restates everything before it).
 * Otherwise read from the latest IB before the window, SEK only (a foreign
 * account's earlier lines are not summed in its currency here). Null when
 * that read fails or does not apply.
 */
async function ledgerBalanceBeforeWindow(input: {
  supabase: SupabaseClient
  companyId: string
  bankAccount: string
  currency: string
  windowFrom: string | null
  ibFloor: string | null
}): Promise<number | null> {
  const { supabase, companyId, bankAccount, windowFrom, ibFloor } = input
  if (!windowFrom || windowFrom === ibFloor) return 0
  if (input.currency !== 'SEK') return null
  const floor = await findOpeningBalanceFloor(supabase, companyId, bankAccount, addDaysIso(windowFrom, -1))
  return sumAccountBalance(supabase, companyId, bankAccount, {
    ...(floor ? { fromDate: floor.date } : {}),
    beforeDate: windowFrom,
  })
}

/**
 * The bank's saldo when its history starts: the balance it last reported
 * (cash_accounts.balance, dated by balance_updated_at) less every non-ignored
 * bank row from the window's start through that day. Every row is on or
 * after history_start, so what remains is the saldo before the first one.
 * The status read already summed those rows (saldo.rows_total, through the
 * Stockholm date of balance_updated_at). Null when the account reports no
 * balance or the balance is older than the history itself.
 */
function bankSaldoAtStart(input: {
  cashAccountId: string | undefined
  historyStart: string
  saldo: BankSaldoFacts | null
}): number | null {
  const { cashAccountId, historyStart, saldo } = input
  if (!cashAccountId || !saldo) return null
  const balance = saldo.balance == null ? Number.NaN : Number(saldo.balance)
  const at = saldo.balance_updated_at ? new Date(saldo.balance_updated_at) : null
  if (!Number.isFinite(balance) || !at || Number.isNaN(at.getTime())) return null
  const balanceDate = todayIsoStockholm(at)
  if (balanceDate < historyStart) return null
  // The rows were summed through the database's own Stockholm date of the
  // same timestamp; both read the IANA zone, so a mismatch means a broken
  // read rather than a rule: no saldo then, never a guess.
  if (saldo.balance_date !== balanceDate || saldo.rows_total == null) return null
  return roundOre(balance - Number(saldo.rows_total))
}

/**
 * Where the books before the bank's history end against where the bank
 * starts (opening_difference). The ledger side is the balance just before
 * the comparison: what stood before the window, the opening balance in it,
 * and the verifikat that moved out of the comparison. Never throws: a read
 * that fails leaves its side unknown.
 */
async function bankOpeningComparison(input: {
  supabase: SupabaseClient
  companyId: string
  bankAccount: string
  currency: string
  cashAccountId: string | undefined
  historyStart: string
  windowFrom: string | null
  ibFloor: string | null
  openingBalanceInWindow: number
  beforeHistoryTotal: number
  saldo: BankSaldoFacts | null
}): Promise<OpeningComparison> {
  let before: number | null
  try {
    before = await ledgerBalanceBeforeWindow(input)
  } catch (err) {
    log.warn('bank opening comparison: ledger balance read failed', {
      companyId: input.companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    before = null
  }
  const ledgerBalanceBeforeStart =
    before === null ? null : roundOre(before + input.openingBalanceInWindow + input.beforeHistoryTotal)
  const saldoAtStart = bankSaldoAtStart(input)
  return {
    ledger_balance_before_start: ledgerBalanceBeforeStart,
    saldo_at_start: saldoAtStart,
    opening_difference:
      saldoAtStart === null || ledgerBalanceBeforeStart === null
        ? null
        : roundOre(saldoAtStart - ledgerBalanceBeforeStart),
  }
}

// ============================================================
// Manual link/unlink
// ============================================================

/**
 * Why manualLink or linkTransactionToVouchers refused: the one code set of
 * the bank link core (lib/transactions/bank-link.ts).
 */
export type { BankLinkRefusalCode }

function refused(code: BankLinkRefusalCode, error: string): { success: false; error: string; code: BankLinkRefusalCode } {
  return { success: false, error, code }
}

/**
 * Why the bank-anchor guards refused a link, per raised name, in words that
 * say what to change: none of them goes away on a retry.
 */
const BANK_ANCHOR_REASON: Record<string, string> = {
  // 20261006121001: a verifikat does not book its amount (a slice: its own
  // slice) on the bank ledger in that direction.
  BANK_ANCHOR_SETTLEMENT_CHANGED:
    'Kopplingen nekades: verifikationen bokför inte beloppet på bankkontot åt samma håll som transaktionen, eller vid en delning som sin del av den. Ett uttag ska stå i kredit på bankkontot och en insättning i debet.',
  // 20261006121004: slices against the row's direction that do not add up to it.
  BANK_ANCHOR_SPLIT_UNBALANCED:
    'Kopplingen nekades: transaktionen fördelas på verifikationer i båda riktningar, och delarna blir inte tillsammans transaktionens belopp. Fördela hela beloppet, så att delarna summerar till transaktionen.',
  // The row's cash account is gone, or no longer in the row's currency.
  BANK_ANCHOR_CASH_ACCOUNT_CHANGED:
    'Kopplingen nekades: transaktionens bankkonto finns inte längre, eller har en annan valuta än transaktionen. Flytta transaktionen till rätt bankkonto innan du kopplar den.',
  // The link would move the row to another cash account, but it is already
  // anchored where it is.
  BANK_ANCHOR_BINDING_IN_USE:
    'Kopplingen nekades: transaktionen skulle flyttas till ett annat bankkonto, men den är redan kopplad på det konto där den ligger. Ta bort den befintliga kopplingen först.',
}

/**
 * A link write the bank-anchor guards refused, as its own refusal instead of
 * WRITE_FAILED: that one reads "Försök igen", and a retry of a refused
 * direction, split or binding fails the same way every time (agent feedback
 * seq 853921, 877706). null for any other database error.
 */
function bankAnchorRefusal(
  error: { code?: string | null; message?: string | null } | null | undefined,
): { success: false; error: string; code: BankLinkRefusalCode } | null {
  if (error?.code !== 'PT409' || typeof error.message !== 'string' || !error.message.startsWith('BANK_ANCHOR_')) {
    return null
  }
  return refused(
    'BANK_ANCHOR_REFUSED',
    BANK_ANCHOR_REASON[error.message] ??
      'Kopplingen nekades: transaktionen och verifikationen stämmer inte längre med varandra på bankkontot. Kontrollera dem innan du kopplar.',
  )
}

/**
 * Manually link a transaction to an existing journal entry.
 * Validates that the journal entry has a bank account line and amounts are directionally compatible.
 *
 * `anchorUnderlag`: the caller links on a person's or an agent's own choice
 * of verifikat for this row (the bank link route, a pair named to the
 * account-keyed reconciliation), so the row's underlag goes onto that
 * verifikat as on every booking path. Off by default: anchoring cannot be
 * undone (a document on a verifikat stays its underlag, and "Koppla bort"
 * only clears the row's pointer), so a link the system guessed (the auto-link
 * after an invoice is linked to its voucher, a confirmed suggestion, proposals
 * applied in bulk) leaves the row's underlag on the row.
 */
export async function manualLink(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
  journalEntryId: string,
  userId: string,
  accountNumber: string,
  options: {
    anchorUnderlag?: boolean
    /**
     * Why the row is linked to this verifikat (transactions.link_basis):
     * user_confirmed for a pair a person or agent named or a suggestion a
     * person confirmed (its method and score as evidence), a rule basis for
     * the auto-link after an invoice is linked to its voucher.
     */
    linkBasis: LinkBasisInput
    /**
     * Signed amount the row may take beyond the verifikat's bank leg because
     * the same act books it: the residual of bookResidualAndLink
     * (lib/reconciliation/residual.ts). Never a default.
     */
    bankLegOverrun?: number
  },
): Promise<{ success: boolean; error?: string; code?: BankLinkRefusalCode }> {
  // Every check is the bank link core's (lib/transactions/bank-link.ts), the
  // same one linkTransactionToJournalEntry runs: pointer and junction guards,
  // ignored row, posted verifikat, the row's account, a line on it or on a
  // sibling ledger the row moves to, and room left on the verifikat's bank
  // leg for this row (GitHub #3507).
  const prepared = await prepareBankLink(supabase, companyId, {
    transactionId,
    journalEntryId,
    accountNumber,
    txColumns: '*',
    ...(options.bankLegOverrun ? { bankLegOverrun: options.bankLegOverrun } : {}),
  })
  if (!prepared.ok) return refused(prepared.code, prepared.error)

  const written = await writeBankLink(supabase, companyId, {
    transactionId,
    journalEntryId,
    prepared,
    linkBasis: options.linkBasis,
  })
  if (!written.ok) {
    if (written.race) return refused('LINK_RACE', 'Transaktionen är redan kopplad till en verifikation.')
    return bankAnchorRefusal(written.error) ?? refused('WRITE_FAILED', 'Kunde inte koppla transaktionen. Försök igen.')
  }

  // On a link someone chose, the row's underlag goes onto the verifikat it
  // is now linked to, as on every booking path (linkTransactionToJournalEntry
  // included): its pinned document and the inkorg items matched to it (see
  // lib/transactions/inbox-underlag.ts). A document pinned in a booking
  // dialog that ended in the duplicate guard's "Matcha mot verifikatet", or
  // in Matcha mot verifikat after the dialog closed, used to stay off it
  // (crm#1101). Best-effort and logged inside: the link stands either way.
  if (options.anchorUnderlag) {
    await propagateUnderlagForBookedTransaction(supabase, companyId, transactionId, journalEntryId)
  }

  try {
    await eventBus.emit({
      type: 'transaction.reconciled',
      payload: {
        transaction: prepared.tx as unknown as Transaction,
        journalEntryId,
        method: 'manual' as ReconciliationMethod,
        userId,
        companyId,
      },
    })
  } catch {
    // Non-critical
  }

  // The row teaches its bank text from this verifikat (crm#1746). A pair
  // someone chose (anchorUnderlag: a person's or an agent's own choice)
  // teaches at once; one the system guessed only once it repeats. Never
  // fails the link: learnFromBankLink logs and returns.
  await learnFromBankLink(
    supabase,
    companyId,
    { transactionId, journalEntryId },
    options.anchorUnderlag ? 'explicit' : 'automatic',
  )

  return { success: true }
}

/** One slice of a bank transaction settled on one verifikat (1:N link). */
export interface VoucherAllocation {
  journal_entry_id: string
  /** Signed, in the transaction's currency: the transaction's sign convention
   *  (negative = money out), the same one bulk_book_transactions writes. */
  amount: number
}

/** Input slice: an omitted amount defaults to the voucher's net line on the account. */
export interface VoucherAllocationInput {
  journal_entry_id: string
  amount?: number
}

export interface LinkTransactionToVouchersResult {
  success: boolean
  error?: string
  /** Why the split was refused; present whenever success is false. */
  code?: BankLinkRefusalCode
  /** The slices as validated, defaults resolved. Present on success and on dry runs. */
  allocations?: VoucherAllocation[]
}

/**
 * Link ONE bank transaction to SEVERAL posted verifikat (1:N): a lump payout
 * covering utlägg booked per receipt, a Bankgirot deposit aggregating two
 * customer payments, a Spiris-era salary voucher per employee paid in one
 * transfer (issue #1553). The mirror image of the N:1 shape manualLink
 * documents, and the counterpart of the invoice split in match-batch.
 *
 * Storage: transactions.journal_entry_id stays NULL and one
 * transaction_voucher_links row per verifikat carries the signed slice
 * (role 'bank_line'), exactly how bulk_book_transactions anchors a
 * samlingsverifikat. Every reader that asks "is this row booked?" through
 * public.bank_row_anchors therefore already sees it; the pointer column is
 * never the answer for a split row.
 *
 * Invariants (all refused, nothing written):
 *   - the transaction exists in the company, is not ignored and is not booked
 *     (live pointer, junction row, or a payment row with a live verifikat);
 *   - at least two distinct verifikat, each posted, in the company, with a
 *     line on the settlement account;
 *   - every slice is non-zero, has the sign of that voucher's net line on the
 *     account and is not larger than it (a voucher cannot absorb more of the
 *     bank row than it books on the account), nor than what other bank rows'
 *     bank_line slices on the same account leave of it;
 *   - the slices sum to the transaction amount within the öre tolerance: the
 *     same rule match-batch enforces, and the one the reconciliation
 *     difference depends on (a split that does not close would hide a real
 *     imbalance behind a "matched" row).
 *
 * Write order: the optimistic-locked transactions UPDATE first (it is the
 * race guard: a concurrent linker makes it match zero rows), then the
 * junction rows in one insert; a failed insert rolls the UPDATE back.
 */
export async function linkTransactionToVouchers(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
  allocations: VoucherAllocationInput[],
  userId: string,
  accountNumber: string = DEFAULT_SETTLEMENT_ACCOUNT,
  options: { dryRun?: boolean } = {},
): Promise<LinkTransactionToVouchersResult> {
  const journalEntryIds = allocations.map((a) => a.journal_entry_id)
  if (new Set(journalEntryIds).size !== journalEntryIds.length) {
    return refused('INVALID_SPLIT', 'Samma verifikat förekommer flera gånger i fördelningen.')
  }
  if (journalEntryIds.length < 2) {
    return refused('INVALID_SPLIT', 'En delning kräver minst två verifikat.')
  }
  if (journalEntryIds.length > MAX_BANK_ROW_SPLIT) {
    return refused('INVALID_SPLIT', `En delning kan omfatta högst ${MAX_BANK_ROW_SPLIT} verifikat.`)
  }

  const { data: txRow, error: txError } = await supabase
    .from('transactions')
    .select('*, transaction_voucher_links(journal_entry_id, role)')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()
  if (txError || !txRow) {
    return refused('TRANSACTION_NOT_FOUND', 'Transaktionen kunde inte hittas.')
  }
  const { transaction_voucher_links: junctionRows, ...tx } = txRow as Record<string, unknown> & {
    transaction_voucher_links?: Array<{ journal_entry_id: string; role?: string | null }> | null
  }
  if (tx.is_ignored === true) {
    return refused('TRANSACTION_IGNORED', 'Transaktionen är ignorerad. Återställ den innan du kopplar.')
  }
  // Stricter than manualLink on purpose: a split is the whole explanation of
  // the row, so ANY junction row (a residual's 'other' row included) makes it
  // ineligible; the UNIQUE (transaction_id, journal_entry_id) key would refuse
  // a re-anchor of that voucher anyway.
  if (Array.isArray(junctionRows) && junctionRows.length > 0) {
    return refused('TRANSACTION_ALREADY_LINKED', 'Transaktionen är redan kopplad till en verifikation.')
  }
  if (
    typeof tx.journal_entry_id === 'string' &&
    (await hasLiveJournalEntryLink(supabase, companyId, tx.journal_entry_id))
  ) {
    return refused('TRANSACTION_ALREADY_LINKED', 'Transaktionen är redan kopplad till en verifikation.')
  }
  // Third anchor of a bank row: a payment row (match-invoice, match-batch)
  // settles the row through invoice_payments / supplier_invoice_payments with
  // the pointer left NULL. Asked of public.bank_row_anchors, the one answer
  // every list and gnubok_get_transaction read: a payment row counts only
  // while a live verifikat stands behind it. A payment row without one (its
  // verifikat was removed, or the payment came over from another system and
  // was booked there) leaves the row open everywhere else, so refusing it
  // here stranded the row: shown as unbooked, impossible to link to the
  // verifikat that do book it (crm#1827). Such a payment row is left as it
  // is: it still names the row and the invoice it paid.
  const { data: paymentAnchors, error: paymentAnchorError } = await supabase
    .from('bank_row_anchors')
    .select('journal_entry_id')
    .eq('company_id', companyId)
    .eq('transaction_id', transactionId)
    .eq('via', 'payment')
    .limit(1)
  if (paymentAnchorError) {
    // Fail closed: an unread anchor must never read as a free row.
    return refused('WRITE_FAILED', 'Kunde inte läsa transaktionens befintliga kopplingar. Försök igen.')
  }
  const paymentAnchor = (paymentAnchors ?? [])[0] as { journal_entry_id: string | null } | undefined
  if (paymentAnchor) {
    const { data: holder } = paymentAnchor.journal_entry_id
      ? await supabase
          .from('journal_entries')
          .select('voucher_series, voucher_number')
          .eq('company_id', companyId)
          .eq('id', paymentAnchor.journal_entry_id)
          .maybeSingle()
      : { data: null }
    const voucher = holder && holder.voucher_number != null ? ` ${formatVoucher(holder)}` : ''
    return refused(
      'TRANSACTION_ALREADY_LINKED',
      `Transaktionen är redan bokförd som en fakturabetalning på verifikat${voucher}, så den kan inte kopplas en gång till. Är den bokningen fel: makulera det verifikatet först, sedan går raden att koppla.`,
    )
  }

  // The transaction must belong to the account being reconciled (same guard
  // as manualLink). Sibling-ledger re-pointing is deliberately not offered on
  // the split path: every verifikat must carry its line on this account.
  if (typeof tx.cash_account_id === 'string') {
    const { data: txCa } = await supabase
      .from('cash_accounts')
      .select('ledger_account')
      .eq('id', tx.cash_account_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (txCa?.ledger_account && txCa.ledger_account !== accountNumber) {
      return refused('TRANSACTION_OTHER_ACCOUNT', `Transaktionen hör till ${txCa.ledger_account}, inte ${accountNumber}`)
    }
  }

  // The verifikat are read in slices of ID_READ_CHUNK: a full split in one
  // `.in()` would overrun the gateway's URL limit (lib/reconciliation/limits.ts).
  const idParts = chunk(journalEntryIds, ID_READ_CHUNK)
  const entries: Array<{
    id: string
    status: string
    voucher_series: string | null
    voucher_number: number | null
    source_type?: string | null
  }> = []
  for (const part of idParts) {
    const { data } = await supabase
      .from('journal_entries')
      .select('id, status, voucher_series, voucher_number, source_type')
      .eq('company_id', companyId)
      .in('id', part)
    entries.push(...((data ?? []) as typeof entries))
  }
  const entryById = new Map(entries.map((e) => [e.id, e]))
  const labelOf = (id: string): string => {
    const e = entryById.get(id)
    return e && e.voucher_number != null ? formatVoucher(e) : id.slice(0, 8)
  }
  for (const id of journalEntryIds) {
    const entry = entryById.get(id)
    if (!entry) return refused('ENTRY_NOT_FOUND', `Verifikationen ${id} kunde inte hittas.`)
    if (entry.status === 'reversed') {
      return refused('ENTRY_REVERSED', `Verifikat ${labelOf(id)} är makulerat och kan inte kopplas.`)
    }
    if (entry.status !== 'posted') {
      return refused('ENTRY_NOT_POSTED', `Verifikat ${labelOf(id)} är inte bokförd ännu.`)
    }
    if (!isBankMovementEntry(entry)) {
      return refused('ENTRY_NOT_BANK_MOVEMENT', `Verifikat ${labelOf(id)} är en ingående balans eller en storno och kan inte kopplas.`)
    }
  }

  // Each voucher's net movement on the account, in the transaction's currency
  // (the split persists a reconciliation link, so it must compare in the
  // account's own unit; see ledgerLineAmountIn).
  const currency = typeof tx.currency === 'string' && tx.currency ? tx.currency : 'SEK'
  const lines: Array<LedgerLineAmount & { journal_entry_id: string }> = []
  for (const part of idParts) {
    const { data } = await supabase
      .from('journal_entry_lines')
      .select('journal_entry_id, debit_amount, credit_amount, currency, amount_in_currency')
      .in('journal_entry_id', part)
      .eq('account_number', accountNumber)
    lines.push(...((data ?? []) as typeof lines))
  }
  const netByEntry = new Map<string, number | null>()
  for (const line of lines) {
    const amount = ledgerLineAmountIn(line, currency)
    const prev = netByEntry.has(line.journal_entry_id) ? netByEntry.get(line.journal_entry_id) : 0
    netByEntry.set(line.journal_entry_id, prev === null || amount === null ? null : roundOre((prev ?? 0) + amount))
  }

  // What other bank rows on this cash account already hold of each verifikat:
  // their bank_line slices (an earlier partial split, a bulk-booked
  // samlingsverifikat) and, since GitHub #3507, their pointers (a row linked
  // 1:1 holds its whole amount; the slices alone let a split take a share of
  // a verifikat another row already settles in full). A verifikat can only
  // give this row the rest: two full-size slices on one verifikat would count
  // its line twice. The same rule as every other linking door
  // (lib/transactions/voucher-bank-leg.ts): same cash account and currency as
  // this row, so the amounts are in the unit of `net`.
  const heldRead = await readBankLegHolders(supabase, companyId, journalEntryIds, [transactionId])
  if (!heldRead.ok) {
    return refused('WRITE_FAILED', 'Kunde inte läsa verifikatens befintliga kopplingar. Försök igen.')
  }
  const ownCashAccountId = typeof tx.cash_account_id === 'string' ? tx.cash_account_id : null
  const heldByEntry = new Map<string, number>()
  for (const [entryId, holders] of heldRead.holders) {
    const onAccount = holdersOnAccount(holders, { cashAccountId: ownCashAccountId, currency })
    if (onAccount.length === 0) continue
    heldByEntry.set(entryId, roundOre(onAccount.reduce((sum, holder) => sum + holder.amount, 0)))
  }

  const txAmount = roundOre(Number(tx.amount))
  const resolved: VoucherAllocation[] = []
  for (const input of allocations) {
    const label = labelOf(input.journal_entry_id)
    if (!netByEntry.has(input.journal_entry_id)) {
      return refused('NOT_SETTLED', `Verifikat ${label} saknar rad på ${accountNumber}`)
    }
    const net = netByEntry.get(input.journal_entry_id) ?? null
    if (net === null) {
      return refused('NOT_SETTLED', `Verifikat ${label} saknar belopp i ${currency} på ${accountNumber}`)
    }
    const held = heldByEntry.get(input.journal_entry_id) ?? 0
    const remainder = roundOre(net - held)
    if (
      Math.abs(held) >= VOUCHER_LINK_AMOUNT_TOLERANCE &&
      (Math.abs(remainder) < VOUCHER_LINK_AMOUNT_TOLERANCE || Math.sign(remainder) !== Math.sign(net))
    ) {
      return refused(
        'OVER_ALLOCATED',
        `Verifikat ${label} är redan helt kopplat på ${accountNumber} till andra transaktioner.`,
      )
    }
    // An omitted slice takes what the verifikat has left, not its whole line.
    const slice = roundOre(input.amount ?? remainder)
    if (Math.abs(slice) < VOUCHER_LINK_AMOUNT_TOLERANCE) {
      return refused('NOT_SETTLED', `Beloppet för verifikat ${label} får inte vara 0.`)
    }
    if (Math.sign(slice) !== Math.sign(net)) {
      return refused(
        'NOT_SETTLED',
        `Beloppet för verifikat ${label} har fel riktning: verifikatet bokför ${net} på ${accountNumber}.`,
      )
    }
    if (Math.abs(slice) > Math.abs(net) + VOUCHER_LINK_AMOUNT_TOLERANCE) {
      return refused(
        'NOT_SETTLED',
        `Beloppet för verifikat ${label} (${slice}) är större än verifikatets rad på ${accountNumber} (${net}).`,
      )
    }
    if (Math.abs(slice) > Math.abs(remainder) + VOUCHER_LINK_AMOUNT_TOLERANCE) {
      return refused(
        'OVER_ALLOCATED',
        `Beloppet för verifikat ${label} (${slice}) är större än det som återstår av verifikatets rad på ${accountNumber} (${remainder}): resten är redan kopplad till andra transaktioner.`,
      )
    }
    resolved.push({ journal_entry_id: input.journal_entry_id, amount: slice })
  }
  const sliceSum = roundOre(resolved.reduce((sum, a) => sum + a.amount, 0))
  if (Math.abs(sliceSum - txAmount) > VOUCHER_LINK_AMOUNT_TOLERANCE) {
    return refused('NOT_SETTLED', `Fördelningen (${sliceSum}) stämmer inte med transaktionens belopp (${txAmount}).`)
  }

  if (options.dryRun) {
    return { success: true, allocations: resolved }
  }

  // Race guard first: the pointer is re-checked inside the write. A stale
  // pointer at a reversed entry (#988) is cleared by locking on its known
  // value; a free row locks on NULL. Zero rows means someone else linked the
  // row between our read and this write.
  const previousJournalEntryId =
    typeof tx.journal_entry_id === 'string' ? tx.journal_entry_id : null
  const lockUpdate = supabase
    .from('transactions')
    .update({
      journal_entry_id: null,
      reconciliation_method: 'manual' as ReconciliationMethod,
      is_business: true,
      potential_journal_entry_id: null,
      potential_match_method: null,
      potential_match_confidence: null,
    })
    .eq('id', transactionId)
    .eq('company_id', companyId)
  const { data: lockedRows, error: lockError } = await (previousJournalEntryId === null
    ? lockUpdate.is('journal_entry_id', null)
    : lockUpdate.eq('journal_entry_id', previousJournalEntryId)
  ).select('id')
  if (lockError) {
    return refused('WRITE_FAILED', 'Kunde inte koppla transaktionen. Försök igen.')
  }
  if (!lockedRows || lockedRows.length === 0) {
    return refused('LINK_RACE', 'Transaktionen är redan kopplad till en verifikation.')
  }

  // A split is always named slice by slice (the reconciliation page, the
  // account-keyed pairs); no matcher proposes one. The request scope says
  // whether a person or a client named it.
  const { error: insertError } = await supabase.from('transaction_voucher_links').insert(
    resolved.map((a) => ({
      user_id: userId,
      company_id: companyId,
      transaction_id: transactionId,
      journal_entry_id: a.journal_entry_id,
      allocated_amount: a.amount,
      role: 'bank_line',
      ...linkBasisColumns('user_confirmed'),
    })),
  )
  if (insertError) {
    // Roll the lock back so the row is exactly where it was; the junction had
    // no rows for this transaction (checked above), so a blanket delete only
    // removes what a partial insert may have left.
    await supabase
      .from('transaction_voucher_links')
      .delete()
      .eq('company_id', companyId)
      .eq('transaction_id', transactionId)
    await supabase
      .from('transactions')
      .update({
        journal_entry_id: previousJournalEntryId,
        reconciliation_method:
          typeof tx.reconciliation_method === 'string'
            ? (tx.reconciliation_method as ReconciliationMethod)
            : null,
        is_business: typeof tx.is_business === 'boolean' ? tx.is_business : null,
      })
      .eq('id', transactionId)
      .eq('company_id', companyId)
    log.error('linkTransactionToVouchers: junction insert failed, lock rolled back', insertError, {
      companyId,
      transactionId,
    })
    return bankAnchorRefusal(insertError) ?? refused('WRITE_FAILED', 'Kunde inte koppla transaktionen. Försök igen.')
  }

  // Behandlingshistorik (BFNAR 2013:2 kap 8): one match event for the row,
  // carrying every slice, mirroring the auto-apply loop in runReconciliation.
  await logMatchEvent(supabase, userId, transactionId, 'matched', {
    matchMethod: 'manual',
    newState: {
      journal_entry_ids: resolved.map((a) => a.journal_entry_id),
      allocations: resolved,
      reconciliation_method: 'manual',
    },
  })
  for (const a of resolved) {
    try {
      await eventBus.emit({
        type: 'transaction.reconciled',
        payload: {
          transaction: tx as unknown as Transaction,
          journalEntryId: a.journal_entry_id,
          method: 'manual' as ReconciliationMethod,
          userId,
          companyId,
        },
      })
    } catch {
      // Non-critical
    }
  }

  return { success: true, allocations: resolved }
}

/** Why unlinkReconciliation refused; the caller turns it into its door's answer. */
export type UnlinkReconciliationCode = 'TRANSACTION_NOT_FOUND' | 'NOT_LINKED' | 'LINK_IS_BOOKING' | 'DB_ERROR'

export interface UnlinkReconciliationResult {
  success: boolean
  error?: string
  /** Set on every refusal. */
  code?: UnlinkReconciliationCode
  /** The database error behind DB_ERROR. */
  cause?: { code?: string | null; message: string }
  /** Verifikat the row was anchored to before the unlink (pointer first, then junction rows). */
  previousJournalEntryIds?: string[]
}

/**
 * Whether koppla-bort may undo a bank row's link. A link records how the row
 * was paired with a verifikat that already existed (reconciliation_method:
 * the matcher's auto_* or 'manual'); a row without one was booked from
 * itself (categorize, match-invoice, a direct booking), so its verifikat is
 * its booking, undone by storno and never by unlinking. The reconciliation
 * items offer 'unmatch' by this same rule, so they never list an action that
 * is refused.
 */
export function isUnlinkableBankLink(row: { reconciliation_method?: string | null }): boolean {
  return Boolean(row.reconciliation_method)
}

/**
 * Remove a reconciliation link (isUnlinkableBankLink).
 * A row with no pointer but junction rows (a 1:N split) is unlinkable too.
 */
export async function unlinkReconciliation(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
  userId: string,
): Promise<UnlinkReconciliationResult> {
  // Fetch transaction
  const { data: tx, error: txError } = await supabase
    .from('transactions')
    .select('id, journal_entry_id, reconciliation_method')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (txError) {
    return { success: false, code: 'DB_ERROR', error: 'Failed to read transaction', cause: txError }
  }
  if (!tx) {
    return { success: false, code: 'TRANSACTION_NOT_FOUND', error: 'Transaction not found' }
  }

  // Collected BEFORE the delete so the audit row and the caller's
  // previous_journal_entry_id are never null for a split row.
  const previousJournalEntryIds: string[] = tx.journal_entry_id ? [tx.journal_entry_id as string] : []
  if (!tx.journal_entry_id) {
    const { data: junctionRows } = await supabase
      .from('transaction_voucher_links')
      .select('journal_entry_id')
      .eq('company_id', companyId)
      .eq('transaction_id', transactionId)
    for (const row of (junctionRows ?? []) as Array<{ journal_entry_id: string }>) {
      previousJournalEntryIds.push(row.journal_entry_id)
    }
    if (previousJournalEntryIds.length === 0) {
      return { success: false, code: 'NOT_LINKED', error: 'Transaction is not linked to any journal entry' }
    }
  }

  if (!isUnlinkableBankLink(tx)) {
    return {
      success: false,
      code: 'LINK_IS_BOOKING',
      error: 'Cannot unlink a categorization-created entry. Use storno to reverse it instead.',
    }
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
    return { success: false, code: 'DB_ERROR', error: 'Failed to unlink transaction', cause: updateError }
  }

  // A residual booking, a bulk-book or a 1:N split anchors the same
  // transaction through transaction_voucher_links as well; "koppla bort"
  // means every anchor goes.
  await supabase
    .from('transaction_voucher_links')
    .delete()
    .eq('company_id', companyId)
    .eq('transaction_id', transactionId)

  await logMatchEvent(supabase, userId, transactionId, 'unmatched', {
    previousState: {
      journal_entry_id: previousJournalEntryIds[0] ?? null,
      journal_entry_ids: previousJournalEntryIds,
      reconciliation_method: tx.reconciliation_method,
    },
  })

  return { success: true, previousJournalEntryIds }
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
 *     Bankavstämning; the one row that already holds it only gets the invoice
 *     tag, see tagHeldBankRow),
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

  // 1. Who already holds this voucher, by its pointer or by a bank_line slice
  //    (a bulk-booked samlingsverifikat, a 1:N split). The pointer alone
  //    missed the slices (GitHub #3507). A failed read links nothing: this
  //    path is best-effort.
  const held = await readBankLegHolders(supabase, companyId, [journalEntryId])
  if (!held.ok) return null
  const holders = held.holders.get(journalEntryId) ?? []

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
    cashByAccount.set(DEFAULT_SETTLEMENT_ACCOUNT, { id: null, currency: 'SEK', isPrimary: true })
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

  // A bank transaction already holds this voucher: the bank side is settled,
  // so don't attach another one behind the user's back. The row that holds
  // it, linked before the invoice was (a sweep, a typed verifikat linked at
  // posting), still gets the invoice tag the link below writes (#204).
  if (holders.length > 0) {
    await tagHeldBankRow(supabase, companyId, userId, journalEntryId, holders, {
      cashAccountId: cashAccount.id,
      currency: cashAccount.currency,
      movement,
    }, options)
    return null
  }

  // 4. Unbooked, non-ignored candidate transactions on that account, scoped the
  //    same way Bankavstämning scopes (handles legacy NULL cash_account_id rows).
  const fromDate = shiftIsoDate(entry.entry_date, -windowDays)
  const toDate = shiftIsoDate(entry.entry_date, windowDays)
  let candQuery = supabase
    .from('open_bank_rows')
    .select('id, amount')
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .gte('date', fromDate)
    .lte('date', toDate)
  candQuery = scopeTransactionsToAccount(
    candQuery,
    cashAccount.id ?? undefined,
    cashAccount.currency,
    cashAccount.isPrimary,
  )
  const { data: candidates } = await candQuery

  const matches = (
    (candidates ?? []) as Array<{ id: string; amount: number; transaction_voucher_links?: Array<{ role?: string | null }> | null }>
  ).filter((tx) => {
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
    {
      // Nobody chose this row: it is the only unbooked one on the account with
      // the voucher's bank amount, in that direction, within the window.
      linkBasis: { basis: 'rule_amount_date', evidence: { rule_id: 'linked_voucher_single_amount_match' } },
    },
  )
  if (!linkResult.success) return null

  // Tag the transaction with the (supplier) invoice for traceability + parity
  // with the transactions-side match. is_business is already set by manualLink,
  // so the row has already dropped out of the inbox regardless of this update;
  // without an invoice there is nothing to tag.
  const tag = invoiceTagFor(options)
  if (tag) {
    await supabase
      .from('transactions')
      .update(tag)
      .eq('id', transactionId)
      .eq('company_id', companyId)
  }

  await logMatchEvent(supabase, userId, transactionId, 'linked_to_existing_voucher', {
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

/**
 * The invoice tag a bank row gets when the verifikat it holds is linked to a
 * (supplier) invoice, with the match hints that link makes dead. null without
 * an invoice: nothing to tag.
 */
function invoiceTagFor(options: { invoiceId?: string; supplierInvoiceId?: string }): Record<string, unknown> | null {
  if (!options.invoiceId && !options.supplierInvoiceId) return null
  const tag: Record<string, unknown> = {
    potential_invoice_id: null,
    potential_rot_rut_payout_request_id: null,
  }
  if (options.invoiceId) tag.invoice_id = options.invoiceId
  if (options.supplierInvoiceId) {
    tag.supplier_invoice_id = options.supplierInvoiceId
    tag.potential_supplier_invoice_id = null
  }
  return tag
}

type HeldBankRowState = {
  journal_entry_id: string | null
  invoice_id: string | null
  supplier_invoice_id: string | null
  transaction_voucher_links?: Array<{ journal_entry_id: string | null; role?: string | null }> | null
}

/**
 * Tag the bank row that already holds a verifikat with the (supplier)
 * invoice just linked to that verifikat: the tag the link path writes
 * (invoiceTagFor) and nothing else. Nothing is relinked or booked, and no
 * payment is registered: the invoice's payment row is the link RPC's.
 *
 * Only when the verifikat has exactly one holder, on its bank account and in
 * its direction, holding it by its pointer; the row holds no other verifikat
 * (a bank_line slice elsewhere) and carries no invoice tag of either kind,
 * so a tag a person or another door wrote is never replaced. The update
 * repeats the pointer and no-tag conditions, so a row another writer changed
 * in between is left alone. Best-effort: a refused write (the denormalised
 * tag must agree with the row's own payment rows,
 * trg_block_contradictory_invoice_denorm) is logged and tags nothing.
 */
async function tagHeldBankRow(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  journalEntryId: string,
  holders: readonly BankLegHolder[],
  account: { cashAccountId: string | null; currency: string; movement: number },
  options: { invoiceId?: string; supplierInvoiceId?: string },
): Promise<boolean> {
  const tag = invoiceTagFor(options)
  if (!tag || holders.length !== 1) return false
  const holder = holders[0]
  if (holdersOnAccount(holders, account).length !== 1) return false
  if (Math.sign(holder.amount) !== Math.sign(account.movement)) return false

  const { data: rowData, error: readError } = await supabase
    .from('transactions')
    .select('journal_entry_id, invoice_id, supplier_invoice_id, transaction_voucher_links(journal_entry_id, role)')
    .eq('id', holder.transactionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (readError || !rowData) return false
  const row = rowData as HeldBankRowState
  if (row.journal_entry_id !== journalEntryId) return false
  if (row.invoice_id || row.supplier_invoice_id) return false
  const slices = Array.isArray(row.transaction_voucher_links) ? row.transaction_voucher_links : []
  if (slices.some((s) => s.role === 'bank_line' && s.journal_entry_id !== journalEntryId)) return false

  const { data: tagged, error } = await supabase
    .from('transactions')
    .update(tag)
    .eq('id', holder.transactionId)
    .eq('company_id', companyId)
    .eq('journal_entry_id', journalEntryId)
    .is('invoice_id', null)
    .is('supplier_invoice_id', null)
    .select('id')
  if (error) {
    log.warn('invoice tag on the bank row holding the verifikat not written', {
      companyId,
      transactionId: holder.transactionId,
      journalEntryId,
      code: error.code,
      reason: error.message,
    })
    return false
  }
  if (!Array.isArray(tagged) || tagged.length !== 1) return false

  await logMatchEvent(supabase, userId, holder.transactionId, 'linked_to_existing_voucher', {
    invoiceId: options.invoiceId,
    supplierInvoiceId: options.supplierInvoiceId,
    matchMethod: 'invoice_voucher_link',
    previousState: { journal_entry_id: journalEntryId, invoice_id: null, supplier_invoice_id: null },
    newState: {
      journal_entry_id: journalEntryId,
      invoice_id: options.invoiceId ?? null,
      supplier_invoice_id: options.supplierInvoiceId ?? null,
    },
  })
  return true
}

// ============================================================
// Helpers
// ============================================================

/**
 * Verifikat one call of a candidate predicate judges. About 1 s cold and
 * 50 ms warm on the largest company's account, far inside the 8 s statement
 * timeout, and a slice of them seldom has more lines than one 1 000-row page,
 * so most slices are one request.
 */
const CANDIDATE_ENTRY_SLICE = 500

/** Slices read side by side: fetchAllRows' pages in flight, for the same pool. */
const CANDIDATE_SLICES_IN_FLIGHT = 3

type CandidateLineKey = Pick<UnlinkedGLLine, 'entry_date' | 'voucher_number' | 'line_id'>

/**
 * The candidate RPCs' order: entry_date, voucher_number, line_id, ascending,
 * NULLs last, as Postgres sorts them. An ISO date sorts as its text, and a
 * uuid's lowercase text sorts as its bytes.
 */
function compareCandidateLines(a: CandidateLineKey, b: CandidateLineKey): number {
  if (a.entry_date !== b.entry_date) return a.entry_date < b.entry_date ? -1 : 1
  if (a.voucher_number !== b.voucher_number) {
    if (a.voucher_number == null) return 1
    if (b.voucher_number == null) return -1
    return a.voucher_number - b.voucher_number
  }
  if (a.line_id === b.line_id) return 0
  return a.line_id < b.line_id ? -1 : 1
}

/**
 * One candidate list, read as the RPC's own two halves: its narrowing once,
 * then its predicate on slices of the verifikat the narrowing names.
 *
 * Not .range() over the RPC (crm#2150): the RPC is plpgsql, so PostgREST runs
 * it to the end for every page and cuts 1 000 rows out of the result. A list
 * of n lines cost n/1 000 runs over the whole window; on the largest
 * company's account every run took longer than the 8 s statement timeout, so
 * a reconciliation without date_from failed on its first page. The predicate
 * judges every verifikat it is handed in full (window, status, links, tenant
 * guard) and each row depends on its own verifikat alone, so the slices
 * together answer the RPC's rows, each verifikat judged once. They are put
 * back in the RPC's order: the matcher keeps list order between equal
 * candidates.
 */
async function readCandidateLines<T extends CandidateLineKey>(
  supabase: SupabaseClient,
  narrowing: string,
  predicate: string,
  args: Record<string, unknown>,
): Promise<T[]> {
  const { data, error } = await supabase.rpc(narrowing, args)
  if (error) throw dbError(error, null)
  // One failed slice fails the read, and the slices not yet asked for are
  // never asked: the pool is not kept busy for an answer no one will use.
  let failed = false
  const slices = await mapWithConcurrency(
    chunk((data ?? []) as string[], CANDIDATE_ENTRY_SLICE),
    CANDIDATE_SLICES_IN_FLIGHT,
    async (entryIds) => {
      if (failed) return []
      try {
        // A slice can still pass PostgREST's silent 1000-row cap (a verifikat
        // with many lines on the account), so it pages, with line_id unique.
        return await fetchAllRows<T>(({ from, to }) =>
          supabase
            .rpc(predicate, { ...args, p_entry_ids: entryIds })
            .order('entry_date')
            .order('voucher_number')
            .order('line_id')
            .range(from, to),
        )
      } catch (err) {
        failed = true
        throw err
      }
    },
  )
  return slices.flat().sort(compareCandidateLines)
}

/**
 * Fetch unlinked GL lines for a settlement account. `accountNumber` defaults to
 * '1930' for back-compat; multi-account customers (Plusgiro 1920, kreditkort
 * 1940, EUR-konto 1932, etc.) pass the BAS code of the account they're
 * reconciling. The reconciliation UI populates this from cash_accounts.

 */
export async function fetchUnlinkedGLLines(
  supabase: SupabaseClient,
  companyId: string,
  accountNumber: string = DEFAULT_SETTLEMENT_ACCOUNT,
  dateFrom?: string,
  dateTo?: string,
): Promise<UnlinkedGLLine[]> {
  // get_unlinked_gl_lines' rows (bank_account_unlinked_entries, then
  // bank_account_unlinked_lines) in its chronological order, every one of
  // them: a truncated list would hide match candidates and undercount
  // unmatched_gl_line_count. A failed read throws: an empty list would read
  // as "nothing to match", so runReconciliation and the unattended sweeps
  // would record a clean run that never looked (accounted#115).
  return readCandidateLines<UnlinkedGLLine>(supabase, 'bank_account_unlinked_entries', 'bank_account_unlinked_lines', {
    p_company_id: companyId,
    p_account_number: accountNumber,
    p_date_from: dateFrom || null,
    p_date_to: dateTo || null,
  })
}

/**
 * What each verifikat of a candidate-RPC result leaves unexplained on the
 * account, in `currency`, keyed by journal_entry_id. Several lines of one
 * verifikat net (a link settles the whole verifikat). A verifikat that 1:N
 * bank_line slices settle in part carries remaining_amount on its lines and
 * counts only that remainder: its full line already sits in the ledger
 * movement, and the slices already explain the rest (agent feedback seq
 * 854089). The RPC computes the remainder in SEK and sets it only for SEK
 * slices, so a foreign account keeps the per-line rule. null for a verifikat
 * with a line that has no amount in `currency` (see ledgerLineAmountIn).
 */
export function openAmountByEntry(lines: UnlinkedGLLine[], currency: string): Map<string, number | null> {
  const out = new Map<string, number | null>()
  const remainders = new Map<string, number>()
  for (const line of lines) {
    if (currency === 'SEK' && line.remaining_amount != null && Number.isFinite(Number(line.remaining_amount))) {
      remainders.set(line.journal_entry_id, roundOre(Number(line.remaining_amount)))
    }
    const amount = ledgerLineAmountIn(line, currency)
    const prev = out.has(line.journal_entry_id) ? out.get(line.journal_entry_id) : 0
    out.set(line.journal_entry_id, prev === null || amount === null ? null : roundOre((prev ?? 0) + amount))
  }
  for (const [entryId, remainder] of remainders) out.set(entryId, remainder)
  return out
}

/** A match candidate that carries how many transactions already point at it. */
export interface GLLineForMatching extends UnlinkedGLLine {
  /** Transactions settling this entry ON THE REQUESTED ACCOUNT (plus legacy
   *  rows with no cash_account_id, which count everywhere EXCEPT on a
   *  non-primary account when the voucher is an own-account transfer and the
   *  row's sign contradicts this account's leg; 20260828220000). A transaction
   *  on another cash account, e.g. the outgoing leg of an own-account transfer,
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
  accountNumber: string = DEFAULT_SETTLEMENT_ACCOUNT,
  dateFrom?: string,
  dateTo?: string,
  includeMatched: boolean = false,
): Promise<GLLineForMatching[]> {
  // get_account_gl_lines_for_matching's rows (bank_account_candidate_entries,
  // then bank_account_candidate_lines), all of them in its chronological
  // order, for the same reasons as fetchUnlinkedGLLines.
  let data: GLLineForMatching[]
  try {
    data = await readCandidateLines<GLLineForMatching>(
      supabase,
      'bank_account_candidate_entries',
      'bank_account_candidate_lines',
      {
        p_company_id: companyId,
        p_account_number: accountNumber,
        p_date_from: dateFrom || null,
        p_date_to: dateTo || null,
        p_include_matched: includeMatched,
      },
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
 * OCR/reference-number match: the transaction's reference named as a whole
 * number in the GL line or entry description (descriptionMentionsReference).
 * A bare number, digits and separators alone, needs four digits and matches as
 * written or on its digits, however the bank grouped them. A reference with
 * letters must stand as written, F-101 or INV-42, never by the digits inside
 * it: the number in "Hyra feb 2026" is a year, and on its digits February's row
 * would take March's verifikat. Words alone name no document. A match of the
 * transaction's description is intentionally NOT done here: that collided on
 * recurring monthly charges across years (same description, same amount,
 * different year).
 */
function hasOcrReferenceMatch(txReference: string, line: UnlinkedGLLine): boolean {
  const digits = normalizeOcrReference(txReference)
  const bareNumber = /^[\d\s./-]+$/.test(txReference)
  if (bareNumber ? digits.length < 4 : digits.length === 0 || txReference.trim().length < 4) return false
  return [line.line_description, line.entry_description].some(
    (text) => descriptionMentionsReference(text, txReference) || (bareNumber && descriptionMentionsReference(text, digits)),
  )
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
 * Whether nothing in the run fits either side of a match as well as its own
 * pair does: no other open row fits the verifikat's line at this confidence
 * or higher, and no line of another verifikat fits the row at this
 * confidence or higher. Two rows of one amount on one date, or two unlinked
 * verifikat that both book the row, are a choice for a person
 * (the rule autoReconcileTransactionForLinkedVoucher keeps for the invoice
 * door: two same-amount rows near the date, don't guess).
 */
function isUnrivalledMatch(
  match: ReconciliationMatch,
  transactions: Transaction[],
  glLines: UnlinkedGLLine[],
  expectedCurrency: string,
): boolean {
  const fitsAsWell = (tx: Transaction, line: UnlinkedGLLine) =>
    (tryReconcileTransaction(tx, [line], expectedCurrency)?.confidence ?? 0) >= match.confidence
  const rivalRow = transactions.some((tx) => tx.id !== match.transaction.id && fitsAsWell(tx, match.glLine))
  if (rivalRow) return false
  return !glLines.some(
    (line) => line.journal_entry_id !== match.glLine.journal_entry_id && fitsAsWell(match.transaction, line),
  )
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
