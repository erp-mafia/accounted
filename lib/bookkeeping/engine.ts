import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import type {
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  JournalEntry,
  JournalEntryLine,
} from '@/types'

/**
 * Validate that a set of journal entry lines is balanced (debits = credits)
 */
export function validateBalance(lines: CreateJournalEntryLineInput[]): {
  valid: boolean
  totalDebit: number
  totalCredit: number
} {
  const totalDebit = lines.reduce((sum, l) => sum + (l.debit_amount || 0), 0)
  const totalCredit = lines.reduce((sum, l) => sum + (l.credit_amount || 0), 0)

  // Round to avoid floating point issues (2 decimal places for SEK)
  const roundedDebit = Math.round(totalDebit * 100) / 100
  const roundedCredit = Math.round(totalCredit * 100) / 100

  return {
    valid: roundedDebit === roundedCredit && roundedDebit > 0,
    totalDebit: roundedDebit,
    totalCredit: roundedCredit,
  }
}

/**
 * Get the next voucher number for a company/period/series
 * Uses the concurrent-safe INSERT ON CONFLICT implementation in the database
 */
export async function getNextVoucherNumber(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  series: string = 'A'
): Promise<number> {

  const { data, error } = await supabase.rpc('next_voucher_number', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
    p_series: series,
  })

  if (error) {
    throw new Error(`Failed to get next voucher number: ${error.message}`)
  }

  return data as number
}

/**
 * Resolve account IDs from account numbers for a company
 */
async function resolveAccountIds(
  supabase: SupabaseClient,
  companyId: string,
  lines: CreateJournalEntryLineInput[]
): Promise<Map<string, string>> {
  const accountNumbers = [...new Set(lines.map((l) => l.account_number))]

  const { data: accounts, error } = await supabase
    .from('chart_of_accounts')
    .select('id, account_number')
    .eq('company_id', companyId)
    .in('account_number', accountNumbers)

  if (error) {
    throw new Error(`Failed to resolve account IDs: ${error.message}`)
  }

  const map = new Map<string, string>()
  for (const account of accounts || []) {
    map.set(account.account_number, account.id)
  }

  return map
}

/**
 * Find the fiscal period for a given date
 */
export async function findFiscalPeriod(
  supabase: SupabaseClient,
  companyId: string,
  date: string
): Promise<string | null> {

  // Overlapping periods are prevented by a DB exclusion constraint
  // (migration 042). limit(1) is kept as a defensive measure.
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .lte('period_start', date)
    .gte('period_end', date)
    .eq('is_closed', false)
    .order('period_start', { ascending: false })
    .limit(1)

  if (error || !data || data.length === 0) {
    return null
  }

  return data[0].id
}

/**
 * Build line insert objects from input lines, resolving account IDs and
 * including tax_code, cost_center, project dimensions
 */
function buildLineInserts(
  entryId: string,
  lines: CreateJournalEntryLineInput[],
  accountIdMap: Map<string, string>
) {
  return lines.map((line, index) => ({
    journal_entry_id: entryId,
    account_number: line.account_number,
    account_id: accountIdMap.get(line.account_number) || null,
    debit_amount: Math.round((line.debit_amount || 0) * 100) / 100,
    credit_amount: Math.round((line.credit_amount || 0) * 100) / 100,
    currency: line.currency || 'SEK',
    amount_in_currency: line.amount_in_currency ? Math.round(line.amount_in_currency * 100) / 100 : null,
    exchange_rate: line.exchange_rate || null,
    line_description: line.line_description || null,
    tax_code: line.tax_code || null,
    cost_center: line.cost_center || null,
    project: line.project || null,
    sort_order: index,
  }))
}

/**
 * Create a draft journal entry with lines (no voucher number assigned yet)
 * The entry stays in 'draft' status until commitEntry() is called.
 */
export async function createDraftEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateJournalEntryInput
): Promise<JournalEntry> {
  // Validate balance
  const balance = validateBalance(input.lines)
  if (!balance.valid) {
    throw new Error(
      `Journal entry is not balanced: debits (${balance.totalDebit}) != credits (${balance.totalCredit})`
    )
  }

  // Resolve account IDs
  const accountIdMap = await resolveAccountIds(supabase, companyId, input.lines)

  // Insert journal entry header as draft (voucher_number = 0, will be assigned on commit)
  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .insert({
      company_id: companyId,
      user_id: userId,
      fiscal_period_id: input.fiscal_period_id,
      voucher_number: 0,
      voucher_series: input.voucher_series || 'A',
      entry_date: input.entry_date,
      description: input.description,
      source_type: input.source_type,
      source_id: input.source_id || null,
      status: 'draft',
    })
    .select()
    .single()

  if (entryError || !entry) {
    throw new Error(`Failed to create draft journal entry: ${entryError?.message}`)
  }

  // Insert journal entry lines with dimensions
  const lineInserts = buildLineInserts(entry.id, input.lines, accountIdMap)

  const { error: linesError } = await supabase
    .from('journal_entry_lines')
    .insert(lineInserts)

  if (linesError) {
    await supabase.from('journal_entries').update({ status: 'cancelled' }).eq('id', entry.id)
    throw new Error(`Failed to create journal entry lines: ${linesError.message}`)
  }

  // Fetch complete entry with lines
  const { data: completeEntry } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', entry.id)
    .single()

  const result = completeEntry as JournalEntry

  await eventBus.emit({
    type: 'journal_entry.drafted',
    payload: { entry: result, userId, companyId },
  })

  return result
}

/**
 * Commit a draft entry: assigns voucher number and transitions to 'posted'
 * Uses the atomic commit_journal_entry RPC so the voucher number increment
 * and status update happen in one transaction. If the balance trigger rejects
 * the entry, the sequence increment rolls back — no burned numbers.
 */
