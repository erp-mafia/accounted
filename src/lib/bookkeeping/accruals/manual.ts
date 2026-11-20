/**
 * Periodisering set up by hand (accounted#164): spread an amount already on
 * an interim account (17xx/29xx) over months, when no invoice line in
 * Accounted carries it: a migrated plan whose remaining months still have to
 * dissolve, an annual cost paid from the bank, a 17xx balance in the year's
 * ingående balans. The plan then runs on the same schedule, installments and
 * catch-up as an invoice plan (createAccrualSchedule).
 *
 * The amount a deferral may spread is what remains on the balance account
 * (accrualRoom): the account's balance over the whole ledger, from its latest
 * ingående balans on, less the months not yet posted of the other active
 * deferrals on the same account, and never more than the origin verifikat or
 * the ingående balans put there. Months already dissolved, by an earlier
 * system's vouchers or by hand, are already off the balance, so a migrated
 * plan can only take what is left. An upplupen kostnad (expense on 29xx) or
 * upplupen intäkt (revenue on 17xx) books before anything is on the account
 * and has no such limit.
 *
 * Undoing a manual plan (cancelManualSchedule) cancels its pending months and
 * stornoes the months it posted, the steps an invoice credit runs; reversing
 * its origin verifikat does the same (cancelManualSchedulesForOrigin, run on
 * journal_entry.reversed).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import type { AccrualDirection, AccrualSchedule } from '@/types'
import { computeInstallments, countCalendarMonths, firstOfMonth, lastOfMonth } from './compute'
import { cancelSchedules, createAccrualSchedule, type AccrualScheduleSpec, type CancelSchedulesResult } from './service'
import { roundOre, sumOre } from '@/lib/money'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { isAccruedBalanceAccount, isInterimBalanceAccount } from './account-suggestions'
import { isBasResultAccount } from '@/lib/bookkeeping/result-account-ranges'

export interface ManualAccrualInput {
  direction: AccrualDirection
  amount_sek: number
  balance_account: string
  target_account: string
  period_start: string
  months?: number
  period_end?: string
  description: string
  dimensions?: Record<string, string>
  origin_journal_entry_id?: string
}

/** What a deferral on one balance account may still spread, in SEK. */
export interface AccrualRoom {
  balance_account: string
  direction: AccrualDirection
  /** False for an upplupen kostnad or intäkt: it has no limit and the amounts below are null. */
  deferral: boolean
  /** The account's balance in the plan's direction (debit for a cost on 17xx, credit for revenue on 29xx). */
  ledger_balance_sek: number | null
  /** The months not yet posted of the other active deferrals on the account. */
  planned_sek: number | null
  /** What the origin verifikat, or the ingående balans, put on the account. */
  origin_amount_sek: number | null
  /** min(ledger_balance_sek - planned_sek, origin_amount_sek), never below 0. */
  available_sek: number | null
}

/** A refusal with its structured-error code (lib/errors/structured-errors.ts). */
class ManualAccrualError extends Error {
  constructor(
    readonly code: string,
    readonly details?: Record<string, unknown>,
    readonly messageSv?: string,
  ) {
    super(code)
    this.name = 'ManualAccrualError'
  }
}

interface AmountLine {
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
}

interface OriginEntry {
  id: string
  entry_date: string
  status: string
  source_type: string | null
  reversed_by_id: string | null
  lines: AmountLine[] | null
}

const SEK = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Debit minus credit, turned to the plan's direction: a cost reads a debit balance, revenue a credit one. */
function inDirection(debitMinusCredit: number, direction: AccrualDirection): number {
  return direction === 'expense' ? roundOre(debitMinusCredit) : roundOre(-debitMinusCredit)
}

function netOn(lines: readonly AmountLine[], account: string): number {
  return sumOre(
    lines
      .filter((line) => line.account_number === account)
      .map((line) => Number(line.debit_amount ?? 0) - Number(line.credit_amount ?? 0)),
  )
}

function toOre(amount: number): number {
  return Math.round(amount * 100)
}

/**
 * The latest ingående balans on `account` through `through` (null: any date),
 * read by public.account_ib_floor, the rule every balance reader floors at:
 * the IB restates the years before it, and same-date IB verifikat add up.
 * `amount` is debit minus credit.
 */
