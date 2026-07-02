import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import type {
  CreateJournalEntryLineInput,
  JournalEntry,
  JournalEntryLine,
} from '@/types'
import { validateBalance, getNextVoucherNumber } from '@/lib/bookkeeping/engine'
import { normalizeLineDimensions, lineDimensionColumns } from '@/lib/bookkeeping/dimension-resolver'
import { backfillStandardBASAccounts } from '@/lib/bookkeeping/account-backfill'
import { resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'
import {
  AccountsNotInChartError,
  BookkeepingDatabaseError,
  CannotCorrectNonPostedError,
  EntryAlreadyReversedError,
  EntryDateOutsideFiscalPeriodError,
  FiscalPeriodNotFoundError,
  JournalEntryNotBalancedError,
  JournalEntryNotFoundError,
  MeaninglessCorrectionError,
  NoOpenPeriodForDateError,
  TargetPeriodClosedError,
  TargetPeriodLockedError,
} from '@/lib/bookkeeping/errors'

/**
 * Round to 2dp using cents-integer math to avoid 0.1+0.2 drift.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * True when every account's (debit − credit) sum across the proposed lines is
 * zero. Such a rättelse describes no real affärshändelse and would erase the
 * original posting without representing anything in its place — disallowed by
 * BFL 5 kap. 5 § / BFNAR 2013:2.
 */
function netsToZeroPerAccount(lines: CreateJournalEntryLineInput[]): boolean {
  const nets = new Map<string, number>()
  for (const line of lines) {
    const delta = round2(line.debit_amount || 0) - round2(line.credit_amount || 0)
    nets.set(line.account_number, (nets.get(line.account_number) || 0) + delta)
  }
  return Array.from(nets.values()).every((n) => Math.abs(n) < 0.005)
}

/**
 * True when proposed lines are the same multiset as the original lines
 * (account_number + debit + credit). A rättelse must actually change something.
 */
function isIdenticalToOriginal(
  proposed: CreateJournalEntryLineInput[],
  original: JournalEntryLine[]
): boolean {
  if (proposed.length !== original.length) return false
  const key = (acc: string, d: number, c: number) =>
    `${acc}|${round2(d).toFixed(2)}|${round2(c).toFixed(2)}`
  const proposedKeys = proposed
    .map((l) => key(l.account_number, l.debit_amount || 0, l.credit_amount || 0))
    .sort()
  const originalKeys = original
    .map((l) => key(l.account_number, Number(l.debit_amount) || 0, Number(l.credit_amount) || 0))
    .sort()
  return proposedKeys.every((k, i) => k === originalKeys[i])
}

/**
 * Storno Service - 3-step correction flow per Bokföringslagen
 *
 * Swedish bookkeeping law requires that committed entries cannot be modified.
 * To correct an error, you must:
 * 1. Create a storno (reversal) entry that nullifies the original
 * 2. Create a corrected entry with the right data
 * 3. Link all three via reverses_id, reversed_by_id, correction_of_id
 */

/**
 * Cancel a journal entry and delete its lines.
 * Uses status='cancelled' instead of DELETE (DB trigger blocks all DELETEs).
 * Works for both draft→cancelled and posted→cancelled transitions.
 */
async function cancelEntry(supabase: SupabaseClient, entryId: string): Promise<void> {
  const { error: statusErr } = await supabase
    .from('journal_entries')
    .update({ status: 'cancelled' })
    .eq('id', entryId)
  if (statusErr) {
    console.error(`[storno] cancelEntry: failed to cancel ${entryId}:`, statusErr.message)
  }
  const { error: linesErr } = await supabase
    .from('journal_entry_lines')
    .delete()
    .eq('journal_entry_id', entryId)
  if (linesErr) {
    console.error(`[storno] cancelEntry: failed to delete lines for ${entryId}:`, linesErr.message)
  }
}

/** Journal entry row fetched together with its lines (the embedded select). */
type OriginalWithLines = JournalEntry & { lines?: JournalEntryLine[] | null }

/**
 * Correct an existing posted journal entry using the storno method.
 *
 * The storno (reversal) is always created in the original entry's period and
 * date, so the original nets to zero where it was booked. The corrected entry
 * defaults to the original's date/period too, but `options.newEntryDate` /
 * `options.newFiscalPeriodId` let a caller re-book it elsewhere — used to move
 * a verifikation booked on the wrong year to its correct period (see
 * recordateEntry). When the date/period is the correction, identical lines are
 * allowed (the move itself is the meaningful change).
 *
 * Returns: { reversal, corrected } - the two new entries created
 */
export async function correctEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  originalEntryId: string,
  correctedLines: CreateJournalEntryLineInput[],
  options?: {
    newEntryDate?: string
    newFiscalPeriodId?: string
    /**
     * The original entry (with lines) already loaded by the caller. When
     * provided, we skip the redundant re-fetch — recordateEntry reads the
     * original to copy its lines and hands it through here. This also closes
     * the small TOCTOU window a second independent read would open.
     */
    preloadedOriginal?: OriginalWithLines
  }
): Promise<{ reversal: JournalEntry; corrected: JournalEntry }> {
  // Validate the corrected lines are balanced
  const balance = validateBalance(correctedLines)
  if (!balance.valid) {
    throw new JournalEntryNotBalancedError(balance.totalDebit, balance.totalCredit, 'correction')
  }

  // Reject a rättelse with no economic effect (e.g. 1930 debit 100 / 1930
  // credit 100). Such an entry would erase the original posting without
  // representing any affärshändelse — disallowed by BFL 5 kap. 5 §.
  if (netsToZeroPerAccount(correctedLines)) {
    throw new MeaninglessCorrectionError('net_zero_per_account')
  }

  // Fetch original entry with lines — unless the caller already loaded it.
  let original = options?.preloadedOriginal ?? null
  if (!original) {
    const { data, error: fetchError } = await supabase
      .from('journal_entries')
      .select('*, lines:journal_entry_lines(*)')
      .eq('id', originalEntryId)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !data) {
      throw new JournalEntryNotFoundError()
    }
    original = data as OriginalWithLines
  }

  if (original.status !== 'posted') {
    throw new CannotCorrectNonPostedError(original.status)
  }

  const originalLines = (original.lines as JournalEntryLine[]) || []

  // Resolve where the corrected entry lands. Defaults to the original's own
  // date/period (a plain line-correction). A caller may override either to
  // re-book the entry in another period (recordate / wrong-year fix).
  const correctedDate = options?.newEntryDate ?? original.entry_date
  const correctedPeriodId = options?.newFiscalPeriodId ?? original.fiscal_period_id
  const dateOrPeriodChanged =
    correctedDate !== original.entry_date || correctedPeriodId !== original.fiscal_period_id

  // Reject when the proposed lines are identical to the original entry — a
  // rättelse must actually change something. Skip this when the date/period is
  // the change (moving a verifikation to the right year keeps the same lines).
  if (!dateOrPeriodChanged && isIdenticalToOriginal(correctedLines, originalLines)) {
    throw new MeaninglessCorrectionError('identical_to_original')
  }

  // When re-booking elsewhere, validate the corrected date falls within the
  // target period's bounds (mirrors createDraftEntry). recordateEntry resolves
  // the period from the date, so this also guards a mismatched explicit
  // override and fails fast before any storno is written.
  if (dateOrPeriodChanged) {
    const { data: targetPeriod, error: targetErr } = await supabase
      .from('fiscal_periods')
      .select('name, period_start, period_end')
      .eq('id', correctedPeriodId)
      .eq('company_id', companyId)
      .single()
    if (targetErr || !targetPeriod) {
      throw new FiscalPeriodNotFoundError()
    }
    if (correctedDate < targetPeriod.period_start || correctedDate > targetPeriod.period_end) {
      throw new EntryDateOutsideFiscalPeriodError(
        correctedDate,
        targetPeriod.name,
        targetPeriod.period_start,
        targetPeriod.period_end
      )
    }
  }

  // ===== Step 0: Resolve corrected-line accounts BEFORE any journal write =====
  // The old flow created and posted the storno first and only then discovered
  // that a corrected line referenced an account outside the chart. The storno
  // then had to be cancelled again, which left a voided 0 kr storno in the
  // correction chain and permanently burned voucher numbers (next_voucher_number
  // is a consuming counter → an unexplained BFNAR 2013:2 gap). Validate up
  // front instead: standard BAS accounts missing from the chart are seeded on
  // demand (same as createDraftEntry); unknown numbers or deliberately
  // deactivated accounts fail fast with nothing written.
  const accountNumbers = [...new Set(correctedLines.map((l) => l.account_number))]
  const resolveActiveAccountIds = async (): Promise<Map<string, string>> => {
    const { data: accounts } = await supabase
      .from('chart_of_accounts')
      .select('id, account_number')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .in('account_number', accountNumbers)
    const map = new Map<string, string>()
    for (const account of accounts || []) {
      map.set(account.account_number, account.id)
    }
    return map
  }

  let accountIdMap = await resolveActiveAccountIds()
  let missingAccounts = accountNumbers.filter((num) => !accountIdMap.has(num))
  if (missingAccounts.length > 0) {
    const seeded = await backfillStandardBASAccounts(supabase, companyId, userId, missingAccounts)
    if (seeded.length > 0) {
      accountIdMap = await resolveActiveAccountIds()
      missingAccounts = accountNumbers.filter((num) => !accountIdMap.has(num))
    }
    if (missingAccounts.length > 0) {
      throw new AccountsNotInChartError(missingAccounts)
    }
  }

  // ===== Step 1: Create storno (reversal) entry =====
  const reversalVoucherNumber = await getNextVoucherNumber(
    supabase,
    companyId,
    original.fiscal_period_id,
    original.voucher_series || 'A'
  )

  const { data: reversalEntry, error: reversalError } = await supabase
    .from('journal_entries')
    .insert({
      company_id: companyId,
      user_id: userId,
      fiscal_period_id: original.fiscal_period_id,
      voucher_number: reversalVoucherNumber,
      voucher_series: original.voucher_series || 'A',
      entry_date: original.entry_date,
      description: `Storno: ${original.description}`,
      source_type: 'storno',
      reverses_id: originalEntryId,
      status: 'draft',
    })
    .select()
    .single()

  if (reversalError || !reversalEntry) {
    throw new BookkeepingDatabaseError('create_reversal_entry', reversalError?.message)
  }

  // Insert reversed lines (swap debit and credit, preserve dimensions)
  const reversalLineInserts = originalLines.map((line, index) => {
    const dimensions = normalizeLineDimensions(line)
    return {
      journal_entry_id: reversalEntry.id,
      account_number: line.account_number,
      account_id: line.account_id || null,
      debit_amount: Math.round((Number(line.credit_amount) || 0) * 100) / 100,
      credit_amount: Math.round((Number(line.debit_amount) || 0) * 100) / 100,
      currency: line.currency || 'SEK',
      amount_in_currency: line.amount_in_currency ? -Number(line.amount_in_currency) : null,
      exchange_rate: line.exchange_rate || null,
      line_description: `Storno: ${line.line_description || ''}`,
      tax_code: line.tax_code || null,
      dimensions,
      ...lineDimensionColumns(dimensions),
      sort_order: index,
    }
  })

  const { error: reversalLinesError } = await supabase
    .from('journal_entry_lines')
    .insert(reversalLineInserts)

  if (reversalLinesError) {
    await cancelEntry(supabase, reversalEntry.id)
    throw new BookkeepingDatabaseError('create_reversal_lines', reversalLinesError.message)
  }

  // Post the reversal entry
  const { error: postReversalError } = await supabase
    .from('journal_entries')
    .update({ status: 'posted' })
    .eq('id', reversalEntry.id)

  if (postReversalError) {
    await cancelEntry(supabase, reversalEntry.id)
    throw new BookkeepingDatabaseError('post_reversal_entry', postReversalError.message)
  }

  // NOTE: Original entry is NOT marked as 'reversed' here. We defer that
  // until both the reversal and corrected entries are successfully posted.
  // This avoids the impossible reversed→posted rollback if step 2 fails.

  // ===== Step 2: Create corrected entry =====
  // If anything in this step fails, cancel the reversal entry.
  // The original entry was never modified, so no rollback needed.

  let correctedEntry: typeof reversalEntry

  try {
    const correctedVoucherNumber = await getNextVoucherNumber(
      supabase,
      companyId,
      correctedPeriodId,
      original.voucher_series || 'A'
    )

    // Account IDs were resolved (and standard BAS accounts seeded) in Step 0,
    // before the storno existed — nothing to clean up if we got this far.
    const { data: newEntry, error: correctedError } = await supabase
      .from('journal_entries')
      .insert({
        company_id: companyId,
        user_id: userId,
        fiscal_period_id: correctedPeriodId,
        voucher_number: correctedVoucherNumber,
        voucher_series: original.voucher_series || 'A',
        entry_date: correctedDate,
        description: `Rättelse: ${original.description}`,
        source_type: 'correction',
        correction_of_id: originalEntryId,
        status: 'draft',
      })
      .select()
      .single()

    if (correctedError || !newEntry) {
      throw new BookkeepingDatabaseError('create_corrected_entry', correctedError?.message)
    }

    correctedEntry = newEntry

    // Insert corrected lines
    const correctedLineInserts = correctedLines.map((line, index) => {
      const dimensions = normalizeLineDimensions(line)
      return {
        journal_entry_id: correctedEntry.id,
        account_number: line.account_number,
        account_id: accountIdMap.get(line.account_number) || null,
        debit_amount: Math.round((line.debit_amount || 0) * 100) / 100,
        credit_amount: Math.round((line.credit_amount || 0) * 100) / 100,
        currency: line.currency || 'SEK',
        amount_in_currency: line.amount_in_currency
          ? Math.round(line.amount_in_currency * 100) / 100
          : null,
        exchange_rate: line.exchange_rate || null,
        line_description: line.line_description || null,
        tax_code: line.tax_code || null,
        dimensions,
        ...lineDimensionColumns(dimensions),
        sort_order: index,
      }
    })

    const { error: correctedLinesError } = await supabase
      .from('journal_entry_lines')
      .insert(correctedLineInserts)

    if (correctedLinesError) {
      await cancelEntry(supabase, correctedEntry.id)
      throw new BookkeepingDatabaseError('create_corrected_lines', correctedLinesError.message)
    }

    // Post the corrected entry
    const { error: postCorrectedError } = await supabase
      .from('journal_entries')
      .update({ status: 'posted' })
      .eq('id', correctedEntry.id)

    if (postCorrectedError) {
      await cancelEntry(supabase, correctedEntry.id)
      throw new BookkeepingDatabaseError('post_corrected_entry', postCorrectedError.message)
    }
  } catch (err) {
    // Cancel the reversal entry (posted → cancelled). Original was never
    // modified so no rollback needed — it's still 'posted'.
    await cancelEntry(supabase, reversalEntry.id)
    throw err
  }

  // ===== Mark original as reversed (CAS guard: only if still 'posted') =====
  const { data: updatedOriginal, error: casError } = await supabase
    .from('journal_entries')
    .update({
      status: 'reversed',
      reversed_by_id: reversalEntry.id,
    })
    .eq('id', originalEntryId)
    .eq('status', 'posted')
    .select('id')

  if (casError || !updatedOriginal || updatedOriginal.length === 0) {
    // Concurrent reversal beat us — cancel both our entries
    await cancelEntry(supabase, reversalEntry.id)
    await cancelEntry(supabase, correctedEntry!.id)
    throw new EntryAlreadyReversedError()
  }

  // Re-point bank transactions and underlag from the original to the corrected
  // entry. The original is now status 'reversed'; the corrected entry is the
  // live representation of the affärshändelse, so the transaction row should
  // keep reading as booked against it (and stay correctable/uncategorizable),
  // and the underlag should travel with it. Best-effort — the correction_of_id
  // chain preserves traceability even if either relink fails.
  await relinkTransactionsToEntry(supabase, companyId, originalEntryId, correctedEntry!.id)
  await relinkDocumentsToEntry(supabase, companyId, originalEntryId, correctedEntry!.id)

  // ===== Step 3: Fetch complete entries =====
  const { data: finalReversal } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', reversalEntry.id)
    .single()

  const { data: finalCorrected } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', correctedEntry.id)
    .single()

  const result = {
    reversal: finalReversal as JournalEntry,
    corrected: finalCorrected as JournalEntry,
  }

  await eventBus.emit({
    type: 'journal_entry.corrected',
    payload: {
      original: original as JournalEntry,
      storno: result.reversal,
      corrected: result.corrected,
      companyId,
      userId,
    },
  })

  return result
}

