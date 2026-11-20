import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'

const mocks = vi.hoisted(() => ({
  ledgerLines: [] as Array<{ account_number: string; debit_amount: number; credit_amount: number }>,
  createAccrualSchedule: vi.fn(),
  cancelSchedules: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/entry-lines', () => ({
  fetchEntryLines: vi.fn(async () => mocks.ledgerLines),
}))

vi.mock('../service', () => ({
  createAccrualSchedule: (...args: unknown[]) => mocks.createAccrualSchedule(...args),
  cancelSchedules: (...args: unknown[]) => mocks.cancelSchedules(...args),
}))

import {
  cancelManualSchedule,
  cancelManualSchedulesForOrigin,
  createManualAccrualSchedule,
  readAccrualRoom,
} from '../manual'

const ORIGIN = '11111111-1111-4111-8111-111111111111'
const SCHEDULE = '22222222-2222-4222-8222-222222222222'

/** Fortnox booked a 12 000 kr annual insurance on 1730 in January and dissolved January to June. */
const ORIGIN_ENTRY = {
  id: ORIGIN,
  entry_date: '2026-01-10',
  status: 'posted',
  source_type: 'import',
  reversed_by_id: null,
  lines: [
    { account_number: '1730', debit_amount: 12000, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 12000 },
  ],
}
const LEDGER_AFTER_SIX_MONTHS = [
  { account_number: '1730', debit_amount: 12000, credit_amount: 0 },
  ...Array.from({ length: 6 }, () => ({ account_number: '1730', debit_amount: 0, credit_amount: 1000 })),
]

const INPUT = {
  direction: 'expense' as const,
  amount_sek: 6000,
  balance_account: '1730',
  target_account: '6310',
  period_start: '2026-07-01',
  months: 6,
  description: 'Företagsförsäkring',
  origin_journal_entry_id: ORIGIN,
}

function setup() {
  const mock = createTableMockSupabase({
    journal_entries: { data: ORIGIN_ENTRY },
    accrual_schedules: { data: [] },
    'rpc:account_ib_floor': { data: null },
  })
  const ctx = { supabase: mock.supabase as never, companyId: 'company-1', userId: 'user-1', log: createLogger('test') }
  return { ...mock, ctx }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.ledgerLines = LEDGER_AFTER_SIX_MONTHS
  mocks.createAccrualSchedule.mockResolvedValue({ id: SCHEDULE, source_kind: 'manual' })
  mocks.cancelSchedules.mockResolvedValue({ cancelledSchedules: 1, reversedEntries: 2, failedReversals: 0 })
})

