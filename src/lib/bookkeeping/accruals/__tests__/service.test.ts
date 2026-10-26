import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  cancelSchedulesForSource,
  createAccrualSchedule,
  dissolveScheduleNow,
  installmentDueDate,
  postDueInstallments,
  replanRemainingInstallments,
} from '@/lib/bookkeeping/accruals/service'
import type { OperationContext } from '@/lib/operations/types'
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
  ACCRUAL_NOTHING_TO_DISSOLVE,
  ACCRUAL_SCHEDULE_NOT_ACTIVE,
  ACCRUAL_SCHEDULE_NOT_FOUND,
} from '@/lib/bookkeeping/accruals/errors'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
  reverseEntry: vi.fn(),
}))

const mockCreateJournalEntry = vi.mocked(createJournalEntry)
const mockFindFiscalPeriod = vi.mocked(findFiscalPeriod)
const mockReverseEntry = vi.mocked(reverseEntry)

const COMPANY = 'company-1'
const USER = 'user-1'

function makeSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sched-1',
    user_id: USER,
    company_id: COMPANY,
    direction: 'expense',
    supplier_invoice_id: 'si-1',
    supplier_invoice_item_id: 'sii-1',
    invoice_id: null,
    invoice_item_id: null,
    balance_account: '1730',
    target_account: '6310',
    total_amount: 12000,
    period_start: '2026-01-01',
    period_end: '2026-12-31',
    months: 12,
    origin_journal_entry_id: 'je-origin',
    posting_floor_date: '2026-01-15',
    status: 'active',
    description: 'Försäkring 2026',
    created_at: '2026-01-15T00:00:00Z',
    updated_at: '2026-01-15T00:00:00Z',
    ...overrides,
  }
}

function makeInstallment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inst-1',
    user_id: USER,
    company_id: COMPANY,
    schedule_id: 'sched-1',
    period_month: '2026-01-01',
    amount: 1000,
    status: 'pending',
    journal_entry_id: null,
    posted_at: null,
    last_error: null,
    created_at: '2026-01-15T00:00:00Z',
    updated_at: '2026-01-15T00:00:00Z',
    schedule: makeSchedule(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFindFiscalPeriod.mockResolvedValue('fp-1')
  mockCreateJournalEntry.mockResolvedValue({ id: 'je-new' } as never)
  mockReverseEntry.mockResolvedValue({ id: 'je-storno' } as never)
})

