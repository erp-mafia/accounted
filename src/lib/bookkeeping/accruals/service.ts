/**
 * Periodisering (accrual schedule) service.
 *
 * A schedule spreads one invoice line's net amount over the calendar months
 * of a service period. The origin entry (supplier invoice registration /
 * customer invoice revenue entry) books the net to an interim account
 * (17xx/29xx); this service creates and posts the monthly dissolution
 * entries:
 *
 *   expense:  Dr target (5xxx/6xxx)  / Cr balance (17xx förutbetald,
 *                                                  29xx upplupen kostnad)
 *   revenue:  Dr balance (29xx förutbetald,
 *                         17xx upplupen intäkt)    / Cr target (3xxx)
 *
 * All entries go through the engine (source_type 'accrual'): never direct
 * inserts, and through the posting port (step 2g), which hands the engine
 * each input unchanged and, while POSTING_EVENTS is shadow or strict, records
 * one business event per verifikat (business-events.ts) and has the engine
 * link it to the draft before a voucher number is drawn. Each month posts
 * on its own, so each dissolution and each storno is its own event; the link
 * basis is the request's (linkBasisColumns: a person, an approved operation,
 * an API client, or the cron as system_derived).
 *
 * A month reaches the books at most once, whichever door posts it: its
 * verifikat and its own row (pending to posted) are committed in one database
 * transaction. A single month goes through commit_accrual_installment
 * (postDueInstallments: the cron, Bokför förfallna, the catch-up), the rest
 * of a schedule in one verifikat through commit_accrual_dissolution
 * (dissolveScheduleNow), which marks exactly the months its amount was added
 * up from. A run that finds its month, or its set of months, taken or
 * changed cancels its draft, which has no voucher number, so overlapping
 * runs post one verifikat and no storno, and a run killed mid-way leaves
 * every month either posted or still waiting. While a database lacks the
 * functions (the minutes between a deploy and its migration) both doors fall
 * back to the separate statements they used before, which is reported as an
 * error by the engine.
 *
 * A deferral posts on max(period_month, posting_floor_date,
 * company lock date + 1) so catch-up months book correctly and the interim
 * account never goes negative. An upplupen kostnad (expense on 29xx) or
 * upplupen intäkt (revenue on 17xx) covers months before the invoice and
 * posts on the last day of each month, never moved by the floor or a lock
 * (accruedPosting).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  AccrualDirection,
  AccrualReplanResult,
  AccrualSchedule,
  AccrualScheduleInstallment,
  CreateJournalEntryLineInput,
} from '@/types'
import { cancelDraftEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import {
  CannotReverseNonPostedError,
  EntryAlreadyReversedError,
} from '@/lib/bookkeeping/errors'
import {
  AccrualNothingToDissolveError,
  AccrualReplanInvalidError,
  AccrualScheduleNotActiveError,
  AccrualScheduleNotFoundError,
} from '@/lib/bookkeeping/accruals/errors'
import {
  computeInstallments,
  dayAfter,
  deferralReleaseDate,
  firstOfMonth,
  lastOfMonth,
  listCalendarMonths,
  maxIsoDate,
  replanPendingInstallments,
} from '@/lib/bookkeeping/accruals/compute'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { isAccruedCostAccount } from '@/lib/bookkeeping/accruals/account-suggestions'
import { coerceDimensionsBag } from '@/lib/bookkeeping/dimension-resolver'
import { isAccruedIncomeAccount } from '@/lib/bookkeeping/accruals/account-suggestions'
import { roundOre, sumOre } from '@/lib/money'
import { createLogger } from '@/lib/logger'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import { liveEntryOf } from '@/lib/core/bookkeeping/correction-chain'
import { accrualDissolutionBusinessEvent, accrualStornoBusinessEvent } from './business-events'

const log = createLogger('bookkeeping.accruals')

export interface AccrualScheduleSpec {
  direction: AccrualDirection
  sourceKind?: 'invoice' | 'manual'
  supplierInvoiceId?: string
  supplierInvoiceItemId?: string | null
  invoiceId?: string
  invoiceItemId?: string | null
  /** Interim account: 17xx or 29xx, in either direction. */
  balanceAccount: string
  /** The P&L account the amount dissolves to. */
  targetAccount: string
  /** Net amount in SEK as booked on the origin entry (ex VAT). */
  totalAmountSek: number
  periodStart: string
  periodEnd: string
  description: string
  /**
   * Dimensions bag ({sie_dim_no: object_code}) as booked on the origin
   * entry's interim line (invoice default_dimensions merged with the item
   * bag). Carried onto both dissolution lines.
   */
  dimensions?: Record<string, string>
}

export interface PostDueResult {
  posted: number
  failed: number
  skipped: number
  errors: Array<{ installmentId: string; message: string }>
  /** Due months not started because the caller's deadline came first; the next run posts them. */
  deferred?: number
}