async function openingBalanceFloor(
  supabase: SupabaseClient,
  companyId: string,
  account: string,
  through: string | null,
): Promise<{ date: string; amount: number } | null> {
  const { data, error } = await supabase
    .rpc('account_ib_floor', { p_company_id: companyId, p_account_number: account, p_through: through })
    .maybeSingle()
  if (error) throw new Error(`Kunde inte läsa ingående balans: ${error.message}`)
  const floor = data as { floor_date: string; amount: number | string } | null
  return floor ? { date: floor.floor_date, amount: Number(floor.amount) } : null
}

/**
 * Debit minus credit on one account over the whole ledger, from its latest
 * ingående balans on, posted and reversed verifikat alike (a storno and its
 * original both count, as in every ledger balance: the trial balance and
 * sumAccountBalance in lib/reconciliation/gl-balance.ts read it the same way).
 */
async function ledgerBalance(supabase: SupabaseClient, companyId: string, account: string): Promise<number> {
  const floor = await openingBalanceFloor(supabase, companyId, account, null)
  const rows = await fetchEntryLines({
    supabase,
    lineColumns: 'account_number, debit_amount, credit_amount',
    filterEntries: (query: EntryLinesQuery) => {
      const scoped = query.eq('company_id', companyId).in('status', ['posted', 'reversed'])
      return floor ? scoped.gte('entry_date', floor.date) : scoped
    },
    filterLines: (query: EntryLinesQuery) => query.eq('account_number', account),
    attachEntriesAs: null,
  })
  return netOn(rows as AmountLine[], account)
}

/** The months not yet posted of the active schedules on `account` in `direction`. */
async function plannedOn(
  supabase: SupabaseClient,
  companyId: string,
  direction: AccrualDirection,
  account: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('accrual_schedules')
    .select('id, installments:accrual_schedule_installments(amount, status)')
    .eq('company_id', companyId)
    .eq('status', 'active')
    .eq('direction', direction)
    .eq('balance_account', account)
  if (error) throw new Error(`Failed to load accrual schedules: ${error.message}`)
  const rows = (data ?? []) as Array<{ installments?: Array<{ amount: number | string; status: string }> | null }>
  return sumOre(
    rows.flatMap((row) => (row.installments ?? []).filter((i) => i.status === 'pending').map((i) => Number(i.amount))),
  )
}

async function loadOrigin(supabase: SupabaseClient, companyId: string, entryId: string): Promise<OriginEntry> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('id, entry_date, status, source_type, reversed_by_id, lines:journal_entry_lines(account_number, debit_amount, credit_amount)')
    .eq('id', entryId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  const entry = data as OriginEntry | null
  if (!entry) throw new ManualAccrualError('ACCRUAL_ORIGIN_NOT_FOUND')
  // reverseEntry marks the original 'reversed' and links its storno; either
  // alone means the verifikat no longer stands.
  if (entry.status === 'reversed' || entry.reversed_by_id) throw new ManualAccrualError('ACCRUAL_ORIGIN_REVERSED')
  if (entry.status !== 'posted') throw new ManualAccrualError('ACCRUAL_ORIGIN_NOT_FOUND')
  return entry
}

interface ResolvedOrigin {
  /** Null for a plan from an ingående balans, named or not. */
  originJournalEntryId: string | null
  /** Floors a deferral's dissolution dates (createAccrualSchedule). */
  postingFloorDate: string
  /** What the origin or the IB put on the account in the plan's direction; null for an upplupen post. */
  originSek: number | null
}

/**
 * Where the plan's amount came from. A named verifikat must stand and carry
 * the balance account (for a deferral: an amount in the plan's direction);
 * one that is itself an ingående balans counts as the IB, with no origin
 * link, so replacing the IB when year-end is re-run leaves the plan alone.
 * Without one, a deferral takes the latest IB on the account through the
 * plan's first month, every same-date IB verifikat added up; an upplupen
 * post needs none and floors at its first month.
 */
