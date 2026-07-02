import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'
import {
  AccountsNotInChartError,
  BookkeepingDatabaseError,
  CannotEditNonDraftError,
  CannotReverseNonPostedError,
  CannotReverseStornoError,
  EntryAlreadyReversedError,
  EntryDateOutsideFiscalPeriodError,
  FiscalPeriodNotFoundError,
  JournalEntryNotBalancedError,
  JournalEntryNotFoundError,
} from '@/lib/bookkeeping/errors'
import { resolveDefaultSeriesForSource } from '@/lib/bookkeeping/voucher-series-resolver'
import { normalizeLineDimensions, lineDimensionColumns } from '@/lib/bookkeeping/dimension-resolver'
import { backfillStandardBASAccounts } from '@/lib/bookkeeping/account-backfill'
import { syncInvoiceStatusFromPaymentEntry, isPaymentSourceType } from '@/lib/bookkeeping/payment-sync'
import { getActor } from '@/lib/bookkeeping/actor-context'
import type {
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  JournalEntry,
  JournalEntryLine,
  JournalEntrySourceType,
} from '@/types'

const log = createLogger('bookkeeping.engine')

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
    throw new BookkeepingDatabaseError('get_next_voucher_number', error.message)
  }

  return data as number
}

/**
 * Resolve account IDs from account numbers for a company.
 *
 * By default only active accounts are returned — inactive / never-added
 * accounts surface as "missing" so callers throw AccountsNotInChartError.
 *
 * Pass `{ includeInactive: true }` for reversals: the accounts on an already-
 * committed entry were legitimately active at commit time, and BFL 5 kap 5§
 * requires storno to be possible even if a user has since deactivated one of
 * those accounts. Blocking the reversal would leave the original entry
 * uncorrected with no audit trail.
 */
async function resolveAccountIds(
  supabase: SupabaseClient,
  companyId: string,
  lines: CreateJournalEntryLineInput[],
  options: { includeInactive?: boolean } = {}
): Promise<Map<string, string>> {
  const accountNumbers = [...new Set(lines.map((l) => l.account_number))]

  let query = supabase
    .from('chart_of_accounts')
    .select('id, account_number')
    .eq('company_id', companyId)
    .in('account_number', accountNumbers)

  if (!options.includeInactive) {
    query = query.eq('is_active', true)
  }

  const { data: accounts, error } = await query

  if (error) {
    throw new BookkeepingDatabaseError('resolve_account_ids', error.message)
  }

  const map = new Map<string, string>()
  for (const account of accounts || []) {
    map.set(account.account_number, account.id)
  }

  return map
}

/**
 * Resolve the default voucher_series for a given source_type from
 * company_settings.default_voucher_series_per_source_type. Falls back to 'A'
 * silently when the column isn't present (e.g. older DB snapshot in a test),
 * the lookup fails, or the configured value is invalid.
 *
 * Only called when the caller of createDraftEntry omitted voucher_series.
 * Explicit voucher_series in the input always wins.
 */
