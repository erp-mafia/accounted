import { describe, it, expect, beforeEach } from 'vitest'
import { applyBookedFilter, countUnbookedBankTransactions } from '../unbooked'

/**
 * Table-routed double that records every builder call. Both legs are head
 * counts on open_bank_rows, told apart by the is_business filter they ask
 * with. Which rows are open is the view's answer, not this file's:
 * tests/pg/bank-row-open-read.pg.test.ts proves it.
 */
function makeSupabase(opts: { untriaged?: number; business?: number; failLeg?: 'untriaged' | 'business' }) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const from = (table: string) => {
    let leg: 'untriaged' | 'business' | null = null
    const chain: Record<string, unknown> = {}
    const settle = () => {
      if (opts.failLeg === leg) return { data: null, error: { message: 'boom' }, count: null }
      return { data: null, error: null, count: (leg === 'untriaged' ? opts.untriaged : opts.business) ?? 0 }
    }
    for (const m of ['select', 'eq', 'is', 'gte', 'lte']) {
      chain[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args })
        if (args[0] === 'is_business') leg = m === 'is' ? 'untriaged' : 'business'
        return chain
      }
    }
    chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(settle()).then(resolve, reject)
    return chain
  }
  const find = (table: string, method: string) =>
    calls.filter((c) => c.table === table && c.method === method).map((c) => c.args)
  return { supabase: { from } as never, calls, find }
}

describe('countUnbookedBankTransactions', () => {
  let setup: ReturnType<typeof makeSupabase>
  beforeEach(() => {
    setup = makeSupabase({})
  })

  it('counts untriaged rows plus triaged business rows with no verifikat', async () => {
    setup = makeSupabase({ untriaged: 4, business: 3 })
    const result = await countUnbookedBankTransactions(setup.supabase, 'co-1')
    expect(result).toEqual({ total: 7, untriaged: 4, business_unbooked: 3 })
  })

  it('is two head counts on open_bank_rows alone, scoped to the company', async () => {
    await countUnbookedBankTransactions(setup.supabase, 'co-1')
    expect([...new Set(setup.calls.map((c) => c.table))]).toEqual(['open_bank_rows'])
    expect(setup.find('open_bank_rows', 'select')).toEqual([
      ['id', { count: 'exact', head: true }],
      ['id', { count: 'exact', head: true }],
    ])
    expect(setup.find('open_bank_rows', 'eq').filter((a) => a[0] === 'company_id')).toEqual([
      ['company_id', 'co-1'],
      ['company_id', 'co-1'],
    ])
  })

  it('asks for the untriaged leg, then the business leg: a private row is on neither', async () => {
    await countUnbookedBankTransactions(setup.supabase, 'co-1')
    const legs = setup.calls.filter((c) => c.args[0] === 'is_business').map((c) => [c.method, ...c.args])
    expect(legs).toEqual([
      ['is', 'is_business', null],
      ['eq', 'is_business', true],
    ])
  })

  it('applies the date range to both legs', async () => {
    await countUnbookedBankTransactions(setup.supabase, 'co-1', { fromDate: '2026-03-01', toDate: '2026-03-31' })
    expect(setup.find('open_bank_rows', 'gte')).toEqual([['date', '2026-03-01'], ['date', '2026-03-01']])
    expect(setup.find('open_bank_rows', 'lte')).toEqual([['date', '2026-03-31'], ['date', '2026-03-31']])
  })

  it('throws instead of reporting zero when either count fails', async () => {
    await expect(countUnbookedBankTransactions(makeSupabase({ failLeg: 'untriaged' }).supabase, 'co-1')).rejects.toThrow(
      /untriaged transaction count failed: boom/,
    )
    await expect(countUnbookedBankTransactions(makeSupabase({ failLeg: 'business' }).supabase, 'co-1')).rejects.toThrow(
      /business transaction count failed: boom/,
    )
  })
})

describe('applyBookedFilter', () => {
  function recorder() {
    const calls: unknown[][] = []
    const chain = {
      eq: (...args: unknown[]) => (calls.push(['eq', ...args]), chain),
    }
    return { chain, calls }
  }

  it('booked: anchored to a verifikat in any of the four ways', () => {
    const { chain, calls } = recorder()
    expect(applyBookedFilter(chain)).toBe(chain)
    expect(calls).toEqual([['eq', 'is_booked', true]])
  })
})