describe('postDueInstallments', () => {
  it('posts a due expense installment with Dr target / Cr balance', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeInstallment()] }, // due installments
      { data: { bookkeeping_locked_through: null } }, // company_settings
      { data: [{ id: 'inst-1' }] }, // CAS claim
      { count: 0 }, // remaining pending
      { data: null }, // schedule -> completed
    ])

    const result = await postDueInstallments(
      supabase as unknown as SupabaseClient,
      COMPANY,
      { userId: USER, today: '2026-01-20' },
    )

    expect(result).toMatchObject({ posted: 1, failed: 0, skipped: 0 })
    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1)
    const input = mockCreateJournalEntry.mock.calls[0][3]
    expect(input.source_type).toBe('accrual')
    expect(input.source_id).toBe('sched-1')
    // Floor: period month 2026-01-01 but origin entry dated 2026-01-15.
    expect(input.entry_date).toBe('2026-01-15')
    expect(input.lines).toEqual([
      expect.objectContaining({ account_number: '6310', debit_amount: 1000, credit_amount: 0 }),
      expect.objectContaining({ account_number: '1730', debit_amount: 0, credit_amount: 1000 }),
    ])
  })

  it('flips the lines for revenue schedules (Dr 29xx / Cr 3xxx)', async () => {
    const revenueSchedule = makeSchedule({
      id: 'sched-2',
      direction: 'revenue',
      supplier_invoice_id: null,
      invoice_id: 'inv-1',
      balance_account: '2970',
      target_account: '3001',
      posting_floor_date: '2026-01-01',
    })
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeInstallment({ schedule_id: 'sched-2', schedule: revenueSchedule })] },
      { data: { bookkeeping_locked_through: null } },
      { data: [{ id: 'inst-1' }] },
      { count: 1 }, // still pending months -> schedule stays active
    ])

    await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-01-20',
    })

    const input = mockCreateJournalEntry.mock.calls[0][3]
    expect(input.lines).toEqual([
      expect.objectContaining({ account_number: '2970', debit_amount: 1000, credit_amount: 0 }),
      expect.objectContaining({ account_number: '3001', debit_amount: 0, credit_amount: 1000 }),
    ])
  })

  it('carries the schedule dimensions bag onto both dissolution lines', async () => {
    const tagged = makeSchedule({ dimensions: { '1': 'KS01', '6': 'P001' } })
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeInstallment({ schedule: tagged })] },
      { data: { bookkeeping_locked_through: null } },
      { data: [{ id: 'inst-1' }] },
      { count: 0 },
      { data: null },
    ])

    await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-01-20',
    })

    const input = mockCreateJournalEntry.mock.calls[0][3]
    // Both lines: the origin entry tags its interim 17xx/29xx line too, so
    // per-dimension views of the interim account must net to zero.
    expect(input.lines).toEqual([
      expect.objectContaining({
        account_number: '6310',
        dimensions: { '1': 'KS01', '6': 'P001' },
      }),
      expect.objectContaining({
        account_number: '1730',
        dimensions: { '1': 'KS01', '6': 'P001' },
      }),
    ])
  })

  it('adds no dimensions key when the schedule bag is empty', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeInstallment({ schedule: makeSchedule({ dimensions: {} }) })] },
      { data: { bookkeeping_locked_through: null } },
      { data: [{ id: 'inst-1' }] },
      { count: 0 },
      { data: null },
    ])

    await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-01-20',
    })

    const input = mockCreateJournalEntry.mock.calls[0][3]
    expect(input.lines).toHaveLength(2)
    for (const line of input.lines) {
      expect(line).not.toHaveProperty('dimensions')
    }
  })

  it('shifts the entry date past the company lock date', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeInstallment({ period_month: '2026-02-01' })] },
      { data: { bookkeeping_locked_through: '2026-03-31' } },
      { data: [{ id: 'inst-1' }] },
      { count: 0 },
      { data: null },
    ])

    await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-04-10',
    })

    expect(mockCreateJournalEntry.mock.calls[0][3].entry_date).toBe('2026-04-01')
  })

  it('skips months that have not begun yet', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [] }, // the .lte filter excludes future months server-side
    ])

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-01-20',
    })

    expect(result.posted).toBe(0)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('reverses its own entry when the CAS claim is lost', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeInstallment()] },
      { data: { bookkeeping_locked_through: null } },
      { data: [] }, // CAS claim lost (another runner won)
    ])

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-01-20',
    })

    expect(result).toMatchObject({ posted: 0, skipped: 1, failed: 0 })
    expect(mockReverseEntry).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY,
      USER,
      'je-new',
    )
  })

  it('reverses its own entry when the CAS claim UPDATE itself errors', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeInstallment()] },
      { data: { bookkeeping_locked_through: null } },
      { data: null, error: { message: 'connection reset' } }, // claim errored
      { data: null }, // last_error update in the catch
    ])

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-01-20',
    })

    expect(result).toMatchObject({ posted: 0, skipped: 0, failed: 1 })
    expect(result.errors[0].message).toMatch(/Failed to mark installment posted/)
    // Without the storno the next cron run would double-book the month.
    expect(mockReverseEntry).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY,
      USER,
      'je-new',
    )
  })

  it('records the reversal failure too when storno after claim error fails', async () => {
    mockReverseEntry.mockRejectedValueOnce(new Error('Bokföringen är låst'))
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeInstallment()] },
      { data: { bookkeeping_locked_through: null } },
      { data: null, error: { message: 'connection reset' } }, // claim errored
      { data: null }, // last_error update in the catch
    ])

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-01-20',
    })

    expect(result.failed).toBe(1)
    expect(result.errors[0].message).toMatch(/misslyckades också/)
    expect(result.errors[0].message).toMatch(/Bokföringen är låst/)
  })

  it('clamps the posting date to the next open fiscal period when the date falls in a closed one', async () => {
    mockFindFiscalPeriod.mockResolvedValueOnce(null) // 2026 period is closed
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeInstallment()] },
      { data: { bookkeeping_locked_through: null } },
      { data: { id: 'fp-next', period_start: '2027-01-01' } }, // next open period
      { data: [{ id: 'inst-1' }] }, // CAS claim
      { count: 0 },
      { data: null },
    ])

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-01-20',
    })

    expect(result).toMatchObject({ posted: 1, failed: 0 })
    const input = mockCreateJournalEntry.mock.calls[0][3]
    expect(input.entry_date).toBe('2027-01-01')
    expect(input.fiscal_period_id).toBe('fp-next')
  })

  it('records an actionable last_error when no open period exists at or after the date', async () => {
    mockFindFiscalPeriod.mockResolvedValueOnce(null)
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeInstallment()] },
      { data: { bookkeeping_locked_through: null } },
      { data: null }, // no open period after the date either
      { data: null }, // last_error update
    ])

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-01-20',
    })

    expect(result).toMatchObject({ posted: 0, failed: 1 })
    expect(result.errors[0].message).toMatch(/eller senare/)
    expect(result.errors[0].message).toMatch(/skapa nästa räkenskapsår/)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('records last_error and continues when posting fails', async () => {
    mockCreateJournalEntry.mockRejectedValueOnce(new Error('Bokföringen är låst'))
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: [
          makeInstallment({ id: 'inst-1' }),
          makeInstallment({ id: 'inst-2', period_month: '2026-02-01' }),
        ],
      },
      { data: { bookkeeping_locked_through: null } },
      { data: null }, // last_error update for inst-1
      { data: [{ id: 'inst-2' }] }, // CAS claim for inst-2
      { count: 0 },
      { data: null },
    ])

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-02-20',
    })

    expect(result).toMatchObject({ posted: 1, failed: 1 })
    expect(result.errors[0]).toMatchObject({ installmentId: 'inst-1' })
  })

  it('ignores installments whose schedule is not active', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: [
          makeInstallment({ schedule: makeSchedule({ status: 'cancelled' }) }),
        ],
      },
    ])

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-01-20',
    })

    expect(result.posted).toBe(0)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })
})

