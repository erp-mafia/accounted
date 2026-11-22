import type { SupabaseClient } from '@supabase/supabase-js'
import type { SIEChunkResult, SIEJob } from '@/lib/import/sie-job-contract'
import type { ScopeFreeLinkBasis } from '@/lib/links/link-basis'

import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'
import { lineBalance, storedLineValues } from './line-balance'
import { withBankLegCurrency } from './bank-booking-context'
import { isCashAccountBusy, retryWhileCashAccountBusy } from './cash-account-busy'
import { isPeriodLockRefusal } from '@/lib/errors/get-structured-error'
import {
  AccountsNotInChartError,
  AssetComponentRefusedError,
  AssetComponentsChangedError,
  AssetDepreciationRefusedError,
  AssetOpeningChangedError,
  AssetValueAdjustmentBlockedError,
  BookkeepingDatabaseError,
  ContractRevenueRefusedError,
  contractRevenueRefusalFromRpc,
  DeferredTaxAlreadyPostedError,
  K3TransitionBlockedError,
  k3TransitionBlockFromRpc,
  CannotCancelNonDraftError,
  CannotEditNonDraftError,
  CannotReverseNonPostedError,
  CannotReverseStornoError,
  CannotReverseCollectedPaymentError,
  CorrectionChainTooDeepError,
  CutoffCarryReversalDateError,
  EntryAlreadyReversedError,
  EntryDateOutsideFiscalPeriodError,
  FiscalPeriodNotFoundError,
  KontantmetodCarryHasSettlementsError,
  JournalEntryNotBalancedError,
  JournalLineNegativeAmountError,
  JournalLineBothSidesNonZeroError,
  JournalEntryNotFoundError,
  UnattendedCommitLimitExceededError,
  AccrualDraftPostedByScheduleError,
  valueAdjustmentBlockFromRpc,
  type BookkeepingOperation,
} from '@/lib/bookkeeping/errors'
import {
  correctionChainDepth,
  CORRECTION_CHAIN_GUARD_DEPTH,
} from '@/lib/core/bookkeeping/correction-chain'
import { assertStornoTarget } from '@/lib/core/bookkeeping/storno-target'
import { resolveDefaultSeriesForSource } from '@/lib/bookkeeping/voucher-series-resolver'
import { validateEntryDimensions } from '@/lib/bookkeeping/dimension-resolver'
import {
  applyDimensionRules,
  assertMandatoryDimensions,
  fetchActiveDimensionRules,
  isDimensionRuleExemptSource,
  isDimensionValidationExemptSource,
} from '@/lib/bookkeeping/dimension-rules'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { buildStornoLines } from '@/lib/bookkeeping/line-side'
import { backfillStandardBASAccounts } from '@/lib/bookkeeping/account-backfill'
import { isPaymentSourceType } from '@/lib/bookkeeping/payment-sync'
import { selectReversalHooks, type ReversalHookAfterContext, type ReversalHookContext } from '@/lib/bookkeeping/reversal-hooks'
import { REVERSAL_HOOKS } from '@/lib/composition/reversal-hooks'
import { defaultCommitMethod, getActor } from '@/lib/bookkeeping/actor-context'
import { rpcWithActor } from '@/lib/bookkeeping/actor-rpc'
import { assertLinesWithinUnattendedCeiling, entryUnattendedCeilingRefusal } from '@/lib/bookkeeping/unattended-ceiling'
import { commitAsReviewed, isBookingReviewRefusal } from '@/lib/bookkeeping/booking-review-commit'
import { linkBusinessEventToDraft, type BusinessEventLink, type SqlBusinessEventLink } from '@/lib/bookkeeping/business-event-link'
import { callWithBusinessEvents } from '@/lib/bookkeeping/business-event-rpc'
import type { PayoutFeeLine } from '@/lib/bookkeeping/payout-fee-lines'
import type { SupplierDebtLine } from '@/lib/bookkeeping/supplier-debt-lines'
import {
  findKontantmetodCarry,
  kontantmetodCarryHasSettlements,
} from '@/lib/bookkeeping/kontantmetod-carry-guard'
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

/**
 * The only application entry point for a durable SIE voucher commit.
 *
 * Deliberately emits no journal_entry.committed, unlike the other posting
 * RPC doors in this file: an import brings in history that was posted
 * elsewhere, often thousands of vouchers, and announcing each would flood
 * webhook subscribers. The same holds for the undo below.
 */
export async function commitSIEImportChunk(supabase: SupabaseClient, job: SIEJob, chunk: number, phase: 'vouchers' | 'finalize'): Promise<SIEChunkResult> {
  const { data, error } = await supabase.rpc('import_sie_chunk', {
    p_company_id: job.company_id, p_import_id: job.id, p_worker_id: job.worker_id,
    p_attempt: job.job_attempt, p_phase: phase, p_chunk_no: chunk,
  })
  if (error) throw new BookkeepingDatabaseError('import_sie_chunk', error.message)
  if (!data) throw new BookkeepingDatabaseError('import_sie_chunk', 'Missing completion receipt')
  return data as SIEChunkResult
}

/**
 * Reversals and their receipt commit together under the execution lease.
 * Silent like the import itself: no journal_entry.committed per storno.
 */
export async function reverseSIEImportChunk(supabase: SupabaseClient, job: SIEJob): Promise<{ reversed: number; done: boolean }> {
  const rpc = job.job_kind === 'duplicate_repair' ? 'undo_sie_duplicate_repair_chunk' : 'undo_sie_import_chunk'
  const { data, error } = await supabase.rpc(rpc, {
    p_company_id: job.company_id, p_import_id: job.id, p_worker_id: job.worker_id, p_attempt: job.job_attempt,
  })
  if (error) throw new BookkeepingDatabaseError(rpc, error.message)
  return data as { reversed: number; done: boolean }
}

const log = createLogger('bookkeeping.engine')

/**
 * Log a failed journal write. A refusal the database raises on purpose is a
 * warning: a PT409 conflict (a busy bank account, a bank row that changed
 * under the booking), which the doors answer as a 409 to retry or refresh,
 * and a write behind a period lock or the lock date, answered as a 4xx.
 * Logged at error they filled Vercel's runtime errors with expected
 * answers. Anything else stays an error.
 */
function logWriteFailure(message: string, error: unknown, context: Record<string, unknown>): void {
  const expected = (error as { code?: unknown } | null)?.code === 'PT409' || isPeriodLockRefusal(error)
  if (expected) log.warn(message, error, context)
  else log.error(message, error, context)
}

/**
 * Validate that a set of journal entry lines is balanced (debits = credits)
 */
export function validateBalance(lines: CreateJournalEntryLineInput[]): {
  valid: boolean
  totalDebit: number
  totalCredit: number
} {
  const { balanced, totalDebit, totalCredit } = lineBalance(lines)
  return { valid: balanced, totalDebit, totalCredit }
}

/**
 * Enforce the one-side invariant every journal line carries: exactly one of
 * debit_amount / credit_amount is above zero, and neither is below zero.
 *
 * `validateBalance` above sums the two columns and can see neither half of
 * this, which is why the engine has to:
 *
 *   - a negative debit nets like a credit, so the totals still match. The
 *     row is stored, but every reader assumes one non-negative side: the
 *     verifikat page hides it and the visible sums disagree.
 *   - a line with BOTH sides above zero cancels itself. The totals still
 *     match, so the entry posts as a nollverifikat; storno then reverses the
 *     line on its net, lands on {0, 0} and dies on the voucher trigger's
 *     "has zero total", leaving the entry uncorrectable (issue #2551).
 *
 * The DB CHECKs `journal_entry_lines_amounts_non_negative` and
 * `journal_entry_lines_single_side` mirror the two halves.
 */
export function assertLinesWellFormed(lines: CreateJournalEntryLineInput[]): void {
  for (const line of lines) {
    const debit = line.debit_amount || 0
    const credit = line.credit_amount || 0
    if (debit < 0 || credit < 0) {
      throw new JournalLineNegativeAmountError(line.account_number, debit, credit)
    }
    if (debit > 0 && credit > 0) {
      throw new JournalLineBothSidesNonZeroError(line.account_number, debit, credit)
    }
  }
}

/**
 * Allocate the next voucher number for a company/period/series.
 * Uses the concurrent-safe INSERT ON CONFLICT implementation in the database.
 * This ADVANCES the sequence: a number allocated and then not posted is a gap
 * that needs a documented explanation. To show a number without taking it,
 * use peekNextVoucherNumber.
 */