type ScheduleRow = AccrualSchedule
type InstallmentRow = AccrualScheduleInstallment & { schedule?: ScheduleRow | null }

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Storno a dissolution through the posting port, recording ledger.storno of
 * the schedule's invoice: system_derived when the service undoes its own
 * duplicate after a lost or failed claim, user_created when the invoice was
 * credited (the request's scope resolves who acted).
 */
function stornoDissolution(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  schedule: Pick<ScheduleRow, 'id' | 'supplier_invoice_id' | 'invoice_id' | 'origin_journal_entry_id' | 'source_kind'>,
  entryId: string,
  basis: 'system_derived' | 'user_created',
  reversalDate?: string,
) {
  return postingPort.reverseJournalEntry({
    supabase,
    companyId,
    userId,
    entryId,
    reversalDate,
    event: () =>
      accrualStornoBusinessEvent({ schedule, occurredOn: todayIsoStockholm(), linkBasis: linkBasisColumns(basis) }),
    role: 'reversal',
  })
}

async function fetchLockDateFloor(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('company_settings')
    .select('bookkeeping_locked_through')
    .eq('company_id', companyId)
    .maybeSingle()
  const lockedThrough = (data as { bookkeeping_locked_through?: string | null } | null)
    ?.bookkeeping_locked_through
  return lockedThrough ? dayAfter(lockedThrough) : null
}

/**
 * Earliest OPEN fiscal period starting after `date`. Used to clamp a posting
 * date forward when the computed date falls inside a closed period (bokslut
 * done): same spirit as the company lock-date floor.
 */
async function findNextOpenPeriodStart(
  supabase: SupabaseClient,
  companyId: string,
  date: string,
): Promise<{ fiscalPeriodId: string; periodStart: string } | null> {
  const { data } = await supabase
    .from('fiscal_periods')
    .select('id, period_start')
    .eq('company_id', companyId)
    .eq('is_closed', false)
    .gt('period_start', date)
    .order('period_start', { ascending: true })
    .limit(1)
    .maybeSingle()
  const row = data as { id: string; period_start: string } | null
  return row ? { fiscalPeriodId: row.id, periodStart: row.period_start } : null
}

/**
 * An expense schedule on 29xx (upplupen kostnad) or a revenue schedule on
 * 17xx (upplupen intäkt): its months lie before the invoice, and the invoice
 * entry that clears the interim account comes after them.
 */
function isAccruedSchedule(schedule: Pick<ScheduleRow, 'direction' | 'balance_account'>): boolean {
  return schedule.direction === 'expense'
    ? isAccruedCostAccount(schedule.balance_account)
    : isAccruedIncomeAccount(schedule.balance_account)
}

interface InstallmentPosting {
  entryDate: string
  fiscalPeriodId: string
}

/**
 * The day a month of `schedule` falls due: its release day for a deferral
 * (the first of the month unless the schedule names another day), the first
 * of the month for an upplupen kostnad or intäkt, whose months lie before the
 * invoice and book on their last day as soon as they are due. One rule for
 * the posting runs and the list's due count.
 */
export function installmentDueDate(
  schedule: Pick<ScheduleRow, 'direction' | 'balance_account' | 'release_day'>,
  periodMonth: string,
): string {
  return isAccruedSchedule(schedule)
    ? firstOfMonth(periodMonth)
    : deferralReleaseDate(periodMonth, schedule.release_day)
}

/**
 * A deferral (förutbetald kostnad 17xx, förutbetald intäkt 29xx) dissolves
 * on max(release date, posting floor, lock date + 1): never before the
 * origin entry put the amount on the interim account, so the interim
 * account cannot go negative, and a closed year clamps to the next open one.
 * The release date is the month's release day, the first unless set.
 */
async function deferralPosting(
  supabase: SupabaseClient,
  companyId: string,
  periodMonth: string,
  schedule: Pick<ScheduleRow, 'posting_floor_date' | 'release_day'>,
  lockFloor: string | null,
): Promise<InstallmentPosting> {
  const entryDate = maxIsoDate(
    deferralReleaseDate(periodMonth, schedule.release_day),
    schedule.posting_floor_date,
    lockFloor,
  )
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, entryDate)
  if (fiscalPeriodId) return { entryDate, fiscalPeriodId }
  // The computed date can fall inside a CLOSED fiscal period (bokslut
  // done while the company lock date lags behind). Clamp forward to the
  // start of the earliest open period: same spirit as the lockFloor:
  // instead of retrying the same impossible date forever.
  const clamped = await findNextOpenPeriodStart(supabase, companyId, entryDate)
  if (!clamped) {
    throw new Error(
      `Ingen öppen räkenskapsperiod för ${entryDate} eller senare: ` +
        'skapa nästa räkenskapsår för att kunna bokföra periodiseringen',
    )
  }
  return { entryDate: clamped.periodStart, fiscalPeriodId: clamped.fiscalPeriodId }
}

/**
 * An upplupen kostnad or intäkt books on the last day of its own month,
 * before the invoice that clears the interim account, so neither the posting
 * floor nor a clamp applies: the cost or revenue belongs to that month. A
 * month that cannot take the entry fails here (the installment stays pending
 * with last_error, retried by the cron and Bokför förfallna) instead of
 * landing in another month. Booking refuses such months up front
 * (assertAccruedCostLinesBookable, assertAccruedIncomeLinesBookable); this
 * only fires when a period was locked or closed in between.
 */
async function accruedPosting(
  supabase: SupabaseClient,
  companyId: string,
  periodMonth: string,
  direction: AccrualDirection,
  lockFloor: string | null,
): Promise<InstallmentPosting> {
  const entryDate = lastOfMonth(periodMonth)
  const subject = direction === 'expense' ? 'Den upplupna kostnaden' : 'Den upplupna intäkten'
  if (lockFloor && entryDate < lockFloor) {
    throw new Error(
      `${subject} för ${periodMonth.slice(0, 7)} ska bokföras ${entryDate}, ` +
        'men datumet ligger inom företagets låsdatum. Den flyttas inte till en annan månad: ' +
        'flytta låsdatumet och välj Bokför förfallna, eller kreditera fakturan.',
    )
  }
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, entryDate)
  if (!fiscalPeriodId) {
    throw new Error(
      `${subject} för ${periodMonth.slice(0, 7)} ska bokföras ${entryDate}, ` +
        'men inget öppet räkenskapsår täcker datumet. Den flyttas inte till en annan period: ' +
        'lägg upp räkenskapsåret om det saknas och välj Bokför förfallna, annars kreditera fakturan.',
    )
  }
  return { entryDate, fiscalPeriodId }
}

function dissolutionLines(
  schedule: Pick<
    ScheduleRow,
    'direction' | 'balance_account' | 'target_account' | 'dimensions'
  >,
  amount: number,
  lineDescription: string,
): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] =
    schedule.direction === 'expense'
      ? [
          {
            account_number: schedule.target_account,
            debit_amount: amount,
            credit_amount: 0,
            line_description: lineDescription,
          },
          {
            account_number: schedule.balance_account,
            debit_amount: 0,
            credit_amount: amount,
            line_description: lineDescription,
          },
        ]
      : [
          {
            account_number: schedule.balance_account,
            debit_amount: amount,
            credit_amount: 0,
            line_description: lineDescription,
          },
          {
            account_number: schedule.target_account,
            debit_amount: 0,
            credit_amount: amount,
            line_description: lineDescription,
          },
        ]
  // Both origin generators tag the interim (17xx/29xx) line with the item's
  // merged bag (groupExpenseBuckets / generatePerRateLines keep the bag when
  // the account swaps to the interim account), so BOTH dissolution lines get
  // the schedule's bag: the P&L line for the per-dimension result, the
  // balance line so per-dimension views of the interim account net to zero.
  const dimensions = coerceDimensionsBag(schedule.dimensions)
  if (dimensions) {
    for (const line of lines) line.dimensions = { ...dimensions }
  }
  return lines
}

