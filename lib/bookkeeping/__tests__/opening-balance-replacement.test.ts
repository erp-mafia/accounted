import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events'
import { replaceOpeningBalanceEntry } from '../engine'
import {
  AccountsNotInChartError,
  BookkeepingDatabaseError,
  JournalEntryNotBalancedError,
} from '../errors'

vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: vi.fn().mockResolvedValue([]),
}))

function thenableChain(result: unknown) {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'in']) {
    chain[method] = vi.fn().mockReturnValue(chain)
  }
  chain.then = (resolve: (value: unknown) => void) => resolve(result)
  return chain
}

const input = {
  fiscal_period_id: 'period-2026',
  entry_date: '2026-01-01',
  description: 'Replacement opening balance',
  source_type: 'opening_balance' as const,
  voucher_series: 'A',
  lines: [
    { account_number: '1930', debit_amount: 150, credit_amount: 0 },
    { account_number: '2010', debit_amount: 0, credit_amount: 150 },
  ],
}

describe('replaceOpeningBalanceEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes resolved lines to the atomic RPC and emits committed/reversed events', async () => {
    const entries = [
      { id: 'old-entry', status: 'reversed', lines: [] },
      { id: 'new-entry', status: 'posted', source_type: 'opening_balance', lines: [] },
      { id: 'storno-entry', status: 'posted', source_type: 'storno', lines: [] },
    ]
    const rpc = vi.fn().mockResolvedValue({
      data: [{
        new_entry_id: 'new-entry',
        storno_entry_id: 'storno-entry',
        new_voucher_number: 2,
        storno_voucher_number: 3,
      }],
      error: null,
    })
    const supabase = {
      rpc,
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'chart_of_accounts') {
          return thenableChain({
            data: [
              { id: 'account-1930', account_number: '1930' },
              { id: 'account-2010', account_number: '2010' },
            ],
            error: null,
          })
        }
        if (table === 'journal_entries') {
          return thenableChain({ data: entries, error: null })
        }
        throw new Error(`Unexpected table: ${table}`)
      }),
    }

    const result = await replaceOpeningBalanceEntry(
      supabase as never,
      'company-1',
      'user-1',
      'old-entry',
      input,
    )

    expect(result).toEqual({
      newEntryId: 'new-entry',
      stornoEntryId: 'storno-entry',
      newVoucherNumber: 2,
      stornoVoucherNumber: 3,
    })
    expect(rpc).toHaveBeenCalledWith('commit_opening_balance_replacement', expect.objectContaining({
      p_company_id: 'company-1',
      p_period_id: 'period-2026',
      p_expected_old_entry_id: 'old-entry',
      p_user_id: 'user-1',
      p_entry_date: '2026-01-01',
      p_voucher_series: 'A',
      p_lines: [
        expect.objectContaining({
          account_number: '1930',
          account_id: 'account-1930',
          debit_amount: 150,
          credit_amount: 0,
        }),
        expect.objectContaining({
          account_number: '2010',
          account_id: 'account-2010',
          debit_amount: 0,
          credit_amount: 150,
        }),
      ],
    }))
    expect(eventBus.emit).toHaveBeenCalledTimes(3)
    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'journal_entry.reversed',
    }))
  })

  it('rejects an unbalanced replacement before calling the RPC', async () => {
    const rpc = vi.fn()

    await expect(replaceOpeningBalanceEntry(
      { rpc } as never,
      'company-1',
      'user-1',
      'old-entry',
      {
        ...input,
        lines: [
          { account_number: '1930', debit_amount: 150, credit_amount: 0 },
          { account_number: '2010', debit_amount: 0, credit_amount: 149 },
        ],
      },
    )).rejects.toBeInstanceOf(JournalEntryNotBalancedError)

    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects lines whose accounts are absent from the chart', async () => {
    const rpc = vi.fn()
    const from = vi.fn().mockImplementation((table: string) => {
      if (table !== 'chart_of_accounts') throw new Error(`Unexpected table: ${table}`)
      return thenableChain({ data: [], error: null })
    })

    await expect(replaceOpeningBalanceEntry(
      { rpc, from } as never,
      'company-1',
      'user-1',
      'old-entry',
      input,
    )).rejects.toBeInstanceOf(AccountsNotInChartError)

    expect(rpc).not.toHaveBeenCalled()
  })

  it('surfaces an atomic RPC failure without attempting a partial journal write', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'Opening balance changed concurrently', code: '40001' },
    })
    const from = vi.fn().mockImplementation((table: string) => {
      if (table !== 'chart_of_accounts') throw new Error(`Unexpected table: ${table}`)
      return thenableChain({
        data: [
          { id: 'account-1930', account_number: '1930' },
          { id: 'account-2010', account_number: '2010' },
        ],
        error: null,
      })
    })

    await expect(replaceOpeningBalanceEntry(
      { rpc, from } as never,
      'company-1',
      'user-1',
      'old-entry',
      input,
    )).rejects.toBeInstanceOf(BookkeepingDatabaseError)

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledTimes(1)
  })
})
