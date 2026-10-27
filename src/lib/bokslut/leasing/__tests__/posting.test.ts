import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/posting/port', () => ({ postingPort: { postJournalEntry: vi.fn() } }))

import { postingPort } from '@/lib/posting/port'
import { bookFinanceLeasesYearEnd } from '../posting'
import type { FinanceLease, LeaseAccounts } from '../finance-lease'

const accounts: LeaseAccounts = {
  asset: '1227', accumulatedDepreciation: '1229', liability: '2399', accruedInterest: '2960',
  leaseCost: '5220', interest: '8419', depreciation: '7836',
}
const lease: FinanceLease = {
  id: 'l1', name: 'Grävmaskin', startDate: '2026-01-01', fairValue: 100_000, payment: 40_000,
  numberOfPayments: 3, periodsPerYear: 1, paymentsInAdvance: false, guaranteedResidual: 0,
  annualRatePercent: 10, directCosts: 0, usefulLifeMonths: 60, ownershipTransfers: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(postingPort.postJournalEntry).mockResolvedValue({ id: 'entry-1' } as never)
})

describe('bookFinanceLeasesYearEnd', () => {
  it('posts one balanced year_end verifikat on balansdagen through the posting port', async () => {
    const entry = await bookFinanceLeasesYearEnd({
      supabase: {} as never,
      companyId: 'company-1',
      userId: 'user-1',
      fiscalPeriodId: 'period-1',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      leases: [{ lease, accounts, openingAccruedInterest: 0 }],
    })
    expect(entry).toEqual({ id: 'entry-1' })
    const call = vi.mocked(postingPort.postJournalEntry).mock.calls[0][0]
    expect(call.input).toMatchObject({ entry_date: '2026-12-31', source_type: 'year_end', fiscal_period_id: 'period-1' })
    const total = call.input.lines.reduce((sum, l) => sum + l.debit_amount - l.credit_amount, 0)
    expect(Math.abs(total)).toBeLessThan(0.005)
    const event = typeof call.event === 'function' ? call.event() : call.event
    expect(event).toMatchObject({ kind: 'year_end.closing', occurredOn: '2026-12-31' })
  })

  it('books nothing for a year the leases do not touch', async () => {
    const entry = await bookFinanceLeasesYearEnd({
      supabase: {} as never,
      companyId: 'company-1',
      userId: 'user-1',
      fiscalPeriodId: 'period-1',
      periodStart: '2031-01-01',
      periodEnd: '2031-12-31',
      leases: [{ lease, accounts, openingAccruedInterest: 0 }],
    })
    expect(entry).toBeNull()
    expect(postingPort.postJournalEntry).not.toHaveBeenCalled()
  })
})
