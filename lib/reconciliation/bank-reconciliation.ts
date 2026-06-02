import type { SupabaseClient } from '@supabase/supabase-js'
import type { Transaction, ReconciliationMethod } from '@/types'
import { eventBus } from '@/lib/events/bus'
import { logMatchEvent } from '@/lib/invoices/match-log'

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
}

export interface ReconciliationStatus {
  bank_transaction_total: number
  /**
   * @deprecated Use `gl_1930_period_movement` for the reconciliation diff. This
   * field is preserved for back-compat with persisted status snapshots produced
   * before the IB-exclusion change; new consumers reading this to compute the
   * "real" difference will be off by the IB amount whenever a SIE-imported
   * opening balance exists on 1930. The `difference` field on this interface
   * is computed against `gl_1930_period_movement`, not this.
   */
  gl_1930_balance: number
  /** Ledger movement on 1930 excluding opening_balance AND storno/correction
   *  lines — i.e. only movements that have a bank-feed counterpart. */
  gl_1930_period_movement: number
  /** IB on 1930 within the date range — surfaced separately so reconciliation
   *  doesn't treat it as an unmatched bank transaction. */
  gl_1930_opening_balance: number
  /** Net of posted storno/correction lines on 1930 within the date range.
   *  Excluded from gl_1930_period_movement (and from the unmatched-voucher set)
   *  because a book-only correction has no counterpart in the bank feed. Surfaced
   *  separately so the UI can explain why a corrected period still reconciles. */
  gl_1930_correction_adjustment: number
  /** bankTotal − gl_1930_period_movement. Zero when every period transaction is matched. */
  difference: number
  is_reconciled: boolean
  matched_count: number
  unmatched_transaction_count: number
  unmatched_gl_line_count: number
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
   * by currency alone — this is what stops two same-currency accounts (e.g.
   * checking 1930 + savings 1931) from pooling together. Omit for the legacy
   * currency-only behaviour.
   */
  cashAccountId?: string
  /**
   * Whether this account claims rows with a NULL cash_account_id (legacy /
   * unassigned). Only the company's primary cash account should — see
   * scopeTransactionsToAccount. Defaults to true for back-compat with the
   * currency-only callers (where cashAccountId is omitted and this is moot).
   */
  includeUnassigned?: boolean
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
 * ONE account, but the query can't tell which — these are unbooked rows in
 * companies with ≥2 same-currency accounts (the backfill refuses to guess
 * between checking + savings) and booked own-account transfers the backfill
 * deliberately skips (>1 bank-class line). Attributing them to EVERY
 * same-currency account double-counts them: a 1931 savings account would pull in
 * 1930's unassigned rows, so Bankavstämning reported a large bogus difference
 * for 1931 while 1930 itself still reconciled. The fix: only the company's
 * PRIMARY cash account (cash_accounts.is_primary — exactly one per company)
 * claims NULL rows; every other account scopes strictly to its own id. Callers
 * pass `includeUnassigned = <this account is_primary>`. When cashAccountId is
 * omitted (single-account companies with no row, the '1930' fallback) the pure
 * currency filter is used and includeUnassigned is moot.
 *
 * The earlier nested `or(cash_account_id.eq.X,and(cash_account_id.is.null,currency.eq.cur))`
 * form is intentionally avoided — it silently returned ZERO rows mid-backfill.
 * A cash account has exactly one currency, so the flat two-term `or` is reliable.
 */
export function scopeTransactionsToAccount<Q extends {
  or(filters: string): Q
  eq(column: string, value: string): Q
}>(query: Q, cashAccountId: string | undefined, currency: string, includeUnassigned = true): Q {
  // Both values are interpolated into a raw PostgREST filter string below. They
  // are DB-derived in every caller (cash_accounts.id / .currency, or the 'SEK'
  // default), never raw user input — but assert their shape anyway so a future
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
    // Non-primary account: strict — never claim the company's unassigned NULL rows.
    return query.eq('currency', currency).eq('cash_account_id', cashAccountId)
  }
  return query.eq('currency', currency)
}