export async function allocateVoucherNumber(
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
 * The number the next commit in a company/period/series would get, read
 * without advancing the sequence (for previews and dry runs). A projection:
 * a concurrent commit can take the number before the caller commits.
 */
export async function peekNextVoucherNumber(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  series: string = 'A'
): Promise<number> {
  const { data, error } = await supabase
    .from('voucher_sequences')
    .select('last_number')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('voucher_series', series)
    .maybeSingle()

  if (error) {
    throw new BookkeepingDatabaseError('peek_next_voucher_number', error.message)
  }

  return ((data as { last_number: number } | null)?.last_number ?? 0) + 1
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

function buildLineInserts(
  entryId: string,
  lines: CreateJournalEntryLineInput[],
  accountIdMap: Map<string, string>
) {
  return storedLineValues(lines, accountIdMap).map((line) => ({
    journal_entry_id: entryId,
    ...line,
  }))
}

/**
 * Insert a draft's lines. The row trigger on journal_entry_lines
 * (lock_cash_history_for_journal_line) observes the company with FOR SHARE
 * NOWAIT, so it refuses with CASH_ACCOUNT_OPERATION_BUSY for as long as
 * another booking of the same company is being numbered: a batch of parallel
 * bookings met itself here (for #206). The insert is one statement, so a
 * refused attempt wrote no line and the draft is exactly what it was; the
 * same insert is tried again on the shared bounded waits (cash-account-busy.ts)
 * and the last refusal is returned when they run out.
 */
function insertEntryLines(supabase: SupabaseClient, lineInserts: ReturnType<typeof buildLineInserts>) {
  return retryWhileCashAccountBusy(
    async () => await supabase.from('journal_entry_lines').insert(lineInserts),
    (outcome) => isCashAccountBusy(outcome.error),
  )
}

/**
 * Options for posting paths whose line bags are not new user input.
 */
export interface CreateEntryOptions {
  /**
   * The line bags are copied verbatim from posted history: skip the soft
   * registry validation, as storno and the accrual replay do. Only the
   * year-end IB carry passes it (issue #3313): a project value archived
   * during the year can still hold a 1470 balance, and a close must not
   * fail on it. The tag is kept, never stripped. Never exempt source type
   * 'opening_balance' as a whole: an import IB carries user codes on a
   * first posting.
   */
  replayDimensions?: boolean
  /**
   * Posting port (src/lib/posting): the business event this verifikat comes
   * from, already recorded by the port. Its link is written right after the
   * draft header and before commit_journal_entry draws a voucher number, so
   * a failed link costs no number. Absent (every caller outside the port,
   * and every posting while POSTING_EVENTS is off), nothing is written and
   * the draft is exactly what it was.
   */
  businessEvent?: BusinessEventLink
}

/**
 * Link the draft to its business event (createDraftEntry, reverseEntry). A
 * refusal under strict mode cancels the draft, which has no number yet, and
 * stops the posting; shadow mode and a missing table were already answered
 * as a success by the writer.
 */
async function linkDraftToBusinessEvent(
  supabase: SupabaseClient,
  companyId: string,
  draftId: string,
  link: BusinessEventLink,
): Promise<void> {
  const linked = await linkBusinessEventToDraft(supabase, companyId, draftId, link)
  if (linked.ok) return
  log.error('business event link refused (strict); draft cancelled before a voucher number was drawn', new Error(linked.message), {
    operation: 'link_business_event',
    companyId,
    entityType: 'journal_entry',
    entityId: draftId,
    businessEventId: link.id,
    pgCode: linked.code,
  })
  const { error: cancelError } = await supabase
    .from('journal_entries')
    .update({ status: 'cancelled' })
    .eq('id', draftId)
  if (cancelError) {
    log.error('orphan draft cleanup failed (phantom draft remains)', cancelError, {
      operation: 'link_business_event.cleanup',
      companyId,
      entityType: 'journal_entry',
      entityId: draftId,
      pgCode: (cancelError as { code?: string }).code,
    })
  }
  throw new BookkeepingDatabaseError('link_business_event', linked.message, linked.code)
}

/**
 * Create a draft journal entry with lines (no voucher number assigned yet)
 * The entry stays in 'draft' status until commitEntry() is called.
 */
export async function createDraftEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateJournalEntryInput,
  options: CreateEntryOptions = {}
): Promise<JournalEntry> {
  // Validate sides and balance
  assertLinesWellFormed(input.lines)
  const balance = validateBalance(input.lines)
  if (!balance.valid) {
    throw new JournalEntryNotBalancedError(balance.totalDebit, balance.totalCredit, 'draft')
  }

  // Account dimension rules (dimensions PR10): apply 'default'/'fixed'
  // values onto the line bags before validation + insert. Zero rules:
  // every company by default - returns the input untouched; a failed rule
  // fetch fails open like the soft validation below. System-generated and
  // correction sources are exempt - policy governs new business events,
  // never imported history or bokslut mechanics.
  const ruleExempt = isDimensionRuleExemptSource(input.source_type)
  const rules = ruleExempt ? [] : await fetchActiveDimensionRules(supabase, companyId)
  if (rules === null) {
    log.warn('dimension rule fetch failed — defaults/fixed skipped (fail-open)', { companyId })
  }
  // A foreign bank row's own figure on the line that books it (crm#1590):
  // one place for every door that declares the row in bank_booking_context.
  const lines = withBankLegCurrency(
    rules ? applyDimensionRules(input.lines, rules) : input.lines,
    input.bank_booking_context,
  )

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
  if (!options.replayDimensions && !isDimensionValidationExemptSource(input.source_type)) {
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
      ...(input.bank_booking_context ? { bank_booking_context: input.bank_booking_context } : {}),
      notes: input.notes || null,
      status: 'draft',
    })
    .select()
    .single()

  if (entryError || !entry) {
    logWriteFailure('insert journal_entries draft failed', entryError ?? new Error('no row returned'), {
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
    throw new BookkeepingDatabaseError('create_draft_entry', entryError?.message, entryError?.code)
  }

  // Posting port: the business event's link, right after the header and
  // before any voucher number is drawn. Skipped entirely without the option.
  if (options.businessEvent) {
    await linkDraftToBusinessEvent(supabase, companyId, entry.id, options.businessEvent)
  }

  // Insert journal entry lines with dimensions
  const lineInserts = buildLineInserts(entry.id, lines, accountIdMap)

  const { error: linesError } = await insertEntryLines(supabase, lineInserts)

  if (linesError) {
    logWriteFailure('insert journal_entry_lines failed', linesError, {
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
    throw new BookkeepingDatabaseError('create_entry_lines', linesError.message, linesError.code)
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
  // Load the entry and assert it is an editable draft. source_type is read
  // for the dimension policy below: the stored value is authoritative.
  const { data: existing, error: loadError } = await supabase
    .from('journal_entries')
    .select('id, status, voucher_series, source_type')
    .eq('id', entryId)
    .eq('company_id', companyId)
    .single()

  if (loadError || !existing) {
    throw new JournalEntryNotFoundError()
  }
  if (existing.status !== 'draft') {
    throw new CannotEditNonDraftError(existing.status as string)
  }

  // Same side and balance gates as createDraftEntry.
  assertLinesWellFormed(input.lines)
  const balance = validateBalance(input.lines)
  if (!balance.valid) {
    throw new JournalEntryNotBalancedError(balance.totalDebit, balance.totalCredit, 'draft')
  }

  // Same dimension policy as createDraftEntry, before any write, so a
  // rejection leaves both the header and the existing lines untouched:
  // account dimension rules (PR10) first, then the soft registry validation.
  // Both exemptions gate on the STORED source_type. Updates preserve it, and
  // the input's copy is not authoritative here (the v1 update operation
  // passes a 'manual' placeholder).
  const storedSourceType = (existing as { source_type?: string | null }).source_type
  const ruleExempt = isDimensionRuleExemptSource(storedSourceType)
  const rules = ruleExempt ? [] : await fetchActiveDimensionRules(supabase, companyId)
  if (rules === null) {
    log.warn('dimension rule fetch failed: defaults/fixed skipped (fail-open)', { companyId })
  }
  const lines = rules ? applyDimensionRules(input.lines, rules) : input.lines
  if (!isDimensionValidationExemptSource(storedSourceType)) {
    await validateEntryDimensions(supabase, companyId, lines)
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
    throw new BookkeepingDatabaseError('create_draft_entry', headerError.message, headerError.code)
  }

  // Replace the lines: delete the old set, insert the new one.
  const { error: deleteError } = await supabase
    .from('journal_entry_lines')
    .delete()
    .eq('journal_entry_id', entryId)

  if (deleteError) {
    throw new BookkeepingDatabaseError('create_entry_lines', deleteError.message, deleteError.code)
  }

  const lineInserts = buildLineInserts(entryId, lines, accountIdMap)
  // The old lines are already deleted: a busy refusal that was not tried
  // again would leave the draft without lines.
  const { error: linesError } = await insertEntryLines(supabase, lineInserts)

  if (linesError) {
    logWriteFailure('update draft: insert journal_entry_lines failed', linesError, {
      operation: 'create_entry_lines',
      companyId,
      userId,
      entityType: 'journal_entry',
      entityId: entryId,
      lineCount: lineInserts.length,
      pgCode: (linesError as { code?: string }).code,
    })
    throw new BookkeepingDatabaseError('create_entry_lines', linesError.message, linesError.code)
  }

  const { data: completeEntry } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', entryId)
    .single()

  return completeEntry as JournalEntry
}

/**
 * Cancel a DRAFT journal entry: the one sanctioned way out of the draft state
 * that is not a commit.
 *
 * A draft holds no voucher_number (drafts are outside the verifikationsserie),
 * so cancelling one leaves no löpnummer gap in the sense BFL 5 kap 7 § means
 * (verifikationsnummer in unbroken löpande nummerordning) and therefore needs
 * no documented gap explanation. The header row is kept as `cancelled` rather than
 * deleted: the immutability trigger's own instruction ("Use cancelled status
 * instead") and the same reason reverseEntry keeps its failed reversal headers
 * around, which is that a row someone looked at should stay explainable.
 *
 * Guards, in order:
 *   - not found / other company  → JournalEntryNotFoundError
 *   - already cancelled          → returned unchanged (idempotent; no event)
 *   - posted / reversed          → CannotCancelNonDraftError (storno instead)
 *
 * The status guard lives here and not only in the DB: the immutability
 * trigger ALLOWS posted → cancelled (migration 20260428160000 relies on it
 * for orphaned payment vouchers, which must also write a voucher-gap
 * explanation). Cancelling a posted verifikat through this path would
 * silently drop a number out of the series, so the application is the
 * authority on which statuses may pass.
 *
 * Period locks are NOT worked around: the update runs through
 * enforce_period_lock / enforce_company_lock_date like any other write, and a
 * draft stranded behind a lock surfaces the DB refusal as a
 * BookkeepingDatabaseError. Callers on the v1 surface pre-check the lock so
 * the client gets PERIOD_LOCKED instead.
 */
export async function cancelDraftEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryId: string
): Promise<JournalEntry> {
  const { data: existing, error: loadError } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', entryId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (loadError) {
    log.error('load journal entry for cancel failed', loadError, {
      operation: 'cancel_draft_entry',
      companyId,
      userId,
      entityType: 'journal_entry',
      entityId: entryId,
      pgCode: (loadError as { code?: string }).code,
    })
    throw new BookkeepingDatabaseError('cancel_draft_entry', loadError.message)
  }
  if (!existing) {
    throw new JournalEntryNotFoundError()
  }

  const entry = existing as JournalEntry
  // Idempotent: a repeated cancel is the caller reaching the state it asked
  // for, not a conflict. Returned without emitting a second event.
  if (entry.status === 'cancelled') {
    return entry
  }
  if (entry.status !== 'draft') {
    throw new CannotCancelNonDraftError(entry.status)
  }

  // CAS on status: a concurrent commit between the read and this write must
  // lose, not silently un-post a verifikat. The trigger would reject
  // posted → cancelled only for the statuses it protects, so the filter is
  // the guarantee, not a convenience.
  const { data: cancelled, error: cancelError } = await supabase
    .from('journal_entries')
    .update({ status: 'cancelled' })
    .eq('id', entryId)
    .eq('company_id', companyId)
    .eq('status', 'draft')
    .select('*, lines:journal_entry_lines(*)')
    .maybeSingle()

  if (cancelError) {
    log.error('cancel draft journal entry failed', cancelError, {
      operation: 'cancel_draft_entry',
      companyId,
      userId,
      entityType: 'journal_entry',
      entityId: entryId,
      pgCode: (cancelError as { code?: string }).code,
      pgDetails: (cancelError as { details?: string }).details,
      pgHint: (cancelError as { hint?: string }).hint,
    })
    throw new BookkeepingDatabaseError('cancel_draft_entry', cancelError.message)
  }

  if (!cancelled) {
    // Zero rows matched: the entry left 'draft' between the read and the
    // write. Re-read so the caller is told what it actually became.
    const { data: current } = await supabase
      .from('journal_entries')
      .select('status')
      .eq('id', entryId)
      .eq('company_id', companyId)
      .maybeSingle()
    const status = (current as { status?: string } | null)?.status
    if (status === 'cancelled') {
      return { ...entry, status: 'cancelled' }
    }
    throw new CannotCancelNonDraftError(status ?? 'unknown')
  }

  const result = cancelled as JournalEntry

  await eventBus.emit({
    type: 'journal_entry.cancelled',
    payload: { entry: result, userId, companyId },
  })

  return result
}

/**
 * Commit a draft entry: assigns voucher number and transitions to 'posted'
 * Uses the atomic commit_journal_entry RPC so the voucher number increment
 * and status update happen in one transaction. If the balance trigger rejects
 * the entry, the sequence increment rolls back: no burned numbers.
 *
 * Actor attribution: the surrounding runWithActor() scope (every cookie-session
 * route through withRouteContext, v1, and the approval entry points) is
 * forwarded to the RPC, which stamps journal_entries.committed_actor_* and
 * the audit_log COMMIT row (migration 20260619120000). No scope → NULLs.
 * A caller that passes no commitMethod records the one its actor implies
 * (defaultCommitMethod), so WHO and HOW are stamped together. An actor that
 * is an API key with an unattended ceiling commits nothing above it
 * (UnattendedCommitLimitExceededError, ./unattended-ceiling.ts).
 *
 * Event: the RPC itself writes the journal_entry.committed row to event_log,
 * in the commit transaction (migration 20261016001100), so the event cannot
 * be lost between the commit and the emit. The emit below still drives the
 * webhook fan-out and extension handlers; the event-log handler's own write
 * for this entry hits the same dedupe_key and is a no-op.
 *
 * The generic commit of an existing draft, the one every door that commits a
 * draft by id goes through (the dashboard, the v1 API and so MCP, and the
 * producers that draft and commit through the posting port). A periodisering
 * draft (source_type 'accrual') is refused here: it is posted only by its
 * schedule, through commitAccrualInstallment or commitAccrualDissolution,
 * which mark the month it books in the same transaction. Committed from here,
 * a draft a killed accrual run left behind would be a verifikat no month
 * points at, and the next run would book the month again.
 */
export async function commitEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryId: string,
  commitMethod?: string,
  rubricVersion?: string
): Promise<JournalEntry> {
  const { data: header, error: headerError } = await supabase
    .from('journal_entries')
    .select('source_type')
    .eq('id', entryId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (headerError) {
    throw new BookkeepingDatabaseError('commit_entry', headerError.message, headerError.code)
  }
  // A draft that is not found falls through: the RPC answers it as it always has.
  if ((header as { source_type?: string | null } | null)?.source_type === 'accrual') {
    throw new AccrualDraftPostedByScheduleError(entryId)
  }
  return postDraftEntry(supabase, companyId, userId, entryId, commitMethod, rubricVersion)
}

/**
 * The commit itself, for a draft whose source type is already known to be
 * allowed: commitEntry's after its check, createJournalEntry's for the draft
 * it just made, and the accrual doors' when the database does not have their
 * function yet. Not exported: no other code may skip commitEntry's check.
 */
async function postDraftEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryId: string,
  commitMethod?: string,
  rubricVersion?: string
): Promise<JournalEntry> {
  const actor = getActor()
  const method = commitMethod ?? defaultCommitMethod(actor)

  // An API key's unattended ceiling (./unattended-ceiling.ts): before the
  // number is drawn, so a refusal leaves the draft a draft.
  const overCeiling = await entryUnattendedCeilingRefusal(supabase, entryId, actor)
  if (overCeiling) throw overCeiling

  // Mandatory dimension rules (dimensions PR10): 'required' rules bite when
  // the verifikat is about to become immutable - drafts may be incomplete,
  // posting may not. Zero active rules (the default) skips the line fetch
  // entirely; a failed rule fetch fails open (transient DB errors must not
  // block bookkeeping). Reversal/correction paths never pass through
  // commitEntry, so history always reverses regardless of policy.
  const rules = await fetchActiveDimensionRules(supabase, companyId)
  if (rules === null) {
    // Deliberate fail-open, but LOUD: a transient policy-table error must not
    // block month-end bookings company-wide, yet a silently skipped control
    // is invisible - the warning makes the degradation observable.
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
      // System/correction sources are exempt - see
      // DIMENSION_RULE_EXEMPT_SOURCE_TYPES (imported history, bokslut
      // mechanics and credit instruments must never be blocked by policy).
      // source_type is a HEADER column (journal_entries) - the join repeats
      // the same value on every line, so reading lines[0] IS reading the
      // entry header; lines cannot mix source types.
      if (!isDimensionRuleExemptSource(typedLines[0]?.journal_entries?.source_type)) {
        assertMandatoryDimensions(typedLines, rules)
      }
    }
  }

  // Atomic: increment voucher sequence + update status in one transaction.
  // Rolls back the sequence if the balance trigger or any constraint fails.
  let { error: commitError } = await supabase.rpc('commit_journal_entry', {
    p_company_id: companyId,
    p_entry_id: entryId,
    p_commit_method: method,
    p_rubric_version: rubricVersion ?? null,
    p_actor_type: actor?.type ?? null,
    p_actor_label: actor?.label ?? null,
  })
  // A booking review rule matches the draft (accounted#130 step 2): only a
  // person's reviewed commit posts it (./booking-review-commit.ts); any
  // other commit throws BookingReviewRequiredError, with nothing posted.
  if (isBookingReviewRefusal(commitError)) {
    ;({ error: commitError } = await commitAsReviewed(supabase, {
      companyId,
      entryId,
      userId,
      actor,
      commitMethod: method,
      rubricVersion: rubricVersion ?? null,
    }))
  }

  if (commitError) {
    logWriteFailure('commit_journal_entry RPC failed', commitError, {
      operation: 'commit_entry',
      companyId,
      userId,
      entityType: 'journal_entry',
      entityId: entryId,
      commitMethod: method,
      pgCode: (commitError as { code?: string }).code,
      pgDetails: (commitError as { details?: string }).details,
      pgHint: (commitError as { hint?: string }).hint,
    })
    throw new BookkeepingDatabaseError('commit_entry', commitError.message, commitError.code)
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
 * Post the storno or rättelse draft a correction path built (reverseEntry
 * below, correctEntry in storno-service) through commit_journal_entry, the
 * RPC commitEntry uses. The voucher number is drawn, the status set and the
 * commit stamp written in one transaction, so a failure burns no number, and
 * the new verifikat records WHO (committed_actor_*, from the surrounding
 * runWithActor scope) and HOW (commit_method, derived from that actor) like
 * any other commit; the audit_log COMMIT row names the same actor. Only the
 * new reversing or correcting verifikat is stamped: the corrected original
 * is never touched here.
 *
 * Unlike commitEntry it runs no mandatory-dimension check (history always
 * reverses, whatever the policy) and emits no journal_entry.committed: the
 * correction paths announce the reversal or correction themselves.
 *
 * Returns the RPC error instead of throwing, so each caller keeps its own
 * cleanup and error translation. A draft above the acting API key's
 * unattended ceiling is not committed: the error is then the typed
 * UnattendedCommitLimitExceededError, which the callers rethrow as it is.
 */
export async function commitStornoOrCorrectionDraft(
  supabase: SupabaseClient,
  companyId: string,
  entryId: string,
): Promise<{ error: { message: string; code?: string } | null }> {
  const actor = getActor()
  const overCeiling = await entryUnattendedCeilingRefusal(supabase, entryId, actor)
  if (overCeiling) return { error: overCeiling }
  const { error } = await supabase.rpc('commit_journal_entry', {
    p_company_id: companyId,
    p_entry_id: entryId,
    p_commit_method: defaultCommitMethod(actor),
    p_rubric_version: null,
    p_actor_type: actor?.type ?? null,
    p_actor_label: actor?.label ?? null,
  })
  if (error) {
    logWriteFailure('commit_journal_entry RPC failed for a storno or rättelse draft', error, {
      operation: 'commit_storno_or_correction',
      companyId,
      entityType: 'journal_entry',
      entityId: entryId,
      pgCode: (error as { code?: string }).code,
    })
    return { error }
  }
  return { error: null }
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
  /** K3 components: the split of current_depreciation over the active
   *  components. Omitted (and not sent) for an asset without components. */
  components?: AssetComponentSplitLine[]
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
  // The caller cancels its draft on a throw, as on any refusal below.
  const overCeiling = entryId ? await entryUnattendedCeilingRefusal(supabase, entryId, actor) : null
  if (overCeiling) throw overCeiling
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
    ...(input.components ? { p_components: input.components } : {}),
  })

  if (error) {
    const pgCode = (error as { code?: string }).code
    if (pgCode === 'PT409' && error.message === 'ASSET_OPENING_CHANGED') throw new AssetOpeningChangedError()
    if (pgCode === 'PT409' && error.message === 'ASSET_COMPONENTS_CHANGED') throw new AssetComponentsChangedError()
    log.error('commit_asset_disposal RPC failed', error, {
      operation: 'commit_asset_disposal',
      companyId,
      userId,
      entityType: 'asset',
      entityId: input.asset_id,
      journalEntryId: entryId,
      pgCode: (error as { code?: string }).code,
    })
    throw new BookkeepingDatabaseError('commit_asset_disposal', error.message, error.code)
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
 * One component's share of a planenlig avskrivning (K3 17.4), with the
 * component's opening snapshot the share was computed from. The posting RPCs
 * refuse a split that does not cover exactly the asset's active components,
 * whose openings changed, or that does not sum to the voucher.
 */
export interface AssetComponentSplitLine {
  component_id: string
  amount: number
  expected_opening_amount: number
  expected_opening_date: string | null
}

export interface AssetDepreciationLink {
  asset_id: string
  /** The amount the register row records. The RPC refuses it unless it equals
   *  what the draft voucher actually books. */
  planned_depreciation: number
  /** Opening snapshot used to calculate this proposal, checked under the row lock. */
  opening_accumulated_depreciation: number
  opening_depreciation_date: string | null
  /** K3 components: the per-component split, required for a component asset.
   *  Omitted (and not sent) for an asset without components. */
  components?: AssetComponentSplitLine[]
}

/**
 * Post one planenlig avskrivning: create the draft, then commit the voucher
 * AND write its depreciation_schedules link in a single database transaction
 * (commit_asset_depreciation, which delegates numbering to
 * commit_journal_entry and holds the asset row lock throughout).
 *
 * This replaces createJournalEntry() followed by a separate schedule write:
 * a failure between those two statements left a posted voucher with no
 * register row (issue #2779). Owning the draft here as well keeps every
 * journal write, including the orphan-draft cleanup, inside the engine.
 *
 * Throws AssetDepreciationRefusedError for the two outcomes a batch should
 * skip rather than fail on. No voucher is posted in either case.
 *
 * The same as createDraftEntry followed by commitAssetDepreciation, which is
 * how the producer (lib/bokslut/assets/depreciation-engine.ts) posts since
 * the posting port: it drafts through the port, so the business event is
 * linked to the draft before a voucher number is drawn.
 */
export async function createAssetDepreciationEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateJournalEntryInput,
  link: AssetDepreciationLink,
): Promise<{ entry: JournalEntry; scheduleId: string }> {
  const draft = await createDraftEntry(supabase, companyId, userId, input)
  return commitAssetDepreciation(supabase, companyId, userId, draft, link)
}

/**
 * Commit a planenlig avskrivning draft: the voucher AND its
 * depreciation_schedules link in one database transaction
 * (commit_asset_depreciation, which delegates numbering to
 * commit_journal_entry and holds the asset row lock throughout). On any
 * refusal the draft is left cancelled, never stranded.
 *
 * Throws AssetDepreciationRefusedError for the two outcomes a batch should
 * skip rather than fail on. No voucher is posted in either case.
 */
export async function commitAssetDepreciation(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  draft: Pick<JournalEntry, 'id' | 'fiscal_period_id'>,
  link: AssetDepreciationLink,
): Promise<{ entry: JournalEntry; scheduleId: string }> {
  const actor = getActor()

  const overCeiling = await entryUnattendedCeilingRefusal(supabase, draft.id, actor)
  if (overCeiling) {
    // Never strand the draft: cancelled as on any refusal of the RPC below.
    await supabase
      .from('journal_entries')
      .update({ status: 'cancelled' })
      .eq('id', draft.id)
      .eq('status', 'draft')
    throw overCeiling
  }

  const { data, error } = await supabase.rpc('commit_asset_depreciation', {
    p_company_id: companyId,
    p_asset_id: link.asset_id,
    p_entry_id: draft.id,
    p_fiscal_period_id: draft.fiscal_period_id,
    p_planned_depreciation: link.planned_depreciation,
    p_expected_opening_amount: link.opening_accumulated_depreciation,
    p_expected_opening_date: link.opening_depreciation_date,
    p_actor_type: actor?.type ?? null,
    p_actor_label: actor?.label ?? null,
    ...(link.components ? { p_components: link.components } : {}),
  })

  if (error) {
    const pgCode = (error as { code?: string }).code
    // The RPC is one transaction, so on any error the draft is still a draft.
    // Same CAS cleanup as createJournalEntry: never strand an undeletable one.
    const { error: cancelError } = await supabase
      .from('journal_entries')
      .update({ status: 'cancelled' })
      .eq('id', draft.id)
      .eq('status', 'draft')
    if (cancelError) {
      log.error('orphan depreciation draft cleanup failed (phantom draft remains)', cancelError, {
        operation: 'commit_asset_depreciation.cleanup',
        companyId,
        entityType: 'journal_entry',
        entityId: draft.id,
      })
    }

    // SQLSTATEs set by the RPC itself: 23505 = this (asset, period) is
    // already posted, P0002 = the asset row is gone (deleted while we waited
    // on its lock). A bad draft is 22023 and falls through as a real error.
    if (pgCode === '23505') throw new AssetDepreciationRefusedError('already_posted')
    if (pgCode === 'P0002') throw new AssetDepreciationRefusedError('asset_not_found')
    if (pgCode === 'PT409' && error.message === 'ASSET_OPENING_CHANGED') {
      throw new AssetOpeningChangedError()
    }
    if (pgCode === 'PT409' && error.message === 'ASSET_COMPONENTS_CHANGED') {
      throw new AssetComponentsChangedError()
    }

    log.error('commit_asset_depreciation RPC failed', error, {
      operation: 'commit_asset_depreciation',
      companyId,
      userId,
      entityType: 'asset',
      entityId: link.asset_id,
      journalEntryId: draft.id,
      pgCode,
    })
    throw new BookkeepingDatabaseError('commit_asset_depreciation', error.message, error.code)
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { voucher_number: number; schedule_id: string }
    | null
    | undefined
  if (!row?.schedule_id) {
    throw new BookkeepingDatabaseError(
      'commit_asset_depreciation',
      'RPC returned no schedule row for a committed depreciation',
    )
  }

  // Voucher and link are committed at this point. As in commitAssetDisposal,
  // a transient reload failure must not masquerade as a failed posting.
  let completeEntry: JournalEntry | null = null
  let lastFetchError: { message: string } | null = null
  for (let attempt = 0; attempt < 2 && !completeEntry; attempt++) {
    const { data: reloaded, error: fetchError } = await supabase
      .from('journal_entries')
      .select('*, lines:journal_entry_lines(*)')
      .eq('id', draft.id)
      .eq('company_id', companyId)
      .single()
    if (reloaded && !fetchError) {
      completeEntry = reloaded as JournalEntry
    } else {
      lastFetchError = fetchError ?? { message: 'posted entry not found' }
    }
  }

  if (!completeEntry) {
    log.error('asset depreciation committed but posted entry reload failed', lastFetchError, {
      operation: 'commit_asset_depreciation',
      companyId,
      userId,
      entityType: 'asset',
      entityId: link.asset_id,
      journalEntryId: draft.id,
    })
    throw new BookkeepingDatabaseError(
      'fetch_asset_depreciation_entry',
      `depreciation voucher is committed but could not be reloaded: ${
        lastFetchError?.message ?? 'posted entry not found'
      }`,
    )
  }

  await eventBus.emit({
    type: 'journal_entry.committed',
    payload: { entry: completeEntry, userId, companyId },
  })
  return { entry: completeEntry, scheduleId: row.schedule_id }
}

export interface AssetComponentReplacementInput {
  asset_id: string
  component_id: string
  derecognised_at: string
  /** The component's depreciation up to the derecognition date, on the voucher. */
  depreciation_to_date: number
  /** The accumulated depreciation the voucher clears (opening, posted and to date). */
  accumulated_cleared: number
  /** The component that replaces it (K3 17.5), registered with no voucher:
   *  the expenditure is already on the asset account. Null derecognises only. */
  new_component: {
    name: string
    cost: number
    useful_life_months: number | null
    salvage_value: number
    acquisition_date: string | null
    depreciation_start_date: string | null
  } | null
}

/**
 * Commit a component replacement draft (K3 17.5, 17.21A): the voucher that
 * takes the component off the books AND the register change (derecognised,
 * the replacing component registered) in one database transaction
 * (commit_asset_component_replacement, which delegates numbering to
 * commit_journal_entry and holds the asset row lock). On any refusal the
 * draft is left cancelled, never stranded.
 */
export async function commitAssetComponentReplacement(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  draft: Pick<JournalEntry, 'id' | 'fiscal_period_id'>,
  input: AssetComponentReplacementInput,
): Promise<{ entry: JournalEntry; newComponentId: string | null }> {
  const actor = getActor()
  const { data, error } = await supabase.rpc('commit_asset_component_replacement', {
    p_company_id: companyId,
    p_asset_id: input.asset_id,
    p_component_id: input.component_id,
    p_entry_id: draft.id,
    p_fiscal_period_id: draft.fiscal_period_id,
    p_derecognised_at: input.derecognised_at,
    p_depreciation_to_date: input.depreciation_to_date,
    p_accumulated_cleared: input.accumulated_cleared,
    p_new_component: input.new_component,
    p_actor_type: actor?.type ?? null,
    p_actor_label: actor?.label ?? null,
  })

  if (error) {
    const pgCode = (error as { code?: string }).code
    await cancelRefusedSqlDraft(supabase, companyId, draft.id, 'commit_asset_component_replacement')
    if (pgCode === 'PT409') {
      switch (error.message) {
        case 'ASSET_COMPONENT_NOT_ACTIVE':
        case 'ASSET_LAST_COMPONENT':
        case 'ASSET_COMPONENT_STATE_CHANGED':
        case 'ASSET_COMPONENT_IMPAIRED':
          throw new AssetComponentRefusedError(error.message)
      }
    }
    if (pgCode === 'P0002') throw new AssetComponentRefusedError('ASSET_COMPONENT_NOT_FOUND')
    log.error('commit_asset_component_replacement RPC failed', error, {
      operation: 'commit_asset_component_replacement',
      companyId,
      userId,
      entityType: 'asset',
      entityId: input.asset_id,
      journalEntryId: draft.id,
      pgCode,
    })
    throw new BookkeepingDatabaseError('commit_asset_component_replacement', error.message, error.code)
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { voucher_number: number; new_component_id: string | null }
    | null
    | undefined

  const entry = await reloadCommittedSqlEntry(supabase, companyId, userId, draft.id, {
    operation: 'commit_asset_component_replacement',
    fetchOperation: 'fetch_asset_component_replacement_entry',
    assetId: input.asset_id,
    what: 'asset component replacement',
  })
  return { entry, newComponentId: row?.new_component_id ?? null }
}

/** Cancel a draft whose SQL posting function refused it, so it is never stranded. */
async function cancelRefusedSqlDraft(
  supabase: SupabaseClient,
  companyId: string,
  draftId: string,
  operation: string,
): Promise<void> {
  const { error: cancelError } = await supabase
    .from('journal_entries')
    .update({ status: 'cancelled' })
    .eq('id', draftId)
    .eq('status', 'draft')
  if (cancelError) {
    log.error('orphan posting draft cleanup failed (phantom draft remains)', cancelError, {
      operation: `${operation}.cleanup`,
      companyId,
      entityType: 'journal_entry',
      entityId: draftId,
    })
  }
}

/**
 * Reload a voucher a SQL posting function has committed, and announce it.
 * Committed at this point: a transient reload failure must not read as a
 * failed posting, so retry once and log the divergence before throwing.
 */
async function reloadCommittedSqlEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryId: string,
  context: { operation: string; fetchOperation: BookkeepingOperation; assetId?: string; what: string },
): Promise<JournalEntry> {
  let completeEntry: JournalEntry | null = null
  let lastFetchError: { message: string } | null = null
  for (let attempt = 0; attempt < 2 && !completeEntry; attempt++) {
    const { data: reloaded, error: fetchError } = await supabase
      .from('journal_entries')
      .select('*, lines:journal_entry_lines(*)')
      .eq('id', entryId)
      .eq('company_id', companyId)
      .single()
    if (reloaded && !fetchError) completeEntry = reloaded as JournalEntry
    else lastFetchError = fetchError ?? { message: 'posted entry not found' }
  }
  if (!completeEntry) {
    log.error(`${context.what} committed but posted entry reload failed`, lastFetchError, {
      operation: context.operation,
      companyId,
      userId,
      ...(context.assetId ? { entityType: 'asset', entityId: context.assetId } : {}),
      journalEntryId: entryId,
    })
    throw new BookkeepingDatabaseError(
      context.fetchOperation,
      `${context.what} voucher is committed but could not be reloaded: ${lastFetchError?.message ?? 'posted entry not found'}`,
    )
  }
  await eventBus.emit({
    type: 'journal_entry.committed',
    payload: { entry: completeEntry, userId, companyId },
  })
  return completeEntry
}

export interface AssetValueAdjustmentInput {
  asset_id: string
  kind: 'impairment' | 'impairment_reversal'
  /** The balansdag: the last day of the draft's fiscal year. */
  adjustment_date: string
  amount: number
  /** Återvinningsvärde (K3 27.5) the amount was derived from. */
  recoverable_amount: number
  reason: string
  /** The 77xx the voucher books (nedskrivning or återföring). */
  expense_account: string
  /** The 12x8 it books against. */
  accumulated_account: string
  /** A component asset: the amount per active component, summing to `amount`. */
  components?: Array<{ component_id: string; amount: number }>
}

/**
 * Commit a nedskrivning or its reversal (ÅRL 4:5, K3 27): the voucher AND
 * the asset_value_adjustments rows in one database transaction
 * (commit_asset_value_adjustment, which delegates numbering to
 * commit_journal_entry and holds the asset row lock). A refusal the caller
 * can act on throws AssetValueAdjustmentBlockedError; the draft is left
 * cancelled either way.
 */
export async function commitAssetValueAdjustment(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  draft: Pick<JournalEntry, 'id' | 'fiscal_period_id'>,
  input: AssetValueAdjustmentInput,
): Promise<{ entry: JournalEntry }> {
  const actor = getActor()
  const { error } = await supabase.rpc('commit_asset_value_adjustment', {
    p_company_id: companyId,
    p_asset_id: input.asset_id,
    p_entry_id: draft.id,
    p_fiscal_period_id: draft.fiscal_period_id,
    p_kind: input.kind,
    p_adjustment_date: input.adjustment_date,
    p_amount: input.amount,
    p_recoverable_amount: input.recoverable_amount,
    p_reason: input.reason,
    p_expense_account: input.expense_account,
    p_accumulated_account: input.accumulated_account,
    p_components: input.components ?? null,
    p_actor_type: actor?.type ?? null,
    p_actor_label: actor?.label ?? null,
  })

  if (error) {
    const pgCode = (error as { code?: string }).code
    await cancelRefusedSqlDraft(supabase, companyId, draft.id, 'commit_asset_value_adjustment')
    const block = pgCode === 'PT409' ? valueAdjustmentBlockFromRpc(error.message) : null
    if (block) throw new AssetValueAdjustmentBlockedError(block)
    log.error('commit_asset_value_adjustment RPC failed', error, {
      operation: 'commit_asset_value_adjustment',
      companyId,
      userId,
      entityType: 'asset',
      entityId: input.asset_id,
      journalEntryId: draft.id,
      pgCode,
    })
    throw new BookkeepingDatabaseError('commit_asset_value_adjustment', error.message, error.code)
  }

  const entry = await reloadCommittedSqlEntry(supabase, companyId, userId, draft.id, {
    operation: 'commit_asset_value_adjustment',
    fetchOperation: 'fetch_asset_value_adjustment_entry',
    assetId: input.asset_id,
    what: 'asset write-down',
  })
  return { entry }
}

export interface DeferredTaxPostingInput {
  /** Net deferred tax at the balansdag: positive a liability, negative an asset. */
  closing: number
  /** closing less what the ledger held; the voucher's net change on 2240 less 1370. */
  change: number
  /** The temporary differences it was computed from (deferred_tax_items rows). */
  items: Array<{
    kind: string
    label: string
    carrying_amount: number
    tax_value: number
    temporary_difference: number
    tax_rate: number
    deferred_tax: number
  }>
}

/**
 * Commit a deferred tax draft (K3 kap. 29): the year_end voucher on
 * 8940/2240/1370 AND its items in one database transaction
 * (commit_deferred_tax, which delegates numbering to commit_journal_entry).
 * A second posting for a year whose first one stands is refused
 * (DeferredTaxAlreadyPostedError); the draft is left cancelled either way.
 */
export async function commitDeferredTax(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  draft: Pick<JournalEntry, 'id' | 'fiscal_period_id'>,
  input: DeferredTaxPostingInput,
): Promise<{ entry: JournalEntry }> {
  const actor = getActor()
  const { error } = await supabase.rpc('commit_deferred_tax', {
    p_company_id: companyId,
    p_entry_id: draft.id,
    p_fiscal_period_id: draft.fiscal_period_id,
    p_closing: input.closing,
    p_change: input.change,
    p_items: input.items,
    p_actor_type: actor?.type ?? null,
    p_actor_label: actor?.label ?? null,
  })
  if (error) {
    const pgCode = (error as { code?: string }).code
    await cancelRefusedSqlDraft(supabase, companyId, draft.id, 'commit_deferred_tax')
    if (pgCode === 'PT409' && error.message === 'DEFERRED_TAX_ALREADY_POSTED') {
      throw new DeferredTaxAlreadyPostedError()
    }
    log.error('commit_deferred_tax RPC failed', error, {
      operation: 'commit_deferred_tax',
      companyId,
      userId,
      journalEntryId: draft.id,
      pgCode,
    })
    throw new BookkeepingDatabaseError('commit_deferred_tax', error.message, error.code)
  }
  const entry = await reloadCommittedSqlEntry(supabase, companyId, userId, draft.id, {
    operation: 'commit_deferred_tax',
    fetchOperation: 'fetch_deferred_tax_entry',
    what: 'deferred tax',
  })
  return { entry }
}

/**
 * What a pågående-arbeten adjustment was computed from (K3 kapitel 23), kept
 * with its verifikat in contract_revenue_bookings.
 */
export interface ContractRevenueBookingInput {
  method: 'successiv' | 'fardigstallande'
  /** The account per role; revenueAdjustment is the saved settings' account. */
  accounts: Record<string, string>
  /** Every uppdrag as stated for the balansdag. */
  contracts: unknown[]
  /** Each uppdrag's computed position. */
  positions: unknown[]
  /** The register's balance per position account after the verifikat (debit positive). */
  targets: Record<string, number>
}

/**
 * Commit a pågående-arbeten draft: the year_end verifikat AND what it was
 * computed from in one database transaction (commit_contract_revenue, which
 * delegates numbering to commit_journal_entry). A year not reported under K3,
 * a register that changed since the adjustment was computed, or a later
 * year's booking that stands on this year's balance is refused
 * (ContractRevenueRefusedError); the draft is left cancelled either way.
 */
export async function commitContractRevenue(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  draft: Pick<JournalEntry, 'id' | 'fiscal_period_id'>,
  booking: ContractRevenueBookingInput,
): Promise<{ entry: JournalEntry }> {
  const actor = getActor()
  const { error } = await supabase.rpc('commit_contract_revenue', {
    p_company_id: companyId,
    p_entry_id: draft.id,
    p_fiscal_period_id: draft.fiscal_period_id,
    p_booking: booking,
    p_actor_type: actor?.type ?? null,
    p_actor_label: actor?.label ?? null,
  })
  if (error) {
    const pgCode = (error as { code?: string }).code
    await cancelRefusedSqlDraft(supabase, companyId, draft.id, 'commit_contract_revenue')
    const refusal = pgCode === 'PT409' ? contractRevenueRefusalFromRpc(error.message) : null
    if (refusal) throw new ContractRevenueRefusedError(refusal)
    log.error('commit_contract_revenue RPC failed', error, {
      operation: 'commit_contract_revenue',
      companyId,
      userId,
      journalEntryId: draft.id,
      pgCode,
    })
    throw new BookkeepingDatabaseError('commit_contract_revenue', error.message, error.code)
  }
  const entry = await reloadCommittedSqlEntry(supabase, companyId, userId, draft.id, {
    operation: 'commit_contract_revenue',
    fetchOperation: 'fetch_contract_revenue_entry',
    what: 'contract revenue',
  })
  return { entry }
}

/** What an accrual commit did with the draft it was handed. */
export type AccrualCommit =
  /** The verifikat is posted and the month (or months) point at it. */
  | { outcome: 'posted'; entry: JournalEntry }
  /** Nothing was waiting for this draft any more; it is cancelled, no number drawn. */
  | { outcome: 'not_pending' }
  /**
   * The database does not have the function yet (PGRST202): the verifikat is
   * posted the way it was before the function, and the month (or months) are
   * the caller's to claim, in a second statement.
   */
  | { outcome: 'posted_unclaimed'; entry: JournalEntry }

/**
 * PostgREST's answer for a function its schema cache does not hold: the
 * migration has not run yet. Only this code means "not deployed". 42883 is
 * also what Postgres raises for any function or operator it cannot resolve
 * inside the body or a trigger it fires, which is a failure, not a missing
 * deploy, and is treated as one.
 */
const FUNCTION_NOT_DEPLOYED_CODE = 'PGRST202'

/** The accrual functions whose absence was already reported by this process. */
const reportedMissingAccrualFunctions = new Set<string>()

type AccrualCommitFunction = 'commit_accrual_installment' | 'commit_accrual_dissolution'

/**
 * Commit an accrual draft through one of the two functions that post the
 * verifikat and mark what it dissolves in one database transaction. Shared
 * by commitAccrualInstallment and commitAccrualDissolution: the same
 * unattended ceiling, the same draft cleanup, the same answers.
 */
async function commitAccrualDraft(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  draftId: string,
  fn: AccrualCommitFunction,
  subject: { entityType: string; entityId: string; params: Record<string, unknown> },
): Promise<AccrualCommit> {
  const actor = getActor()

  const overCeiling = await entryUnattendedCeilingRefusal(supabase, draftId, actor)
  if (overCeiling) {
    await cancelRefusedSqlDraft(supabase, companyId, draftId, fn)
    throw overCeiling
  }

  const { data, error } = await supabase.rpc(fn, {
    p_company_id: companyId,
    ...subject.params,
    p_entry_id: draftId,
    p_commit_method: defaultCommitMethod(actor),
    p_actor_type: actor?.type ?? null,
    p_actor_label: actor?.label ?? null,
  })

  if (error) {
    const pgCode = (error as { code?: string }).code
    if (pgCode === FUNCTION_NOT_DEPLOYED_CODE) {
      // Posted the old way, which is not safe against a second run. That is
      // acceptable for the minutes between a deploy and its migration and not
      // a day longer, so it is an error, said once per process: a fallback
      // that keeps happening must be seen.
      if (!reportedMissingAccrualFunctions.has(fn)) {
        reportedMissingAccrualFunctions.add(fn)
        log.error(`${fn} is not in the database; posting falls back to separate statements`, error, {
          operation: fn,
          companyId,
          pgCode,
        })
      }
      // The accrual door's own commit: the one path besides the functions
      // that may post a periodisering draft (commitEntry refuses it).
      try {
        const entry = await postDraftEntry(supabase, companyId, userId, draftId)
        return { outcome: 'posted_unclaimed', entry }
      } catch (commitError) {
        // The commit is atomic: the draft is still a draft and has no number.
        await cancelRefusedSqlDraft(supabase, companyId, draftId, fn)
        throw commitError
      }
    }
    // One transaction, so on any error the draft is still a draft.
    await cancelRefusedSqlDraft(supabase, companyId, draftId, fn)
    log.error(`${fn} RPC failed`, error, {
      operation: fn,
      companyId,
      userId,
      entityType: subject.entityType,
      entityId: subject.entityId,
      journalEntryId: draftId,
      pgCode,
    })
    throw new BookkeepingDatabaseError(fn, error.message, error.code)
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | null | undefined
  if (row?.outcome === 'not_pending') {
    await cancelRefusedSqlDraft(supabase, companyId, draftId, fn)
    return { outcome: 'not_pending' }
  }
  if (row?.outcome !== 'posted') {
    throw new BookkeepingDatabaseError(fn, 'RPC returned no outcome for an accrual draft')
  }

  const entry = await reloadCommittedSqlEntry(supabase, companyId, userId, draftId, {
    operation: fn,
    fetchOperation: fn === 'commit_accrual_installment' ? 'fetch_accrual_installment_entry' : 'fetch_accrual_dissolution_entry',
    what: fn === 'commit_accrual_installment' ? 'accrual installment' : 'accrual dissolution',
  })
  return { outcome: 'posted', entry }
}

/**
 * Commit a periodisering month's draft: the verifikat AND the month's row
 * (accrual_schedule_installments pending to posted) in one database
 * transaction (commit_accrual_installment, which delegates numbering to
 * commit_journal_entry and holds the month's row lock). The old shape
 * committed the verifikat and flipped the month in a second statement, so a
 * run killed in between booked the month again the next day, and two
 * overlapping runs both posted.
 *
 * A month that is no longer waiting (another run posted it, a credit
 * cancelled it, a re-plan removed it) is an answer, not an error: the draft,
 * which has no voucher number, is cancelled and nothing is posted. Any other
 * refusal leaves the draft cancelled too and throws.
 *
 * `posted_unclaimed` is the window right after a deploy, before the
 * migration has run: the verifikat is posted the way it was before, and the
 * caller claims the month in a second statement. It is reported as an
 * error.
 */
export async function commitAccrualInstallment(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  draft: Pick<JournalEntry, 'id'>,
  installmentId: string,
): Promise<AccrualCommit> {
  return commitAccrualDraft(supabase, companyId, userId, draft.id, 'commit_accrual_installment', {
    entityType: 'accrual_schedule_installment',
    entityId: installmentId,
    params: { p_installment_id: installmentId },
  })
}

/** The schedule a combined dissolution closes, and the pending months its draft was added up from. */
export interface AccrualDissolutionLink {
  scheduleId: string
  installmentIds: string[]
}

/**
 * Commit the one verifikat that dissolves the rest of a periodisering
 * ("lös upp resten nu"): the verifikat, every pending month of the schedule
 * and the schedule's completion in one database transaction
 * (commit_accrual_dissolution, migration 20261112181809). The months are the
 * ones the draft's amount was added up from: when the schedule's pending
 * months are no longer exactly those (the posting run booked one, a credit
 * cancelled them, a re-plan replaced them) the answer is `not_pending`, the
 * draft is cancelled and nothing is posted, so the caller can start again
 * from what is pending now. Otherwise as commitAccrualInstallment.
 */
export async function commitAccrualDissolution(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  draft: Pick<JournalEntry, 'id'>,
  link: AccrualDissolutionLink,
): Promise<AccrualCommit> {
  return commitAccrualDraft(supabase, companyId, userId, draft.id, 'commit_accrual_dissolution', {
    entityType: 'accrual_schedule',
    entityId: link.scheduleId,
    params: { p_schedule_id: link.scheduleId, p_installment_ids: link.installmentIds },
  })
}

export interface K3TransitionPostingInput {
  /** The retained-result account the adjustments are booked against (35.11). */
  equityAccount: string
  /** The opening deferred tax at the transition: positive a liability, negative an asset. */
  openingDeferredTax: number
  /** The voucher's net change on 2240 less 1370. */
  deferredTaxChange: number
  /** The temporary differences the opening deferred tax was computed from. */
  items: DeferredTaxPostingInput['items']
}

/**
 * Commit the K3 transition voucher (BFNAR 2012:1 35.11): balance sheet
 * adjustments and the opening deferred tax against equity, dated the first
 * day of the first K3 year, and the transition marked committed, in one
 * database transaction (commit_k3_transition, which delegates numbering to
 * commit_journal_entry). A refusal leaves the draft cancelled and throws
 * K3TransitionBlockedError with the reason.
 */
export async function commitK3Transition(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  draft: Pick<JournalEntry, 'id'>,
  input: K3TransitionPostingInput,
): Promise<{ entry: JournalEntry }> {
  const actor = getActor()
  const { error } = await supabase.rpc('commit_k3_transition', {
    p_company_id: companyId,
    p_entry_id: draft.id,
    p_equity_account: input.equityAccount,
    p_opening_deferred_tax: input.openingDeferredTax,
    p_deferred_tax_change: input.deferredTaxChange,
    p_deferred_tax_items: input.items,
    p_actor_type: actor?.type ?? null,
    p_actor_label: actor?.label ?? null,
  })
  if (error) {
    const pgCode = (error as { code?: string }).code
    await cancelRefusedSqlDraft(supabase, companyId, draft.id, 'commit_k3_transition')
    const reason = pgCode === 'PT409' ? k3TransitionBlockFromRpc(error.message) : null
    if (reason) throw new K3TransitionBlockedError(reason)
    log.error('commit_k3_transition RPC failed', error, {
      operation: 'commit_k3_transition',
      companyId,
      userId,
      journalEntryId: draft.id,
      pgCode,
    })
    throw new BookkeepingDatabaseError('commit_k3_transition', error.message, error.code)
  }
  const entry = await reloadCommittedSqlEntry(supabase, companyId, userId, draft.id, {
    operation: 'commit_k3_transition',
    fetchOperation: 'fetch_k3_transition_entry',
    what: 'K3 transition',
  })
  return { entry }
}

/**
 * Create a journal entry with lines (verifikation)
 * Convenience wrapper: creates draft + commits in one step.
 * The voucher number is only assigned after lines are successfully inserted,
 * preventing gaps in the voucher sequence (BFL 5 kap. 7§).
 *
 * If the commit fails (e.g. balance trigger rejection, period lock, RPC error),
 * the orphan draft is cancelled so callers don't leave an undeletable stuck draft.
 * The commit RPC is atomic: no voucher number is burned on failure.
 */
export async function createJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateJournalEntryInput,
  commitMethod?: string,
  rubricVersion?: string,
  options: CreateEntryOptions = {}
): Promise<JournalEntry> {
  // The commit refuses it too; asked first so no draft is written for a
  // verifikat an API key may not post unattended.
  assertLinesWithinUnattendedCeiling(input.lines)
  // A periodisering verifikat is posted only by its schedule, with the month
  // it books (commitAccrualInstallment, commitAccrualDissolution): refused
  // before any write, as commitEntry refuses such a draft.
  if (input.source_type === 'accrual') {
    throw new AccrualDraftPostedByScheduleError()
  }
  const draft = await createDraftEntry(supabase, companyId, userId, input, options)
  try {
    // The draft was made here from this input: its source type is checked above.
    return await postDraftEntry(supabase, companyId, userId, draft.id, commitMethod, rubricVersion)
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
 *
 * `options.businessEvents`: the posting port's two events by position (the
 * new IB's ledger.opening_balance, the storno's ledger.storno), which the
 * function links to its two drafts before either number is drawn
 * (business-event-rpc.ts). Without it the function is called as before.
 */
export async function replaceOpeningBalanceEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  expectedOldEntryId: string,
  input: CreateJournalEntryInput,
  options: { businessEvents?: SqlBusinessEventLink } = {},
): Promise<OpeningBalanceReplacementResult> {
  if (input.source_type !== 'opening_balance') {
    throw new BookkeepingDatabaseError(
      'replace_opening_balance',
      'Replacement entry must use source_type opening_balance',
    )
  }

  assertLinesWellFormed(input.lines)
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
  const preparedLines = storedLineValues(input.lines, accountIdMap)
  const actor = getActor()

  const { data, error } = await callWithBusinessEvents('commit_opening_balance_replacement', options.businessEvents, (events) =>
    supabase.rpc('commit_opening_balance_replacement', {
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
      ...events,
    }),
  )

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
    throw new BookkeepingDatabaseError('replace_opening_balance', error.message, error.code)
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

export interface BulkBookingInput {
  txIds: string[]
  /** link_existing: attach the rows to this already-posted voucher. */
  existingJournalEntryId: string | null
  /** create_new: the samlingsverifikat's description and balanced lines. */
  newEntry: Record<string, unknown> | null
  /** commit_method for a new verifikat; omitted, the actor's default. */
  commitMethod?: 'bulk_accept'
  /**
   * The posting port's bank.categorized events, one per row of txIds, linked
   * to a new samlingsverifikat before its number is drawn. Omitted: the RPC
   * is called as before.
   */
  businessEvents?: SqlBusinessEventLink
}

/**
 * Bulk-book N same-date SEK bank rows through bulk_book_transactions: one new
 * samlingsverifikat (BFL 5 kap 6 §, mode create_new) or a link to an
 * already-posted voucher (link_existing). The RPC inserts, numbers and commits
 * the verifikat in SQL via commit_journal_entry, so it never passes through
 * commitEntry. This is its one application door, so that a new verifikat is
 * announced with journal_entry.committed exactly as commitEntry announces one.
 * link_existing posts nothing and emits nothing: that voucher was announced
 * when it was committed.
 *
 * Attribution: the RPC hands commit method and actor on to
 * commit_journal_entry (migration 20261011140000), resolved here exactly as
 * commitEntry resolves them. The posting port's events, when given, are
 * linked by the RPC to its draft (business-event-rpc.ts).
 *
 * Returns the RPC's answer unchanged. Its structured refusals
 * ({ ok: false, code }) and transport errors stay the callers' to translate.
 */
export async function commitBulkBooking(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: BulkBookingInput,
): Promise<PostingRpcAnswer> {
  const actor = getActor()
  const { data, error } = await callWithBusinessEvents('bulk_book_transactions', input.businessEvents, (events) =>
    supabase.rpc('bulk_book_transactions', {
      p_tx_ids: input.txIds,
      p_existing_journal_entry_id: input.existingJournalEntryId,
      p_new_entry: input.newEntry,
      p_company_id: companyId,
      // Honoured only for a service_role caller (the v1 and pending-operation
      // doors); a session caller resolves from its own auth.uid()
      // (migration 20260824170000).
      p_user_id: userId,
      p_commit_method: input.commitMethod ?? defaultCommitMethod(actor),
      p_actor_type: actor?.type ?? null,
      p_actor_label: actor?.label ?? null,
      ...events,
    }),
  )
  if (error) return { data, error }

  const result = data as { ok?: boolean; mode?: string; journal_entry_id?: string } | null
  if (result?.ok === true && result.mode === 'create_new' && result.journal_entry_id) {
    await announceRpcPostedEntry(supabase, companyId, userId, result.journal_entry_id, 'commit_bulk_booking')
  }
  return { data, error: null }
}

/** The raw answer of a posting RPC: its jsonb result, or the transport error. */
type PostingRpcAnswer = { data: unknown; error: { message: string; code?: string } | null }

/**
 * Announce a verifikat a SQL function has posted. The posting RPCs below
 * insert, number and commit their verifikat in SQL via commit_journal_entry,
 * so it never passes through commitEntry; their engine door calls this to
 * emit the journal_entry.committed payload commitEntry emits, reloaded and
 * scoped to the company. The verifikat is committed when this runs, so a
 * failed reload is logged and the event skipped: the operation still
 * succeeds.
 */
async function announceRpcPostedEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  journalEntryId: string,
  operation: string,
): Promise<void> {
  const { data: entry, error: fetchError } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .single()
  if (entry && !fetchError) {
    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: entry as JournalEntry, userId, companyId },
    })
    return
  }
  log.error(
    `${operation}: verifikat committed but its reload failed, journal_entry.committed not emitted`,
    fetchError ?? new Error('posted entry not found'),
    { operation, companyId, userId, journalEntryId },
  )
}

