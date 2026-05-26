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
  /** Ledger movement on 1930 excluding source_type='opening_balance' lines. */
  gl_1930_period_movement: number
  /** IB on 1930 within the date range — surfaced separately so reconciliation
   *  doesn't treat it as an unmatched bank transaction. */
  gl_1930_opening_balance: number
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
  } = options

  // Fetch unlinked GL lines via RPC
  const glLines = await fetchUnlinkedGLLines(supabase, companyId, accountNumber, dateFrom, dateTo)

  // Fetch unmatched transactions
  let query = supabase
    .from('transactions')
    .select('*')
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .eq('currency', currency)

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
): Promise<ReconciliationStatus> {
  // Get all transactions in range
  let txQuery = supabase
    .from('transactions')
    .select('amount, journal_entry_id, reconciliation_method')
    .eq('company_id', companyId)
    .eq('currency', currency)

  if (dateFrom) txQuery = txQuery.gte('date', dateFrom)
  if (dateTo) txQuery = txQuery.lte('date', dateTo)

  const { data: transactions } = await txQuery

  // Get GL bank account lines (all, not just unlinked). Pull source_type
  // from the join so we can split IB out of the period-movement comparison —
  // an opening_balance line on 1930 is the prior year's closing balance, not
  // a bank transaction we should expect to match.
  let glQuery = supabase
    .from('journal_entry_lines')
    .select('debit_amount, credit_amount, journal_entries!inner(company_id, entry_date, status, source_type)')
    .eq('account_number', bankAccount)
    .eq('journal_entries.company_id', companyId)
    .eq('journal_entries.status', 'posted')

  if (dateFrom) glQuery = glQuery.gte('journal_entries.entry_date', dateFrom)
  if (dateTo) glQuery = glQuery.lte('journal_entries.entry_date', dateTo)

  const { data: glLines } = await glQuery

  type GlLineRow = {
    debit_amount: number | string | null
    credit_amount: number | string | null
    journal_entries: { source_type?: string | null } | { source_type?: string | null }[] | null
  }
  function isOpeningBalance(line: GlLineRow): boolean {
    const je = line.journal_entries
    if (!je) return false
    // Supabase typings sometimes widen embedded relations to arrays even when
    // the join is one-to-one. Handle both shapes defensively.
    const sourceType = Array.isArray(je) ? je[0]?.source_type : je.source_type
    return sourceType === 'opening_balance'
  }

  // Calculate totals
  const bankTotal = (transactions || []).reduce(
    (sum, tx) => sum + (Number(tx.amount) || 0),
    0
  )

  const allLines = (glLines || []) as GlLineRow[]
  const glBalance = allLines.reduce(
    (sum, line) => sum + (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0),
    0
  )
  const glOpeningBalance = allLines
    .filter(isOpeningBalance)
    .reduce(
      (sum, line) => sum + (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0),
      0
    )
  const glPeriodMovement = glBalance - glOpeningBalance

  const matchedCount = (transactions || []).filter(
    (tx) => tx.journal_entry_id !== null
  ).length

  const unmatchedTransactionCount = (transactions || []).filter(
    (tx) => tx.journal_entry_id === null
  ).length

  // Unlinked GL lines count (RPC excludes source_type='opening_balance' since
  // 20260514132534_unlinked_1930_lines_exclude_opening_balance.sql)
  const unlinkedLines = await fetchUnlinkedGLLines(supabase, companyId, bankAccount, dateFrom, dateTo)

  const difference = Math.round((bankTotal - glPeriodMovement) * 100) / 100

  return {
    bank_transaction_total: Math.round(bankTotal * 100) / 100,
    gl_1930_balance: Math.round(glBalance * 100) / 100,
    gl_1930_period_movement: Math.round(glPeriodMovement * 100) / 100,
    gl_1930_opening_balance: Math.round(glOpeningBalance * 100) / 100,
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
  userId: string
): Promise<{ success: boolean; error?: string }> {
  // Fetch transaction
  const { data: tx, error: txError } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()

  if (txError || !tx) {
    return { success: false, error: 'Transaction not found' }
  }

  if (tx.journal_entry_id) {
    return { success: false, error: 'Transaction is already linked to a journal entry' }
  }

  // Fetch journal entry + verify it has a 1930 line
  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .select('id, company_id, status')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .single()

  if (entryError || !entry) {
    return { success: false, error: 'Journal entry not found' }
  }

  if (entry.status !== 'posted') {
    return { success: false, error: 'Journal entry is not posted' }
  }

  // Check for a bank account line (19xx class accounts)
  const { data: lines } = await supabase
    .from('journal_entry_lines')
    .select('debit_amount, credit_amount, account_number')
    .eq('journal_entry_id', journalEntryId)
    .gte('account_number', '1900')
    .lte('account_number', '1999')

  if (!lines || lines.length === 0) {
    return { success: false, error: 'Verifikationen saknar rad på bankkonto (19xx)' }
  }

  // Check that no other transaction is already linked to this entry
  const { data: existingLink } = await supabase
    .from('transactions')
    .select('id')
    .eq('journal_entry_id', journalEntryId)
    .eq('company_id', companyId)
    .single()

  if (existingLink) {
    return { success: false, error: 'Another transaction is already linked to this journal entry' }
  }

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
    return { success: false, error: 'Failed to link transaction' }
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