describe('createManualAccrualSchedule: what remains on the account', () => {
  it('previews the remaining months of a migrated plan and writes nothing', async () => {
    const { ctx } = setup()

    const outcome = await createManualAccrualSchedule(ctx, INPUT, { dryRun: true })

    if (!outcome.ok || !outcome.dryRun) throw new Error(JSON.stringify(outcome))
    expect(outcome.preview).toMatchObject({
      sourceKind: 'manual',
      totalAmountSek: 6000,
      periodStart: '2026-07-01',
      periodEnd: '2026-12-31',
      origin_journal_entry_id: ORIGIN,
      posting_floor_date: '2026-01-10',
      available_sek: 6000,
      ledger_balance_sek: 6000,
      planned_sek: 0,
    })
    expect((outcome.preview.installments as unknown[]).length).toBe(6)
    expect(mocks.createAccrualSchedule).not.toHaveBeenCalled()
  })

  it('refuses the full original amount once months are dissolved: no month is booked twice', async () => {
    const { ctx } = setup()

    const outcome = await createManualAccrualSchedule(ctx, { ...INPUT, amount_sek: 12000, period_start: '2026-01-01', months: 12 }, { dryRun: true })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'ACCRUAL_BALANCE_EXCEEDED',
      details: { balance_account: '1730', available_sek: 6000, ledger_balance_sek: 6000, origin_amount_sek: 12000 },
    })
    if (!outcome.ok) expect(outcome.messageSv).toMatch(/6\s000,00 kr kvar att periodisera på 1730/)
  })

  it('subtracts the months other active plans on the same account have not posted yet', async () => {
    const { ctx, setTable } = setup()
    setTable('accrual_schedules', {
      data: [{ id: 'other', installments: [{ amount: 1000, status: 'pending' }, { amount: 1000, status: 'pending' }, { amount: 1000, status: 'posted' }] }],
    })

    const outcome = await createManualAccrualSchedule(ctx, INPUT, { dryRun: true })

    expect(outcome).toMatchObject({ ok: false, code: 'ACCRUAL_BALANCE_EXCEEDED', details: { available_sek: 4000, planned_sek: 2000 } })
  })

  it('reads the other plans on the balance account and in the direction of this one', async () => {
    const { ctx, findCalls } = setup()

    await createManualAccrualSchedule(ctx, INPUT, { dryRun: true })

    expect(findCalls('accrual_schedules', 'eq')).toEqual(
      expect.arrayContaining([['status', 'active'], ['direction', 'expense'], ['balance_account', '1730']]),
    )
  })

  it('never allows more than the origin put on the account', async () => {
    const { ctx } = setup()
    mocks.ledgerLines = [{ account_number: '1730', debit_amount: 50000, credit_amount: 0 }]

    const outcome = await createManualAccrualSchedule(ctx, { ...INPUT, amount_sek: 12000.01 }, { dryRun: true })

    expect(outcome).toMatchObject({ ok: false, code: 'ACCRUAL_BALANCE_EXCEEDED', details: { available_sek: 12000 } })
  })

  it('reads a förutbetald intäkt on 29xx as a credit balance', async () => {
    const { ctx, setTable } = setup()
    setTable('journal_entries', {
      data: { ...ORIGIN_ENTRY, lines: [{ account_number: '2970', debit_amount: 0, credit_amount: 3000 }, { account_number: '1930', debit_amount: 3000, credit_amount: 0 }] },
    })
    mocks.ledgerLines = [{ account_number: '2970', debit_amount: 0, credit_amount: 3000 }]

    const outcome = await createManualAccrualSchedule(
      ctx,
      { ...INPUT, direction: 'revenue', balance_account: '2970', target_account: '3041', amount_sek: 3000, months: 3 },
      { dryRun: true },
    )

    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { available_sek: 3000 } })
  })
})

describe('createManualAccrualSchedule: the origin', () => {
  it('refuses a reversed origin', async () => {
    const { ctx, setTable } = setup()
    setTable('journal_entries', { data: { ...ORIGIN_ENTRY, status: 'reversed', reversed_by_id: 'storno-1' } })

    expect(await createManualAccrualSchedule(ctx, INPUT, { dryRun: true })).toMatchObject({ ok: false, code: 'ACCRUAL_ORIGIN_REVERSED' })
  })

  it('answers 404 for a missing or unposted origin', async () => {
    const { ctx, setTable } = setup()
    setTable('journal_entries', { data: null })
    expect(await createManualAccrualSchedule(ctx, INPUT, { dryRun: true })).toMatchObject({ ok: false, code: 'ACCRUAL_ORIGIN_NOT_FOUND' })

    setTable('journal_entries', { data: { ...ORIGIN_ENTRY, status: 'draft' } })
    expect(await createManualAccrualSchedule(ctx, INPUT, { dryRun: true })).toMatchObject({ ok: false, code: 'ACCRUAL_ORIGIN_NOT_FOUND' })
  })

  it('refuses an origin that put nothing on the balance account', async () => {
    const { ctx } = setup()

    const outcome = await createManualAccrualSchedule(ctx, { ...INPUT, balance_account: '1710' }, { dryRun: true })

    expect(outcome).toMatchObject({ ok: false, code: 'ACCRUAL_ORIGIN_ACCOUNT_MISSING', details: { balance_account: '1710' } })
  })

  it('treats an ingående balans picked as the origin as the IB: no origin link', async () => {
    const { ctx, setTable } = setup()
    setTable('journal_entries', { data: { ...ORIGIN_ENTRY, source_type: 'opening_balance', entry_date: '2026-01-01' } })

    const outcome = await createManualAccrualSchedule(ctx, INPUT, { dryRun: true })

    expect(outcome).toMatchObject({ ok: true, preview: { origin_journal_entry_id: null, posting_floor_date: '2026-01-01' } })
  })

  it('without an origin, a deferral takes the ingående balans on the account, same-date IB verifikat added up', async () => {
    const { ctx, setTable } = setup()
    // account_ib_floor sums every IB verifikat dated the year's first day.
    setTable('rpc:account_ib_floor', { data: { floor_date: '2026-01-01', amount: 12000, entry_ids: ['ib-1', 'ib-2'] } })
    mocks.ledgerLines = [
      { account_number: '1730', debit_amount: 9000, credit_amount: 0 },
      { account_number: '1730', debit_amount: 3000, credit_amount: 0 },
    ]

    const outcome = await createManualAccrualSchedule(ctx, { ...INPUT, origin_journal_entry_id: undefined, amount_sek: 12000, period_start: '2026-01-01', months: 12 }, { dryRun: true })

    expect(outcome).toMatchObject({ ok: true, preview: { origin_journal_entry_id: null, posting_floor_date: '2026-01-01', available_sek: 12000 } })
  })

  it('without an origin or an ingående balans, a deferral is refused', async () => {
    const { ctx } = setup()

    const outcome = await createManualAccrualSchedule(ctx, { ...INPUT, origin_journal_entry_id: undefined }, { dryRun: true })

    expect(outcome).toMatchObject({ ok: false, code: 'ACCRUAL_OPENING_BALANCE_MISSING' })
  })

  it('an upplupen kostnad needs no origin, no ingående balans and no room', async () => {
    const { ctx, tables } = setup()

    const outcome = await createManualAccrualSchedule(
      ctx,
      { ...INPUT, balance_account: '2990', origin_journal_entry_id: undefined, amount_sek: 900, months: 3 },
      { dryRun: true },
    )

    expect(outcome).toMatchObject({ ok: true, preview: { available_sek: null, posting_floor_date: '2026-07-01' } })
    expect(tables()).not.toContain('accrual_schedules')
  })
})