export interface MatchBatchAllocationInput {
  transactionId: string
  /** The allocations exactly as match_batch_allocate takes them. */
  allocations: unknown[]
  /**
   * The payment service's fees on the row (payoutFeeLines,
   * lib/bookkeeping/payout-fee-lines.ts), sent as p_fee_lines
   * (migration 20261028231700). Empty or omitted: the parameter is not sent,
   * so a database without it answers as before.
   */
  feeLines?: PayoutFeeLine[]
  /**
   * Kontantmetoden: customer invoice id to the revenue, moms and
   * öresavrundning lines its unbooked sale books at payment
   * (lib/invoices/batch-cash-method-guard.ts), sent as p_cash_lines (migration
   * 20261031100700). Empty or omitted: the parameter is not sent. Sent to a
   * database without it, the call answers PGRST202: a refusal, never a 1510
   * clearing.
   */
  cashLines?: Record<
    string,
    Array<{
      account_number: string
      debit_amount: number
      credit_amount: number
      line_description?: string
      dimensions?: Record<string, string>
    }>
  >
  /**
   * A supplier batch: the supplier debt from before the company kept its
   * books here that the row also pays (supplierDebtLines,
   * lib/bookkeeping/supplier-debt-lines.ts), sent as p_debt_lines (migration
   * 20261120150000). Empty or omitted: the parameter is not sent. Sent to a
   * database without it, the call answers PGRST202: a refusal, never a fee row.
   */
  debtLines?: SupplierDebtLine[]
  /**
   * The posting port's events, one per allocation (sale.payment_received or
   * purchase.paid), linked to the samlingsverifikat before its number is
   * drawn. Omitted: the RPC is called as before.
   */
  businessEvents?: SqlBusinessEventLink
}