export async function commitEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryId: string
): Promise<JournalEntry> {

  // Atomic: increment voucher sequence + update status in one transaction.
  // Rolls back the sequence if the balance trigger or any constraint fails.
  const { data: rpcResult, error: commitError } = await supabase.rpc('commit_journal_entry', {
    p_company_id: companyId,
    p_entry_id: entryId,
  })

  if (commitError) {
    throw new Error(`Failed to commit journal entry: ${commitError.message}`)
  }

  // Fetch complete posted entry with lines
  const { data: completeEntry } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', entryId)
    .single()

  const result = completeEntry as JournalEntry

  await eventBus.emit({
    type: 'journal_entry.committed',
    payload: { entry: result, userId, companyId },
  })

  return result
}

/**
 * Create a journal entry with lines (verifikation)
 * Convenience wrapper: creates draft + commits in one step.
 * The voucher number is only assigned after lines are successfully inserted,
 * preventing gaps in the voucher sequence (BFL 5 kap. 7§).
 */
export async function createJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateJournalEntryInput
): Promise<JournalEntry> {
  const draft = await createDraftEntry(supabase, companyId, userId, input)
  return commitEntry(supabase, companyId, userId, draft.id)
}

/**
 * Get the current date in Swedish timezone (Europe/Stockholm).
 * Avoids UTC date shift when server runs in a different timezone.
 */
export function getSwedishLocalDate(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date())
}

/**
 * Create a reversal entry for an existing journal entry
 * Sets reversed_by_id/reverses_id links for compliance tracking
 */
export async function reverseEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryId: string,
  reversalDate?: string
): Promise<JournalEntry> {

  // Fetch original entry with lines
  const { data: original, error } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', entryId)
    .eq('company_id', companyId)
    .single()

  if (error || !original) {
    throw new Error('Journal entry not found')
  }

  if (original.status !== 'posted') {
    throw new Error('Can only reverse posted entries')
  }

  const lines = (original.lines as JournalEntryLine[]) || []

  // Create reversed lines (swap debit and credit, preserve dimensions)
  const reversedLines: CreateJournalEntryLineInput[] = lines.map((line) => ({
    account_number: line.account_number,
    debit_amount: line.credit_amount,
    credit_amount: line.debit_amount,
    line_description: `Reversal: ${line.line_description || ''}`,
    currency: line.currency,
    amount_in_currency: line.amount_in_currency
      ? -line.amount_in_currency
      : undefined,
    exchange_rate: line.exchange_rate || undefined,
    tax_code: line.tax_code || undefined,
    cost_center: line.cost_center || undefined,
    project: line.project || undefined,
  }))

  const entryDate = reversalDate || getSwedishLocalDate()

  // Get voucher number for the reversal
  const voucherNumber = await getNextVoucherNumber(
    supabase,
    companyId,
    original.fiscal_period_id,
    original.voucher_series || 'A'
  )

  // Resolve account IDs
  const accountIdMap = await resolveAccountIds(supabase, companyId, reversedLines)

  // Create reversal entry with reverses_id link
  const { data: reversalEntry, error: reversalError } = await supabase
    .from('journal_entries')
    .insert({
      company_id: companyId,
      user_id: userId,
      fiscal_period_id: original.fiscal_period_id,
      voucher_number: voucherNumber,
      voucher_series: original.voucher_series || 'A',
      entry_date: entryDate,
      description: `Makulering: ${original.description}`,
      source_type: 'storno',
      source_id: original.source_id || null,
      reverses_id: entryId,
      status: 'draft',
    })
    .select()
    .single()

  if (reversalError || !reversalEntry) {
    throw new Error(`Failed to create reversal entry: ${reversalError?.message}`)
  }

  // Insert reversal lines with dimensions
  const lineInserts = buildLineInserts(reversalEntry.id, reversedLines, accountIdMap)

  const { error: linesError } = await supabase
    .from('journal_entry_lines')
    .insert(lineInserts)

  if (linesError) {
    await supabase.from('journal_entries').update({ status: 'cancelled' }).eq('id', reversalEntry.id)
    await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', reversalEntry.id)
    throw new Error(`Failed to create reversal lines: ${linesError.message}`)
  }

  // Post the reversal entry
  const { error: postError } = await supabase
    .from('journal_entries')
    .update({ status: 'posted' })
    .eq('id', reversalEntry.id)

  if (postError) {
    await supabase.from('journal_entries').update({ status: 'cancelled' }).eq('id', reversalEntry.id)
    await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', reversalEntry.id)
    throw new Error(`Failed to post reversal entry: ${postError.message}`)
  }

  // Mark original as reversed with reversed_by_id link (CAS guard: only if still 'posted')
  const { data: updatedOriginal, error: casError } = await supabase
    .from('journal_entries')
    .update({
      status: 'reversed',
      reversed_by_id: reversalEntry.id,
    })
    .eq('id', entryId)
    .eq('status', 'posted')
    .select('id')

  if (casError || !updatedOriginal || updatedOriginal.length === 0) {
    // Another concurrent reversal already changed the status — mark the orphaned
    // reversal as cancelled so it's excluded from reports but remains traceable.
    await supabase.from('journal_entries').update({ status: 'cancelled' }).eq('id', reversalEntry.id)
    await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', reversalEntry.id)
    throw new Error('Entry was already reversed by a concurrent operation')
  }

  // Fetch complete reversal entry with lines
  const { data: completeEntry } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', reversalEntry.id)
    .single()

  const result = completeEntry as JournalEntry

  await eventBus.emit({
    type: 'journal_entry.committed',
    payload: { entry: result, userId, companyId },
  })

  return result
}