async function resolveOrigin(
  supabase: SupabaseClient,
  companyId: string,
  input: Pick<ManualAccrualInput, 'direction' | 'balance_account' | 'origin_journal_entry_id' | 'period_start'>,
  deferral: boolean,
): Promise<ResolvedOrigin> {
  if (input.origin_journal_entry_id) {
    const origin = await loadOrigin(supabase, companyId, input.origin_journal_entry_id)
    const lines = origin.lines ?? []
    const amount = inDirection(netOn(lines, input.balance_account), input.direction)
    if (!lines.some((line) => line.account_number === input.balance_account) || (deferral && amount <= 0)) {
      throw new ManualAccrualError('ACCRUAL_ORIGIN_ACCOUNT_MISSING', { balance_account: input.balance_account })
    }
    return {
      originJournalEntryId: origin.source_type === 'opening_balance' ? null : origin.id,
      postingFloorDate: origin.entry_date,
      originSek: deferral ? amount : null,
    }
  }
  if (!deferral) {
    return { originJournalEntryId: null, postingFloorDate: firstOfMonth(input.period_start), originSek: null }
  }
  const floor = await openingBalanceFloor(supabase, companyId, input.balance_account, lastOfMonth(input.period_start))
  const amount = floor ? inDirection(floor.amount, input.direction) : 0
  if (!floor || amount <= 0) {
    throw new ManualAccrualError('ACCRUAL_OPENING_BALANCE_MISSING', { balance_account: input.balance_account })
  }
  return { originJournalEntryId: null, postingFloorDate: floor.date, originSek: amount }
}

/** The room on a deferral's account, given what its origin put there. */
async function roomOn(
  supabase: SupabaseClient,
  companyId: string,
  input: Pick<ManualAccrualInput, 'direction' | 'balance_account'>,
  originSek: number,
): Promise<AccrualRoom> {
  const [ledger, planned] = await Promise.all([
    ledgerBalance(supabase, companyId, input.balance_account),
    plannedOn(supabase, companyId, input.direction, input.balance_account),
  ])
  const ledgerSek = inDirection(ledger, input.direction)
  const available = Math.max(0, Math.min(roundOre(ledgerSek - planned), originSek))
  return {
    balance_account: input.balance_account,
    direction: input.direction,
    deferral: true,
    ledger_balance_sek: ledgerSek,
    planned_sek: planned,
    origin_amount_sek: originSek,
    available_sek: roundOre(available),
  }
}

function assertBalanceAccount(account: string): void {
  if (!isInterimBalanceAccount(account)) throw new ManualAccrualError('ACCRUAL_BALANCE_ACCOUNT_INVALID')
}

/**
 * What a new plan on `balance_account` may spread (AccrualRoom), for the
 * dialog's prefill and its "kvar att periodisera" line. `period_start`
 * (default today) picks the ingående balans when no origin is named.
 */
export async function readAccrualRoom(
  supabase: SupabaseClient,
  companyId: string,
  input: Pick<ManualAccrualInput, 'direction' | 'balance_account' | 'origin_journal_entry_id'> & { period_start?: string },
): Promise<OperationOutcome<AccrualRoom>> {
  try {
    assertBalanceAccount(input.balance_account)
    if (isAccruedBalanceAccount(input.direction, input.balance_account)) {
      return {
        ok: true,
        data: {
          balance_account: input.balance_account,
          direction: input.direction,
          deferral: false,
          ledger_balance_sek: null,
          planned_sek: null,
          origin_amount_sek: null,
          available_sek: null,
        },
      }
    }
    const origin = await resolveOrigin(
      supabase,
      companyId,
      { ...input, period_start: input.period_start ?? todayIsoStockholm() },
      true,
    )
    return { ok: true, data: await roomOn(supabase, companyId, input, origin.originSek ?? 0) }
  } catch (error) {
    return manualAccrualFailure(error, 'ACCRUAL_ROOM_FAILED')
  }
}

function periodEnd(input: Pick<ManualAccrualInput, 'period_start' | 'period_end' | 'months'>): string {
  if (input.period_end) {
    if (firstOfMonth(input.period_end) < firstOfMonth(input.period_start)) {
      throw new ManualAccrualError('ACCRUAL_PERIOD_REQUIRED')
    }
    return input.period_end
  }
  if (!input.months || !Number.isInteger(input.months) || input.months < 1) {
    throw new ManualAccrualError('ACCRUAL_PERIOD_REQUIRED')
  }
  const year = Number(input.period_start.slice(0, 4))
  const month = Number(input.period_start.slice(5, 7))
  return lastOfMonth(new Date(Date.UTC(year, month + input.months - 2, 1)).toISOString().slice(0, 10))
}

interface ManualPlan {
  spec: AccrualScheduleSpec
  origin: ResolvedOrigin
  room: AccrualRoom | null
  installments: ReturnType<typeof computeInstallments>
}