/**
 * Create a schedule + its monthly installments for one deferred invoice
 * line, then immediately post every installment whose month has already
 * begun (catch-up). Catch-up failures do not throw: they are recorded on
 * the installment (last_error) and retried by the daily cron.
 */
export async function createAccrualSchedule(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  spec: AccrualScheduleSpec,
  options: {
    originJournalEntryId?: string | null
    /**
     * Entry date of the origin entry; floors every deferral's dissolution
     * dates. An upplupen kostnad (expense on 29xx) or intäkt (revenue on
     * 17xx) books before it.
     */
    postingFloorDate: string
    /** Skip synchronous catch-up posting (tests / bulk imports). */
    postCatchUp?: boolean
    today?: string
  },
): Promise<AccrualSchedule> {
  const plan = computeInstallments(spec.totalAmountSek, spec.periodStart, spec.periodEnd)

  const { data: schedule, error: scheduleError } = await supabase
    .from('accrual_schedules')
    .insert({
      user_id: userId,
      company_id: companyId,
      direction: spec.direction,
      source_kind: spec.sourceKind ?? 'invoice',
      supplier_invoice_id: spec.supplierInvoiceId ?? null,
      supplier_invoice_item_id: spec.supplierInvoiceItemId ?? null,
      invoice_id: spec.invoiceId ?? null,
      invoice_item_id: spec.invoiceItemId ?? null,
      balance_account: spec.balanceAccount,
      target_account: spec.targetAccount,
      total_amount: roundOre(spec.totalAmountSek),
      period_start: spec.periodStart,
      period_end: spec.periodEnd,
      months: plan.length,
      origin_journal_entry_id: options.originJournalEntryId ?? null,
      posting_floor_date: options.postingFloorDate,
      status: 'active',
      description: spec.description,
      dimensions: spec.dimensions ?? {},
    })
    .select('*')
    .single()

  if (scheduleError || !schedule) {
    throw new Error(
      `Failed to create accrual schedule: ${scheduleError?.message ?? 'no row returned'}`,
    )
  }

  const scheduleRow = schedule as ScheduleRow

  const { error: installmentError } = await supabase
    .from('accrual_schedule_installments')
    .insert(
      plan.map((installment) => ({
        user_id: userId,
        company_id: companyId,
        schedule_id: scheduleRow.id,
        period_month: installment.period_month,
        amount: installment.amount,
        status: 'pending',
      })),
    )

  if (installmentError) {
    // Schedule without installments is inert but confusing: clean it up.
    await supabase.from('accrual_schedules').delete().eq('id', scheduleRow.id)
    throw new Error(`Failed to create accrual installments: ${installmentError.message}`)
  }

  if (options.postCatchUp !== false) {
    const result = await postDueInstallments(supabase, companyId, {
      userId,
      scheduleId: scheduleRow.id,
      today: options.today,
    })
    if (result.failed > 0) {
      log.warn('accrual catch-up posting failed for some installments', {
        companyId,
        scheduleId: scheduleRow.id,
        failed: result.failed,
      })
    }
  }

  return scheduleRow
}

const MANUAL_ORIGIN_REVERSED_MESSAGE =
  'Verifikatet som periodiseringen utgår från är makulerat utan rättelse, så månaden bokförs inte. ' +
  'Ångra periodiseringen, och lägg vid behov upp en ny från det verifikat som står kvar.'

/**
 * Whether a manual periodisering's origin verifikat still stands: posted, or
 * stornoed with a posted rättelse in its place (liveEntryOf). Reversing the
 * origin cancels its manual plans (cancel-accruals-on-origin-reversal); this
 * keeps a month from posting when that did not run. Invoice plans and plans
 * from an ingående balans have no origin to check. Cached per run.
 */
async function manualOriginStands(
  supabase: SupabaseClient,
  companyId: string,
  schedule: Pick<ScheduleRow, 'source_kind' | 'origin_journal_entry_id'>,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const originId = schedule.source_kind === 'manual' ? schedule.origin_journal_entry_id : null
  if (!originId) return true
  const cached = cache.get(originId)
  if (cached !== undefined) return cached
  const live = await liveEntryOf(supabase, companyId, originId)
  const stands = !('none' in live)
  cache.set(originId, stands)
  return stands
}

/**
 * How a month was claimed before commit_accrual_installment, kept for the
 * window right after a deploy in which the database does not have the
 * function yet: the engine's accrual door has posted the verifikat
 * (posted_unclaimed), and the month is claimed with a compare-and-set. The
 * two are separate writes, so the loser of a race stornoes its own verifikat;
 * the function removes exactly that.
 */