describe('createAccrualSchedule', () => {
  const spec = {
    direction: 'expense' as const,
    supplierInvoiceId: 'si-1',
    supplierInvoiceItemId: 'sii-1',
    balanceAccount: '1730',
    targetAccount: '6310',
    totalAmountSek: 12000,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    description: 'Försäkring 2026',
  }

  it('creates the schedule and 12 installments without posting when postCatchUp=false', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeSchedule() }, // schedule insert
      { data: null }, // installments insert
    ])

    const schedule = await createAccrualSchedule(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      spec,
      { originJournalEntryId: 'je-origin', postingFloorDate: '2026-01-15', postCatchUp: false },
    )

    expect(schedule.id).toBe('sched-1')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('persists the spec dimensions bag on the schedule row', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeSchedule({ dimensions: { '6': 'P001' } }) },
      { data: null },
    ])

    await createAccrualSchedule(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      { ...spec, dimensions: { '6': 'P001' } },
      { postingFloorDate: '2026-01-15', postCatchUp: false },
    )

    const insert = findCall('accrual_schedules', 'insert')?.[0]
    expect(insert).toMatchObject({ dimensions: { '6': 'P001' } })
  })

  it('defaults the schedule dimensions to an empty bag', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeSchedule() },
      { data: null },
    ])

    await createAccrualSchedule(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      spec,
      { postingFloorDate: '2026-01-15', postCatchUp: false },
    )

    const insert = findCall('accrual_schedules', 'insert')?.[0]
    expect(insert).toMatchObject({ dimensions: {} })
  })

  it('cleans up the schedule when installment insert fails', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeSchedule() },
      { data: null, error: { message: 'boom' } },
      { data: null }, // cleanup delete
    ])

    await expect(
      createAccrualSchedule(
        supabase as unknown as SupabaseClient,
        COMPANY,
        USER,
        spec,
        { postingFloorDate: '2026-01-15', postCatchUp: false },
      ),
    ).rejects.toThrow(/installments/i)
  })
})

describe('dissolveScheduleNow', () => {
  it('posts one combined entry for the remaining months', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeSchedule() }, // schedule fetch
      {
        data: [
          makeInstallment({ id: 'inst-11', period_month: '2026-11-01', amount: 1000 }),
          makeInstallment({ id: 'inst-12', period_month: '2026-12-01', amount: 1000 }),
        ],
      },
      { data: { bookkeeping_locked_through: null } },
      { data: [{ id: 'inst-11' }, { id: 'inst-12' }] }, // claim both
      { data: null }, // schedule completed
    ])

    const result = await dissolveScheduleNow(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      'sched-1',
      { today: '2026-10-15' },
    )

    expect(result).toMatchObject({ journalEntryId: 'je-new', amount: 2000 })
    const input = mockCreateJournalEntry.mock.calls[0][3]
    expect(input.entry_date).toBe('2026-10-15')
    expect(input.lines[0]).toMatchObject({ account_number: '6310', debit_amount: 2000 })
  })

  it('reverses the combined entry when the claim is incomplete', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeSchedule() },
      {
        data: [
          makeInstallment({ id: 'inst-11', period_month: '2026-11-01', amount: 1000 }),
          makeInstallment({ id: 'inst-12', period_month: '2026-12-01', amount: 1000 }),
        ],
      },
      { data: { bookkeeping_locked_through: null } },
      { data: [{ id: 'inst-11' }] }, // only one claimed
    ])

    await expect(
      dissolveScheduleNow(supabase as unknown as SupabaseClient, COMPANY, USER, 'sched-1', {
        today: '2026-10-15',
      }),
    ).rejects.toThrow(/ändrades samtidigt/i)
    expect(mockReverseEntry).toHaveBeenCalled()
  })

  it('throws a typed not-found error with a stable code', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: null, error: { message: 'No rows' } }])

    await expect(
      dissolveScheduleNow(supabase as unknown as SupabaseClient, COMPANY, USER, 'missing'),
    ).rejects.toMatchObject({
      code: ACCRUAL_SCHEDULE_NOT_FOUND,
      message: 'Periodiseringen hittades inte',
    })
  })

  it('throws a typed not-active error with a stable code', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: makeSchedule({ status: 'completed' }) }])

    await expect(
      dissolveScheduleNow(supabase as unknown as SupabaseClient, COMPANY, USER, 'sched-1'),
    ).rejects.toMatchObject({
      code: ACCRUAL_SCHEDULE_NOT_ACTIVE,
      message: 'Periodiseringen är inte aktiv',
    })
  })

  it('throws a typed nothing-to-dissolve error with a stable code', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: makeSchedule() }, // schedule fetch
      { data: [] }, // nothing pending
      { count: 0 }, // completeScheduleIfDone: remaining pending
      { data: null }, // schedule -> completed
    ])

    await expect(
      dissolveScheduleNow(supabase as unknown as SupabaseClient, COMPANY, USER, 'sched-1'),
    ).rejects.toMatchObject({
      code: ACCRUAL_NOTHING_TO_DISSOLVE,
      message: 'Det finns inget kvar att lösa upp',
    })
  })
})