// ============================================================
// In-memory matching: single transaction against GL line pool
// ============================================================

/**
 * Try to reconcile a single transaction against a pool of unlinked GL lines.
 * Returns the best match or null. Purely in-memory, no DB calls.
 *
 * `expectedCurrency` filters which transactions can match — defaults to 'SEK'
 * so existing callers behave identically.
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
    const lineAmount = getDirectionalAmount(line)
    if (!isDirectionCompatible(txAmount, line)) continue

    const amountMatches = Math.abs(Math.abs(txAmount) - Math.abs(lineAmount)) < 0.005
    const fuzzyAmountMatches = Math.abs(Math.abs(txAmount) - Math.abs(lineAmount)) <= 0.01
    const exactDateMatch = txDate === line.entry_date
    const dateWithinRange = isDateWithinRange(txDate, line.entry_date, 3)
    // Reference matches require BOTH a real OCR/reference token AND a bounded
    // date window. Never description-only — that collides on recurring monthly
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
  } = options

  // Fetch unlinked GL lines via RPC
  const glLines = await fetchUnlinkedGLLines(supabase, companyId, accountNumber, dateFrom, dateTo)

  // Fetch unmatched transactions, scoped to the selected cash account.
  let query = supabase
    .from('transactions')
    .select('*')
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .eq('is_ignored', false)
  query = scopeTransactionsToAccount(query, cashAccountId, currency, includeUnassigned)

  if (dateFrom) query = query.gte('date', dateFrom)
  if (dateTo) query = query.lte('date', dateTo)

  const { data: transactions } = await query

  if (!transactions || transactions.length === 0 || glLines.length === 0) {
    return { matches: [], applied: 0, errors: 0 }
  }

  // Run greedy matching, highest confidence first
  const matches = greedyMatch(transactions as Transaction[], glLines, currency)

  if (dryRun) {
    return { matches, applied: 0, errors: 0 }
  }

  // Apply matches
  let applied = 0
  let errors = 0

  for (const match of matches) {
    try {
      const { error } = await supabase
        .from('transactions')
        .update({
          journal_entry_id: match.glLine.journal_entry_id,
          reconciliation_method: match.method,
          is_business: true,
        })
        .eq('id', match.transaction.id)
        .eq('company_id', companyId)

      if (error) {
        errors++
      } else {
        applied++
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

  return { matches, applied, errors }
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
 * both — comparing EUR GL movements against SEK transaction totals would
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
  // rows are pulled too so the totals card still reflects what the bank
  // actually moved, but they're excluded from the "unmatched" count below — the
  // user has explicitly said they don't want them surfacing as something to
  // reconcile. Scoping by cash account (not just currency) is what stops a
  // second same-currency account from inflating bankTotal here.
  let txQuery = supabase
    .from('transactions')
    .select('amount, journal_entry_id, reconciliation_method, is_ignored')
    .eq('company_id', companyId)
  txQuery = scopeTransactionsToAccount(txQuery, cashAccountId, currency, includeUnassigned)

  if (dateFrom) txQuery = txQuery.gte('date', dateFrom)
  if (dateTo) txQuery = txQuery.lte('date', dateTo)

  const { data: transactions } = await txQuery

  // Get GL bank account lines. Pull id/status/source_type from the join so we
  // can (a) split out lines that have no bank-feed counterpart — opening_balance
  // (prior year's closing balance) and storno/correction (book-only corrections)
  // — and (b) identify reversed originals, whose still-linked bank transactions
  // are superseded by the correction and must drop off the bank side too.
  // 'reversed' is fetched alongside 'posted' precisely to resolve those links;
  // reversed lines are NOT counted in any movement total.
  let glQuery = supabase
    .from('journal_entry_lines')
    .select('debit_amount, credit_amount, journal_entries!inner(id, company_id, entry_date, status, source_type)')
    .eq('account_number', bankAccount)
    .eq('journal_entries.company_id', companyId)
    .in('journal_entries.status', ['posted', 'reversed'])

  if (dateFrom) glQuery = glQuery.gte('journal_entries.entry_date', dateFrom)
  if (dateTo) glQuery = glQuery.lte('journal_entries.entry_date', dateTo)

  const { data: glLines } = await glQuery

  type GlEntry = { id?: string | null; status?: string | null; source_type?: string | null }
  type GlLineRow = {
    debit_amount: number | string | null
    credit_amount: number | string | null
    journal_entries: GlEntry | GlEntry[] | null
  }
  // Supabase typings sometimes widen embedded relations to arrays even when the
  // join is one-to-one. Handle both shapes defensively.
  function entryOf(line: GlLineRow): GlEntry | null {
    const je = line.journal_entries
    if (!je) return null
    return Array.isArray(je) ? je[0] ?? null : je
  }
  function lineAmount(line: GlLineRow): number {
    return (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)
  }

  const allLines = (glLines || []) as GlLineRow[]
  const postedLines = allLines.filter((l) => entryOf(l)?.status === 'posted')

  // Reversed originals retain their bank-transaction link (the storno flow never
  // re-points it), so a transaction pointing at one is a superseded booking —
  // drop it from the bank side to keep the comparison symmetric with the
  // movement, which excludes the matching storno/correction below.
  const reversedEntryIds = new Set<string>(
    allLines
      .filter((l) => entryOf(l)?.status === 'reversed')
      .map((l) => entryOf(l)?.id)
      .filter((id): id is string => Boolean(id))
  )

  // Calculate totals. Exclude transactions whose linked entry was reversed —
  // their booking lives on in the correction, which is itself excluded from the
  // movement, so counting the transaction would resurrect a phantom diff.
  const bankTotal = (transactions || []).reduce((sum, tx) => {
    if (tx.journal_entry_id && reversedEntryIds.has(tx.journal_entry_id)) return sum
    return sum + (Number(tx.amount) || 0)
  }, 0)

  // gl_1930_balance keeps its historical meaning: the posted balance incl. IB.
  const glBalance = postedLines.reduce((sum, line) => sum + lineAmount(line), 0)
  const glOpeningBalance = postedLines
    .filter((l) => entryOf(l)?.source_type === 'opening_balance')
    .reduce((sum, line) => sum + lineAmount(line), 0)
  const glCorrectionAdjustment = postedLines
    .filter((l) => {
      const st = entryOf(l)?.source_type
      return st === 'storno' || st === 'correction'
    })
    .reduce((sum, line) => sum + lineAmount(line), 0)
  // Period movement = only the lines that have a bank-feed counterpart.
  const glPeriodMovement = glBalance - glOpeningBalance - glCorrectionAdjustment

  const matchedCount = (transactions || []).filter(
    (tx) => tx.journal_entry_id !== null
  ).length

  const unmatchedTransactionCount = (transactions || []).filter(
    (tx) => tx.journal_entry_id === null && tx.is_ignored !== true
  ).length

  // Unlinked GL lines count (RPC excludes opening_balance, storno and correction
  // since 20260601120000_unlinked_gl_lines_exclude_storno_correction.sql)
  const unlinkedLines = await fetchUnlinkedGLLines(supabase, companyId, bankAccount, dateFrom, dateTo)

  const difference = Math.round((bankTotal - glPeriodMovement) * 100) / 100

  return {
    bank_transaction_total: Math.round(bankTotal * 100) / 100,
    gl_1930_balance: Math.round(glBalance * 100) / 100,
    gl_1930_period_movement: Math.round(glPeriodMovement * 100) / 100,
    gl_1930_opening_balance: Math.round(glOpeningBalance * 100) / 100,
    gl_1930_correction_adjustment: Math.round(glCorrectionAdjustment * 100) / 100,
    difference,
    is_reconciled: Math.abs(difference) < 0.01,
    matched_count: matchedCount,
    unmatched_transaction_count: unmatchedTransactionCount,
    unmatched_gl_line_count: unlinkedLines.length,
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

  if (tx.journal_entry_id) {
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
  }

  // Check for a bank account line on the SELECTED settlement account. The old
  // "any 19xx line" check let a 1930 transaction link to a voucher that only
  // touched 1931 — a cross-account link that silently hides a real imbalance.
  const { data: lines } = await supabase
    .from('journal_entry_lines')
    .select('debit_amount, credit_amount, account_number')
    .eq('journal_entry_id', journalEntryId)
    .eq('account_number', accountNumber)

  if (!lines || lines.length === 0) {
    return { success: false, error: `Verifikationen saknar rad på ${accountNumber}` }
  }

  // N:1 is intentionally allowed: several bank transactions may settle ONE
  // verifikat (a salary run paid out in multiple transfers, a supplier invoice
  // paid in instalments). The voucher's bank line is counted once in the period
  // movement while each transaction sums on the bank side, so correctly-summing
  // links net to zero and any mis-link surfaces as a non-zero difference on the
  // status card — there's no need to forbid a second link here. (A given
  // transaction still can't be double-linked: the tx.journal_entry_id guard
  // above already blocks that.) The candidate list only surfaces an
  // already-matched voucher when the user opts in via "Visa även matchade
  // verifikationer", so this can't happen by accident.

  // Apply link
  const { error: updateError } = await supabase
    .from('transactions')
    .update({
      journal_entry_id: journalEntryId,
      reconciliation_method: 'manual' as ReconciliationMethod,
      is_business: true,
    })
    .eq('id', transactionId)
    .eq('company_id', companyId)

  if (updateError) {
    return { success: false, error: 'Kunde inte koppla transaktionen. Försök igen.' }
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
  transactionId: string
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

  logMatchEvent(supabase, companyId, transactionId, 'unmatched', {
    previousState: {
      journal_entry_id: tx.journal_entry_id,
      reconciliation_method: tx.reconciliation_method,
    },
  })

  return { success: true }
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
  const { data, error } = await supabase.rpc('get_unlinked_gl_lines', {
    p_company_id: companyId,
    p_account_number: accountNumber,
    p_date_from: dateFrom || null,
    p_date_to: dateTo || null,
  })

  if (error || !data) return []
  return data as UnlinkedGLLine[]
}

/** A match candidate that carries how many transactions already point at it. */
export interface GLLineForMatching extends UnlinkedGLLine {
  linked_transaction_count: number
}

