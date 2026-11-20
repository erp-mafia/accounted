import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/posting/port', () => ({ postingPort: { postJournalEntry: vi.fn() } }))

import { postingPort } from '@/lib/posting/port'
import { FinanceLeaseError, bookFinanceLeaseYear, type FinanceLeaseRow } from '../register'

const lease = (overrides: Partial<FinanceLeaseRow> = {}): FinanceLeaseRow => ({
  id: 'lease-1',
  company_id: 'company-1',
  name: 'Grävmaskin',
  start_date: '2026-01-01',
  fair_value: '100000.00',
  payment: '40000.00',
  number_of_payments: 3,
  periods_per_year: 1,
  payments_in_advance: false,
  guaranteed_residual: '0',
  annual_rate_percent: '10',
  direct_costs: '0',
  useful_life_months: 60,
  ownership_transfers: false,
  asset_account: '1227',
  accumulated_depreciation_account: '1229',
  liability_account: '2399',
  lease_cost_account: '5220',
  interest_account: '8419',
  accrued_interest_account: '2960',
  depreciation_account: '7836',
  direct_cost_account: null,
  initial_entry_id: null,
  ...overrides,
})

const PERIOD = { id: 'period-1', period_start: '2026-01-01', period_end: '2026-12-31' }

let mock: ReturnType<typeof createQueuedMockSupabase>

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  let n = 0
  vi.mocked(postingPort.postJournalEntry).mockImplementation(async () => ({ id: `entry-${++n}` }) as never)
})

const book = () => bookFinanceLeaseYear(mock.supabase as never, 'company-1', 'user-1', 'period-1')

describe('bookFinanceLeaseYear', () => {
  it('is refused while the company keeps the 20.29 relief', async () => {
    mock.enqueue({ data: { finance_lease_capitalisation: false } })
    await expect(book()).rejects.toMatchObject({ code: 'FINANCE_LEASE_NOT_ENABLED' })
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })

  it('is refused for a financial year outside the company', async () => {
    mock.enqueueMany([{ data: { finance_lease_capitalisation: true } }, { data: null }])
    await expect(book()).rejects.toMatchObject({ code: 'FINANCE_LEASE_NO_PERIOD' })
  })

  it('never books a year twice', async () => {
    mock.enqueueMany([{ data: { finance_lease_capitalisation: true } }, { data: PERIOD }, { data: { id: 'posting-1' } }])
    await expect(book()).rejects.toMatchObject({ code: 'FINANCE_LEASE_YEAR_ALREADY_POSTED' })
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses a lease that began in an earlier year whose start is not booked', async () => {
    mock.enqueueMany([
      { data: { finance_lease_capitalisation: true } },
      { data: { ...PERIOD, period_start: '2027-01-01', period_end: '2027-12-31' } },
      { data: null },
      { data: [lease()] },
    ])
    const error = await book().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FinanceLeaseError)
    expect(error).toMatchObject({ code: 'FINANCE_LEASE_START_NOT_BOOKED', details: { leases: ['Grävmaskin'] } })
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })

  it('books the start of a new lease, then the year-end adjustment, then records the year', async () => {
    mock.enqueueMany([
      { data: { finance_lease_capitalisation: true } },
      { data: PERIOD },
      { data: null },
      { data: [lease(), lease({ id: 'lease-2', name: 'Senare', start_date: '2027-03-01' })] },
      { data: null }, // finance_leases update (initial_entry_id)
      { data: null }, // finance_lease_postings insert
    ])
    const result = await book()
    expect(result.initialEntries.map((e) => e.id)).toEqual(['entry-1'])
    expect(result.yearEndEntry).toEqual({ id: 'entry-2' })

    const [start, yearEnd] = vi.mocked(postingPort.postJournalEntry).mock.calls.map((c) => c[0])
    expect(start.input).toMatchObject({ entry_date: '2026-01-01', source_type: 'system', fiscal_period_id: 'period-1' })
    expect(start.input.lines).toEqual([
      expect.objectContaining({ account_number: '1227', debit_amount: 99_474.08, credit_amount: 0 }),
      expect.objectContaining({ account_number: '2399', debit_amount: 0, credit_amount: 99_474.08 }),
    ])
    expect(yearEnd.input).toMatchObject({ entry_date: '2026-12-31', source_type: 'year_end' })
    for (const call of [start, yearEnd]) {
      const net = call.input.lines.reduce((sum, l) => sum + l.debit_amount - l.credit_amount, 0)
      expect(Math.abs(net)).toBeLessThan(0.005)
    }

    expect(mock.findCall('finance_leases', 'update')).toEqual([{ initial_entry_id: 'entry-1' }])
    expect(mock.findCall('finance_lease_postings', 'insert')).toEqual([
      { company_id: 'company-1', fiscal_period_id: 'period-1', journal_entry_id: 'entry-2' },
    ])
  })

  it('skips the start of a lease already booked', async () => {
    mock.enqueueMany([
      { data: { finance_lease_capitalisation: true } },
      { data: { ...PERIOD, period_start: '2027-01-01', period_end: '2027-12-31' } },
      { data: null },
      { data: [lease({ initial_entry_id: 'entry-0' })] },
      { data: null }, // finance_lease_postings insert
    ])
    const result = await book()
    expect(result.initialEntries).toEqual([])
    expect(postingPort.postJournalEntry).toHaveBeenCalledTimes(1)
    expect(vi.mocked(postingPort.postJournalEntry).mock.calls[0][0].input.source_type).toBe('year_end')
  })
})