/**
 * Allocate one bank transaction across N customer or N supplier invoices
 * through match_batch_allocate: one samlingsverifikat (BFL 5 kap 6 §) and N
 * payment rows, atomically in SQL. This is the RPC's one application door,
 * so that its verifikat is announced with journal_entry.committed. Every
 * success posts one, so every success emits; a refusal or transport error
 * emits nothing. A dry run must never reach this door.
 *
 * Attribution: the actor of the surrounding runWithActor scope is handed to
 * the RPC, which forwards it to commit_journal_entry (migration
 * 20261016005100); rpcWithActor retries without it on a database that does
 * not have that migration yet.
 *
 * Returns the RPC's answer unchanged: callers translate its refusals.
 */
export async function commitMatchBatchAllocation(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: MatchBatchAllocationInput,
): Promise<PostingRpcAnswer> {
  const { data, error } = await callWithBusinessEvents('match_batch_allocate', input.businessEvents, (events) =>
    rpcWithActor(supabase, 'match_batch_allocate', {
      p_tx_id: input.transactionId,
      p_allocations: input.allocations,
      p_company_id: companyId,
      // Honoured only for a service_role caller (the v1 and pending-operation
      // doors); a session caller resolves from its own auth.uid()
      // (migration 20260824120000).
      p_user_id: userId,
      ...(input.feeLines?.length ? { p_fee_lines: input.feeLines } : {}),
      ...(input.cashLines && Object.keys(input.cashLines).length > 0 ? { p_cash_lines: input.cashLines } : {}),
      ...(input.debtLines?.length ? { p_debt_lines: input.debtLines } : {}),
      ...events,
    }),
  )
  if (error) return { data, error }

  const result = data as { ok?: boolean; journal_entry_id?: string } | null
  if (result?.ok === true && result.journal_entry_id) {
    await announceRpcPostedEntry(supabase, companyId, userId, result.journal_entry_id, 'match_batch_allocate')
  }
  return { data, error: null }
}

