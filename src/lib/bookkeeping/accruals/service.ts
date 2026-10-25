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
  AccrualSchedule,
  AccrualScheduleInstallment,
  CreateJournalEntryLineInput,
} from '@/types'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import {
  CannotReverseNonPostedError,
  EntryAlreadyReversedError,
} from '@/lib/bookkeeping/errors'
import {
  AccrualNothingToDissolveError,
  AccrualScheduleNotActiveError,
  AccrualScheduleNotFoundError,
} from '@/lib/bookkeeping/accruals/errors'
import {
  computeInstallments,
  dayAfter,
  firstOfMonth,
  lastOfMonth,
  maxIsoDate,
} from '@/lib/bookkeeping/accruals/compute'
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
  schedule: Pick<ScheduleRow, 'supplier_invoice_id' | 'invoice_id'>,
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
 * A deferral (förutbetald kostnad 17xx, förutbetald intäkt 29xx) dissolves
 * on max(period month, posting floor, lock date + 1): never before the
 * origin entry put the amount on the interim account, so the interim
 * account cannot go negative, and a closed year clamps to the next open one.
 */
async function deferralPosting(
  supabase: SupabaseClient,
  companyId: string,
  periodMonth: string,
  schedule: Pick<ScheduleRow, 'posting_floor_date'>,
  lockFloor: string | null,
): Promise<InstallmentPosting> {
  const entryDate = maxIsoDate(periodMonth, schedule.posting_floor_date, lockFloor)
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

  const due = ((data ?? []) as InstallmentRow[]).filter(
    (installment) => installment.schedule?.status === 'active',
  )
  if (due.length === 0) return result

  const lockFloor = await fetchLockDateFloor(supabase, companyId)
  const touchedSchedules = new Set<string>()

  for (const installment of due) {
    const schedule = installment.schedule as ScheduleRow
    try {
      const { entryDate, fiscalPeriodId } = isAccruedSchedule(schedule)
        ? await accruedPosting(supabase, companyId, installment.period_month, schedule.direction, lockFloor)
        : await deferralPosting(supabase, companyId, installment.period_month, schedule, lockFloor)

      const monthLabel = installment.period_month.slice(0, 7)
      const description = schedule.description
        ? `Periodisering ${monthLabel}: ${schedule.description}`
        : `Periodisering ${monthLabel}`

      const entry = await postingPort.postJournalEntry({
        supabase,
        companyId,
        userId: options.userId ?? schedule.user_id,
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

      // CAS claim: only the runner that flips pending→posted keeps its entry.
      // A concurrent runner (cron + manual button) loses the race and stornos
      // its own entry so the ledger nets to a single dissolution.
      const { data: claimed, error: claimError } = await supabase
        .from('accrual_schedule_installments')
        .update({
          status: 'posted',
          journal_entry_id: entry.id,
          posted_at: new Date().toISOString(),
          last_error: null,
        })
        .eq('id', installment.id)
        .eq('status', 'pending')
        .select('id')

      if (claimError) {
        // The journal entry is already committed but the installment was NOT
        // flipped to posted: without a storno the next run would book the
        // same month twice. Mirror the dissolveScheduleNow handling: reverse
        // our own entry best-effort, then record the failure (the catch below
        // writes last_error on the installment).
        let reversalNote = ''
        try {
          await stornoDissolution(supabase, companyId, options.userId ?? schedule.user_id, schedule, entry.id, 'system_derived')
        } catch (reversalError) {
          log.error('failed to reverse accrual entry after claim error', reversalError, {
            companyId,
            installmentId: installment.id,
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
          installmentId: installment.id,
          entryId: entry.id,
        })
        await stornoDissolution(supabase, companyId, options.userId ?? schedule.user_id, schedule, entry.id, 'system_derived')
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

  const entry = await postingPort.postJournalEntry({
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

  const pendingIds = pending.map((installment) => installment.id)
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
): Promise<{
  cancelledSchedules: number
  reversedEntries: number
  failedReversals: number
}> {
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
  const schedules = (data ?? []) as ScheduleRow[]

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
            last_error: `Storno vid kreditering misslyckades: ${message}`,
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
