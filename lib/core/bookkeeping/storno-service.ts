import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import type {
  CreateJournalEntryLineInput,
  JournalEntry,
  JournalEntryLine,
} from '@/types'
import { validateBalance, getNextVoucherNumber } from '@/lib/bookkeeping/engine'
import {
  AccountsNotInChartError,
  BookkeepingDatabaseError,
  CannotCorrectNonPostedError,
  EntryAlreadyReversedError,
  JournalEntryNotBalancedError,
  JournalEntryNotFoundError,
  MeaninglessCorrectionError,
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

/**
 * Correct an existing posted journal entry using the storno method.
 *
 * Returns: { reversal, corrected } - the two new entries created
 */
export async function correctEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  originalEntryId: string,
  correctedLines: CreateJournalEntryLineInput[]
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

  // Fetch original entry with lines
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

  const originalLines = (original.lines as JournalEntryLine[]) || []

  // Reject when the proposed lines are identical to the original entry —
  // a rättelse must actually change something.
  if (isIdenticalToOriginal(correctedLines, originalLines)) {
    throw new MeaninglessCorrectionError('identical_to_original')
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

  // Insert reversed lines (swap debit and credit)
  const reversalLineInserts = originalLines.map((line, index) => ({
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
    cost_center: line.cost_center || null,
    project: line.project || null,
    sort_order: index,
  }))

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
      original.fiscal_period_id,
      original.voucher_series || 'A'
    )

    // Resolve account IDs for corrected lines — only active rows count
    const accountNumbers = [...new Set(correctedLines.map((l) => l.account_number))]
    const { data: accounts } = await supabase
      .from('chart_of_accounts')
      .select('id, account_number')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .in('account_number', accountNumbers)

    const accountIdMap = new Map<string, string>()
    for (const account of accounts || []) {
      accountIdMap.set(account.account_number, account.id)
    }

    // Validate all account numbers resolved to IDs
    const missingAccounts = accountNumbers.filter(num => !accountIdMap.has(num))
    if (missingAccounts.length > 0) {
      throw new AccountsNotInChartError(missingAccounts)
    }

    const { data: newEntry, error: correctedError } = await supabase
      .from('journal_entries')
      .insert({
        company_id: companyId,
        user_id: userId,
        fiscal_period_id: original.fiscal_period_id,
        voucher_number: correctedVoucherNumber,
        voucher_series: original.voucher_series || 'A',
        entry_date: original.entry_date,
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
    const correctedLineInserts = correctedLines.map((line, index) => ({
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
      cost_center: line.cost_center || null,
      project: line.project || null,
      sort_order: index,
    }))

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