describe('cancelSchedulesForSource', () => {
  it('cancels pending months, reverses posted ones, and cancels the schedule', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeSchedule()] }, // schedules for source
      { data: null }, // pending -> cancelled
      {
        data: [
          {
            id: 'inst-1',
            journal_entry_id: 'je-jan',
            journal_entry: { fiscal_period: { period_start: '2026-01-01', period_end: '2026-12-31' } },
          },
        ],
      }, // posted rows
      { data: null }, // schedule -> cancelled
    ])

    const result = await cancelSchedulesForSource(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      { supplierInvoiceId: 'si-1' },
      { reversalDate: '2026-05-01' },
    )

    expect(result).toEqual({ cancelledSchedules: 1, reversedEntries: 1, failedReversals: 0 })
    expect(mockReverseEntry).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY,
      USER,
      'je-jan',
      '2026-05-01',
    )
  })

  // A storno is numbered and booked in its original's year (BFL 5 kap 5 §,
  // BFNAR 2013:2 p. 2.17-2.18): a 2025 dissolution credited in 2026 is
  // stornoed on its own date, while the 2026 one takes the credit date.
  it('dates a dissolution from an earlier year on its own date, not the credit date', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeSchedule({ period_start: '2025-07-01', period_end: '2026-06-30' })] },
      { data: null }, // pending -> cancelled
      {
        data: [
          {
            id: 'inst-dec',
            journal_entry_id: 'je-dec-2025',
            journal_entry: { fiscal_period: { period_start: '2025-01-01', period_end: '2025-12-31' } },
          },
          {
            id: 'inst-jan',
            journal_entry_id: 'je-jan-2026',
            journal_entry: { fiscal_period: { period_start: '2026-01-01', period_end: '2026-12-31' } },
          },
        ],
      },
      { data: null }, // schedule -> cancelled
    ])

    const result = await cancelSchedulesForSource(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      { supplierInvoiceId: 'si-1' },
      { reversalDate: '2026-03-10' },
    )

    expect(result).toEqual({ cancelledSchedules: 1, reversedEntries: 2, failedReversals: 0 })
    // No reversal date: the posting port's ledger adapter passes none at all (storno-target dates it).
    expect(mockReverseEntry).toHaveBeenNthCalledWith(1, expect.anything(), COMPANY, USER, 'je-dec-2025')
    expect(mockReverseEntry).toHaveBeenNthCalledWith(2, expect.anything(), COMPANY, USER, 'je-jan-2026', '2026-03-10')
  })

  it('leaves the schedule active and reports the failure when a storno fails', async () => {
    mockReverseEntry.mockRejectedValueOnce(new Error('Bokföringen är låst'))
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeSchedule()] }, // schedules for source
      { data: null }, // pending -> cancelled
      { data: [{ id: 'inst-1', journal_entry_id: 'je-jan' }] }, // posted rows
      { data: null }, // last_error update on the stuck installment
      // NOTE: no schedule -> cancelled update is queued; the schedule must
      // stay 'active' so the UI keeps showing the un-reversed remainder.
    ])

    const result = await cancelSchedulesForSource(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      { supplierInvoiceId: 'si-1' },
    )

    expect(result).toEqual({ cancelledSchedules: 0, reversedEntries: 0, failedReversals: 1 })
  })

  it('treats already-reversed dissolutions as success and still cancels the schedule', async () => {
    mockReverseEntry
      .mockRejectedValueOnce(new EntryAlreadyReversedError())
      .mockRejectedValueOnce(new CannotReverseNonPostedError('reversed'))
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeSchedule()] },
      { data: null }, // pending -> cancelled
      {
        data: [
          { id: 'inst-1', journal_entry_id: 'je-jan' },
          { id: 'inst-2', journal_entry_id: 'je-feb' },
        ],
      },
      { data: { id: 'je-jan', status: 'reversed' } }, // live walk: jan stornoed
      { data: [] }, // ... with no correction
      { data: { id: 'je-feb', status: 'reversed' } }, // live walk: feb stornoed
      { data: [] }, // ... with no correction
      { data: null }, // schedule -> cancelled
    ])

    const result = await cancelSchedulesForSource(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      { supplierInvoiceId: 'si-1' },
    )

    expect(result).toEqual({ cancelledSchedules: 1, reversedEntries: 0, failedReversals: 0 })
    expect(mockReverseEntry).toHaveBeenCalledTimes(2)
  })

  // A rättelse (correctEntry) stornoes the dissolution and posts the
  // corrected month as a new 'correction' verifikat; the installment keeps
  // pointing at the original. Crediting the invoice must storno the
  // correction too, or it stays on the interim and the cost account.
  it('stornoes the live correction of a dissolution corrected before the credit', async () => {
    mockReverseEntry
      .mockRejectedValueOnce(new EntryAlreadyReversedError())
      .mockResolvedValueOnce({ id: 'je-storno-corr' } as never)
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeSchedule()] },
      { data: null }, // pending -> cancelled
      {
        data: [
          {
            id: 'inst-sep',
            journal_entry_id: 'je-sep',
            journal_entry: { fiscal_period: { period_start: '2026-01-01', period_end: '2026-12-31' } },
          },
        ],
      },
      { data: { id: 'je-sep', status: 'reversed' } }, // live walk: the original
      { data: [{ id: 'je-sep-corr' }] }, // its correction
      { data: { id: 'je-sep-corr', status: 'posted' } }, // live
      { data: { fiscal_period: { period_start: '2026-01-01', period_end: '2026-12-31' } } }, // correction's year
      { data: null }, // schedule -> cancelled
    ])

    const result = await cancelSchedulesForSource(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      { supplierInvoiceId: 'si-1' },
      { reversalDate: '2026-10-14' },
    )

    expect(result).toEqual({ cancelledSchedules: 1, reversedEntries: 1, failedReversals: 0 })
    expect(mockReverseEntry).toHaveBeenNthCalledWith(2, expect.anything(), COMPANY, USER, 'je-sep-corr', '2026-10-14')
  })

  it('leaves the schedule active when the correction of a dissolution cannot be stornoed', async () => {
    mockReverseEntry
      .mockRejectedValueOnce(new EntryAlreadyReversedError())
      .mockRejectedValueOnce(new Error('Bokföringen är låst'))
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeSchedule()] },
      { data: null }, // pending -> cancelled
      { data: [{ id: 'inst-sep', journal_entry_id: 'je-sep' }] },
      { data: { id: 'je-sep', status: 'reversed' } },
      { data: [{ id: 'je-sep-corr' }] },
      { data: { id: 'je-sep-corr', status: 'posted' } },
      { data: { fiscal_period: null } },
      { data: null }, // last_error update on the stuck installment
      // No schedule -> cancelled: the correction still carries the month.
    ])

    const result = await cancelSchedulesForSource(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      { supplierInvoiceId: 'si-1' },
    )

    expect(result).toEqual({ cancelledSchedules: 0, reversedEntries: 0, failedReversals: 1 })
  })

  it('requires a source id', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      cancelSchedulesForSource(supabase as unknown as SupabaseClient, COMPANY, USER, {}),
    ).rejects.toThrow(/source invoice id/i)
  })
})