async function claimAfterUnclaimedPosting(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  schedule: ScheduleRow,
  installmentId: string,
  entry: { id: string },
): Promise<'posted' | 'not_pending'> {
  const { data: claimed, error: claimError } = await supabase
    .from('accrual_schedule_installments')
    .update({
      status: 'posted',
      journal_entry_id: entry.id,
      posted_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', installmentId)
    .eq('status', 'pending')
    .select('id')

  if (claimError) {
    // The verifikat is committed but the month was not marked posted:
    // without a storno the next run would book the same month twice.
    let reversalNote = ''
    try {
      await stornoDissolution(supabase, companyId, userId, schedule, entry.id, 'system_derived')
    } catch (reversalError) {
      log.error('failed to reverse accrual entry after claim error', reversalError, {
        companyId,
        installmentId,
        entryId: entry.id,
      })
      reversalNote =
        `; storno av verifikat ${entry.id} misslyckades också: ` +
        getErrorMessage(reversalError)
    }
    throw new Error(
      `Failed to mark installment posted: ${claimError.message}${reversalNote}`,
    )
  }
  if (!claimed || claimed.length === 0) {
    log.warn('accrual installment claimed concurrently; reversing duplicate entry', {
      companyId,
      installmentId,
      entryId: entry.id,
    })
    await stornoDissolution(supabase, companyId, userId, schedule, entry.id, 'system_derived')
    return 'not_pending'
  }
  return 'posted'
}

/**
 * An accrual draft is committed (or cancelled) within the call that made it,
 * so one that is still a draft half an hour later was left by a run that was
 * killed between the two. It has no voucher number and no door will post it;
 * it is cancelled so it does not sit in the drafts list looking like a month
 * someone should book by hand.
 */
const ABANDONED_DRAFT_MIN_AGE_MS = 30 * 60 * 1000
/** How long a draft whose cancel keeps failing is tried again (once a day), and then left alone. */
const ABANDONED_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/**
 * A problem with a draft is reported only while the draft is younger than
 * this: the windows [30 min, 24.5 h) of two daily runs 24 hours apart do not
 * overlap, so the one daily run whose window a draft falls in reports it and
 * the runs after it are quiet. Nothing can be written on a draft behind a
 * lock, so its age is the only memory there is.
 */
const ABANDONED_DRAFT_REPORT_AGE_MS = 24.5 * 60 * 60 * 1000
const ABANDONED_DRAFT_BATCH = 200
/** The draft with its fiscal year's lock state: enforce_period_lock refuses any write in a closed or locked year. */
const ABANDONED_DRAFT_SELECT =
  'id, company_id, user_id, created_at, fiscal_period:fiscal_periods!journal_entries_fiscal_period_id_fkey!inner(is_closed, locked_at)'

interface AbandonedDraftRow {
  id: string
  company_id: string
  user_id: string
  created_at: string
  fiscal_period?: { is_closed: boolean | null; locked_at: string | null } | null
}

/**
 * Cancel the accrual drafts killed runs left behind, in every company,
 * whether or not a month is due today: the daily cron calls this once per
 * run. Only this service drafts with source_type 'accrual' (the API refuses
 * the type to its callers), so the query is the whole set: drafts between
 * half an hour and a week old in a fiscal year that is open, oldest first, at
 * most ABANDONED_DRAFT_BATCH, the year's lock filtered in the query so drafts
 * that cannot be cancelled never take the place of ones that can.
 *
 * A draft whose year was closed or locked after the killed run drafted it
 * cannot be cancelled (enforce_period_lock refuses the write) and cannot be
 * posted either: it is inert and has no number. It is never tried; the daily
 * run whose window it falls in reports it once as an error, and a person
 * removes it if the year is opened again. A cancel that fails for another
 * reason is reported once the same way and tried again quietly each day for
 * a week (cancelDraftEntry logs its own database refusals).
 */
export async function cancelAbandonedAccrualDrafts(
  supabase: SupabaseClient,
  options: { now?: Date } = {},
): Promise<{ cancelled: number; failed: number; locked: number }> {
  const now = (options.now ?? new Date()).getTime()
  const olderThan = new Date(now - ABANDONED_DRAFT_MIN_AGE_MS).toISOString()
  const reportable = (row: AbandonedDraftRow) => now - Date.parse(row.created_at) < ABANDONED_DRAFT_REPORT_AGE_MS

  const { data, error } = await supabase
    .from('journal_entries')
    .select(ABANDONED_DRAFT_SELECT)
    .eq('source_type', 'accrual')
    .eq('status', 'draft')
    .eq('fiscal_period.is_closed', false)
    .is('fiscal_period.locked_at', null)
    .gte('created_at', new Date(now - ABANDONED_DRAFT_MAX_AGE_MS).toISOString())
    .lt('created_at', olderThan)
    .order('created_at', { ascending: true })
    .limit(ABANDONED_DRAFT_BATCH)
  if (error) {
    throw new Error(`Failed to look for abandoned accrual drafts: ${error.message}`)
  }

  let cancelled = 0
  let failed = 0
  for (const draft of (data ?? []) as unknown as AbandonedDraftRow[]) {
    try {
      await cancelDraftEntry(supabase, draft.company_id, draft.user_id, draft.id)
      cancelled++
      log.info('cancelled an accrual draft a killed run left behind', { companyId: draft.company_id, draftId: draft.id })
    } catch (cancelError) {
      failed++
      const context = { companyId: draft.company_id, draftId: draft.id, createdAt: draft.created_at }
      if (reportable(draft)) {
        log.error('an abandoned accrual draft could not be cancelled; it has no voucher number and is tried again daily for a week', cancelError, context)
      } else {
        log.info('abandoned accrual draft still not cancelled', { ...context, message: getErrorMessage(cancelError) })
      }
    }
  }

  // The drafts the query above leaves out because their year is closed or
  // locked: reported once, by the run whose window they fall in.
  const { data: recent, error: recentError } = await supabase
    .from('journal_entries')
    .select(ABANDONED_DRAFT_SELECT)
    .eq('source_type', 'accrual')
    .eq('status', 'draft')
    .gte('created_at', new Date(now - ABANDONED_DRAFT_REPORT_AGE_MS).toISOString())
    .lt('created_at', olderThan)
    .order('created_at', { ascending: true })
    .limit(ABANDONED_DRAFT_BATCH)
  if (recentError) {
    throw new Error(`Failed to look for abandoned accrual drafts in closed years: ${recentError.message}`)
  }
  let locked = 0
  for (const draft of (recent ?? []) as unknown as AbandonedDraftRow[]) {
    if (!draft.fiscal_period?.is_closed && !draft.fiscal_period?.locked_at) continue
    locked++
    log.error(
      'an abandoned accrual draft sits in a closed or locked fiscal year: it cannot be cancelled or posted and is left as an unnumbered draft',
      new Error('abandoned accrual draft behind a period lock'),
      { companyId: draft.company_id, draftId: draft.id, createdAt: draft.created_at },
    )
  }
  return { cancelled, failed, locked }
}

/**
 * Post every pending installment whose calendar month has begun.
 * Used by the daily cron, the manual "Bokför förfallna" action, and the
 * synchronous catch-up at schedule creation (scheduleId filter).
 *
 * Each installment books independently; one failure never blocks the rest.
 */
export async function postDueInstallments(
  supabase: SupabaseClient,
  companyId: string,
  options: {
    /** Falls back to each schedule's creator for cron runs. */
    userId?: string
    scheduleId?: string
    today?: string
    /** Epoch ms after which no further month is started (the cron's time budget). */
    deadline?: number
  } = {},
): Promise<PostDueResult> {
  const today = options.today ?? todayIsoStockholm()
  const result: PostDueResult = { posted: 0, failed: 0, skipped: 0, errors: [] }

  let query = supabase
    .from('accrual_schedule_installments')
    .select('*, schedule:accrual_schedules(*)')
    .eq('company_id', companyId)
    .eq('status', 'pending')
    .lte('period_month', firstOfMonth(today))
    .order('period_month', { ascending: true })

  if (options.scheduleId) {
    query = query.eq('schedule_id', options.scheduleId)
  }

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to load due accrual installments: ${error.message}`)
  }

  // The query takes every month that has begun; a month whose release day
  // is still ahead waits for it.
  const due = ((data ?? []) as InstallmentRow[]).filter(
    (installment) =>
      installment.schedule?.status === 'active' &&
      installmentDueDate(installment.schedule, installment.period_month) <= today,
  )
  if (due.length === 0) return result

  const lockFloor = await fetchLockDateFloor(supabase, companyId)
  const touchedSchedules = new Set<string>()
  const originStanding = new Map<string, boolean>()

  for (const [index, installment] of due.entries()) {
    // A month not started stays pending, untouched: the next run takes it.
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      result.deferred = due.length - index
      break
    }
    const schedule = installment.schedule as ScheduleRow
    try {
      if (!(await manualOriginStands(supabase, companyId, schedule, originStanding))) {
        throw new Error(MANUAL_ORIGIN_REVERSED_MESSAGE)
      }
      const { entryDate, fiscalPeriodId } = isAccruedSchedule(schedule)
        ? await accruedPosting(supabase, companyId, installment.period_month, schedule.direction, lockFloor)
        : await deferralPosting(supabase, companyId, installment.period_month, schedule, lockFloor)

      const monthLabel = installment.period_month.slice(0, 7)
      const description = schedule.description
        ? `Periodisering ${monthLabel}: ${schedule.description}`
        : `Periodisering ${monthLabel}`

      const userId = options.userId ?? schedule.user_id
      // Draft first: it holds no voucher number, so a month another run
      // takes in the meantime costs a cancelled draft and nothing else.
      const draft = await postingPort.draftJournalEntry({
        supabase,
        companyId,
        userId,
        // The month the share belongs to: its last day for an upplupen
        // kostnad or intäkt (its entry date, never moved), its first for a
        // deferral.
        event: () =>
          accrualDissolutionBusinessEvent({
            schedule,
            occurredOn: isAccruedSchedule(schedule) ? entryDate : installment.period_month,
            amount: installment.amount,
            linkBasis: linkBasisColumns('user_created'),
          }),
        input: {
          fiscal_period_id: fiscalPeriodId,
          entry_date: entryDate,
          description,
          source_type: 'accrual',
          source_id: schedule.id,
          lines: dissolutionLines(schedule, installment.amount, description),
        },
      })

      // The voucher number and the month's pending to posted in one
      // transaction, under the month's row lock.
      const committed = await postingPort.commitSqlPosting({
        supabase,
        companyId,
        userId,
        fn: 'commit_accrual_installment',
        args: [draft, installment.id],
      })
      const outcome =
        committed.outcome === 'posted_unclaimed'
          ? await claimAfterUnclaimedPosting(supabase, companyId, userId, schedule, installment.id, committed.entry)
          : committed.outcome
      if (outcome === 'not_pending') {
        if (committed.outcome === 'not_pending') {
          log.info('accrual installment already taken by another run; draft cancelled, nothing posted', {
            companyId,
            installmentId: installment.id,
            draftId: draft.id,
          })
        }
        result.skipped++
        continue
      }

      touchedSchedules.add(schedule.id)
      result.posted++
    } catch (error) {
      const message = getErrorMessage(error)
      log.error('failed to post accrual installment', error, {
        companyId,
        installmentId: installment.id,
        scheduleId: schedule.id,
      })
      result.failed++
      result.errors.push({ installmentId: installment.id, message })
      await supabase
        .from('accrual_schedule_installments')
        .update({ last_error: message })
        .eq('id', installment.id)
        .eq('status', 'pending')
    }
  }

  for (const scheduleId of touchedSchedules) {
    await completeScheduleIfDone(supabase, companyId, scheduleId)
  }

  return result
}

async function completeScheduleIfDone(
  supabase: SupabaseClient,
  companyId: string,
  scheduleId: string,
): Promise<void> {
  const { count, error } = await supabase
    .from('accrual_schedule_installments')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('schedule_id', scheduleId)
    .eq('status', 'pending')

  if (error || count === null || count > 0) return

  await supabase
    .from('accrual_schedules')
    .update({ status: 'completed' })
    .eq('id', scheduleId)
    .eq('company_id', companyId)
    .eq('status', 'active')
}

/**
 * Dissolve everything that remains on a schedule in one entry, dated today
 * (clamped by lock date / posting floor). Used when the service period ends
 * early or the user simply wants the rest expensed now. For an upplupen
 * kostnad or intäkt whose month can no longer take its entry this is the
 * explicit way out: the confirm dialog says the remainder books today.
 */
export async function dissolveScheduleNow(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  scheduleId: string,
  options: { today?: string } = {},
): Promise<{ journalEntryId: string; amount: number }> {
  const today = options.today ?? todayIsoStockholm()

  const { data: scheduleData, error: scheduleError } = await supabase
    .from('accrual_schedules')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', scheduleId)
    .single()

  if (scheduleError || !scheduleData) {
    throw new AccrualScheduleNotFoundError()
  }
  const schedule = scheduleData as ScheduleRow
  if (schedule.status !== 'active') {
    throw new AccrualScheduleNotActiveError(schedule.status)
  }

  const { data: pendingData, error: pendingError } = await supabase
    .from('accrual_schedule_installments')
    .select('*')
    .eq('company_id', companyId)
    .eq('schedule_id', scheduleId)
    .eq('status', 'pending')

  if (pendingError) {
    throw new Error(`Failed to load installments: ${pendingError.message}`)
  }
  const pending = (pendingData ?? []) as InstallmentRow[]
  if (pending.length === 0) {
    await completeScheduleIfDone(supabase, companyId, scheduleId)
    throw new AccrualNothingToDissolveError()
  }

  const amount = sumOre(pending.map((installment) => installment.amount))

  const lockFloor = await fetchLockDateFloor(supabase, companyId)
  const entryDate = maxIsoDate(today, schedule.posting_floor_date, lockFloor)
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, entryDate)
  if (!fiscalPeriodId) {
    throw new Error(`Ingen öppen räkenskapsperiod för ${entryDate}`)
  }

  const description = schedule.description
    ? `Periodisering, slutupplösning: ${schedule.description}`
    : 'Periodisering, slutupplösning'

  const draft = await postingPort.draftJournalEntry({
    supabase,
    companyId,
    userId,
    // The rest dissolved by decision today.
    event: () =>
      accrualDissolutionBusinessEvent({ schedule, occurredOn: today, amount, linkBasis: linkBasisColumns('user_created') }),
    input: {
      fiscal_period_id: fiscalPeriodId,
      entry_date: entryDate,
      description,
      source_type: 'accrual',
      source_id: schedule.id,
      lines: dissolutionLines(schedule, amount, description),
    },
  })

  // The voucher number, every pending month and the schedule's completion in
  // one transaction, for exactly the months the amount was added up from.
  const pendingIds = pending.map((installment) => installment.id)
  const committed = await postingPort.commitSqlPosting({
    supabase,
    companyId,
    userId,
    fn: 'commit_accrual_dissolution',
    args: [draft, { scheduleId, installmentIds: pendingIds }],
  })
  if (committed.outcome === 'posted_unclaimed') {
    return claimAllAfterUnclaimedPosting(supabase, companyId, userId, schedule, pendingIds, committed.entry, amount)
  }
  if (committed.outcome === 'not_pending') {
    // The posting run booked a month, a credit cancelled them or a re-plan
    // replaced them since they were read. Nothing was posted: the draft had
    // no number and is cancelled, and no month was touched.
    throw new Error('Periodiseringen ändrades samtidigt: försök igen')
  }

  return { journalEntryId: committed.entry.id, amount }
}

/**
 * How the months of a dissolution were claimed before
 * commit_accrual_dissolution, kept for the window right after a deploy in
 * which the database does not have the function yet: the engine's accrual
 * door has posted the combined verifikat (posted_unclaimed), and the months
 * are claimed with a compare-and-set. The two are separate writes, so a
 * posting run in between leaves a combined verifikat to storno and months
 * pointing at it; the function removes exactly that.
 */
async function claimAllAfterUnclaimedPosting(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  schedule: ScheduleRow,
  pendingIds: string[],
  entry: { id: string },
  amount: number,
): Promise<{ journalEntryId: string; amount: number }> {
  const scheduleId = schedule.id

  const { data: claimed, error: claimError } = await supabase
    .from('accrual_schedule_installments')
    .update({
      status: 'posted',
      journal_entry_id: entry.id,
      posted_at: new Date().toISOString(),
      last_error: null,
    })
    .in('id', pendingIds)
    .eq('status', 'pending')
    .select('id')

  if (claimError || !claimed || claimed.length !== pendingIds.length) {
    // Concurrent posting changed the set under us: undo our combined entry
    // and let the caller retry against the new state. If the storno itself
    // fails, the combined entry stands while some installments point at the
    // cron's entries: the interim account would dissolve twice. Surface
    // both failures and pin the alert on the installments so the
    // periodiseringar UI shows the stuck state instead of nothing.
    try {
      await stornoDissolution(supabase, companyId, userId, schedule, entry.id, 'system_derived')
    } catch (reversalError) {
      const message = getErrorMessage(reversalError)
      log.error('failed to reverse combined dissolution entry after lost claim race', reversalError, {
        companyId,
        scheduleId,
        entryId: entry.id,
      })
      await supabase
        .from('accrual_schedule_installments')
        .update({
          last_error: `Storno av samlad upplösning (verifikat ${entry.id}) misslyckades: kontrollera interimskontot: ${message}`.slice(0, 2_000),
        })
        .in('id', pendingIds)
        .eq('company_id', companyId)
      throw new Error(
        `Periodiseringen ändrades samtidigt och vändningen av det samlade verifikatet misslyckades: ${message}`,
      )
    }
    throw new Error('Periodiseringen ändrades samtidigt: försök igen')
  }

  await supabase
    .from('accrual_schedules')
    .update({ status: 'completed' })
    .eq('id', scheduleId)
    .eq('company_id', companyId)
    .eq('status', 'active')

  return { journalEntryId: entry.id, amount }
}

type FiscalYearBounds = { period_start: string; period_end: string }

type PostedInstallmentRow = {
  id: string
  journal_entry_id: string | null
  journal_entry?: { fiscal_period?: FiscalYearBounds | null } | null
}

function isAlreadyReversed(error: unknown): boolean {
  return (
    error instanceof EntryAlreadyReversedError ||
    (error instanceof CannotReverseNonPostedError && error.currentStatus === 'reversed')
  )
}

/**
 * The credit date when it lies inside the verifikat's own fiscal year, else
 * undefined: a storno is numbered and booked in its original's year
 * (storno-target.ts), so it then takes the verifikat's own date.
 */
function reversalDateWithin(year: FiscalYearBounds | null | undefined, reversalDate?: string): string | undefined {
  return reversalDate && year && reversalDate >= year.period_start && reversalDate <= year.period_end
    ? reversalDate
    : undefined
}

/**
 * Storno a posted month's dissolution for a credit. True when a storno was
 * booked, false when nothing was left to reverse. Throws when a storno fails.
 *
 * A dissolution that is already stornoed was undone by an earlier (partially
 * failed) cancel run, which is fine (an idempotent re-credit), or by a
 * rättelse. correctEntry posts the corrected month as a new 'correction'
 * verifikat while the installment keeps pointing at the original, so the
 * books still carry the month: its live correction is stornoed in its place,
 * or the credit leaves it standing on the interim account and on the cost or
 * revenue account.
 */
async function stornoInstallmentDissolution(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  schedule: ScheduleRow,
  entryId: string,
  ownYear: FiscalYearBounds | null | undefined,
  reversalDate?: string,
): Promise<boolean> {
  try {
    await stornoDissolution(supabase, companyId, userId, schedule, entryId, 'user_created', reversalDateWithin(ownYear, reversalDate))
    return true
  } catch (error) {
    if (!isAlreadyReversed(error)) throw error
  }

  const live = await liveEntryOf(supabase, companyId, entryId)
  if ('exhausted' in live) throw new Error('rättelsekedjan är för lång för att följas')
  if ('none' in live) return false

  const { data: liveEntry, error: liveError } = await supabase
    .from('journal_entries')
    .select('fiscal_period:fiscal_periods!journal_entries_fiscal_period_id_fkey(period_start, period_end)')
    .eq('company_id', companyId)
    .eq('id', live.id)
    .maybeSingle()
  if (liveError) throw new Error(`Failed to load the corrected dissolution: ${liveError.message}`)
  const liveYear = (liveEntry as { fiscal_period?: FiscalYearBounds | null } | null)?.fiscal_period
  try {
    await stornoDissolution(supabase, companyId, userId, schedule, live.id, 'user_created', reversalDateWithin(liveYear, reversalDate))
    return true
  } catch (error) {
    if (isAlreadyReversed(error)) return false
    throw error
  }
}

export interface AccrualReplanInput {
  /** The period's new last day; the current one when omitted. */
  periodEnd?: string
  /**
   * The day each month books on (1-31, clamped to the month's last day, so
   * 31 is the last day), null for the first of the month; unchanged when
   * omitted.
   */
  releaseDay?: number | null
}

interface PlannedReplan {
  result: AccrualReplanResult
  plan: Array<{ period_month: string; amount: number }>
}

async function planReplan(
  ctx: OperationContext,
  scheduleId: string,
  input: AccrualReplanInput,
): Promise<PlannedReplan> {
  const { data, error } = await ctx.supabase
    .from('accrual_schedules')
    .select('*, installments:accrual_schedule_installments(period_month, amount, status)')
    .eq('company_id', ctx.companyId)
    .eq('id', scheduleId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load accrual schedule: ${error.message}`)
  if (!data) throw new AccrualScheduleNotFoundError()

  const schedule = data as ScheduleRow & {
    installments?: Array<{ period_month: string; amount: number; status: string }>
  }
  if (schedule.status !== 'active') throw new AccrualScheduleNotActiveError(schedule.status)
  if (isAccruedSchedule(schedule)) {
    throw new AccrualReplanInvalidError(schedule.direction === 'expense' ? 'accrued_cost' : 'accrued_income')
  }

  const installments = [...(schedule.installments ?? [])]
    .map((i) => ({ ...i, amount: Number(i.amount) }))
    .sort((a, b) => a.period_month.localeCompare(b.period_month))
  // A credit cancels the pending months before it stornoes the posted ones;
  // a schedule left active with cancelled months is a credit still settling.
  if (installments.some((i) => i.status === 'cancelled')) throw new AccrualReplanInvalidError('cancelled_months')
  const pending = installments.filter((i) => i.status === 'pending')
  const posted = installments.filter((i) => i.status === 'posted')
  if (pending.length === 0) throw new AccrualReplanInvalidError('nothing_pending')

  const periodEnd = input.periodEnd ?? schedule.period_end
  const releaseDayBefore = schedule.release_day ?? null
  const releaseDay = input.releaseDay === undefined ? releaseDayBefore : input.releaseDay
  if (periodEnd < schedule.period_start) throw new AccrualReplanInvalidError('end_before_start')
  if (periodEnd === schedule.period_end && releaseDay === releaseDayBefore) {
    throw new AccrualReplanInvalidError('no_change')
  }
  const lastMonth = firstOfMonth(periodEnd)
  if (posted.some((i) => i.period_month > lastMonth)) throw new AccrualReplanInvalidError('end_before_posted')

  const remaining = roundOre(schedule.total_amount - sumOre(posted.map((i) => i.amount)))
  const postedMonths = new Set(posted.map((i) => i.period_month))
  const openMonths = listCalendarMonths(schedule.period_start, periodEnd).filter((m) => !postedMonths.has(m))
  if (openMonths.length === 0) throw new AccrualReplanInvalidError('no_month_left')
  if (Math.round(remaining * 100) < openMonths.length) throw new AccrualReplanInvalidError('amount_too_small')

  const plan = replanPendingInstallments({
    totalAmount: schedule.total_amount,
    periodStart: schedule.period_start,
    periodEnd,
    posted,
  })

  const lockFloor = await fetchLockDateFloor(ctx.supabase, ctx.companyId)
  const bookingDate = (periodMonth: string, day: number | null) =>
    maxIsoDate(deferralReleaseDate(periodMonth, day), schedule.posting_floor_date, lockFloor)

  return {
    plan,
    result: {
      accrual_schedule_id: schedule.id,
      period_start: schedule.period_start,
      period_end_before: schedule.period_end,
      period_end_after: periodEnd,
      release_day_before: releaseDayBefore,
      release_day_after: releaseDay,
      remaining_amount: remaining,
      before: pending.map((i) => ({
        period_month: i.period_month,
        amount: i.amount,
        booking_date: bookingDate(i.period_month, releaseDayBefore),
      })),
      after: plan.map((i) => ({
        period_month: i.period_month,
        amount: i.amount,
        booking_date: bookingDate(i.period_month, releaseDay),
      })),
    },
  }
}

function replanRpcFailure(
  ctx: OperationContext,
  scheduleId: string,
  error: { code?: string; message?: string },
): OperationOutcome<AccrualReplanResult> {
  const message = error.message ?? ''
  if (message.includes('ACCRUAL_SCHEDULE_NOT_FOUND')) return { ok: false, code: 'ACCRUAL_NOT_FOUND' }
  if (message.includes('ACCRUAL_SCHEDULE_NOT_ACTIVE')) return { ok: false, code: 'ACCRUAL_NOT_ACTIVE' }
  // The posting run booked a month, or another re-plan won, between the
  // read and the write: the RPC refuses rather than replace a changed plan.
  if (message.includes('ACCRUAL_REPLAN_CONFLICT')) return { ok: false, code: 'ACCRUAL_REPLAN_CONFLICT' }
  if (error.code === '42501') return { ok: false, code: 'FORBIDDEN' }
  ctx.log.error('replan_accrual_installments failed', new Error(message || 'replan_accrual_installments'), {
    scheduleId,
  })
  return { ok: false, code: 'ACCRUAL_REPLAN_FAILED' }
}

/**
 * "Ändra periodisering": re-plan the months of a schedule that are not yet
 * posted, with a new period end and/or a new release day. Posted months and
 * their verifikat stay exactly as they are; what remains (total minus posted)
 * is split equally over the calendar months of the new period that have no
 * posted month, the same split a new schedule gets. A deferral only: an
 * upplupen kostnad books each month's last day before its invoice.
 *
 * The replacement is atomic (replan_accrual_installments, which also checks
 * that the months cover the period exactly once and add up to the total).
 * Months whose day has already come are then booked at once, as at
 * creation. The one service behind the dashboard route, the v1 endpoint and
 * the staged MCP tool (operation accrual-schedules.replan); a dry run
 * answers the before and after months and writes nothing.
 */
export async function replanRemainingInstallments(
  ctx: OperationContext,
  scheduleId: string,
  input: AccrualReplanInput,
  options: { dryRun?: boolean; today?: string } = {},
): Promise<OperationOutcome<AccrualReplanResult>> {
  let planned: PlannedReplan
  try {
    planned = await planReplan(ctx, scheduleId, input)
  } catch (err) {
    if (err instanceof AccrualScheduleNotFoundError) return { ok: false, code: 'ACCRUAL_NOT_FOUND' }
    if (err instanceof AccrualScheduleNotActiveError) {
      return { ok: false, code: 'ACCRUAL_NOT_ACTIVE', details: { currentStatus: err.currentStatus } }
    }
    if (err instanceof AccrualReplanInvalidError) {
      return { ok: false, code: 'ACCRUAL_REPLAN_INVALID', details: { reason: err.reason }, messageSv: err.message }
    }
    throw err
  }

  if (options.dryRun) return { ok: true, dryRun: true, preview: { ...planned.result } }

  const { error } = await ctx.supabase.rpc('replan_accrual_installments', {
    p_company_id: ctx.companyId,
    p_schedule_id: scheduleId,
    p_user_id: ctx.userId,
    p_period_end: planned.result.period_end_after,
    p_release_day: planned.result.release_day_after,
    p_installments: planned.plan,
  })
  if (error) return replanRpcFailure(ctx, scheduleId, error)

  const catchUp = await postDueInstallments(ctx.supabase, ctx.companyId, {
    userId: ctx.userId,
    scheduleId,
    today: options.today,
  })
  if (catchUp.failed > 0) {
    log.warn('accrual catch-up posting after re-plan failed for some installments', {
      companyId: ctx.companyId,
      scheduleId,
      failed: catchUp.failed,
    })
  }
  return { ok: true, data: { ...planned.result, posted_now: catchUp.posted } }
}

/**
 * Cancel all schedules belonging to a credited/cancelled invoice:
 * pending installments are cancelled, already-posted dissolutions are
 * reversed (storno; a corrected one through its live correction,
 * stornoInstallmentDissolution), and the schedule is marked cancelled. The caller's
 * credit-note entry reverses the interim account at its full original
 * amount, so the net of origin + dissolutions + stornos + credit is zero.
 *
 * A schedule is only marked cancelled when ALL its posted dissolutions
 * reversed cleanly: otherwise it stays 'active' (so the UI keeps showing
 * the un-reversed remainder instead of remaining=0 while 17xx/29xx is still
 * unbalanced) and the stuck installments get a descriptive last_error.
 * Callers should surface `failedReversals > 0` as a warning.
 *
 * `options.reversalDate` (the credit note's date) dates a dissolution's
 * storno only when it lies inside that dissolution's own fiscal year: a
 * storno is numbered and booked in its original's year (storno-target.ts),
 * so a dissolution from an earlier year is stornoed on its own date instead.
 */
export async function cancelSchedulesForSource(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  source: { supplierInvoiceId?: string; invoiceId?: string },
  options: { reversalDate?: string } = {},
): Promise<CancelSchedulesResult> {
  if (!source.supplierInvoiceId && !source.invoiceId) {
    throw new Error('cancelSchedulesForSource requires a source invoice id')
  }

  let query = supabase
    .from('accrual_schedules')
    .select('*')
    .eq('company_id', companyId)
    .neq('status', 'cancelled')
  query = source.supplierInvoiceId
    ? query.eq('supplier_invoice_id', source.supplierInvoiceId)
    : query.eq('invoice_id', source.invoiceId as string)

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to load accrual schedules: ${error.message}`)
  }
  return cancelSchedules(supabase, companyId, userId, (data ?? []) as ScheduleRow[], {
    reversalDate: options.reversalDate,
    failurePrefix: 'Storno vid kreditering misslyckades',
  })
}

export interface CancelSchedulesResult {
  cancelledSchedules: number
  reversedEntries: number
  failedReversals: number
}

/**
 * Undo what each schedule booked: cancel its pending months, storno every
 * posted dissolution and mark it cancelled, so the interim account holds the
 * whole amount again. The credit of an invoice (cancelSchedulesForSource) and
 * the undo of a manual periodisering (lib/bookkeeping/accruals/manual.ts) run
 * the same steps; `failurePrefix` names the action in a stuck month's
 * last_error. A schedule whose stornos did not all go through stays active.
 */
export async function cancelSchedules(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  schedules: readonly ScheduleRow[],
  options: { reversalDate?: string; failurePrefix: string },
): Promise<CancelSchedulesResult> {
  let cancelledSchedules = 0
  let reversedEntries = 0
  let failedReversals = 0

  for (const schedule of schedules) {
    // Cancel pending months first so the posting cron cannot book new
    // dissolutions for a credited invoice while (or after) we storno the
    // already-posted ones.
    await supabase
      .from('accrual_schedule_installments')
      .update({ status: 'cancelled' })
      .eq('company_id', companyId)
      .eq('schedule_id', schedule.id)
      .eq('status', 'pending')

    // The dissolution's own fiscal year rides along: its storno may take the
    // credit date only inside that year.
    const { data: postedData } = await supabase
      .from('accrual_schedule_installments')
      .select(
        'id, journal_entry_id, journal_entry:journal_entries!journal_entry_id(fiscal_period:fiscal_periods!journal_entries_fiscal_period_id_fkey(period_start, period_end))',
      )
      .eq('company_id', companyId)
      .eq('schedule_id', schedule.id)
      .eq('status', 'posted')

    let scheduleFailures = 0
    for (const installment of (postedData ?? []) as unknown as PostedInstallmentRow[]) {
      if (!installment.journal_entry_id) continue
      try {
        const reversed = await stornoInstallmentDissolution(
          supabase, companyId, userId, schedule, installment.journal_entry_id,
          installment.journal_entry?.fiscal_period, options.reversalDate,
        )
        if (reversed) reversedEntries++
      } catch (error) {
        scheduleFailures++
        const message = getErrorMessage(error)
        log.warn('could not reverse accrual dissolution during cancel', {
          companyId,
          scheduleId: schedule.id,
          journalEntryId: installment.journal_entry_id,
          message,
        })
        // Posted installments freeze their financial fields, but last_error
        // stays writable: surface the stuck storno in the periodiseringar UI.
        await supabase
          .from('accrual_schedule_installments')
          .update({
            last_error: `${options.failurePrefix}: ${message}`,
          })
          .eq('id', installment.id)
          .eq('company_id', companyId)
      }
    }

    if (scheduleFailures > 0) {
      failedReversals += scheduleFailures
      continue
    }

    await supabase
      .from('accrual_schedules')
      .update({ status: 'cancelled' })
      .eq('id', schedule.id)
      .eq('company_id', companyId)
    cancelledSchedules++
  }

  return { cancelledSchedules, reversedEntries, failedReversals }
}