async function planManual(supabase: SupabaseClient, companyId: string, input: ManualAccrualInput): Promise<ManualPlan> {
  if (!(input.amount_sek > 0)) throw new ManualAccrualError('ACCRUAL_AMOUNT_INVALID')
  assertBalanceAccount(input.balance_account)
  if (!isBasResultAccount(input.target_account)) throw new ManualAccrualError('ACCRUAL_TARGET_ACCOUNT_INVALID')
  const end = periodEnd(input)
  const periodStart = firstOfMonth(input.period_start)
  // Every month needs at least one öre (the installment CHECK).
  if (toOre(input.amount_sek) < countCalendarMonths(periodStart, end)) throw new ManualAccrualError('ACCRUAL_AMOUNT_INVALID')
  const installments = computeInstallments(input.amount_sek, periodStart, lastOfMonth(end))
  const deferral = !isAccruedBalanceAccount(input.direction, input.balance_account)
  const origin = await resolveOrigin(supabase, companyId, input, deferral)

  let room: AccrualRoom | null = null
  if (deferral) {
    room = await roomOn(supabase, companyId, input, origin.originSek ?? 0)
    const available = room.available_sek ?? 0
    if (toOre(input.amount_sek) > toOre(available)) {
      throw new ManualAccrualError(
        'ACCRUAL_BALANCE_EXCEEDED',
        {
          balance_account: input.balance_account,
          available_sek: available,
          ledger_balance_sek: room.ledger_balance_sek,
          planned_sek: room.planned_sek,
          origin_amount_sek: room.origin_amount_sek,
        },
        `Det finns ${SEK.format(available)} kr kvar att periodisera på ${input.balance_account}. ` +
          'Ange det belopp som återstår och den första månad som inte redan är upplöst: en månad som redan ' +
          'bokförts, här eller i ett tidigare system, får inte bokföras igen.',
      )
    }
  }

  return {
    spec: {
      direction: input.direction,
      sourceKind: 'manual',
      balanceAccount: input.balance_account,
      targetAccount: input.target_account,
      totalAmountSek: roundOre(input.amount_sek),
      periodStart,
      periodEnd: lastOfMonth(end),
      description: input.description,
      dimensions: input.dimensions,
    },
    origin,
    room,
    installments,
  }
}

/** A refusal as an operation outcome; anything unexpected answers `fallbackCode` with the error. */
export function manualAccrualFailure(error: unknown, fallbackCode = 'ACCRUAL_CREATE_FAILED'): OperationOutcome<never> {
  if (error instanceof ManualAccrualError) {
    return {
      ok: false,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
      ...(error.messageSv ? { messageSv: error.messageSv } : {}),
    }
  }
  return { ok: false, code: fallbackCode, error }
}

/**
 * Create a manual periodisering, or answer its months on a dry run. The one
 * service behind the dashboard route, the v1 endpoint and the staged MCP tool
 * (operation accrual-schedules.create).
 */
export async function createManualAccrualSchedule(
  ctx: OperationContext,
  input: ManualAccrualInput,
  options: { dryRun: boolean },
): Promise<OperationOutcome<AccrualSchedule>> {
  try {
    const plan = await planManual(ctx.supabase, ctx.companyId, input)
    if (options.dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          ...plan.spec,
          origin_journal_entry_id: plan.origin.originJournalEntryId,
          posting_floor_date: plan.origin.postingFloorDate,
          available_sek: plan.room?.available_sek ?? null,
          ledger_balance_sek: plan.room?.ledger_balance_sek ?? null,
          planned_sek: plan.room?.planned_sek ?? null,
          installments: plan.installments,
        },
      }
    }
    const schedule = await createAccrualSchedule(ctx.supabase, ctx.companyId, ctx.userId, plan.spec, {
      originJournalEntryId: plan.origin.originJournalEntryId,
      postingFloorDate: plan.origin.postingFloorDate,
    })
    return { ok: true, data: schedule, created: true }
  } catch (error) {
    return manualAccrualFailure(error)
  }
}

export interface ManualAccrualCancelResult {
  accrual_schedule_id: string
  /** 'cancelled', or still 'active' when a month's storno failed (its last_error says why). */
  status: 'cancelled' | 'active'
  cancelled_months: number
  reversed_entries: number
  failed_reversals: number
}

type CancelRow = AccrualSchedule & {
  installments?: Array<{ period_month: string; amount: number | string; status: string; journal_entry_id: string | null }> | null
}

