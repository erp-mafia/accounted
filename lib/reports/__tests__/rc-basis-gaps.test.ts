/**
 * Tests for findRcBasisGaps: per-voucher FK004 detection.
 *
 * Mocks the entry-lines fetch layer and resolvePeriodDates. The period must
 * resolve through resolvePeriodDates (not the calendar arithmetic) so yearly
 * (helårsmoms) worklists cover extended/broken räkenskapsår: a calendar span
 * hid gap vouchers that the declaration totals still included.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const resolvePeriodDatesMock = vi.fn()
vi.mock('../vat-declaration', () => ({
  resolvePeriodDates: (...args: unknown[]) => resolvePeriodDatesMock(...args),
}))

const fetchEntryLinesMock = vi.fn()
const fetchLinesByEntryIdsMock = vi.fn()
vi.mock('@/lib/bookkeeping/entry-lines', () => ({
  fetchEntryLines: (...args: unknown[]) => fetchEntryLinesMock(...args),
  fetchLinesByEntryIds: (...args: unknown[]) => fetchLinesByEntryIdsMock(...args),
}))

const fetchDynamicVatAccountsMock = vi.fn()
vi.mock('../vat-revenue-accounts', () => ({
  fetchDynamicVatAccounts: (...args: unknown[]) => fetchDynamicVatAccountsMock(...args),
}))

import { findRcBasisGaps } from '../rc-basis-gaps'

const supabase = {} as SupabaseClient

function rcLine(entryId: string, voucherNumber: number, credit: number) {
  return {
    journal_entry_id: entryId,
    account_number: '2614',
    debit_amount: 0,
    credit_amount: credit,
    journal_entries: {
      id: entryId,
      voucher_number: voucherNumber,
      voucher_series: 'A',
      entry_date: '2026-05-20',
      description: `Voucher ${voucherNumber}`,
    },
  }
}

describe('findRcBasisGaps', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolvePeriodDatesMock.mockResolvedValue({ start: '2025-07-17', end: '2026-12-31' })
    fetchEntryLinesMock.mockResolvedValue([])
    fetchLinesByEntryIdsMock.mockResolvedValue([])
    fetchDynamicVatAccountsMock.mockResolvedValue({
      explicitAccounts: new Set(),
      rcBasisRateByAccount: new Map(),
    })
  })

  it('resolves the period via resolvePeriodDates with the fiscal period id', async () => {
    await findRcBasisGaps(supabase, 'company-1', 'yearly', 2026, 1, { fiscalPeriodId: 'fp-1' })

    expect(resolvePeriodDatesMock).toHaveBeenCalledWith(
      supabase, 'company-1', 'yearly', 2026, 1, 'fp-1',
    )
  })

  it('filters entries on the resolved bounds, not the calendar year', async () => {
    await findRcBasisGaps(supabase, 'company-1', 'yearly', 2026, 1, { fiscalPeriodId: 'fp-1' })

    const { filterEntries } = fetchEntryLinesMock.mock.calls[0][0]
    const calls: Array<[string, ...unknown[]]> = []
    const q = new Proxy(
      {},
      {
        get:
          (_t, method: string) =>
          (...args: unknown[]) => {
            calls.push([method, ...args])
            return q
          },
      },
    )
    filterEntries(q)

    expect(calls).toContainEqual(['gte', 'entry_date', '2025-07-17'])
    expect(calls).toContainEqual(['lte', 'entry_date', '2026-12-31'])
  })

  it('flags vouchers whose RC output VAT lacks a matching basis pair', async () => {
    fetchEntryLinesMock.mockResolvedValue([
      rcLine('entry-1', 8, 527.29), // no basis lines at all
      rcLine('entry-2', 9, 250), // fully booked basis
    ])
    fetchLinesByEntryIdsMock.mockResolvedValue([
      {
        id: 'l-1',
        journal_entry_id: 'entry-2',
        account_number: '4535',
        debit_amount: 1000,
        credit_amount: 0,
      },
    ])

    const gaps = await findRcBasisGaps(supabase, 'company-1', 'monthly', 2026, 5)

    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({
      entryId: 'entry-1',
      voucherNumber: 8,
      rcOutputAccount: '2614',
      rcOutputAmount: 527.29,
      expectedBasisAmount: 2109.16,
      suggestedBasisAccount: '4535',
      rate: 0.25,
    })
  })

  it('flags a voucher whose basis is materially short of the expected amount', async () => {
    fetchEntryLinesMock.mockResolvedValue([rcLine('entry-1', 8, 2500)])
    fetchLinesByEntryIdsMock.mockResolvedValue([
      {
        id: 'l-1',
        journal_entry_id: 'entry-1',
        account_number: '4535',
        debit_amount: 4000, // expected 10000
        credit_amount: 0,
      },
    ])

    const gaps = await findRcBasisGaps(supabase, 'company-1', 'monthly', 2026, 5)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].expectedBasisAmount).toBe(10000)
  })

  it('accepts a custom EU purchase basis account at the matching rate', async () => {
    fetchDynamicVatAccountsMock.mockResolvedValue({
      explicitAccounts: new Set(['4056']),
      rcBasisRateByAccount: new Map([['4056', 0.25]]),
    })
    fetchEntryLinesMock.mockResolvedValue([rcLine('entry-1', 8, 250)])
    fetchLinesByEntryIdsMock.mockResolvedValue([{
      id: 'l-1', journal_entry_id: 'entry-1', account_number: '4056',
      debit_amount: 1000, credit_amount: 0,
    }])
    await expect(findRcBasisGaps(supabase, 'company-1', 'monthly', 2026, 5))
      .resolves.toEqual([])
  })

  it('does not let a 25 percent basis cover 12 percent output VAT', async () => {
    fetchEntryLinesMock.mockResolvedValue([{
      ...rcLine('entry-1', 8, 120),
      account_number: '2624',
    }])
    fetchLinesByEntryIdsMock.mockResolvedValue([{
      id: 'l-1', journal_entry_id: 'entry-1', account_number: '4535',
      debit_amount: 1000, credit_amount: 0,
    }])
    const gaps = await findRcBasisGaps(supabase, 'company-1', 'monthly', 2026, 5)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].rate).toBe(0.12)
  })
})