// Upplupen kostnad: an expense schedule on 29xx. Its months lie before the
// invoice month; each posts on its own last day, Dr cost / Cr 29xx, and is
// never moved by the posting floor (the invoice date) or a lock.
describe('upplupen intäkt (revenue schedule on 17xx, #62)', () => {
  // Consulting August-September on a customer invoice dated 2026-10-15.
  const accrued = (overrides: Record<string, unknown> = {}) =>
    makeSchedule({
      direction: 'revenue',
      supplier_invoice_id: null,
      supplier_invoice_item_id: null,
      invoice_id: 'inv-1',
      invoice_item_id: 'ii-1',
      balance_account: '1790',
      target_account: '3001',
      total_amount: 20000,
      period_start: '2026-08-01',
      period_end: '2026-09-30',
      months: 2,
      posting_floor_date: '2026-10-15',
      description: 'Konsultation aug-sep (faktura 1043)',
      ...overrides,
    })

  it('posts every month on its last day with Dr 17xx / Cr revenue, ignoring the invoice-date floor', async () => {
    const schedule = accrued()
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: [
          makeInstallment({ id: 'inst-aug', period_month: '2026-08-01', amount: 10000, schedule }),
          makeInstallment({ id: 'inst-sep', period_month: '2026-09-01', amount: 10000, schedule }),
        ],
      },
      { data: { bookkeeping_locked_through: null } },
      { data: [{ id: 'inst-aug' }] },
      { data: [{ id: 'inst-sep' }] },
      { count: 0 },
      { data: null },
    ])

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-10-15',
    })

    expect(result).toMatchObject({ posted: 2, failed: 0 })
    expect(mockCreateJournalEntry.mock.calls.map((call) => call[3].entry_date)).toEqual(['2026-08-31', '2026-09-30'])
    expect(mockFindFiscalPeriod.mock.calls.map((call) => call[2])).toEqual(['2026-08-31', '2026-09-30'])
    const sep = mockCreateJournalEntry.mock.calls[1][3]
    expect(sep.source_type).toBe('accrual')
    // Revenue in its own month, no moms: the output VAT stays on the invoice.
    expect(sep.lines).toEqual([
      expect.objectContaining({ account_number: '1790', debit_amount: 10000, credit_amount: 0 }),
      expect.objectContaining({ account_number: '3001', debit_amount: 0, credit_amount: 10000 }),
    ])
  })

  it('never moves a month behind the company lock date: it fails and stays pending', async () => {
    const schedule = accrued()
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeInstallment({ period_month: '2026-08-01', amount: 10000, schedule })] },
      { data: { bookkeeping_locked_through: '2026-08-31' } },
      { data: null }, // last_error update
    ])

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-10-15',
    })

    expect(result).toMatchObject({ posted: 0, failed: 1 })
    expect(result.errors[0].message).toMatch(/Den upplupna intäkten för 2026-08 ska bokföras 2026-08-31/)
    expect(result.errors[0].message).toMatch(/flyttas inte/)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('keeps a 29xx förutbetald intäkt on the invoice-date floor (unchanged)', async () => {
    const deferred = accrued({ balance_account: '2970', period_start: '2026-10-01', period_end: '2027-03-31', months: 6 })
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeInstallment({ period_month: '2026-10-01', schedule: deferred })] },
      { data: { bookkeeping_locked_through: null } },
      { data: [{ id: 'inst-1' }] },
      { count: 5 },
    ])

    await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-10-15',
    })

    expect(mockCreateJournalEntry.mock.calls[0][3].entry_date).toBe('2026-10-15')
    expect(mockCreateJournalEntry.mock.calls[0][3].lines).toEqual([
      expect.objectContaining({ account_number: '2970', debit_amount: 1000 }),
      expect.objectContaining({ account_number: '3001', credit_amount: 1000 }),
    ])
  })
})