/**
 * "Ångra periodisering": undo a manual plan. Its pending months are cancelled
 * and every month it posted is stornoed (dated today when today lies in the
 * month's own fiscal year, else on the month's own date), so the whole amount
 * is back on the balance account. An invoice plan is refused: crediting the
 * invoice cancels it and keeps the invoice in step. A plan whose earlier
 * undo left a storno undone is still active and can be undone again. A dry
 * run answers the months it would cancel and reverse and writes nothing.
 */
export async function cancelManualSchedule(
  ctx: OperationContext,
  scheduleId: string,
  options: { dryRun: boolean; today?: string },
): Promise<OperationOutcome<ManualAccrualCancelResult>> {
  try {
    const { data, error } = await ctx.supabase
      .from('accrual_schedules')
      .select('*, installments:accrual_schedule_installments(period_month, amount, status, journal_entry_id)')
      .eq('company_id', ctx.companyId)
      .eq('id', scheduleId)
      .maybeSingle()
    if (error) throw error
    const schedule = data as CancelRow | null
    if (!schedule) return { ok: false, code: 'ACCRUAL_NOT_FOUND' }
    if (schedule.source_kind !== 'manual') return { ok: false, code: 'ACCRUAL_CANCEL_NOT_MANUAL' }
    if (schedule.status === 'cancelled') {
      return { ok: false, code: 'ACCRUAL_NOT_ACTIVE', details: { currentStatus: schedule.status } }
    }

    const installments = [...(schedule.installments ?? [])].sort((a, b) => a.period_month.localeCompare(b.period_month))
    const pending = installments.filter((i) => i.status === 'pending')
    const posted = installments.filter((i) => i.status === 'posted')
    if (options.dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          accrual_schedule_id: schedule.id,
          balance_account: schedule.balance_account,
          cancel_months: pending.map((i) => i.period_month),
          reverse_months: posted.map((i) => ({
            period_month: i.period_month,
            amount: Number(i.amount),
            journal_entry_id: i.journal_entry_id,
          })),
          reversed_amount: sumOre(posted.map((i) => Number(i.amount))),
        },
      }
    }

    const result: CancelSchedulesResult = await cancelSchedules(ctx.supabase, ctx.companyId, ctx.userId, [schedule], {
      reversalDate: options.today ?? todayIsoStockholm(),
      failurePrefix: 'Storno vid ångrad periodisering misslyckades',
    })
    const warnings: OperationWarning[] = result.failedReversals > 0
      ? [{
          code: 'ACCRUAL_CANCEL_INCOMPLETE',
          message_sv: `${result.failedReversals} bokförda månader kunde inte vändas, så periodiseringen är fortfarande aktiv. Se felet på månaderna och försök igen.`,
          message_en: `${result.failedReversals} posted months could not be reversed, so the schedule is still active. See the error on the months and try again.`,
        }]
      : []
    return {
      ok: true,
      data: {
        accrual_schedule_id: schedule.id,
        status: result.failedReversals > 0 ? 'active' : 'cancelled',
        cancelled_months: pending.length,
        reversed_entries: result.reversedEntries,
        failed_reversals: result.failedReversals,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  } catch (error) {
    return manualAccrualFailure(error, 'ACCRUAL_CANCEL_FAILED')
  }
}

/**
 * Cancel the manual plans whose origin verifikat was just reversed, the way
 * an invoice credit cancels the invoice's plans: the storno took the amount
 * off the balance account, so the months the plans posted are stornoed too
 * (dated `reversalDate`, the storno's date, inside each month's own year).
 */
export async function cancelManualSchedulesForOrigin(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  originEntryId: string,
  options: { reversalDate?: string } = {},
): Promise<CancelSchedulesResult> {
  const { data, error } = await supabase
    .from('accrual_schedules')
    .select('*')
    .eq('company_id', companyId)
    .eq('source_kind', 'manual')
    .eq('origin_journal_entry_id', originEntryId)
    .neq('status', 'cancelled')
  if (error) throw new Error(`Failed to load accrual schedules: ${error.message}`)
  const schedules = (data ?? []) as AccrualSchedule[]
  if (schedules.length === 0) return { cancelledSchedules: 0, reversedEntries: 0, failedReversals: 0 }
  return cancelSchedules(supabase, companyId, userId, schedules, {
    reversalDate: options.reversalDate,
    failurePrefix: 'Storno när ursprungsverifikatet vändes misslyckades',
  })
}