describe('createManualAccrualSchedule: input rules', () => {
  it('refuses a target account outside the result classes', async () => {
    const { ctx } = setup()
    expect(await createManualAccrualSchedule(ctx, { ...INPUT, target_account: '1930' }, { dryRun: true })).toMatchObject({
      ok: false,
      code: 'ACCRUAL_TARGET_ACCOUNT_INVALID',
    })
  })

  it('refuses an end before the first month and an amount below one öre a month', async () => {
    const { ctx } = setup()
    expect(
      await createManualAccrualSchedule(ctx, { ...INPUT, months: undefined, period_end: '2026-06-30' }, { dryRun: true }),
    ).toMatchObject({ ok: false, code: 'ACCRUAL_PERIOD_REQUIRED' })
    expect(await createManualAccrualSchedule(ctx, { ...INPUT, amount_sek: 0.05 }, { dryRun: true })).toMatchObject({
      ok: false,
      code: 'ACCRUAL_AMOUNT_INVALID',
    })
  })

  it('creates the plan through the accrual service, with the origin as posting floor', async () => {
    const { ctx } = setup()

    const outcome = await createManualAccrualSchedule(ctx, INPUT, { dryRun: false })

    expect(outcome).toMatchObject({ ok: true, created: true, data: { id: SCHEDULE } })
    expect(mocks.createAccrualSchedule).toHaveBeenCalledWith(
      ctx.supabase,
      'company-1',
      'user-1',
      expect.objectContaining({ sourceKind: 'manual', balanceAccount: '1730', targetAccount: '6310', totalAmountSek: 6000, periodStart: '2026-07-01', periodEnd: '2026-12-31' }),
      { originJournalEntryId: ORIGIN, postingFloorDate: '2026-01-10' },
    )
  })
})

describe('readAccrualRoom', () => {
  it('answers what remains for the dialog prefill', async () => {
    const { ctx } = setup()

    const outcome = await readAccrualRoom(ctx.supabase, 'company-1', { direction: 'expense', balance_account: '1730', origin_journal_entry_id: ORIGIN })

    expect(outcome).toEqual({
      ok: true,
      data: {
        balance_account: '1730', direction: 'expense', deferral: true,
        ledger_balance_sek: 6000, planned_sek: 0, origin_amount_sek: 12000, available_sek: 6000,
      },
    })
  })

  it('answers no room for an upplupen post', async () => {
    const { ctx } = setup()
    expect(await readAccrualRoom(ctx.supabase, 'company-1', { direction: 'revenue', balance_account: '1790' })).toMatchObject({
      ok: true,
      data: { deferral: false, available_sek: null },
    })
  })
})