describe('upplupen kostnad (expense schedule on 29xx)', () => {
  // Electricity July-September on an invoice dated 2026-10-05.
  const accrued = (overrides: Record<string, unknown> = {}) =>
    makeSchedule({
      balance_account: '2990',
      target_account: '5020',
      total_amount: 3000,
      period_start: '2026-07-01',
      period_end: '2026-09-30',
      months: 3,
      posting_floor_date: '2026-10-05',
      description: 'El jul-sep',
      ...overrides,
    })

  it('posts every month on its last day with Dr cost / Cr 29xx, ignoring the invoice-date floor', async () => {
    const schedule = accrued()
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: [
          makeInstallment({ id: 'inst-jul', period_month: '2026-07-01', schedule }),
          makeInstallment({ id: 'inst-aug', period_month: '2026-08-01', schedule }),
          makeInstallment({ id: 'inst-sep', period_month: '2026-09-01', schedule }),
        ],
      },
      { data: { bookkeeping_locked_through: null } },
      { data: [{ id: 'inst-jul' }] },
      { data: [{ id: 'inst-aug' }] },
      { data: [{ id: 'inst-sep' }] },
      { count: 0 },
      { data: null },
    ])

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-10-05',
    })

    expect(result).toMatchObject({ posted: 3, failed: 0 })
    const dates = mockCreateJournalEntry.mock.calls.map((call) => call[3].entry_date)
    expect(dates).toEqual(['2026-07-31', '2026-08-31', '2026-09-30'])
    // Each month's own fiscal period is looked up for its own date.
    expect(mockFindFiscalPeriod.mock.calls.map((call) => call[2])).toEqual([
      '2026-07-31',
      '2026-08-31',
      '2026-09-30',
    ])
    const sep = mockCreateJournalEntry.mock.calls[2][3]
    expect(sep.source_type).toBe('accrual')
    // No moms on the accrual: VAT stays on the invoice date.
    expect(sep.lines).toEqual([
      expect.objectContaining({ account_number: '5020', debit_amount: 1000, credit_amount: 0 }),
      expect.objectContaining({ account_number: '2990', debit_amount: 0, credit_amount: 1000 }),
    ])
  })

  it('books a December cost in the previous fiscal year (January invoice)', async () => {
    mockFindFiscalPeriod.mockResolvedValueOnce('fp-2025')
    const schedule = accrued({
      period_start: '2025-12-01',
      period_end: '2025-12-31',
      months: 1,
      posting_floor_date: '2026-01-20',
    })
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeInstallment({ period_month: '2025-12-01', schedule })] },
      { data: { bookkeeping_locked_through: null } },
      { data: [{ id: 'inst-1' }] },
      { count: 0 },
      { data: null },
    ])

    await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-01-20',
    })

    const input = mockCreateJournalEntry.mock.calls[0][3]
    expect(input.entry_date).toBe('2025-12-31')
    expect(input.fiscal_period_id).toBe('fp-2025')
  })

  it('never moves a month behind the company lock date: it fails and stays pending', async () => {
    const schedule = accrued()
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeInstallment({ period_month: '2026-07-01', schedule })] },
      { data: { bookkeeping_locked_through: '2026-07-31' } },
      { data: null }, // last_error update
    ])

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-10-05',
    })

    expect(result).toMatchObject({ posted: 0, failed: 1 })
    expect(result.errors[0].message).toMatch(/2026-07-31/)
    expect(result.errors[0].message).toMatch(/flyttas inte/)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(findCall('accrual_schedule_installments', 'update')?.[0]).toMatchObject({
      last_error: expect.stringMatching(/låsdatum/),
    })
  })

  it('never clamps into the next open year when its own year is closed or missing', async () => {
    mockFindFiscalPeriod.mockResolvedValueOnce(null)
    const schedule = accrued()
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeInstallment({ period_month: '2026-09-01', schedule })] },
      { data: { bookkeeping_locked_through: null } },
      { data: null }, // last_error update (no next-open-period lookup)
    ])

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-10-05',
    })

    expect(result).toMatchObject({ posted: 0, failed: 1 })
    expect(result.errors[0].message).toMatch(/inget öppet räkenskapsår täcker datumet/)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('keeps a 17xx schedule on the invoice-date floor (unchanged)', async () => {
    const prepaid = makeSchedule({ balance_account: '1790', posting_floor_date: '2026-10-05' })
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeInstallment({ period_month: '2026-10-01', schedule: prepaid })] },
      { data: { bookkeeping_locked_through: null } },
      { data: [{ id: 'inst-1' }] },
      { count: 1 },
    ])

    await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-10-05',
    })

    expect(mockCreateJournalEntry.mock.calls[0][3].entry_date).toBe('2026-10-05')
  })

  it('a credit note cancels the schedule and stornoes its posted months on the credit date', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [accrued()] },
      { data: null }, // pending -> cancelled
      {
        data: ['jul', 'aug', 'sep'].map((month) => ({
          id: `inst-${month}`,
          journal_entry_id: `je-${month}`,
          journal_entry: { fiscal_period: { period_start: '2026-01-01', period_end: '2026-12-31' } },
        })),
      },
      { data: null }, // schedule -> cancelled
    ])

    const result = await cancelSchedulesForSource(
      supabase as unknown as SupabaseClient,
      COMPANY,
      USER,
      { supplierInvoiceId: 'si-1' },
      { reversalDate: '2026-11-02' },
    )

    expect(result).toEqual({ cancelledSchedules: 1, reversedEntries: 3, failedReversals: 0 })
    for (const month of ['jul', 'aug', 'sep']) {
      expect(mockReverseEntry).toHaveBeenCalledWith(expect.anything(), COMPANY, USER, `je-${month}`, '2026-11-02')
    }
  })
})

