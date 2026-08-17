import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PayrollConfig } from '@/lib/salary/payroll-config'
import type { MileageTrip } from '@/types'

vi.mock('@/lib/supabase/fetch-all', () => ({ fetchAllRows: vi.fn() }))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bookkeeping/engine')>()
  return { ...actual, createJournalEntry: vi.fn() }
})
vi.mock('@/lib/salary/payroll-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/salary/payroll-config')>()
  return { ...actual, loadPayrollConfig: vi.fn() }
})
vi.mock('@/lib/core/bookkeeping/period-service', () => ({
  resolvePeriodStatusForDate: vi.fn(),
}))

import {
  bookMileagePeriod,
  createTrip,
  pushMileageToSalaryRun,
  ratePerMil,
  summarizeTrips,
} from '@/lib/mileage/mileage-service'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { loadPayrollConfig } from '@/lib/salary/payroll-config'
import { resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'

const CONFIG = {
  milersattningEgenBil: 25,
  milersattningFormansbilFossil: 12,
  milersattningFormansbilEl: 9.5,
} as PayrollConfig

function trip(overrides: Partial<MileageTrip>): MileageTrip {
  return {
    id: 'trip-1',
    company_id: 'company-1',
    user_id: 'user-1',
    employee_id: null,
    trip_date: '2026-05-10',
    vehicle_type: 'own_car',
    vehicle_registration: null,
    odometer_start: null,
    odometer_end: null,
    distance_km: 100,
    from_location: 'Kontoret',
    to_location: 'Kunden',
    purpose: 'Kundbesök',
    visited: null,
    is_round_trip: false,
    status: 'draft',
    journal_entry_id: null,
    salary_run_id: null,
    notes: null,
    created_via: 'manual',
    created_at: '2026-05-10T00:00:00Z',
    updated_at: '2026-05-10T00:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ratePerMil', () => {
  it('maps every vehicle type to its config rate', () => {
    expect(ratePerMil(CONFIG, 'own_car')).toBe(25)
    expect(ratePerMil(CONFIG, 'company_car_fossil')).toBe(12)
    expect(ratePerMil(CONFIG, 'company_car_electric')).toBe(9.5)
  })
})

describe('summarizeTrips', () => {
  it('converts km to mil and applies the schablon rate', () => {
    const [summary] = summarizeTrips([trip({ distance_km: 100 })], CONFIG)
    expect(summary).toMatchObject({
      vehicle_type: 'own_car',
      trip_count: 1,
      total_km: 100,
      total_mil: 10,
      rate_per_mil: 25,
      amount: 250,
    })
  })

  it('keeps öre precision without drift (32.3 km → 80.75 kr)', () => {
    const [summary] = summarizeTrips([trip({ distance_km: 32.3 })], CONFIG)
    expect(summary.total_mil).toBe(3.23)
    expect(summary.amount).toBe(80.75)
  })

  it('groups by vehicle type and sums per group', () => {
    const summaries = summarizeTrips(
      [
        trip({ distance_km: 40 }),
        trip({ distance_km: 60 }),
        trip({ distance_km: 50, vehicle_type: 'company_car_electric' }),
      ],
      CONFIG
    )
    expect(summaries).toHaveLength(2)
    const own = summaries.find((s) => s.vehicle_type === 'own_car')
    const el = summaries.find((s) => s.vehicle_type === 'company_car_electric')
    expect(own).toMatchObject({ trip_count: 2, total_km: 100, amount: 250 })
    expect(el).toMatchObject({ trip_count: 1, total_km: 50, amount: 47.5 })
  })

  it('tolerates numeric-as-string distances from Postgres', () => {
    const [summary] = summarizeTrips(
      [trip({ distance_km: '12.5' as unknown as number })],
      CONFIG
    )
    expect(summary.total_km).toBe(12.5)
    expect(summary.amount).toBe(31.25)
  })
})

describe('createTrip', () => {
  it('rejects a förmånsbil trip without vehicle_registration before any write', async () => {
    const supabase = { from: vi.fn() }
    await expect(
      createTrip(supabase as never, 'company-1', 'user-1', {
        trip_date: '2026-05-10',
        vehicle_type: 'company_car_electric',
        distance_km: 10,
        from_location: 'A',
        to_location: 'B',
        purpose: 'Kundbesök',
      })
    ).rejects.toThrow(/registreringsnummer/)
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('pushMileageToSalaryRun', () => {
  const params = {
    runId: 'run-1',
    employeeId: 'emp-1',
    from: '2026-05-01',
    to: '2026-05-31',
  }

  function salarySupabase(opts: {
    run?: { id: string; status: string } | null
    sre?: { id: string } | null
    claimIds?: string[]
    itemError?: { message: string } | null
  }) {
    const insert = vi.fn(() => Promise.resolve({ error: opts.itemError ?? null }))
    const tripChain: Record<string, unknown> = {}
    for (const method of ['update', 'eq', 'in', 'is']) {
      tripChain[method] = vi.fn(() => tripChain)
    }
    tripChain.select = vi.fn(() =>
      Promise.resolve({ data: (opts.claimIds ?? []).map((id) => ({ id })), error: null })
    )
    tripChain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(resolve)

    const singleChain = (row: unknown) => {
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'eq']) {
        chain[method] = vi.fn(() => chain)
      }
      chain.single = vi.fn(() => Promise.resolve({ data: row, error: row ? null : {} }))
      return chain
    }

    return {
      from: vi.fn((table: string) => {
        if (table === 'salary_runs') return singleChain(opts.run ?? null)
        if (table === 'salary_run_employees') return singleChain(opts.sre ?? null)
        if (table === 'salary_line_items') return { insert }
        return tripChain
      }),
      insert,
      tripChain,
    }
  }

  it('maps missing run / wrong status / missing employee to their codes', async () => {
    const missingRun = salarySupabase({ run: null })
    expect(
      await pushMileageToSalaryRun(missingRun as never, 'company-1', params)
    ).toEqual({ ok: false, code: 'RUN_NOT_FOUND' })

    const bookedRun = salarySupabase({ run: { id: 'run-1', status: 'booked' } })
    expect(
      await pushMileageToSalaryRun(bookedRun as never, 'company-1', params)
    ).toEqual({ ok: false, code: 'RUN_NOT_EDITABLE' })

    const noSre = salarySupabase({ run: { id: 'run-1', status: 'draft' }, sre: null })
    expect(
      await pushMileageToSalaryRun(noSre as never, 'company-1', params)
    ).toEqual({ ok: false, code: 'EMPLOYEE_NOT_IN_RUN' })
  })

  it('claims trips BEFORE inserting line items and inserts kostnadsersättning flags', async () => {
    vi.mocked(fetchAllRows).mockResolvedValue([
      trip({ id: 't1', employee_id: 'emp-1', distance_km: 100 }),
    ])
    vi.mocked(loadPayrollConfig).mockResolvedValue(CONFIG)
    const supabase = salarySupabase({
      run: { id: 'run-1', status: 'draft' },
      sre: { id: 'sre-1' },
      claimIds: ['t1'],
    })

    const result = await pushMileageToSalaryRun(supabase as never, 'company-1', params)
    expect(result).toMatchObject({ ok: true, tripCount: 1, totalAmount: 250 })
    const item = (supabase.insert.mock.calls[0] as unknown[][])[0][0]
    expect(item).toMatchObject({
      item_type: 'mileage_taxfree',
      amount: 250,
      is_taxable: false,
      is_avgift_basis: false,
      is_vacation_basis: false,
      account_number: '7331',
    })
    // The claim ran before the insert (retry cannot double-pay).
    const claimOrder = (supabase.tripChain.update as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]
    const insertOrder = supabase.insert.mock.invocationCallOrder[0]
    expect(claimOrder).toBeLessThan(insertOrder)
  })

  it('returns CLAIM_LOST and reverts when another booking claimed first', async () => {
    vi.mocked(fetchAllRows).mockResolvedValue([
      trip({ id: 't1', employee_id: 'emp-1' }),
      trip({ id: 't2', employee_id: 'emp-1' }),
    ])
    vi.mocked(loadPayrollConfig).mockResolvedValue(CONFIG)
    const supabase = salarySupabase({
      run: { id: 'run-1', status: 'draft' },
      sre: { id: 'sre-1' },
      claimIds: ['t1'],
    })
    const result = await pushMileageToSalaryRun(supabase as never, 'company-1', params)
    expect(result).toEqual({ ok: false, code: 'CLAIM_LOST' })
    expect(supabase.insert).not.toHaveBeenCalled()
    // The partial claim was reverted, not left dangling.
    expect(supabase.tripChain.update).toHaveBeenCalledWith({
      status: 'draft',
      salary_run_id: null,
    })
  })

  it('reverts the claim when the line item insert fails', async () => {
    vi.mocked(fetchAllRows).mockResolvedValue([trip({ id: 't1', employee_id: 'emp-1' })])
    vi.mocked(loadPayrollConfig).mockResolvedValue(CONFIG)
    const supabase = salarySupabase({
      run: { id: 'run-1', status: 'draft' },
      sre: { id: 'sre-1' },
      claimIds: ['t1'],
      itemError: { message: 'insert failed' },
    })
    await expect(
      pushMileageToSalaryRun(supabase as never, 'company-1', params)
    ).rejects.toThrow('insert failed')
    expect(supabase.tripChain.update).toHaveBeenCalledWith({ status: 'draft', salary_run_id: null })
  })
})

describe('bookMileagePeriod', () => {
  const params = {
    from: '2026-05-01',
    to: '2026-05-31',
    entryDate: '2026-05-31',
    counterAccount: '2820' as const,
  }

  // Queued mock: each .select() call consumes the next result (claim first,
  // then the journal_entry_id link). The orphan sweep and revert paths await
  // the chain without .select(), so the chain itself is thenable.
  function stampSupabase(selectResults: string[][]) {
    const queue = [...selectResults]
    const chain: Record<string, unknown> = {}
    for (const method of ['update', 'eq', 'in', 'is', 'lt', 'gte', 'lte', 'maybeSingle']) {
      chain[method] = vi.fn(() => chain)
    }
    chain.select = vi.fn(() => {
      const ids = queue.shift() ?? []
      return Promise.resolve({ data: ids.map((id) => ({ id })), error: null })
    })
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(resolve)
    return { from: vi.fn(() => chain), chain }
  }

  it('returns NO_TRIPS when the period has no drafts', async () => {
    vi.mocked(fetchAllRows).mockResolvedValue([])
    const result = await bookMileagePeriod(
      stampSupabase([]) as never,
      'company-1',
      'user-1',
      params
    )
    expect(result).toEqual({ ok: false, code: 'NO_TRIPS' })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('loses a concurrent race cleanly: partial claim reverts as CLAIM_LOST', async () => {
    vi.mocked(fetchAllRows).mockResolvedValue([trip({ id: 't1' }), trip({ id: 't2' })])
    vi.mocked(resolvePeriodStatusForDate).mockResolvedValue({
      status: 'open',
      period_id: 'period-1',
    } as never)
    vi.mocked(loadPayrollConfig).mockResolvedValue(CONFIG)

    // Another booking claimed t2 first: our claim only gets t1.
    const supabase = stampSupabase([['t1']])
    const result = await bookMileagePeriod(supabase as never, 'company-1', 'user-1', params)
    expect(result).toEqual({ ok: false, code: 'CLAIM_LOST' })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('fails as TRIPS_CHANGED when the staged trip set drifted before approval', async () => {
    vi.mocked(fetchAllRows).mockResolvedValue([trip({ id: 't1' }), trip({ id: 't3' })])
    const supabase = stampSupabase([])
    const result = await bookMileagePeriod(supabase as never, 'company-1', 'user-1', {
      ...params,
      expectedTripIds: ['t1', 't2'],
    })
    expect(result).toEqual({ ok: false, code: 'TRIPS_CHANGED' })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('rejects a period spanning calendar years', async () => {
    const supabase = stampSupabase([])
    await expect(
      bookMileagePeriod(supabase as never, 'company-1', 'user-1', {
        ...params,
        from: '2025-12-20',
        to: '2026-01-10',
      })
    ).rejects.toThrow(/kalenderår/)
  })

  it('refuses a period spanning several employees (BFL motpart)', async () => {
    vi.mocked(fetchAllRows).mockResolvedValue([
      trip({ id: 't1', employee_id: 'emp-1' }),
      trip({ id: 't2', employee_id: null }),
    ])
    const result = await bookMileagePeriod(
      stampSupabase([]) as never,
      'company-1',
      'user-1',
      params
    )
    expect(result).toEqual({ ok: false, code: 'MIXED_EMPLOYEES' })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('returns PERIOD_NOT_OPEN without writing when the entry date is locked', async () => {
    vi.mocked(fetchAllRows).mockResolvedValue([trip({})])
    vi.mocked(resolvePeriodStatusForDate).mockResolvedValue({
      status: 'locked',
      period_id: 'p1',
    } as never)
    const result = await bookMileagePeriod(
      stampSupabase([]) as never,
      'company-1',
      'user-1',
      params
    )
    expect(result).toEqual({ ok: false, code: 'PERIOD_NOT_OPEN' })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('books one balanced verifikat and stamps the trips', async () => {
    const trips = [
      trip({ id: 't1', distance_km: 100 }),
      trip({ id: 't2', distance_km: 50, vehicle_type: 'company_car_electric' }),
    ]
    vi.mocked(fetchAllRows).mockResolvedValue(trips)
    vi.mocked(resolvePeriodStatusForDate).mockResolvedValue({
      status: 'open',
      period_id: 'period-1',
    } as never)
    vi.mocked(loadPayrollConfig).mockResolvedValue(CONFIG)
    vi.mocked(createJournalEntry).mockResolvedValue({
      id: 'je-1',
      voucher_number: 42,
      voucher_series: 'A',
    } as never)

    const supabase = stampSupabase([['t1', 't2'], ['t1', 't2']])
    const result = await bookMileagePeriod(supabase as never, 'company-1', 'user-1', params)

    expect(result).toMatchObject({
      ok: true,
      journalEntryId: 'je-1',
      voucherNumber: 42,
      tripCount: 2,
      totalAmount: 297.5,
    })

    const input = vi.mocked(createJournalEntry).mock.calls[0][3]
    expect(input.fiscal_period_id).toBe('period-1')
    expect(input.source_type).toBe('manual')
    const debits = input.lines.filter((l) => l.debit_amount > 0)
    const credit = input.lines.find((l) => l.credit_amount > 0)
    expect(debits).toHaveLength(2)
    expect(debits.every((l) => l.account_number === '7331')).toBe(true)
    expect(credit?.account_number).toBe('2820')
    const totalDebit = debits.reduce((sum, l) => sum + l.debit_amount, 0)
    expect(Math.round(totalDebit * 100) / 100).toBe(credit?.credit_amount)
  })

  it('surfaces STAMP_FAILED with the entry id when the entry link mismatches', async () => {
    vi.mocked(fetchAllRows).mockResolvedValue([
      trip({ id: 't1' }),
      trip({ id: 't2' }),
    ])
    vi.mocked(resolvePeriodStatusForDate).mockResolvedValue({
      status: 'open',
      period_id: 'period-1',
    } as never)
    vi.mocked(loadPayrollConfig).mockResolvedValue(CONFIG)
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-1' } as never)

    // Claim succeeds for both trips; the journal_entry_id backfill only lands
    // on one row.
    const supabase = stampSupabase([['t1', 't2'], ['t1']])
    const result = await bookMileagePeriod(supabase as never, 'company-1', 'user-1', params)
    expect(result).toEqual({ ok: false, code: 'STAMP_FAILED', journalEntryId: 'je-1' })
  })

  it('reverts the claim when verifikat creation fails', async () => {
    vi.mocked(fetchAllRows).mockResolvedValue([trip({ id: 't1' })])
    vi.mocked(resolvePeriodStatusForDate).mockResolvedValue({
      status: 'open',
      period_id: 'period-1',
    } as never)
    vi.mocked(loadPayrollConfig).mockResolvedValue(CONFIG)
    vi.mocked(createJournalEntry).mockRejectedValue(new Error('period locked'))

    const supabase = stampSupabase([['t1']])
    await expect(
      bookMileagePeriod(supabase as never, 'company-1', 'user-1', params)
    ).rejects.toThrow('period locked')
    // Claim + revert both went through the update chain.
    expect(supabase.chain.update).toHaveBeenCalledWith({ status: 'booked' })
    expect(supabase.chain.update).toHaveBeenCalledWith({ status: 'draft' })
  })
})