describe('cancelManualSchedule', () => {
  const MANUAL = {
    id: SCHEDULE, company_id: 'company-1', source_kind: 'manual', status: 'active', balance_account: '1730',
    installments: [
      { period_month: '2026-08-01', amount: 1000, status: 'posted', journal_entry_id: 'je-8' },
      { period_month: '2026-07-01', amount: 1000, status: 'posted', journal_entry_id: 'je-7' },
      { period_month: '2026-09-01', amount: 1000, status: 'pending', journal_entry_id: null },
    ],
  }

  it('answers 404 for an unknown plan and refuses an invoice plan', async () => {
    const { ctx, setTable } = setup()
    setTable('accrual_schedules', { data: null })
    expect(await cancelManualSchedule(ctx, SCHEDULE, { dryRun: false })).toEqual({ ok: false, code: 'ACCRUAL_NOT_FOUND' })

    setTable('accrual_schedules', { data: { ...MANUAL, source_kind: 'invoice' } })
    expect(await cancelManualSchedule(ctx, SCHEDULE, { dryRun: false })).toEqual({ ok: false, code: 'ACCRUAL_CANCEL_NOT_MANUAL' })
    expect(mocks.cancelSchedules).not.toHaveBeenCalled()
  })

  it('previews the months it cancels and reverses without writing', async () => {
    const { ctx, setTable } = setup()
    setTable('accrual_schedules', { data: MANUAL })

    const outcome = await cancelManualSchedule(ctx, SCHEDULE, { dryRun: true })

    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: {
        cancel_months: ['2026-09-01'],
        reverse_months: [{ period_month: '2026-07-01', journal_entry_id: 'je-7' }, { period_month: '2026-08-01', journal_entry_id: 'je-8' }],
        reversed_amount: 2000,
      },
    })
    expect(mocks.cancelSchedules).not.toHaveBeenCalled()
  })

  it('undoes the plan through the shared cancel steps, stornoes dated today', async () => {
    const { ctx, setTable } = setup()
    setTable('accrual_schedules', { data: MANUAL })

    const outcome = await cancelManualSchedule(ctx, SCHEDULE, { dryRun: false, today: '2026-11-07' })

    expect(outcome).toEqual({
      ok: true,
      data: { accrual_schedule_id: SCHEDULE, status: 'cancelled', cancelled_months: 1, reversed_entries: 2, failed_reversals: 0 },
    })
    expect(mocks.cancelSchedules).toHaveBeenCalledWith(ctx.supabase, 'company-1', 'user-1', [expect.objectContaining({ id: SCHEDULE })], {
      reversalDate: '2026-11-07',
      failurePrefix: 'Storno vid ångrad periodisering misslyckades',
    })
  })

  it('keeps the plan active with a warning when a storno fails', async () => {
    const { ctx, setTable } = setup()
    setTable('accrual_schedules', { data: MANUAL })
    mocks.cancelSchedules.mockResolvedValue({ cancelledSchedules: 0, reversedEntries: 1, failedReversals: 1 })

    const outcome = await cancelManualSchedule(ctx, SCHEDULE, { dryRun: false })

    expect(outcome).toMatchObject({
      ok: true,
      data: { status: 'active', failed_reversals: 1 },
      warnings: [{ code: 'ACCRUAL_CANCEL_INCOMPLETE' }],
    })
  })
})

describe('cancelManualSchedulesForOrigin', () => {
  it('cancels the manual plans of a reversed origin on the storno date', async () => {
    const { ctx, setTable, findCalls } = setup()
    setTable('accrual_schedules', { data: [{ id: SCHEDULE, source_kind: 'manual' }] })

    const result = await cancelManualSchedulesForOrigin(ctx.supabase, 'company-1', 'user-1', ORIGIN, { reversalDate: '2026-11-07' })

    expect(result).toEqual({ cancelledSchedules: 1, reversedEntries: 2, failedReversals: 0 })
    expect(findCalls('accrual_schedules', 'eq')).toEqual(
      expect.arrayContaining([['source_kind', 'manual'], ['origin_journal_entry_id', ORIGIN]]),
    )
    expect(mocks.cancelSchedules).toHaveBeenCalledWith(ctx.supabase, 'company-1', 'user-1', [{ id: SCHEDULE, source_kind: 'manual' }], {
      reversalDate: '2026-11-07',
      failurePrefix: 'Storno när ursprungsverifikatet vändes misslyckades',
    })
  })

  it('does nothing when the verifikat is no plan\'s origin', async () => {
    const { ctx } = setup()

    expect(await cancelManualSchedulesForOrigin(ctx.supabase, 'company-1', 'user-1', ORIGIN)).toEqual({
      cancelledSchedules: 0, reversedEntries: 0, failedReversals: 0,
    })
    expect(mocks.cancelSchedules).not.toHaveBeenCalled()
  })
})