export interface ExpensePayoutBatchInput {
  claimIds: string[]
  payoutDate: string
  cashAccount: string
  notes: string | null
  /** The bank outflow the payout is matched to, linked in the same RPC. */
  transactionId: string | null
  /**
   * The posting port's expense.paid_out events, one per claim, linked to the
   * verifikat before its number is drawn. Omitted: the RPC is called as
   * before.
   */
  businessEvents?: SqlBusinessEventLink
}

/**
 * Pay one claimant back for N registered expense claims through
 * create_expense_payout_batch: the liability to cash verifikat, the batch and
 * the claims marked paid, in one SQL transaction. This is the RPC's one
 * application door, so that its verifikat is announced with
 * journal_entry.committed. Every success posts one, so every success emits; a
 * refusal or transport error emits nothing. A dry run must never reach this
 * door. The actor is handed on as for commitMatchBatchAllocation.
 *
 * Returns the RPC's answer unchanged: callers translate its refusals.
 */
export async function commitExpensePayoutBatch(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: ExpensePayoutBatchInput,
): Promise<PostingRpcAnswer> {
  const { data, error } = await callWithBusinessEvents('create_expense_payout_batch', input.businessEvents, (events) =>
    rpcWithActor(supabase, 'create_expense_payout_batch', {
      p_company_id: companyId,
      p_claim_ids: input.claimIds,
      p_payout_date: input.payoutDate,
      p_cash_account: input.cashAccount,
      p_notes: input.notes,
      // Honoured only for a service_role caller (API-key and MCP paths run on
      // the cookieless service client where auth.uid() is NULL); a session
      // caller is pinned to its own auth.uid() by the RPC.
      p_user_id: userId,
      p_transaction_id: input.transactionId,
      ...events,
    }),
  )
  if (error) return { data, error }

  const result = data as { ok?: boolean; journal_entry_id?: string } | null
  if (result?.ok === true && result.journal_entry_id) {
    await announceRpcPostedEntry(supabase, companyId, userId, result.journal_entry_id, 'create_expense_payout_batch')
  }
  return { data, error: null }
}

