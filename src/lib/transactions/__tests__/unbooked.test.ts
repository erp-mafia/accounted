import { describe, it, expect, beforeEach } from 'vitest'
import { countUnbookedBankTransactions, fetchAnchoredTransactionIds } from '../unbooked'

/**
 * Table-routed double that records every builder call. The untriaged leg is
 * a head count; the business leg returns candidate ids; the three anchor
 * tables answer from `anchors`.
 */
function makeSupabase(opts: {
  untriaged?: number
  candidates?: string[]
  anchors?: Partial<Record<'transaction_voucher_links' | 'invoice_payments' | 'supplier_invoice_payments', string[]>>
  failTable?: string
}) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const from = (table: string) => {
    let isHead = false
    const chain: Record<string, unknown> = {}
    const settle = () => {
      if (opts.failTable === table) return { data: null, error: { message: 'boom' }, count: null }
      if (table === 'transactions') {
        if (isHead) return { data: null, error: null, count: opts.untriaged ?? 0 }
        return { data: (opts.candidates ?? []).map((id) => ({ id })), error: null, count: null }
      }
      const ids = opts.anchors?.[table as keyof NonNullable<typeof opts.anchors>] ?? []
      return { data: ids.map((transaction_id) => ({ transaction_id })), error: null, count: null }
    }
    for (const m of ['eq', 'is', 'gte', 'lte', 'in', 'order', 'or', 'not']) {
      chain[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      }
    }
    chain.select = (...args: unknown[]) => {
      calls.push({ table, method: 'select', args })
      const o = args[1] as { head?: boolean } | undefined
      isHead = o?.head === true
      return chain
    }
    chain.range = () => Promise.resolve(settle())
    chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(settle()).then(resolve, reject)
    return chain
  }
  const find = (table: string, method: string) =>
    calls.filter((c) => c.table === table && c.method === method).map((c) => c.args)
  return { supabase: { from } as never, find }
}

describe('countUnbookedBankTransactions', () => {
  let setup: ReturnType<typeof makeSupabase>
  beforeEach(() => {
    setup = makeSupabase({})
  })

  it('counts untriaged rows plus triaged business rows with no verifikat', async () => {
    setup = makeSupabase({ untriaged: 4, candidates: ['a', 'b', 'c'] })
    const result = await countUnbookedBankTransactions(setup.supabase, 'co-1')
    expect(result).toEqual({ total: 7, untriaged: 4, business_unbooked: 3 })
  })

  it('does not count a business row anchored through a voucher link or a payment allocation', async () => {
    setup = makeSupabase({
      untriaged: 0,
      candidates: ['bulk', 'paid', 'supplier', 'open'],
      anchors: {
        transaction_voucher_links: ['bulk'],
        invoice_payments: ['paid'],
        supplier_invoice_payments: ['supplier'],
      },
    })
    const result = await countUnbookedBankTransactions(setup.supabase, 'co-1')
    expect(result).toEqual({ total: 1, untriaged: 0, business_unbooked: 1 })
  })

  it('excludes ignored rows and private rows on both legs', async () => {
    await countUnbookedBankTransactions(setup.supabase, 'co-1')
    const eq = setup.find('transactions', 'eq')
    expect(eq.filter((a) => a[0] === 'is_ignored')).toEqual([['is_ignored', false], ['is_ignored', false]])
    // Leg 1 is is_business IS NULL, leg 2 is is_business = true: false (private) is never counted.
    expect(setup.find('transactions', 'is')).toContainEqual(['is_business', null])
    expect(eq).toContainEqual(['is_business', true])
    expect(eq).not.toContainEqual(['is_business', false])
  })

  it('applies the date range to both legs', async () => {
    await countUnbookedBankTransactions(setup.supabase, 'co-1', { fromDate: '2026-03-01', toDate: '2026-03-31' })
    expect(setup.find('transactions', 'gte')).toEqual([['date', '2026-03-01'], ['date', '2026-03-01']])
    expect(setup.find('transactions', 'lte')).toEqual([['date', '2026-03-31'], ['date', '2026-03-31']])
  })

  it('reads no anchors when there are no business candidates', async () => {
    setup = makeSupabase({ untriaged: 2 })
    await countUnbookedBankTransactions(setup.supabase, 'co-1')
    expect(setup.find('transaction_voucher_links', 'in')).toEqual([])
  })

  it('throws instead of reporting zero when an anchor lookup fails', async () => {
    setup = makeSupabase({ candidates: ['a'], failTable: 'invoice_payments' })
    await expect(countUnbookedBankTransactions(setup.supabase, 'co-1')).rejects.toThrow(/invoice_payments anchor lookup failed/)
  })
})

describe('fetchAnchoredTransactionIds', () => {
  it('returns the ids anchored in any of the three tables', async () => {
    const { supabase } = makeSupabase({
      anchors: { transaction_voucher_links: ['x'], supplier_invoice_payments: ['y'] },
    })
    const anchored = await fetchAnchoredTransactionIds(supabase, ['x', 'y', 'z'])
    expect([...anchored].sort()).toEqual(['x', 'y'])
  })
})
