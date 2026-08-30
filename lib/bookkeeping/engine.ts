import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'
import {
  AccountsNotInChartError,
  BookkeepingDatabaseError,
  CannotEditNonDraftError,
  CannotReverseNonPostedError,
  CannotReverseStornoError,
  CorrectionChainTooDeepError,
  EntryAlreadyReversedError,
  EntryDateOutsideFiscalPeriodError,
  FiscalPeriodNotFoundError,
  withUnusedVoucherAllocation,
  JournalEntryNotBalancedError,
  JournalEntryNotFoundError,
} from '@/lib/bookkeeping/errors'
import {
  correctionChainDepth,
  CORRECTION_CHAIN_GUARD_DEPTH,
} from '@/lib/core/bookkeeping/correction-chain'
import { resolveDefaultSeriesForSource } from '@/lib/bookkeeping/voucher-series-resolver'
import {
  normalizeLineDimensions,
  validateEntryDimensions,
} from '@/lib/bookkeeping/dimension-resolver'
import {
  applyDimensionRules,
  assertMandatoryDimensions,
  fetchActiveDimensionRules,
  isDimensionRuleExemptSource,
  isDimensionValidationExemptSource,
} from '@/lib/bookkeeping/dimension-rules'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { backfillStandardBASAccounts } from '@/lib/bookkeeping/account-backfill'
import { syncInvoiceStatusFromPaymentEntry, isPaymentSourceType } from '@/lib/bookkeeping/payment-sync'
import { getActor } from '@/lib/bookkeeping/actor-context'
import type {
  AssetDisposalType,
  AssetJamkningDirection,
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  JournalEntry,
  JournalEntryLine,
  JournalEntrySourceType,
  VatTreatment,
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
 * By default only active accounts are returned: inactive / never-added
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
 * including tax_code and the dimensions bag
 */
function buildLineValues(
  lines: CreateJournalEntryLineInput[],
  accountIdMap: Map<string, string>
) {
  return lines.map((line, index) => {
    // dimensions JSONB is the single source of truth; cost_center/project
    // are GENERATED columns derived from keys '1'/'6' since the PR9 cutover
    // (20260702230000): writing them explicitly would error.
    const dimensions = normalizeLineDimensions(line)
    return {
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
      sort_order: index,
    }
  })
}

function buildLineInserts(
  entryId: string,
  lines: CreateJournalEntryLineInput[],
  accountIdMap: Map<string, string>
) {
  return buildLineValues(lines, accountIdMap).map((line) => ({
    journal_entry_id: entryId,
    ...line,
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
    throw new JournalEntryNotBalancedError(balance.totalDebit, balance.totalCredit, 'draft')
  }

  // Account dimension rules (dimensions PR10): apply 'default'/'fixed'
  // values onto the line bags before validation + insert. Zero rules —
  // every company by default — returns the input untouched; a failed rule
  // fetch fails open like the soft validation below. System-generated and
  // correction sources are exempt — policy governs new business events,
  // never imported history or bokslut mechanics.
  const ruleExempt = isDimensionRuleExemptSource(input.source_type)
  const rules = ruleExempt ? [] : await fetchActiveDimensionRules(supabase, companyId)
  if (rules === null) {
    log.warn('dimension rule fetch failed — defaults/fixed skipped (fail-open)', { companyId })
  }
  const lines = rules ? applyDimensionRules(input.lines, rules) : input.lines

  // Soft dimension validation (dimensions plan PR3): free for untagged
  // entries; free-text passthrough unless company_settings.dimensions_enabled;
  // enabled companies get registry validation with a typed Swedish rejection.
  // Runs before any insert so a rejection leaves no orphan rows. Reversal/
  // storno/correction paths bypass this: they copy posted data verbatim.
  // Accrual dissolutions bypass it for exactly that reason too: they replay
  // the origin entry's bag, so a value archived after the origin was posted
  // must not be able to strand the remaining months as pending and leave the
  // interim 17xx/29xx account overstated. See
  // DIMENSION_VALIDATION_EXEMPT_SOURCE_TYPES.
  if (!isDimensionValidationExemptSource(input.source_type)) {
    await validateEntryDimensions(supabase, companyId, lines)
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
  const lineInserts = buildLineInserts(entry.id, lines, accountIdMap)

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
 * Update an existing DRAFT journal entry in place: header + lines. Only drafts
 * are editable; committed entries (posted/reversed/cancelled) are immutable per
 * BFL 5 kap. and rejected with CannotEditNonDraftError (the DB immutability
 * trigger is the backstop). Mirrors createDraftEntry's validate-everything-first
 * order so an unbalanced set, a bad period, or a locked period fails before any
 * row is mutated: the header UPDATE is the first write, so a locked period
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

  // Same soft dimension validation as createDraftEntry: before any write, so
  // a rejection leaves both the header and the existing lines untouched.
  // Account dimension rules (PR10) apply first — same as create. Gate on
  // the STORED source_type (updates preserve it; the input's copy is not
  // authoritative here).
  const ruleExempt = isDimensionRuleExemptSource(
    (existing as { source_type?: string }).source_type
  )
  const rules = ruleExempt ? [] : await fetchActiveDimensionRules(supabase, companyId)
  if (rules === null) {
    log.warn('dimension rule fetch failed — defaults/fixed skipped (fail-open)', { companyId })
  }
  const lines = rules ? applyDimensionRules(input.lines, rules) : input.lines
  await validateEntryDimensions(supabase, companyId, lines)

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
  // the line insert below cannot fail on a missing account: same as create.
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

  // All validation passed: mutate. Update the header first; a locked/closed
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

  const lineInserts = buildLineInserts(entryId, lines, accountIdMap)
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
 * the entry, the sequence increment rolls back: no burned numbers.
 *
 * Actor attribution: the surrounding runWithActor() scope (set by the
 * approval entry points: commitPendingOperation, web approve routes) is
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

  // Mandatory dimension rules (dimensions PR10): 'required' rules bite when
  // the verifikat is about to become immutable — drafts may be incomplete,
  // posting may not. Zero active rules (the default) skips the line fetch
  // entirely; a failed rule fetch fails open (transient DB errors must not
  // block bookkeeping). Reversal/correction paths never pass through
  // commitEntry, so history always reverses regardless of policy.
  const rules = await fetchActiveDimensionRules(supabase, companyId)
  if (rules === null) {
    // Deliberate fail-open, but LOUD: a transient policy-table error must not
    // block month-end bookings company-wide, yet a silently skipped control
    // is invisible — the warning makes the degradation observable.
    log.warn('dimension rule fetch failed — mandatory enforcement skipped (fail-open)', {
      companyId,
      entityId: entryId,
    })
  } else if (rules.some((r) => r.rule_type === 'required')) {
    // READ ONLY: this is a pre-commit policy check, not a write. The two-step
    // fetch (lib/bookkeeping/entry-lines.ts) replaces a
    // `journal_entries!inner(source_type)` embed so no query in the commit
    // path can compile to the correlated LATERAL join that scans every
    // tenant's journal_entry_lines. The parent is reattached under the same
    // `journal_entries` key, so the exemption read below is unchanged. The
    // entry-side company_id filter is defense in depth (repo convention);
    // commitEntry is always called with the entry's own company.
    type RuleLine = {
      account_number: string
      dimensions: Record<string, string>
      journal_entries: { source_type: string }
    }
    let typedLines: RuleLine[] | null = null
    try {
      typedLines = await fetchEntryLines<RuleLine>({
        supabase,
        entryColumns: 'source_type',
        lineColumns: 'account_number, dimensions',
        filterEntries: (q: EntryLinesQuery) => q.eq('id', entryId).eq('company_id', companyId),
      })
    } catch {
      typedLines = null
    }
    if (!typedLines) {
      log.warn('line fetch for mandatory dimension check failed — enforcement skipped (fail-open)', {
        companyId,
        entityId: entryId,
      })
    } else {
      // System/correction sources are exempt — see
      // DIMENSION_RULE_EXEMPT_SOURCE_TYPES (imported history, bokslut
      // mechanics and credit instruments must never be blocked by policy).
      // source_type is a HEADER column (journal_entries) — the join repeats
      // the same value on every line, so reading lines[0] IS reading the
      // entry header; lines cannot mix source types.
      if (!isDimensionRuleExemptSource(typedLines[0]?.journal_entries?.source_type)) {
        assertMandatoryDimensions(typedLines, rules)
      }
    }
  }

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

export interface CommitAssetDisposalInput {
  asset_id: string
  fiscal_period_id: string
  disposal_type: AssetDisposalType
  disposed_at: string
  disposed_proceeds: number
  proceeds_vat: number
  vat_treatment: VatTreatment | null
  current_depreciation: number
  jamkning_amount: number
  jamkning_direction: AssetJamkningDirection
  jamkning_remaining_years: number | null
  jamkning_total_years: number | null
  jamkning_original_input_vat: number | null
  jamkning_original_deduction_percent: number | null
  jamkning_new_deduction_percent: number | null
}

/**
 * Commit a prepared asset-disposal draft and update the asset register in the
 * same database transaction. The dedicated RPC delegates voucher numbering to
 * commit_journal_entry, so disposal cannot leave a posted voucher without the
 * corresponding immutable register state.
 */
export async function commitAssetDisposal(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryId: string | null,
  input: CommitAssetDisposalInput,
): Promise<JournalEntry | null> {
  const actor = getActor()
  const { error } = await supabase.rpc('commit_asset_disposal', {
    p_company_id: companyId,
    p_asset_id: input.asset_id,
    p_entry_id: entryId,
    p_fiscal_period_id: input.fiscal_period_id,
    p_disposal_type: input.disposal_type,
    p_disposed_at: input.disposed_at,
    p_disposed_proceeds: input.disposed_proceeds,
    p_proceeds_vat: input.proceeds_vat,
    p_vat_treatment: input.vat_treatment,
    p_current_depreciation: input.current_depreciation,
    p_jamkning_amount: input.jamkning_amount,
    p_jamkning_direction: input.jamkning_direction,
    p_jamkning_remaining_years: input.jamkning_remaining_years,
    p_jamkning_total_years: input.jamkning_total_years,
    p_jamkning_original_input_vat: input.jamkning_original_input_vat,
    p_jamkning_original_deduction_percent: input.jamkning_original_deduction_percent,
    p_jamkning_new_deduction_percent: input.jamkning_new_deduction_percent,
    p_actor_type: actor?.type ?? null,
    p_actor_label: actor?.label ?? null,
  })

  if (error) {
    log.error('commit_asset_disposal RPC failed', error, {
      operation: 'commit_asset_disposal',
      companyId,
      userId,
      entityType: 'asset',
      entityId: input.asset_id,
      journalEntryId: entryId,
      pgCode: (error as { code?: string }).code,
    })
    throw new BookkeepingDatabaseError('commit_asset_disposal', error.message)
  }

  if (!entryId) return null

  // The RPC has already committed the voucher and the register update at this
  // point. A transient reload failure must not masquerade as a failed
  // disposal, so retry once and log the divergence before surfacing it.
  let completeEntry: JournalEntry | null = null
  let lastFetchError: { message: string } | null = null
  for (let attempt = 0; attempt < 2 && !completeEntry; attempt++) {
    const { data, error: fetchError } = await supabase
      .from('journal_entries')
      .select('*, lines:journal_entry_lines(*)')
      .eq('id', entryId)
      .eq('company_id', companyId)
      .single()
    if (data && !fetchError) {
      completeEntry = data as JournalEntry
    } else {
      lastFetchError = fetchError ?? { message: 'posted entry not found' }
    }
  }

  if (!completeEntry) {
    log.error(
      'asset disposal committed but posted entry reload failed',
      lastFetchError,
      {
        operation: 'commit_asset_disposal',
        companyId,
        userId,
        entityType: 'asset',
        entityId: input.asset_id,
        journalEntryId: entryId,
      },
    )
    throw new BookkeepingDatabaseError(
      'fetch_asset_disposal_entry',
      `disposal voucher is committed but could not be reloaded: ${
        lastFetchError?.message ?? 'posted entry not found'
      }`,
    )
  }

  const result = completeEntry
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
 * The commit RPC is atomic: no voucher number is burned on failure.
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
    // on a posted row anyway: the filter just avoids firing the trigger.
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

export interface OpeningBalanceReplacementResult {
  newEntryId: string
  stornoEntryId: string
  newVoucherNumber: number
  stornoVoucherNumber: number
}

/**
 * Atomically replace a period's posted opening balance with a new engine
 * voucher and a storno of the old voucher. The database function owns the
 * period row lock, authorization, compare-and-swap check, voucher commits,
 * status transition, and pointer swap in one transaction.
 */
export async function replaceOpeningBalanceEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  expectedOldEntryId: string,
  input: CreateJournalEntryInput,
): Promise<OpeningBalanceReplacementResult> {
  if (input.source_type !== 'opening_balance') {
    throw new BookkeepingDatabaseError(
      'replace_opening_balance',
      'Replacement entry must use source_type opening_balance',
    )
  }

  const balance = validateBalance(input.lines)
  if (!balance.valid) {
    throw new JournalEntryNotBalancedError(
      balance.totalDebit,
      balance.totalCredit,
      'draft',
    )
  }

  await validateEntryDimensions(supabase, companyId, input.lines)

  const accountIdMap = await resolveAccountIds(supabase, companyId, input.lines)
  const accountNumbers = [...new Set(input.lines.map((line) => line.account_number))]
  let missingAccounts = accountNumbers.filter((number) => !accountIdMap.has(number))

  if (missingAccounts.length > 0) {
    const seeded = await backfillStandardBASAccounts(
      supabase,
      companyId,
      userId,
      missingAccounts,
    )
    if (seeded.length > 0) {
      const refreshed = await resolveAccountIds(supabase, companyId, input.lines)
      for (const [number, id] of refreshed) accountIdMap.set(number, id)
      missingAccounts = accountNumbers.filter((number) => !accountIdMap.has(number))
    }
    if (missingAccounts.length > 0) {
      throw new AccountsNotInChartError(missingAccounts)
    }
  }

  const voucherSeries = input.voucher_series
    ?? await resolveSeriesFromSettings(supabase, companyId, 'opening_balance')
  const preparedLines = buildLineValues(input.lines, accountIdMap)
  const actor = getActor()

  const { data, error } = await supabase.rpc('commit_opening_balance_replacement', {
    p_company_id: companyId,
    p_period_id: input.fiscal_period_id,
    p_expected_old_entry_id: expectedOldEntryId,
    p_user_id: userId,
    p_entry_date: input.entry_date,
    p_description: input.description,
    p_voucher_series: voucherSeries,
    p_lines: preparedLines,
    p_actor_type: actor?.type ?? null,
    p_actor_label: actor?.label ?? null,
  })

  if (error) {
    log.error('commit_opening_balance_replacement RPC failed', error, {
      operation: 'replace_opening_balance',
      companyId,
      userId,
      entityType: 'journal_entry',
      entityId: expectedOldEntryId,
      fiscalPeriodId: input.fiscal_period_id,
      pgCode: (error as { code?: string }).code,
      pgDetails: (error as { details?: string }).details,
      pgHint: (error as { hint?: string }).hint,
    })
    throw new BookkeepingDatabaseError('replace_opening_balance', error.message)
  }

  type RpcRow = {
    new_entry_id: string
    storno_entry_id: string
    new_voucher_number: number
    storno_voucher_number: number
  }
  const row = (Array.isArray(data) ? data[0] : data) as RpcRow | null
  if (!row?.new_entry_id || !row.storno_entry_id) {
    throw new BookkeepingDatabaseError(
      'replace_opening_balance',
      'Atomic replacement returned no journal entry ids',
    )
  }

  const result: OpeningBalanceReplacementResult = {
    newEntryId: row.new_entry_id,
    stornoEntryId: row.storno_entry_id,
    newVoucherNumber: row.new_voucher_number,
    stornoVoucherNumber: row.storno_voucher_number,
  }

  const { data: entries, error: entriesError } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('company_id', companyId)
    .in('id', [expectedOldEntryId, result.newEntryId, result.stornoEntryId])

  if (entriesError) {
    log.error('atomic opening balance replacement committed but entry refresh failed', entriesError, {
      companyId,
      entityId: result.newEntryId,
    })
    return result
  }

  const byId = new Map(
    ((entries ?? []) as JournalEntry[]).map((entry) => [entry.id, entry]),
  )
  const originalEntry = byId.get(expectedOldEntryId)
  const newEntry = byId.get(result.newEntryId)
  const stornoEntry = byId.get(result.stornoEntryId)

  if (!originalEntry || !newEntry || !stornoEntry) {
    log.error(
      'atomic opening balance replacement committed but event entries are missing',
      new Error('journal entry refresh returned incomplete replacement data'),
      {
        companyId,
        expectedOldEntryId,
        newEntryId: result.newEntryId,
        stornoEntryId: result.stornoEntryId,
        missingOriginalEntry: !originalEntry,
        missingNewEntry: !newEntry,
        missingStornoEntry: !stornoEntry,
      },
    )
  }

  if (newEntry) {
    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: newEntry, userId, companyId },
    })
  }
  if (stornoEntry) {
    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: stornoEntry, userId, companyId },
    })
  }
  if (originalEntry && stornoEntry) {
    await eventBus.emit({
      type: 'journal_entry.reversed',
      payload: { originalEntry, reversalEntry: stornoEntry, userId, companyId },
    })
  }

  return result
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
  reversalDate?: string,
  options?: {
    /**
     * Bypass the correction-chain depth guard: reversing an entry that is
     * already CORRECTION_CHAIN_GUARD_DEPTH+ links deep throws
     * CorrectionChainTooDeepError unless set (see storno-service correctEntry).
     */
    allowDeepChain?: boolean
  }
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

  // A storno entry must never itself be reversed: a storno-of-a-storno makes
  // the original verifikat's cancellation chain ambiguous (BFL 5 kap 5§). A
  // correction entry, by contrast, is a regular live verifikation and must
  // stay reversible: it can be a duplicate (the affärshändelse already booked
  // by another verifikat) or plain wrong, and blocking it left users with no
  // sanctioned way out (support case 2026-07-26). Its correction_of_id link
  // keeps the chain traceable either way; the original it corrected stays
  // 'reversed'. The UI hides "Återför" for stornos; this is the server-side
  // backstop against a direct API call.
  if (original.source_type === 'storno') {
    throw new CannotReverseStornoError(original.source_type)
  }

  // Chain-depth guard: a storno on an entry already deep in a rättelse chain
  // is almost always an agent reflexively cancelling its own correction
  // (Christoffer case 2026-08-11). Same guard and bypass as correctEntry.
  if (!options?.allowDeepChain) {
    const chain = await correctionChainDepth(supabase, companyId, original)
    if (chain.depth >= CORRECTION_CHAIN_GUARD_DEPTH) {
      throw new CorrectionChainTooDeepError(chain.depth, chain.rootVoucher)
    }
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
  const unusedVoucherAllocation = {
    fiscalPeriodId: original.fiscal_period_id,
    voucherSeries: original.voucher_series || 'A',
    voucherNumber,
  }

  // Resolve account IDs: include inactive rows. The accounts on the
  // original committed entry were active at commit time; if the user has
  // since toggled one off, the storno must still be allowed to go through
  // (BFL 5 kap 5§). Only a truly missing chart row (rare: would require
  // the row to have been deleted) still throws AccountsNotInChartError.
  let accountIdMap: Map<string, string>
  try {
    accountIdMap = await resolveAccountIds(supabase, companyId, reversedLines, { includeInactive: true })
  } catch (resolveError) {
    // The sequence RPC committed, but no reversal row exists yet. Carry the
    // exact unused number so the caller can document this real gap.
    throw withUnusedVoucherAllocation(resolveError, unusedVoucherAllocation)
  }

  const reversalAccountNumbers = [...new Set(reversedLines.map(l => l.account_number))]
  const missingReversalAccounts = reversalAccountNumbers.filter(num => !accountIdMap.has(num))
  if (missingReversalAccounts.length > 0) {
    throw withUnusedVoucherAllocation(
      new AccountsNotInChartError(missingReversalAccounts),
      unusedVoucherAllocation,
    )
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

  if (reversalError) {
    // PostgreSQL rejected the insert, so the allocated number is confirmed
    // unused and can be explained without guessing from the original entry.
    throw withUnusedVoucherAllocation(
      new BookkeepingDatabaseError('create_reversal_entry', reversalError.message),
      unusedVoucherAllocation,
    )
  }
  if (!reversalEntry) {
    // No database error means the outcome is ambiguous. Do not label the
    // number unused unless the engine has a confirmed failure state.
    throw new BookkeepingDatabaseError('create_reversal_entry', undefined)
  }

  // Insert reversal lines with dimensions
  const lineInserts = buildLineInserts(reversalEntry.id, reversedLines, accountIdMap)

  const { error: linesError } = await supabase
    .from('journal_entry_lines')
    .insert(lineInserts)

  if (linesError) {
    // Keep the reversal header as cancelled bookkeeping evidence. The gap
    // detector counts every non-draft header, including cancelled rows, so
    // this allocation is still used and must not be labelled as a gap.
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
    // As above, cleanup preserves the allocated voucher on the cancelled
    // header. A failed or ambiguous cleanup also cannot prove it unused.
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
    // Another concurrent reversal already changed the status: mark the orphaned
    // reversal as cancelled so it's excluded from reports but remains traceable.
    // Its header still occupies the voucher number, so no gap metadata applies.
    await supabase.from('journal_entries').update({ status: 'cancelled' }).eq('id', reversalEntry.id)
    await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', reversalEntry.id)
    throw new EntryAlreadyReversedError()
  }

  // Unlink any bank transactions booked by the reversed entry so they return
  // to "Att bokföra" and can be booked again from the transactions view.
  // Without this the row keeps pointing at a status='reversed' entry, reads
  // as bokförd forever, and has no re-booking affordance: the agent paths
  // (lib/pending-operations/commit.ts) already did this manually after every
  // reverseEntry call; the dashboard reverse route did not.
  //
  // The worklist's "unbooked" predicate is is_business IS NULL (see
  // lib/worklist/types.ts), not journal_entry_id IS NULL, so clearing only the
  // link left the stornoed row invisible in Att bokföra and in the nav badge
  // (#1950) while the storno dialog (reverse_warning) promised the return.
  // The engine therefore resets the same triple the uncategorize paths write
  // (is_business, category, journal_entry_id), plus reconciliation_method:
  // it describes how the link was made, and the link is gone (the koppla-bort
  // path in lib/reconciliation/bank-reconciliation.ts resets it the same way).
  const { error: unlinkError } = await supabase
    .from('transactions')
    .update({
      journal_entry_id: null,
      is_business: null,
      category: null,
      reconciliation_method: null,
    })
    .eq('company_id', companyId)
    .eq('journal_entry_id', entryId)
  if (unlinkError) {
    log.error('failed to unlink transactions from reversed entry', unlinkError, { entryId })
  }

  // Same promise, second anchor. Bulk-booked rows (bulk_book_transactions RPC)
  // and residual verifikat (lib/reconciliation/residual.ts) anchor bank lines
  // through transaction_voucher_links; for a samlingsverifikat with N>1 rows
  // that junction is the ONLY anchor (journal_entry_id stays NULL), so the
  // UPDATE above matches nothing and all N rows keep is_business = true
  // against a status='reversed' entry. The link rows go the way koppla-bort
  // removes them, and a row returns to Att bokföra only when no anchor is
  // left: a residual booking keeps the main verifikat in journal_entry_id
  // while its junction row points at the small residual verifikat, and
  // stornoing the residual must not put a still-booked row back in the list.
  const { data: junctionRows, error: junctionReadError } = await supabase
    .from('transaction_voucher_links')
    .select('transaction_id')
    .eq('company_id', companyId)
    .eq('journal_entry_id', entryId)
  if (junctionReadError) {
    log.error('failed to read voucher links of reversed entry', junctionReadError, { entryId })
  } else if (junctionRows && junctionRows.length > 0) {
    const junctionTxIds = [
      ...new Set((junctionRows as Array<{ transaction_id: string }>).map((r) => r.transaction_id)),
    ]
    const { error: junctionDeleteError } = await supabase
      .from('transaction_voucher_links')
      .delete()
      .eq('company_id', companyId)
      .eq('journal_entry_id', entryId)
    if (junctionDeleteError) {
      log.error('failed to delete voucher links of reversed entry', junctionDeleteError, { entryId })
    } else {
      const { data: remainingRows, error: remainingError } = await supabase
        .from('transaction_voucher_links')
        .select('transaction_id, role, allocated_amount')
        .eq('company_id', companyId)
        .in('transaction_id', junctionTxIds)
      if (remainingError) {
        log.error('failed to read remaining voucher links after storno', remainingError, {
          entryId,
        })
      } else {
        const remainingByTx = new Map<string, Array<{ role: string; allocated_amount: number }>>()
        for (const row of (remainingRows ?? []) as Array<{
          transaction_id: string
          role?: string | null
          allocated_amount?: number | string | null
        }>) {
          const rows = remainingByTx.get(row.transaction_id) ?? []
          rows.push({ role: row.role ?? 'bank_line', allocated_amount: Number(row.allocated_amount ?? 0) })
          remainingByTx.set(row.transaction_id, rows)
        }
        // A row split over several verifikat (1:N, lib/reconciliation/
        // bank-reconciliation.ts linkTransactionToVouchers) is anchored by
        // 'bank_line' slices that sum to its amount. Reversing one of them
        // leaves a partial anchor: the row would read as booked while the
        // ledger no longer explains it, and the reconciliation difference
        // would move by the reversed slice with nothing to act on. Such a
        // row goes back to Att bokföra whole: the surviving slices are
        // dropped (their vouchers surface as unmatched again) and the row is
        // released like a bulk-booked one. Rows whose remaining anchors
        // still sum to the amount (bulk-book, one row per transaction) or
        // include a non-bank_line anchor (a residual booking) are untouched.
        const partialSplitIds: string[] = []
        const candidates = junctionTxIds.filter((id) => (remainingByTx.get(id) ?? []).length > 0)
        if (candidates.length > 0) {
          const { data: txRows, error: txReadError } = await supabase
            .from('transactions')
            .select('id, amount, journal_entry_id')
            .eq('company_id', companyId)
            .in('id', candidates)
          if (txReadError) {
            log.error('failed to read split transactions after storno', txReadError, { entryId })
          } else {
            for (const tx of (txRows ?? []) as Array<{
              id: string
              amount: number | string | null
              journal_entry_id: string | null
            }>) {
              if (tx.journal_entry_id) continue
              const rows = remainingByTx.get(tx.id) ?? []
              if (!rows.every((r) => r.role === 'bank_line')) continue
              const anchored = rows.reduce((sum, r) => sum + r.allocated_amount, 0)
              if (Math.abs(Math.round((anchored - Number(tx.amount ?? 0)) * 100) / 100) > 0.005) {
                partialSplitIds.push(tx.id)
              }
            }
          }
        }
        if (partialSplitIds.length > 0) {
          const { error: partialDeleteError } = await supabase
            .from('transaction_voucher_links')
            .delete()
            .eq('company_id', companyId)
            .in('transaction_id', partialSplitIds)
          if (partialDeleteError) {
            log.error('failed to drop the surviving slices of a split transaction after storno', partialDeleteError, {
              entryId,
            })
          }
        }
        const stillAnchored = new Set(
          [...remainingByTx.keys()].filter((id) => !partialSplitIds.includes(id)),
        )
        const releaseIds = junctionTxIds.filter((id) => !stillAnchored.has(id))
        if (releaseIds.length > 0) {
          const { error: releaseError } = await supabase
            .from('transactions')
            .update({ is_business: null, category: null, reconciliation_method: null })
            .eq('company_id', companyId)
            .in('id', releaseIds)
            .is('journal_entry_id', null)
          if (releaseError) {
            log.error('failed to release junction-linked transactions of reversed entry', releaseError, {
              entryId,
            })
          }
        }
      }
    }
  }

  // Same hazard one table over: a period whose opening_balance_entry_id still
  // points at the entry we just reversed. getOpeningBalances() reads the linked
  // entry's lines directly with no status filter, so the Balansrapport would go
  // on showing a cancelled IB, and year-end refuses to run while the link is
  // non-null ("Next fiscal period already has opening balance entry posted;
  // reverse it before re-running year-end"): advice the storno itself could
  // never satisfy, leaving no in-app way out. Clearing the link falls
  // getOpeningBalances through to the duplicate-safe
  // compute_prior_opening_balances RPC, and lets year-end re-book the IB.
  //
  // Two statements, not one: enforce_opening_balance_immutability rejects any
  // UPDATE that changes opening_balance_entry_id while OLD.opening_balances_set
  // is still true, so the flag must fall first (same order, and same reason, as
  // the replace_period_opening_balance_link RPC). Both are scoped to this
  // entryId, so a period already pointing elsewhere is untouched and callers
  // that storno an old IB then relink a fresh one (opening-balance/correct)
  // still win: they relink after this returns.
  if (original.source_type === 'opening_balance') {
    const { error: obFlagError } = await supabase
      .from('fiscal_periods')
      .update({ opening_balances_set: false })
      .eq('company_id', companyId)
      .eq('opening_balance_entry_id', entryId)

    if (obFlagError) {
      log.error('failed to clear opening_balances_set on reversed IB period', obFlagError, {
        entryId,
      })
    } else {
      const { error: obUnlinkError } = await supabase
        .from('fiscal_periods')
        .update({ opening_balance_entry_id: null })
        .eq('company_id', companyId)
        .eq('opening_balance_entry_id', entryId)
      if (obUnlinkError) {
        log.error('failed to unlink reversed opening balance entry from period', obUnlinkError, {
          entryId,
        })
      }
    }
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