// Ändra periodisering: the months not yet posted, re-planned.
describe('replanRemainingInstallments', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
  const ctxOf = (supabase: unknown): OperationContext => ({
    supabase: supabase as OperationContext['supabase'],
    companyId: COMPANY,
    userId: USER,
    log: log as unknown as OperationContext['log'],
  })
  // 12 000 over 2026, January posted, February to December pending.
  const months = (postedThrough: number, statusOf: (i: number) => string = (i) => (i < postedThrough ? 'posted' : 'pending')) =>
    Array.from({ length: 12 }, (_, i) => ({
      period_month: `2026-${String(i + 1).padStart(2, '0')}-01`,
      amount: 1000,
      status: statusOf(i),
    }))
  const scheduleWith = (overrides: Record<string, unknown> = {}) =>
    makeSchedule({ release_day: null, installments: months(1), ...overrides })

  it('dry run: answers the months before and after on the new release day and writes nothing', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: scheduleWith() },
      { data: { bookkeeping_locked_through: null } },
    ])

    const outcome = await replanRemainingInstallments(ctxOf(supabase), 'sched-1', { releaseDay: 14 }, { dryRun: true })

    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    const preview = outcome.preview as {
      before: Array<{ period_month: string; booking_date: string }>
      after: Array<{ period_month: string; amount: number; booking_date: string }>
      remaining_amount: number
      release_day_after: number | null
    }
    expect(preview.remaining_amount).toBe(11000)
    expect(preview.release_day_after).toBe(14)
    expect(preview.before[0]).toMatchObject({ period_month: '2026-02-01', booking_date: '2026-02-01' })
    expect(preview.after).toHaveLength(11)
    expect(preview.after[0]).toEqual({ period_month: '2026-02-01', amount: 1000, booking_date: '2026-02-14' })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('commits a new end through the replan RPC, then books the months already due', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: scheduleWith() },
      { data: { bookkeeping_locked_through: null } },
      { data: { months: 6, pending_months: 5 } }, // replan_accrual_installments
      { data: [] }, // catch-up: nothing due
    ])

    const outcome = await replanRemainingInstallments(ctxOf(supabase), 'sched-1', { periodEnd: '2026-06-30' }, { today: '2026-01-20' })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok || outcome.dryRun) return
    expect(outcome.data.posted_now).toBe(0)
    expect(supabase.rpc).toHaveBeenCalledWith('replan_accrual_installments', {
      p_company_id: COMPANY,
      p_schedule_id: 'sched-1',
      p_user_id: USER,
      p_period_end: '2026-06-30',
      p_release_day: null,
      p_installments: ['02', '03', '04', '05', '06'].map((m) => ({ period_month: `2026-${m}-01`, amount: 2200 })),
    })
  })

  it('answers a conflict when the RPC finds the plan changed underneath', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: scheduleWith() },
      { data: { bookkeeping_locked_through: null } },
      { error: { code: 'P0001', message: 'ACCRUAL_REPLAN_CONFLICT: the months no longer cover the period once' } },
    ])

    const outcome = await replanRemainingInstallments(ctxOf(supabase), 'sched-1', { releaseDay: 14 })

    expect(outcome).toEqual({ ok: false, code: 'ACCRUAL_REPLAN_CONFLICT' })
  })

  it.each([
    ['a missing schedule', { data: null }, {}, 'ACCRUAL_NOT_FOUND', undefined],
    ['a completed schedule', { data: scheduleWith({ status: 'completed' }) }, { releaseDay: 14 }, 'ACCRUAL_NOT_ACTIVE', undefined],
    [
      'an upplupen kostnad (29xx expense)',
      { data: scheduleWith({ balance_account: '2990' }) },
      { releaseDay: 14 },
      'ACCRUAL_REPLAN_INVALID',
      'accrued_cost',
    ],
    ['nothing pending', { data: scheduleWith({ installments: months(12) }) }, { releaseDay: 14 }, 'ACCRUAL_REPLAN_INVALID', 'nothing_pending'],
    ['no change', { data: scheduleWith() }, { periodEnd: '2026-12-31', releaseDay: null }, 'ACCRUAL_REPLAN_INVALID', 'no_change'],
    [
      'an end before a posted month',
      { data: scheduleWith({ installments: months(3) }) },
      { periodEnd: '2026-02-28' },
      'ACCRUAL_REPLAN_INVALID',
      'end_before_posted',
    ],
    [
      'an end that leaves no unposted month',
      { data: scheduleWith({ installments: months(3) }) },
      { periodEnd: '2026-03-31' },
      'ACCRUAL_REPLAN_INVALID',
      'no_month_left',
    ],
    [
      'a credit still settling (cancelled months)',
      { data: scheduleWith({ installments: months(1, (i) => (i === 0 ? 'posted' : 'cancelled')) }) },
      { releaseDay: 14 },
      'ACCRUAL_REPLAN_INVALID',
      'cancelled_months',
    ],
  ])('refuses %s', async (_label, row, input, code, reason) => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([row, { data: { bookkeeping_locked_through: null } }])

    const outcome = await replanRemainingInstallments(ctxOf(supabase), 'sched-1', input, { dryRun: true })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe(code)
    if (reason) expect(outcome.details).toEqual({ reason })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})

