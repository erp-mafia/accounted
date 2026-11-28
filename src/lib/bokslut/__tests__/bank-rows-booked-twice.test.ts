import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bankRowsBookedTwice } from '../bank-rows-booked-twice'

// The rule itself runs in the database (public.bank_rows_booked_twice,
// tests/pg/bank-rows-booked-twice.pg.test.ts); here, how its answer is read.
function supabaseAnswering(answer: { data: unknown; error: unknown }) {
  const builder = {
    order: vi.fn(),
    range: vi.fn(async (_from: number, _to: number) => answer),
  }
  builder.order.mockReturnValue(builder)
  const rpc = vi.fn((_name: string, _args: Record<string, unknown>) => builder)
  return { client: { rpc } as never, rpc, builder }
}

const ROW = {
  transaction_id: 'tx-1',
  kept_journal_entry_id: 'je-11',
  kept_voucher_series: 'A',
  kept_voucher_number: 11,
  extra_entries: [
    { journal_entry_id: 'je-12', voucher_series: 'A', voucher_number: 12 },
    { journal_entry_id: 'je-13', voucher_series: 'A', voucher_number: 13 },
  ],
}

describe('bankRowsBookedTwice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads the period of the company and keeps the copy that stays apart from the extra ones', async () => {
    const { client, rpc, builder } = supabaseAnswering({ data: [ROW], error: null })

    expect(await bankRowsBookedTwice(client, 'company-1', 'fp-1')).toEqual([
      {
        transaction_id: 'tx-1',
        kept: { journal_entry_id: 'je-11', voucher_series: 'A', voucher_number: 11 },
        extras: [
          { journal_entry_id: 'je-12', voucher_series: 'A', voucher_number: 12 },
          { journal_entry_id: 'je-13', voucher_series: 'A', voucher_number: 13 },
        ],
      },
    ])
    expect(rpc).toHaveBeenCalledWith('bank_rows_booked_twice', { p_company_id: 'company-1', p_fiscal_period_id: 'fp-1' })
    // Paged on a total order: a company could have more than one page.
    expect(builder.order).toHaveBeenCalledWith('transaction_id', { ascending: true })
    expect(builder.range).toHaveBeenCalledWith(0, 999)
  })

  it('reports nothing when no row is booked twice', async () => {
    const { client } = supabaseAnswering({ data: [], error: null })

    expect(await bankRowsBookedTwice(client, 'company-1', 'fp-1')).toEqual([])
  })

  it('fails when the read fails, so the caller can tell it from nothing booked twice', async () => {
    const { client } = supabaseAnswering({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } })

    await expect(bankRowsBookedTwice(client, 'company-1', 'fp-1')).rejects.toThrow(/statement timeout/)
  })
})