export interface VoucherLinkInput {
  /** The already-posted verifikat that paid the invoice. */
  journalEntryId: string
  notes: string | null
  /**
   * The posting port's payment event (sale.payment_received or
   * purchase.paid), linked to the kursdifferens verifikat before its number
   * is drawn when the RPC posts one. Omitted: the RPC is called as before.
   */
  businessEvents?: SqlBusinessEventLink
}

/**
 * Link a posted verifikat to an open customer invoice as its payment through
 * link_invoice_to_voucher. The link itself posts nothing: the linked voucher
 * was announced when it was committed. Only when a foreign-currency invoice
 * settles at another rate than it was booked at does the RPC post the
 * kursdifferens as its own verifikat (3960/7960), and only that verifikat is
 * announced with journal_entry.committed. This is the RPC's one application
 * door. The actor is handed on as for commitMatchBatchAllocation and stamped
 * on that kursdifferens verifikat.
 *
 * `amount` is the share of the verifikat that is this invoice's, when the
 * verifikat settles several invoices. `p_amount` is sent only when a share is
 * stated, as on the supplier side: a link without one then reads the same
 * against a database that does not have migration 20261026007000 yet.
 *
 * Returns the RPC's answer unchanged: callers translate its refusals.
 */
export async function commitInvoiceVoucherLink(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: VoucherLinkInput & { invoiceId: string; amount?: number | null },
): Promise<PostingRpcAnswer> {
  const { data, error } = await callWithBusinessEvents('link_invoice_to_voucher', input.businessEvents, (events) =>
    rpcWithActor(supabase, 'link_invoice_to_voucher', {
      p_invoice_id: input.invoiceId,
      p_journal_entry_id: input.journalEntryId,
      p_user_id: userId,
      p_company_id: companyId,
      p_notes: input.notes,
      ...(input.amount == null ? {} : { p_amount: input.amount }),
      ...events,
    }),
  )
  if (error) return { data, error }

  const result = data as { ok?: boolean; fx_journal_entry_id?: string | null } | null
  if (result?.ok === true && result.fx_journal_entry_id) {
    await announceRpcPostedEntry(supabase, companyId, userId, result.fx_journal_entry_id, 'link_invoice_to_voucher')
  }
  return { data, error: null }
}

