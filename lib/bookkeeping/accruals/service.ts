/**
 * Periodisering (accrual schedule) service.
 *
 * A schedule spreads one invoice line's net amount over the calendar months
 * of a service period. The origin entry (supplier invoice registration /
 * customer invoice revenue entry) books the net to an interim account
 * (17xx/29xx); this service creates and posts the monthly dissolution
 * entries:
 *
 *   expense:  Dr target (5xxx/6xxx)  / Cr balance (17xx)
 *   revenue:  Dr balance (29xx)      / Cr target (3xxx)
 *
 * All entries go through the engine (source_type 'accrual'): never direct
 * inserts. Posting dates are max(period_month, posting_floor_date,
 * company lock date + 1) so catch-up months book correctly and the interim
 * account never goes negative.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  AccrualDirection,
  AccrualSchedule,
  AccrualScheduleInstallment,
  CreateJournalEntryLineInput,
} from '@/types'
import {
  createJournalEntry,
  findFiscalPeriod,
  reverseEntry,
} from '@/lib/bookkeeping/engine'
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
  maxIsoDate,
} from '@/lib/bookkeeping/accruals/compute'
import { roundOre, sumOre } from '@/lib/money'
import { createLogger } from '@/lib/logger'

const log = createLogger('bookkeeping.accruals')

export interface AccrualScheduleSpec {
  direction: AccrualDirection
  supplierInvoiceId?: string
  supplierInvoiceItemId?: string | null
  invoiceId?: string
  invoiceItemId?: string | null
  /** Interim account: 17xx (expense) / 29xx (revenue). */
  balanceAccount: string
  /** The P&L account the amount dissolves to. */
  targetAccount: string
  /** Net amount in SEK as booked on the origin entry (ex VAT). */
  totalAmountSek: number
  periodStart: string
  periodEnd: string
  description: string
}

export interface PostDueResult {
  posted: number
  failed: number
  skipped: number
  errors: Array<{ installmentId: string; message: string }>
}

type ScheduleRow = AccrualSchedule
type InstallmentRow = AccrualScheduleInstallment & { schedule?: ScheduleRow | null }

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function dissolutionLines(
  schedule: Pick<ScheduleRow, 'direction' | 'balance_account' | 'target_account'>,
  amount: number,
  lineDescription: string,
): CreateJournalEntryLineInput[] {
  if (schedule.direction === 'expense') {
    return [
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
  }
  return [
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
    /** Entry date of the origin entry; floors all dissolution dates. */
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
  const today = options.today ?? todayIso()
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
      let entryDate = maxIsoDate(
        installment.period_month,
        schedule.posting_floor_date,
        lockFloor,
      )
      let fiscalPeriodId = await findFiscalPeriod(supabase, companyId, entryDate)
      if (!fiscalPeriodId) {
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
        entryDate = clamped.periodStart
        fiscalPeriodId = clamped.fiscalPeriodId
      }

      const monthLabel = installment.period_month.slice(0, 7)
      const description = schedule.description
        ? `Periodisering ${monthLabel}: ${schedule.description}`
        : `Periodisering ${monthLabel}`

      const entry = await createJournalEntry(
        supabase,
        companyId,
        options.userId ?? schedule.user_id,
        {
          fiscal_period_id: fiscalPeriodId,
          entry_date: entryDate,
          description,
          source_type: 'accrual',
          source_id: schedule.id,
          lines: dissolutionLines(schedule, installment.amount, description),
        },
      )

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
          await reverseEntry(
            supabase,
            companyId,
            options.userId ?? schedule.user_id,
            entry.id,
          )
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
        await reverseEntry(
          supabase,
          companyId,
          options.userId ?? schedule.user_id,
          entry.id,
        )
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
 * early or the user simply wants the rest expensed now.
 */
export async function dissolveScheduleNow(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  scheduleId: string,
  options: { today?: string } = {},
): Promise<{ journalEntryId: string; amount: number }> {
  const today = options.today ?? todayIso()

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

  const entry = await createJournalEntry(supabase, companyId, userId, {
    fiscal_period_id: fiscalPeriodId,
    entry_date: entryDate,
    description,
    source_type: 'accrual',
    source_id: schedule.id,
    lines: dissolutionLines(schedule, amount, description),
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
      await reverseEntry(supabase, companyId, userId, entry.id)
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

/**
 * Cancel all schedules belonging to a credited/cancelled invoice:
 * pending installments are cancelled, already-posted dissolutions are
 * reversed (storno), and the schedule is marked cancelled. The caller's
 * credit-note entry reverses the interim account at its full original
 * amount, so the net of origin + dissolutions + stornos + credit is zero.
 *
 * A schedule is only marked cancelled when ALL its posted dissolutions
 * reversed cleanly: otherwise it stays 'active' (so the UI keeps showing
 * the un-reversed remainder instead of remaining=0 while 17xx/29xx is still
 * unbalanced) and the stuck installments get a descriptive last_error.
 * Callers should surface `failedReversals > 0` as a warning.
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

    const { data: postedData } = await supabase
      .from('accrual_schedule_installments')
      .select('id, journal_entry_id')
      .eq('company_id', companyId)
      .eq('schedule_id', schedule.id)
      .eq('status', 'posted')

    let scheduleFailures = 0
    for (const installment of (postedData ?? []) as Array<{
      id: string
      journal_entry_id: string | null
    }>) {
      if (!installment.journal_entry_id) continue
      try {
        await reverseEntry(
          supabase,
          companyId,
          userId,
          installment.journal_entry_id,
          options.reversalDate,
        )
        reversedEntries++
      } catch (error) {
        // A dissolution stornoed by an earlier (partially failed) cancel run
        // is fine: idempotent re-credit, treated as success.
        if (
          error instanceof EntryAlreadyReversedError ||
          (error instanceof CannotReverseNonPostedError &&
            error.currentStatus === 'reversed')
        ) {
          continue
        }
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
