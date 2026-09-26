/**
 * gnubok_get_income_statement returns the statutory nettoomsättning and the
 * account definitions behind every figure, so an agent asked "what is our
 * revenue" answers with the same figure as the årsredovisning.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import type { TrialBalanceRow } from '@/types'
import { tools } from '../server'

vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: vi.fn() }))

const incomeStatement = tools.find((t) => t.name === 'gnubok_get_income_statement')!
const mockTrialBalance = vi.mocked(generateTrialBalance)

function row(account_number: string, account_class: number, credit: number, debit = 0): TrialBalanceRow {
  return {
    account_number,
    account_name: account_number,
    account_class,
    opening_debit: 0,
    opening_credit: 0,
    period_debit: debit,
    period_credit: credit,
    closing_debit: debit,
    closing_credit: credit,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('gnubok_get_income_statement: statutory figures', () => {
  it('returns nettoomsattning, rorelseresultat and definitions', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'fp-1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' },
      error: null,
    })
    mockTrialBalance.mockResolvedValue({
      rows: [row('3001', 3, 1000), row('3990', 3, 200), row('5010', 5, 0, 300)],
      totalDebit: 300,
      totalCredit: 1200,
      isBalanced: false,
    })

    const result = (await incomeStatement.execute(
      { period_id: 'fp-1' },
      'company-1',
      'user-1',
      supabase as never,
    )) as Record<string, unknown> & {
      definitions: Record<string, { accounts: string }>
    }

    expect(result.nettoomsattning).toBe(1000)
    expect(result.ovriga_rorelseintakter).toBe(200)
    expect(result.total_revenue).toBe(1200)
    expect(result.rorelseresultat).toBe(900)
    expect(result.definitions.nettoomsattning.accounts).toBe('3000-3799')

    const props = (incomeStatement.outputSchema as { properties: Record<string, unknown> }).properties
    expect(props).toHaveProperty('nettoomsattning')
    expect(incomeStatement.description).toMatch(/nettoomsattning \(3000-3799\)/)
  })
})