/**
 * Link a posted verifikat to an open supplier invoice as its payment through
 * link_supplier_invoice_to_voucher. As for the customer side, the link posts
 * nothing except the kursdifferens verifikat (3960/7960) a foreign-currency
 * invoice settled on 244x at another rate can need, and only that verifikat
 * is announced with journal_entry.committed. This is the RPC's one
 * application door.
 *
 * `amount` is the share of the verifikat that is this invoice's, when the
 * verifikat pays several debts. `p_amount` is sent only when a share is
 * stated: a link without one then reads the same against a database that
 * does not have migration 20261011153000 yet (the deploy and the migration
 * land separately), where the five-argument function is the only one. The
 * actor is handed on as for commitInvoiceVoucherLink.
 *
 * `linkBasis` is the payment row's basis on a door no person chose the pair
 * on. Left out, the RPC records a person's: `p_link_basis` is sent only when
 * named, for the same reason as `p_amount`.
 *
 * Returns the RPC's answer unchanged: callers translate its refusals.
 */
export async function commitSupplierInvoiceVoucherLink(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: VoucherLinkInput & { supplierInvoiceId: string; amount?: number | null; linkBasis?: ScopeFreeLinkBasis },
): Promise<PostingRpcAnswer> {
  const { data, error } = await callWithBusinessEvents('link_supplier_invoice_to_voucher', input.businessEvents, (events) =>
    rpcWithActor(supabase, 'link_supplier_invoice_to_voucher', {
      p_supplier_invoice_id: input.supplierInvoiceId,
      p_journal_entry_id: input.journalEntryId,
      p_user_id: userId,
      p_company_id: companyId,
      p_notes: input.notes,
      ...(input.amount == null ? {} : { p_amount: input.amount }),
      ...(input.linkBasis ? { p_link_basis: input.linkBasis } : {}),
      ...events,
    }),
  )
  if (error) return { data, error }

  const result = data as { ok?: boolean; fx_journal_entry_id?: string | null } | null
  if (result?.ok === true && result.fx_journal_entry_id) {
    await announceRpcPostedEntry(
      supabase,
      companyId,
      userId,
      result.fx_journal_entry_id,
      'link_supplier_invoice_to_voucher',
    )
  }
  return { data, error: null }
}

export interface CounterpartySetoffInput {
  /** The set-off's id (lib/invoices/counterparty-setoff/ids.ts), the voucher's source_id. */
  setoffId: string
  invoiceId: string
  supplierInvoiceId: string
  /** In SEK, öre-exact. */
  amount: number
  setoffDate: string
  note: string | null
  /**
   * The posting port's counterparty.set_off event, linked to the verifikat
   * before its number is drawn. Omitted: the RPC is called without it.
   */
  businessEvents?: SqlBusinessEventLink
}

/**
 * Kvittning through book_counterparty_setoff: the set-off verifikat (Dr 244x
 * / Cr 151x), both invoices' remaining amounts, a payment row on each side
 * and the counterparty_setoffs row, atomically in SQL. This is the RPC's one
 * application door, so that its verifikat is announced with
 * journal_entry.committed. Every success posts one, so every success emits; a
 * refusal or transport error emits nothing. A dry run must never reach this
 * door. The actor is handed on as for commitMatchBatchAllocation.
 *
 * Returns the RPC's answer unchanged: callers translate its refusals.
 */
export async function commitCounterpartySetoff(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CounterpartySetoffInput,
): Promise<PostingRpcAnswer> {
  const { data, error } = await callWithBusinessEvents('book_counterparty_setoff', input.businessEvents, (events) =>
    rpcWithActor(supabase, 'book_counterparty_setoff', {
      p_company_id: companyId,
      p_setoff_id: input.setoffId,
      p_invoice_id: input.invoiceId,
      p_supplier_invoice_id: input.supplierInvoiceId,
      p_amount: input.amount,
      p_setoff_date: input.setoffDate,
      p_note: input.note,
      // Honoured only for a service_role caller (the v1 and MCP doors run on
      // the cookieless service client); a session caller is pinned to its
      // own auth.uid() by the RPC.
      p_user_id: userId,
      ...events,
    }),
  )
  if (error) return { data, error }

  const result = data as { ok?: boolean; journal_entry_id?: string } | null
  if (result?.ok === true && result.journal_entry_id) {
    await announceRpcPostedEntry(supabase, companyId, userId, result.journal_entry_id, 'book_counterparty_setoff')
  }
  return { data, error: null }
}

/**
 * Cancel the verifikat a failed multi-step workflow created moments ago in
 * this same request (compensation, never a user-facing undo: that is a storno).
 *
 * posted -> cancelled is gated in the database: a direct UPDATE is refused
 * for every role, and the cancel_orphaned_entry RPC is the one door. It locks
 * the row and cancels it in whatever state the workflow left it: a draft as
 * it is, a posted entry only when the acting user both created and posted it
 * within the last 15 minutes, no live verifikat references it, and its
 * period is open and not behind the lock date. `gapExplanation`, when given, is written to
 * voucher_gap_explanations in the same transaction when the caller may author
 * one (team owner/admin, or a trusted backend client); otherwise it is skipped,
 * and the cancelled header still occupies its number, so no gap opens.
 *
 * The cancelled header keeps its lines: together they are the retained record
 * of how the voucher number was used, and every report excludes cancelled
 * entries by status.
 *
 * Never throws: every caller is already on an error path whose own response
 * must survive. A failure is logged and returned.
 */
export async function cancelOrphanedEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryId: string,
  options?: { gapExplanation?: string },
): Promise<{ error: { message: string; code?: string } | null }> {
  try {
    const { error } = await supabase.rpc('cancel_orphaned_entry', {
      p_company_id: companyId,
      p_entry_id: entryId,
      p_user_id: userId,
      p_gap_explanation: options?.gapExplanation ?? null,
    })
    if (error) {
      log.error('orphan cleanup refused or failed (entry left as it is)', error, {
        operation: 'cancel_orphaned_entry',
        companyId,
        entityType: 'journal_entry',
        entityId: entryId,
        pgCode: (error as { code?: string }).code,
      })
      return { error }
    }
    return { error: null }
  } catch (err) {
    log.error('orphan cleanup failed unexpectedly (entry left as it is)', err as Error, {
      operation: 'cancel_orphaned_entry',
      companyId,
      entityType: 'journal_entry',
      entityId: entryId,
    })
    return { error: { message: err instanceof Error ? err.message : String(err) } }
  }
}


/**
 * True when the collections rebook holds the collected payment booked on
 * this voucher: booked, not yet paid out by a booked payout, and under a
 * live booking lease (lib/collections/rebook.ts claims it before the storno).
 */
async function holdsCollectionsRebook(supabase: SupabaseClient, companyId: string, entryId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('collection_collected_payments')
    .select('id')
    .eq('company_id', companyId)
    .eq('journal_entry_id', entryId)
    .eq('status', 'booked')
    .is('settlement_id', null)
    .gt('booking_lease_until', new Date().toISOString())
    .limit(1)
  if (error) throw new BookkeepingDatabaseError('load_collections_rebook', error.message, error.code)
  return (data ?? []).length > 0
}

/**
 * Release the bank rows a reversed verifikat still anchors so they return to
 * Att bokföra: the pointer column and the transaction_voucher_links junction.
 * reverseEntry runs it after every storno; correctEntry (storno-service) runs
 * it for the rows its relink could not move to the corrected verifikat. A
 * row moved off the entry is untouched, so it is safe to call either way.
 * Failures are logged, not thrown: the storno itself already stands.
 */