async function resolveSeriesFromSettings(
  supabase: SupabaseClient,
  companyId: string,
  sourceType: JournalEntrySourceType,
): Promise<string> {
  try {
    const { data, error } = await supabase
      .from('company_settings')
      .select('default_voucher_series_per_source_type')
      .eq('company_id', companyId)
      .maybeSingle()

    if (error) return 'A'
    return resolveDefaultSeriesForSource(
      data as { default_voucher_series_per_source_type?: Record<string, string> | null } | null,
      sourceType,
    )
  } catch {
    return 'A'
  }
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
  return lines.map((line, index) => {
    // dimensions JSONB is the source of truth; cost_center/project are
    // derived mirrors (dual-write window — see lib/bookkeeping/dimension-resolver.ts)
    const dimensions = normalizeLineDimensions(line)
    return {
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
      dimensions,
      ...lineDimensionColumns(dimensions),
      sort_order: index,
    }
  })
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
    throw new JournalEntryNotBalancedError(balance.totalDebit, balance.totalCredit, 'draft')
  }

  // Validate that entry_date falls within the selected fiscal period
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('name, period_start, period_end')
    .eq('id', input.fiscal_period_id)
    .eq('company_id', companyId)
    .single()

  if (periodError || !period) {
    throw new FiscalPeriodNotFoundError()
  }

  if (input.entry_date < period.period_start || input.entry_date > period.period_end) {
    throw new EntryDateOutsideFiscalPeriodError(
      input.entry_date,
      period.name,
      period.period_start,
      period.period_end
    )
  }

  // Resolve account IDs
  const accountIdMap = await resolveAccountIds(supabase, companyId, input.lines)

  // Validate all account numbers resolved to IDs. Standard BAS accounts are
  // seeded on demand before failing: a minimal chart routinely lacks accounts
  // legitimate flows reach (3740 öresavrundning on the first sub-krona
  // Bankgiro diff, 6580 on a first legal invoice), and throwing here turned
  // those into dead ends. Non-BAS numbers and deliberately deactivated
  // accounts still throw.
  const allAccountNumbers = [...new Set(input.lines.map(l => l.account_number))]
  let missingAccounts = allAccountNumbers.filter(num => !accountIdMap.has(num))
  if (missingAccounts.length > 0) {
    const seeded = await backfillStandardBASAccounts(supabase, companyId, userId, missingAccounts)
    if (seeded.length > 0) {
      const refreshed = await resolveAccountIds(supabase, companyId, input.lines)
      for (const [num, id] of refreshed) accountIdMap.set(num, id)
      missingAccounts = allAccountNumbers.filter(num => !accountIdMap.has(num))
    }
    if (missingAccounts.length > 0) {
      throw new AccountsNotInChartError(missingAccounts)
    }
  }

  // Resolve voucher_series: explicit input wins; otherwise look up the
  // per-source-type default from company_settings (falls back to 'A').
  const resolvedSeries = input.voucher_series
    ? input.voucher_series
    : await resolveSeriesFromSettings(supabase, companyId, input.source_type)

  // Insert journal entry header as draft (voucher_number = 0, will be assigned on commit)
  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .insert({
      company_id: companyId,
      user_id: userId,
      fiscal_period_id: input.fiscal_period_id,
      voucher_number: 0,
      voucher_series: resolvedSeries,
      entry_date: input.entry_date,
      description: input.description,
      source_type: input.source_type,
      source_id: input.source_id || null,
      notes: input.notes || null,
      status: 'draft',
    })
    .select()
    .single()

  if (entryError || !entry) {
    log.error('insert journal_entries draft failed', entryError ?? new Error('no row returned'), {
      operation: 'create_draft_entry',
      companyId,
      userId,
      entityType: 'journal_entry',
      fiscalPeriodId: input.fiscal_period_id,
      sourceType: input.source_type,
      pgCode: (entryError as { code?: string } | null)?.code,
      pgDetails: (entryError as { details?: string } | null)?.details,
      pgHint: (entryError as { hint?: string } | null)?.hint,
    })
    throw new BookkeepingDatabaseError('create_draft_entry', entryError?.message)
  }

  // Insert journal entry lines with dimensions
  const lineInserts = buildLineInserts(entry.id, input.lines, accountIdMap)

  const { error: linesError } = await supabase
    .from('journal_entry_lines')
    .insert(lineInserts)

  if (linesError) {
    log.error('insert journal_entry_lines failed', linesError, {
      operation: 'create_entry_lines',
      companyId,
      userId,
      entityType: 'journal_entry',
      entityId: entry.id,
      lineCount: lineInserts.length,
      pgCode: (linesError as { code?: string }).code,
      pgDetails: (linesError as { details?: string }).details,
      pgHint: (linesError as { hint?: string }).hint,
    })
    const { error: cancelError } = await supabase
      .from('journal_entries')
      .update({ status: 'cancelled' })
      .eq('id', entry.id)
    if (cancelError) {
      log.error('orphan draft cleanup failed (phantom draft remains)', cancelError, {
        operation: 'create_entry_lines.cleanup',
        companyId,
        entityType: 'journal_entry',
        entityId: entry.id,
        pgCode: (cancelError as { code?: string }).code,
      })
    }
    throw new BookkeepingDatabaseError('create_entry_lines', linesError.message)
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
 * Update an existing DRAFT journal entry in place — header + lines. Only drafts
 * are editable; committed entries (posted/reversed/cancelled) are immutable per
 * BFL 5 kap. and rejected with CannotEditNonDraftError (the DB immutability
 * trigger is the backstop). Mirrors createDraftEntry's validate-everything-first
 * order so an unbalanced set, a bad period, or a locked period fails before any
 * row is mutated — the header UPDATE is the first write, so a locked period
 * aborts cleanly with the draft untouched.
 */
export async function updateDraftEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryId: string,
  input: CreateJournalEntryInput
): Promise<JournalEntry> {
  // Load the entry and assert it is an editable draft.
  const { data: existing, error: loadError } = await supabase
    .from('journal_entries')
    .select('id, status, voucher_series')
    .eq('id', entryId)
    .eq('company_id', companyId)
    .single()

  if (loadError || !existing) {
    throw new JournalEntryNotFoundError()
  }
  if (existing.status !== 'draft') {
    throw new CannotEditNonDraftError(existing.status as string)
  }

  // Same balance gate as createDraftEntry.
  const balance = validateBalance(input.lines)
  if (!balance.valid) {
    throw new JournalEntryNotBalancedError(balance.totalDebit, balance.totalCredit, 'draft')
  }

  // Entry date must fall within the selected fiscal period.
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('name, period_start, period_end')
    .eq('id', input.fiscal_period_id)
    .eq('company_id', companyId)
    .single()

  if (periodError || !period) {
    throw new FiscalPeriodNotFoundError()
  }
  if (input.entry_date < period.period_start || input.entry_date > period.period_end) {
    throw new EntryDateOutsideFiscalPeriodError(
      input.entry_date,
      period.name,
      period.period_start,
      period.period_end
    )
  }

  // Resolve account IDs (seeding standard BAS accounts on demand) up front, so
  // the line insert below cannot fail on a missing account — same as create.
  const accountIdMap = await resolveAccountIds(supabase, companyId, input.lines)
  const allAccountNumbers = [...new Set(input.lines.map((l) => l.account_number))]
  let missingAccounts = allAccountNumbers.filter((num) => !accountIdMap.has(num))
  if (missingAccounts.length > 0) {
    const seeded = await backfillStandardBASAccounts(supabase, companyId, userId, missingAccounts)
    if (seeded.length > 0) {
      const refreshed = await resolveAccountIds(supabase, companyId, input.lines)
      for (const [num, id] of refreshed) accountIdMap.set(num, id)
      missingAccounts = allAccountNumbers.filter((num) => !accountIdMap.has(num))
    }
    if (missingAccounts.length > 0) {
      throw new AccountsNotInChartError(missingAccounts)
    }
  }

  const resolvedSeries = input.voucher_series || (existing.voucher_series as string) || 'A'

  // All validation passed — mutate. Update the header first; a locked/closed
  // period blocks this write (enforce_period_lock) before any line is touched.
  // source_type / source_id / status are intentionally preserved.
  const { error: headerError } = await supabase
    .from('journal_entries')
    .update({
      fiscal_period_id: input.fiscal_period_id,
      entry_date: input.entry_date,
      description: input.description,
      voucher_series: resolvedSeries,
      notes: input.notes || null,
    })
    .eq('id', entryId)
    .eq('company_id', companyId)

  if (headerError) {
    throw new BookkeepingDatabaseError('create_draft_entry', headerError.message)
  }

  // Replace the lines: delete the old set, insert the new one.
  const { error: deleteError } = await supabase
    .from('journal_entry_lines')
    .delete()
    .eq('journal_entry_id', entryId)

  if (deleteError) {
    throw new BookkeepingDatabaseError('create_entry_lines', deleteError.message)
  }

  const lineInserts = buildLineInserts(entryId, input.lines, accountIdMap)
  const { error: linesError } = await supabase
    .from('journal_entry_lines')
    .insert(lineInserts)

  if (linesError) {
    log.error('update draft: insert journal_entry_lines failed', linesError, {
      operation: 'create_entry_lines',
      companyId,
      userId,
      entityType: 'journal_entry',
      entityId: entryId,
      lineCount: lineInserts.length,
      pgCode: (linesError as { code?: string }).code,
    })
    throw new BookkeepingDatabaseError('create_entry_lines', linesError.message)
  }

  const { data: completeEntry } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', entryId)
    .single()

  return completeEntry as JournalEntry
}