/**
 * Move a posted verifikation to a different date — and thereby a different
 * fiscal period — without changing its lines. Fixes a booking entered with the
 * wrong date/year (e.g. 2026-07-03 that should have been 2025-07-03).
 *
 * A posted verifikation is immutable (BFL), so this is a storno + re-book under
 * the hood: the original is reversed in its own period (netting it to zero
 * there) and an identical corrected verifikation is posted with `newDate` in
 * the target period. The underlag follows the corrected entry. The full chain
 * original → storno → correction stays linked (BFL 5 kap. 5 §).
 *
 * Fails fast with a typed error if the target date is not bookable: closed year
 * (TargetPeriodClosedError), locked period / company lock date
 * (TargetPeriodLockedError), or no covering period (NoOpenPeriodForDateError).
 */
export async function recordateEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  originalEntryId: string,
  newDate: string
): Promise<{ reversal: JournalEntry; corrected: JournalEntry }> {
  // Fetch original with lines
  const { data: original, error: fetchError } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', originalEntryId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !original) {
    throw new JournalEntryNotFoundError()
  }
  if (original.status !== 'posted') {
    throw new CannotCorrectNonPostedError(original.status)
  }
  if (newDate === original.entry_date) {
    throw new MeaninglessCorrectionError('no_date_change')
  }

  // Classify the target date using the same two-layer logic the DB triggers
  // enforce (company lock date + period is_closed/locked_at), so we surface a
  // clear Swedish message instead of a raw trigger rejection.
  const target = await resolvePeriodStatusForDate(supabase, companyId, newDate)
  if (target.status === 'closed') {
    throw new TargetPeriodClosedError(newDate)
  }
  if (target.status === 'locked') {
    throw new TargetPeriodLockedError(newDate, target.lock_date)
  }
  if (!target.period_id) {
    // 'open' but no covering period — we do not auto-create periods on a fix.
    throw new NoOpenPeriodForDateError(newDate)
  }

  // Copy the original lines verbatim — they were correct; only the date was
  // wrong. correctEntry rebuilds the storno from the original anyway.
  const originalLines = (original.lines as JournalEntryLine[]) || []
  const copiedLines: CreateJournalEntryLineInput[] = originalLines
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((line) => ({
      account_number: line.account_number,
      debit_amount: Number(line.debit_amount) || 0,
      credit_amount: Number(line.credit_amount) || 0,
      line_description: line.line_description || undefined,
      currency: line.currency || undefined,
      amount_in_currency:
        line.amount_in_currency != null ? Number(line.amount_in_currency) : undefined,
      exchange_rate: line.exchange_rate != null ? Number(line.exchange_rate) : undefined,
      tax_code: line.tax_code || undefined,
      dimensions: line.dimensions || undefined,
      cost_center: line.cost_center || undefined,
      project: line.project || undefined,
    }))

  const result = await correctEntry(
    supabase,
    companyId,
    userId,
    originalEntryId,
    copiedLines,
    {
      newEntryDate: newDate,
      newFiscalPeriodId: target.period_id,
      // Hand the entry we already fetched (with lines) to correctEntry so it
      // doesn't re-read the same row.
      preloadedOriginal: original as OriginalWithLines,
    }
  )

  // Underlag and bank-transaction links follow the corrected entry —
  // correctEntry handles both relinks for every correction flavour.
  return result
}