/**
 * Fetch GL lines on a settlement account as match candidates. With
 * `includeMatched=false` this is parity with fetchUnlinkedGLLines (unmatched
 * only); with `includeMatched=true` it also returns already-matched vouchers,
 * each carrying `linked_transaction_count`, so a second/third bank transaction
 * can be attached to the same verifikat (N:1 — a salary run paid in several
 * transfers, a supplier invoice paid in instalments). Server-only: like the rest
 * of this module it must never reach the client bundle.
 */
export async function fetchGLLinesForMatching(
  supabase: SupabaseClient,
  companyId: string,
  accountNumber: string = '1930',
  dateFrom?: string,
  dateTo?: string,
  includeMatched: boolean = false,
): Promise<GLLineForMatching[]> {
  const { data, error } = await supabase.rpc('get_account_gl_lines_for_matching', {
    p_company_id: companyId,
    p_account_number: accountNumber,
    p_date_from: dateFrom || null,
    p_date_to: dateTo || null,
    p_include_matched: includeMatched,
  })

  if (error || !data) return []
  // count(*) can arrive as a bigint string over the wire — coerce defensively.
  return (data as GLLineForMatching[]).map((line) => ({
    ...line,
    linked_transaction_count: Number(line.linked_transaction_count) || 0,
  }))
}

/** Get the net amount from a GL line (positive for debit, negative for credit) */
function getDirectionalAmount(line: UnlinkedGLLine): number {
  if (line.debit_amount > 0) return line.debit_amount
  if (line.credit_amount > 0) return -line.credit_amount
  return 0
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
 * substring matching is intentionally NOT done here — that collided on recurring
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
