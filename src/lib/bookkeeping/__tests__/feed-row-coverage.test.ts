import { beforeEach, describe, expect, it, vi } from 'vitest'

const covered = vi.hoisted(() => vi.fn())
vi.mock('@/lib/bookkeeping/ledger-coverage', () => ({ ledgerCoveredThrough: covered }))

import { firstCoveredFeedRow, isFeedConnectorRow } from '../feed-row-coverage'

const supabase = {} as never
const ledgerOf = (accounts: Record<string, string>) => (id: string) => accounts[id]

beforeEach(() => {
  covered.mockReset()
})

describe('isFeedConnectorRow', () => {
  it('is a Stripe row, never a bank, bank-file or manual row', () => {
    expect(isFeedConnectorRow({ import_source: 'stripe' })).toBe(true)
    for (const import_source of [null, undefined, 'camt053', 'csv_seb', 'enable_banking', 'manual']) {
      expect(isFeedConnectorRow({ import_source })).toBe(false)
    }
  })
})

describe('firstCoveredFeedRow', () => {
  it('reads once per settlement account from the earliest feed row and returns the first covered row', async () => {
    covered.mockResolvedValue('2026-10-15')
    const result = await firstCoveredFeedRow(
      supabase,
      'company-1',
      [
        { id: 'late', date: '2026-10-20', import_source: 'stripe' },
        { id: 'early', date: '2026-10-10', import_source: 'stripe' },
        { id: 'bank', date: '2026-10-01', import_source: null },
      ],
      ledgerOf({ late: '1686', early: '1686', bank: '1930' }),
    )
    expect(result).toEqual({ transactionId: 'early', settlementAccount: '1686', coveredThrough: '2026-10-15' })
    expect(covered).toHaveBeenCalledTimes(1)
    expect(covered).toHaveBeenCalledWith(supabase, 'company-1', ['1686'], '2026-10-10')
  })

  it('lets a feed row after the covered day through', async () => {
    covered.mockResolvedValue('2026-10-15')
    const result = await firstCoveredFeedRow(
      supabase,
      'company-1',
      [{ id: 'late', date: '2026-10-20T00:00:00Z', import_source: 'stripe' }],
      ledgerOf({ late: '1686' }),
    )
    expect(result).toBeNull()
  })

  it('answers null without reading when nothing is covered or no row is a feed row', async () => {
    covered.mockResolvedValue(null)
    expect(
      await firstCoveredFeedRow(supabase, 'company-1', [{ id: 'a', date: '2026-10-01', import_source: 'stripe' }], ledgerOf({ a: '1686' })),
    ).toBeNull()
    covered.mockReset()
    expect(
      await firstCoveredFeedRow(supabase, 'company-1', [{ id: 'b', date: '2026-10-01', import_source: null }], ledgerOf({ b: '1930' })),
    ).toBeNull()
    expect(covered).not.toHaveBeenCalled()
  })
})