/**
 * Re-point every bank transaction from one entry to another. Used when a
 * verifikation is corrected so the transaction row keeps reading as booked
 * against the live (corrected) entry instead of the reversed original.
 * Failures are logged, not thrown — the correction chain stays traceable.
 */
async function relinkTransactionsToEntry(
  supabase: SupabaseClient,
  companyId: string,
  fromEntryId: string,
  toEntryId: string
): Promise<void> {
  const { error } = await supabase
    .from('transactions')
    .update({ journal_entry_id: toEntryId })
    .eq('company_id', companyId)
    .eq('journal_entry_id', fromEntryId)
  if (error) {
    console.error(
      `[storno] relinkTransactionsToEntry: failed to move transactions ${fromEntryId} → ${toEntryId}:`,
      error.message
    )
  }
}

/**
 * Re-point every document_attachment from one entry to another. Used when a
 * verifikation is moved to a different period so its underlag travels with the
 * live (corrected) entry. The line-level link is cleared because the corrected
 * entry has new line ids. Failures are logged, not thrown — the entry-level
 * correction chain is the source of truth for traceability.
 */
async function relinkDocumentsToEntry(
  supabase: SupabaseClient,
  companyId: string,
  fromEntryId: string,
  toEntryId: string
): Promise<void> {
  const { error } = await supabase
    .from('document_attachments')
    .update({ journal_entry_id: toEntryId, journal_entry_line_id: null })
    .eq('company_id', companyId)
    .eq('journal_entry_id', fromEntryId)
  if (error) {
    console.error(
      `[storno] relinkDocumentsToEntry: failed to move documents ${fromEntryId} → ${toEntryId}:`,
      error.message
    )
  }
}