describe('release day', () => {
  it('a deferral month falls due on its release day, an upplupen kostnad on the first', () => {
    expect(installmentDueDate({ direction: 'expense', balance_account: '1790', release_day: 14 }, '2026-02-01')).toBe('2026-02-14')
    expect(installmentDueDate({ direction: 'expense', balance_account: '1790', release_day: null }, '2026-02-01')).toBe('2026-02-01')
    expect(installmentDueDate({ direction: 'revenue', balance_account: '2970', release_day: 31 }, '2026-02-01')).toBe('2026-02-28')
    expect(installmentDueDate({ direction: 'expense', balance_account: '2990', release_day: null }, '2026-02-01')).toBe('2026-02-01')
  })

  it('waits for the release day before posting a month', async () => {
    const schedule = makeSchedule({ release_day: 14, posting_floor_date: '2026-01-15' })
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: [makeInstallment({ period_month: '2026-02-01', schedule })] }])

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-02-10',
    })

    expect(result).toMatchObject({ posted: 0, failed: 0 })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('posts the month on its release day once the day has come', async () => {
    const schedule = makeSchedule({ release_day: 14, posting_floor_date: '2026-01-15' })
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makeInstallment({ period_month: '2026-02-01', schedule })] },
      { data: { bookkeeping_locked_through: null } },
      { data: [{ id: 'inst-1' }] }, // CAS claim
      { count: 3 }, // pending months left
    ])

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-02-20',
    })

    expect(result).toMatchObject({ posted: 1, failed: 0 })
    expect(mockCreateJournalEntry.mock.calls[0][3].entry_date).toBe('2026-02-14')
  })
})