export async function releaseBankRowsOfReversedEntry(
  supabase: SupabaseClient,
  companyId: string,
  entryId: string,
): Promise<void> {
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
  //
  // A released row must have no anchor left. A residual booking
  // (lib/reconciliation/residual.ts) keeps the main verifikat in the pointer
  // column and anchors the small residual verifikat through a junction row of
  // role 'other'. With the pointer gone that row would be the only thing left,
  // and it explains a few kronor of fee, not the bank amount: every reader
  // that counts junction rows (the bulk_book RPC, the link doors) would go on
  // calling the row booked while the
  // worklist shows it as att bokföra (#2061). The release_reversed_entry_
  // transactions RPC therefore resets the pointer AND drops the released
  // rows' links to other verifikat in one statement (one snapshot, the
  // UPDATE's row locks): no read-then-write window in which a failed read or
  // a concurrent booking leaves the half-anchored row behind. That mirrors
  // what koppla-bort removes and what the 1:N partial-split path below drops;
  // the residual verifikat stays posted and surfaces as unmatched again,
  // which is honest: its main sibling is gone. Links to the reversed entry
  // itself are left to the junction cleanup below, which owns them.
  const { data: releaseData, error: unlinkError } = await supabase.rpc(
    'release_reversed_entry_transactions',
    { p_company_id: companyId, p_entry_id: entryId },
  )
  if (unlinkError) {
    log.error('failed to unlink transactions from reversed entry', unlinkError, { entryId })
  } else {
    const counts = (releaseData ?? {}) as { released?: number; dropped?: number }
    if ((counts.dropped ?? 0) > 0) {
      log.info('dropped supplementary voucher links of released transactions', {
        entryId,
        released: counts.released ?? 0,
        dropped: counts.dropped,
      })
    }
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
}

/**
 * Create a reversal entry for an existing journal entry
 * Sets reversed_by_id/reverses_id links for compliance tracking
 *
 * The reversal is posted through commit_journal_entry
 * (commitStornoOrCorrectionDraft), so it records the actor of the
 * surrounding runWithActor scope like any other commit.
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
    /**
     * The collections rebook only (lib/collections/rebook.ts): lets the
     * storno of a collected-payment voucher through while the rebook holds
     * that payment's booking lease, and leaves its collections payment row
     * for collections_rebook_release. Every other caller leaves it unset, so
     * the generic storno of such a voucher stays refused.
     */
    collectionsRebook?: boolean
    /**
     * Posting port: the business event the storno answers, linked right
     * after the reversal's draft header and before its voucher number is
     * drawn (see CreateEntryOptions.businessEvent). Absent, nothing changes.
     */
    businessEvent?: BusinessEventLink
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

  // A payment the collections provider collected (invoice_payments.source
  // 'collections', step C in lib/collections/collected-payments.ts) is
  // corrected only through the collections rebook, which reopens and
  // re-settles the invoice in one service call. A generic storno would
  // reverse the voucher while block_delete_collected_payment keeps the
  // payment row: the invoice would stay paid against a reopened receivable,
  // and the provider's payout would still clear the reversed capital.
  // Checked before any voucher number is drawn.
  let collectionsRebook = false
  if (isPaymentSourceType(original.source_type)) {
    const { data: collected, error: collectedError } = await supabase
      .from('invoice_payments')
      .select('id')
      .eq('company_id', companyId)
      .eq('journal_entry_id', entryId)
      .eq('source', 'collections')
      .limit(1)
    if (collectedError) {
      throw new BookkeepingDatabaseError('load_collected_payment_rows', collectedError.message, collectedError.code)
    }
    if ((collected ?? []).length > 0) {
      collectionsRebook = options?.collectionsRebook === true && (await holdsCollectionsRebook(supabase, companyId, entryId))
      if (!collectionsRebook) throw new CannotReverseCollectedPaymentError()
    }
  }

  // A kundförlust voucher is undone latest decision first (a recovery before
  // the write-off it recovers), so the decision rows never disagree with the
  // ledger: its reversal hook refuses the rest before anything is posted.
  if (original.source_type === 'customer_loss') {
    // A recovery booked from a payment the collections provider collected
    // (a written-off invoice, lib/collections/collected-payments.ts) is
    // corrected through the collections rebook only, like a C voucher: a
    // generic storno would leave the payment booked on a reversed voucher,
    // and a booked payout may already have cleared its capital.
    const { data: collected, error: collectedError } = await supabase
      .from('collection_collected_payments')
      .select('id')
      .eq('company_id', companyId)
      .eq('journal_entry_id', entryId)
      .limit(1)
    if (collectedError) {
      throw new BookkeepingDatabaseError('load_collected_payment_rows', collectedError.message, collectedError.code)
    }
    if ((collected ?? []).length > 0) {
      collectionsRebook = options?.collectionsRebook === true && (await holdsCollectionsRebook(supabase, companyId, entryId))
      if (!collectionsRebook) throw new CannotReverseCollectedPaymentError()
    }
  }

  // A kontantmetod year-end carry (#3440) is stornoed only on its own date,
  // so its moms leaves the VAT period it was declared in, and only while
  // nothing has settled the invoice since. The database refuses both
  // (kontantmetod_carry_on_reversal) and releases the invoice link on a
  // storno it allows; refusing here first keeps the answer readable, since a
  // refusal at the compare-and-set below can only say "already reversed".
  if (original.source_type === 'year_end') {
    const carry = await findKontantmetodCarry(supabase, companyId, entryId)
    if (carry) {
      const carryReversalDate = reversalDate ?? original.entry_date
      if (carryReversalDate !== original.entry_date) {
        throw new CutoffCarryReversalDateError(original.entry_date, carryReversalDate)
      }
      if (await kontantmetodCarryHasSettlements(supabase, companyId, carry, original.entry_date)) {
        throw new KontantmetodCarryHasSettlementsError(
          (carry.invoiceId ?? carry.supplierInvoiceId) as string,
        )
      }
    }
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

  // The business-state mirrors this storno must run (reversal hooks:
  // lib/bookkeeping/reversal-hooks.ts, wired in lib/composition). Selected
  // and checked before anything is written, so neither refusal spends a
  // voucher number: a source type that needs a mirror with none registered
  // throws ReversalHookMissingError, and a beforeReversal may refuse (a
  // migrated invoice's deduction reclassification while a begäran holds the
  // invoice).
  const reversalHooks = selectReversalHooks(REVERSAL_HOOKS, original.source_type)
  const reversalHookContext: ReversalHookContext = {
    supabase,
    companyId,
    userId,
    entry: original as JournalEntry,
    // The rebook removes the collections payment row itself, inside its window.
    ...(collectionsRebook ? { leaveCollectedPaymentRows: true } : {}),
  }
  for (const hook of reversalHooks) {
    if (hook.beforeReversal) await hook.beforeReversal(reversalHookContext)
  }

  const lines = (original.lines as JournalEntryLine[]) || []

  // Create reversed lines (buildStornoLines: the opposite side, swapped on
  // the line's net), preserving dimensions.
  const reversedLines: CreateJournalEntryLineInput[] = buildStornoLines(lines).map(({ line, ...storno }) => ({
    account_number: line.account_number,
    debit_amount: storno.debit_amount,
    credit_amount: storno.credit_amount,
    line_description: `Reversal: ${line.line_description || ''}`,
    currency: line.currency,
    amount_in_currency: storno.amount_in_currency ?? undefined,
    exchange_rate: line.exchange_rate || undefined,
    tax_code: line.tax_code || undefined,
    dimensions: line.dimensions || undefined,
    cost_center: line.cost_center || undefined,
    project: line.project || undefined,
  }))

  // The storno is numbered in the original's series and booked into the
  // original's fiscal year, so its date must lie inside that year and the year
  // must be open (BFL 5 kap 5 §, BFNAR 2013:2 p. 2.17-2.18). Checked before
  // anything is written: the period-lock trigger only refused the insert.
  const entryDate = await assertStornoTarget(supabase, companyId, original, reversalDate)

  // Resolve account IDs: include inactive rows. The accounts on the
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

  // Create the reversal as a draft with reverses_id link. It holds no voucher
  // number yet (drafts are outside the verifikationsserie): commit_journal_entry
  // draws the next number in the original's series and period when it posts
  // it below, so a failure before that burns none. No `notes`: the note
  // describes the affärshändelse, and a storno cancels it instead of
  // representing it. The reversed original keeps its own note, and this
  // entry's text names the verifikat it reverses (crm#1078).
  const { data: reversalEntry, error: reversalError } = await supabase
    .from('journal_entries')
    .insert({
      company_id: companyId,
      user_id: userId,
      fiscal_period_id: original.fiscal_period_id,
      voucher_number: 0,
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
    throw new BookkeepingDatabaseError('create_reversal_entry', reversalError.message, reversalError.code)
  }
  if (!reversalEntry) {
    throw new BookkeepingDatabaseError('create_reversal_entry', undefined)
  }

  // Posting port: link before the lines and before the number, as in
  // createDraftEntry. Skipped entirely without the option.
  if (options?.businessEvent) {
    await linkDraftToBusinessEvent(supabase, companyId, reversalEntry.id, options.businessEvent)
  }

  // Insert reversal lines with dimensions
  const lineInserts = buildLineInserts(reversalEntry.id, reversedLines, accountIdMap)

  const { error: linesError } = await supabase
    .from('journal_entry_lines')
    .insert(lineInserts)

  if (linesError) {
    // Keep the reversal header as cancelled bookkeeping evidence. It is still
    // a draft without a number, so no voucher number is used or lost.
    await supabase.from('journal_entries').update({ status: 'cancelled' }).eq('id', reversalEntry.id)
    await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', reversalEntry.id)
    throw new BookkeepingDatabaseError('create_reversal_lines', linesError.message, linesError.code)
  }

  // Post the reversal: number, status and the commit stamp (the acting
  // user, key, OAuth client or cron job) in one transaction.
  const { error: postError } = await commitStornoOrCorrectionDraft(supabase, companyId, reversalEntry.id)

  if (postError) {
    // The RPC rolls back on any error, so the reversal is normally still a
    // draft without a number. The post may still have landed (an ambiguous
    // error), so this goes through the gated cleanup door, which cancels a
    // draft or a fresh posted orphan alike and keeps its lines.
    await cancelOrphanedEntry(supabase, companyId, userId, reversalEntry.id)
    if (postError instanceof UnattendedCommitLimitExceededError) throw postError
    throw new BookkeepingDatabaseError('post_reversal_entry', postError.message, postError.code)
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
    // posted -> cancelled is only possible through the gated cleanup door; it
    // refuses if the original in fact points at this reversal (an ambiguous
    // CAS error that did land), which leaves the consistent pair intact.
    await cancelOrphanedEntry(supabase, companyId, userId, reversalEntry.id)
    throw new EntryAlreadyReversedError()
  }

  await releaseBankRowsOfReversedEntry(supabase, companyId, entryId)

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
  // entryId, so a period already pointing elsewhere is untouched: callers
  // that relink a fresh IB before stornoing the old one
  // (opening-balance/correct) keep their new link.
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

  // Same hazard in the asset register: a planenlig avskrivning posted from
  // the register (commit_asset_depreciation) links its depreciation_schedules
  // row to this voucher. Left in place, the row keeps reading as "posted"
  // against a cancelled avskrivning: commit_asset_depreciation refuses to
  // book the period again and the register, the årsredovisning asset note
  // and disposal's accumulated depreciation all count an amount the ledger
  // no longer holds. Releasing the link makes the row an unposted proposal
  // again. enforce_depreciation_schedule_immutability permits exactly this
  // change and only once the voucher is 'reversed' with the posted storno
  // written above (migration 20260925194235), and the release is audited by
  // audit_depreciation_schedule_release. Scoped to this entryId, so rows
  // linked to any other voucher are untouched. Register-linked vouchers are
  // always source_type 'year_end' (the RPC refuses anything else).
  if (original.source_type === 'year_end') {
    const { error: depreciationReleaseError } = await supabase
      .from('depreciation_schedules')
      .update({ journal_entry_id: null, posted_at: null })
      .eq('company_id', companyId)
      .eq('journal_entry_id', entryId)
    if (depreciationReleaseError) {
      log.error('failed to release depreciation schedule from reversed entry', depreciationReleaseError, {
        entryId,
      })
    }
  }

  // The business-state mirrors selected above (the invoice behind a payment
  // voucher, a ROT/RUT begäran, a migrated invoice's deduction, a collections
  // payout, a kundförlust decision), in list order, one at a time, each with
  // the storno it follows. Not caught: an unexpected throw propagates, the
  // storno stands and the emits below are skipped.
  const reversalHookAfterContext: ReversalHookAfterContext = {
    ...reversalHookContext,
    storno: { id: reversalEntry.id, entry_date: reversalEntry.entry_date },
  }
  for (const hook of reversalHooks) {
    if (hook.afterReversal) await hook.afterReversal(reversalHookAfterContext)
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