/**
 * Commit a draft entry: assigns voucher number and transitions to 'posted'
 * Uses the atomic commit_journal_entry RPC so the voucher number increment
 * and status update happen in one transaction. If the balance trigger rejects
 * the entry, the sequence increment rolls back — no burned numbers.
 *
 * Actor attribution: the surrounding runWithActor() scope (set by the
 * approval entry points — commitPendingOperation, web approve routes) is
 * forwarded to the RPC, which stamps journal_entries.committed_actor_* and
 * the audit_log COMMIT row (migration 20260619120000). No scope → NULLs,
 * identical to pre-attribution behaviour.
 */
export async function commitEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryId: string,
  commitMethod?: string,
  rubricVersion?: string
): Promise<JournalEntry> {
  const actor = getActor()

  // Atomic: increment voucher sequence + update status in one transaction.
  // Rolls back the sequence if the balance trigger or any constraint fails.
  const { data: rpcResult, error: commitError } = await supabase.rpc('commit_journal_entry', {
    p_company_id: companyId,
    p_entry_id: entryId,
    p_commit_method: commitMethod ?? null,
    p_rubric_version: rubricVersion ?? null,
    p_actor_type: actor?.type ?? null,
    p_actor_label: actor?.label ?? null,
  })

  if (commitError) {
    log.error('commit_journal_entry RPC failed', commitError, {
      operation: 'commit_entry',
      companyId,
      userId,
      entityType: 'journal_entry',
      entityId: entryId,
      commitMethod: commitMethod ?? null,
      pgCode: (commitError as { code?: string }).code,
      pgDetails: (commitError as { details?: string }).details,
      pgHint: (commitError as { hint?: string }).hint,
    })
    throw new BookkeepingDatabaseError('commit_entry', commitError.message)
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
 *
 * If commitEntry fails (e.g. balance trigger rejection, period lock, RPC error),
 * the orphan draft is cancelled so callers don't leave an undeletable stuck draft.
 * The commit RPC is atomic — no voucher number is burned on failure.
 */
export async function createJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateJournalEntryInput,
  commitMethod?: string,
  rubricVersion?: string
): Promise<JournalEntry> {
  const draft = await createDraftEntry(supabase, companyId, userId, input)
  try {
    return await commitEntry(supabase, companyId, userId, draft.id, commitMethod, rubricVersion)
  } catch (commitError) {
    // CAS guard: only cancel if still in draft. If the RPC actually posted
    // before failing downstream, immutability trigger blocks draft→cancelled
    // on a posted row anyway — the filter just avoids firing the trigger.
    try {
      const { error: cancelError } = await supabase
        .from('journal_entries')
        .update({ status: 'cancelled' })
        .eq('id', draft.id)
        .eq('status', 'draft')
      if (cancelError) {
        log.error('orphan draft cleanup failed (phantom draft remains)', cancelError, {
          operation: 'create_journal_entry.cleanup',
          companyId,
          entityType: 'journal_entry',
          entityId: draft.id,
          pgCode: (cancelError as { code?: string }).code,
        })
      }
    } catch (cleanupErr) {
      // Surface the original commit error, but don't lose the cleanup signal.
      log.error('orphan draft cleanup threw (phantom draft remains)', cleanupErr as Error, {
        operation: 'create_journal_entry.cleanup',
        companyId,
        entityType: 'journal_entry',
        entityId: draft.id,
      })
    }
    throw commitError
  }
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
    throw new JournalEntryNotFoundError()
  }

  if (original.status !== 'posted') {
    throw new CannotReverseNonPostedError(original.status)
  }

  // A storno or correction entry must never itself be reversed: a
  // storno-of-a-storno makes the original verifikat's cancellation chain
  // ambiguous (BFL 5 kap 5§). The UI hides "Återför" for these source types;
  // this is the server-side backstop against a direct API call.
  if (original.source_type === 'storno' || original.source_type === 'correction') {
    throw new CannotReverseStornoError(original.source_type)
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
    dimensions: line.dimensions || undefined,
    cost_center: line.cost_center || undefined,
    project: line.project || undefined,
  }))

  const entryDate = reversalDate ?? original.entry_date

  // Get voucher number for the reversal
  const voucherNumber = await getNextVoucherNumber(
    supabase,
    companyId,
    original.fiscal_period_id,
    original.voucher_series || 'A'
  )

  // Resolve account IDs — include inactive rows. The accounts on the
  // original committed entry were active at commit time; if the user has
  // since toggled one off, the storno must still be allowed to go through
  // (BFL 5 kap 5§). Only a truly missing chart row (rare: would require
  // the row to have been deleted) still throws AccountsNotInChartError.
  const accountIdMap = await resolveAccountIds(supabase, companyId, reversedLines, { includeInactive: true })

  const reversalAccountNumbers = [...new Set(reversedLines.map(l => l.account_number))]
  const missingReversalAccounts = reversalAccountNumbers.filter(num => !accountIdMap.has(num))
  if (missingReversalAccounts.length > 0) {
    throw new AccountsNotInChartError(missingReversalAccounts)
  }

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
    throw new BookkeepingDatabaseError('create_reversal_entry', reversalError?.message)
  }

  // Insert reversal lines with dimensions
  const lineInserts = buildLineInserts(reversalEntry.id, reversedLines, accountIdMap)

  const { error: linesError } = await supabase
    .from('journal_entry_lines')
    .insert(lineInserts)

  if (linesError) {
    await supabase.from('journal_entries').update({ status: 'cancelled' }).eq('id', reversalEntry.id)
    await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', reversalEntry.id)
    throw new BookkeepingDatabaseError('create_reversal_lines', linesError.message)
  }

  // Post the reversal entry
  const { error: postError } = await supabase
    .from('journal_entries')
    .update({ status: 'posted' })
    .eq('id', reversalEntry.id)

  if (postError) {
    await supabase.from('journal_entries').update({ status: 'cancelled' }).eq('id', reversalEntry.id)
    await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', reversalEntry.id)
    throw new BookkeepingDatabaseError('post_reversal_entry', postError.message)
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
    throw new EntryAlreadyReversedError()
  }

  // Unlink any bank transactions booked by the reversed entry so they return
  // to "Att bokföra" and can be booked again from the transactions view.
  // Without this the row keeps pointing at a status='reversed' entry, reads
  // as bokförd forever, and has no re-booking affordance — the agent paths
  // (lib/pending-operations/commit.ts) already did this manually after every
  // reverseEntry call; the dashboard reverse route did not.
  const { error: unlinkError } = await supabase
    .from('transactions')
    .update({ journal_entry_id: null })
    .eq('company_id', companyId)
    .eq('journal_entry_id', entryId)
  if (unlinkError) {
    log.error('failed to unlink transactions from reversed entry', unlinkError, { entryId })
  }

  // If this was a payment entry, sync the linked invoice/supplier-invoice status.
  // Helper is shared with the DELETE journal entry route so both code paths leave
  // the invoice in a consistent state (BFL 5 kap 5§ requires GL reversal; this
  // covers the business-level state that lives outside the GL).
  if (isPaymentSourceType(original.source_type)) {
    await syncInvoiceStatusFromPaymentEntry(supabase, companyId, original as JournalEntry)
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

  await eventBus.emit({
    type: 'journal_entry.reversed',
    payload: { originalEntry: original as JournalEntry, reversalEntry: result, userId, companyId },
  })

  return result
}
