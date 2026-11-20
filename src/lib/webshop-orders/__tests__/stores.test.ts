import { describe, it, expect, vi } from 'vitest'
import { listWebshopStores } from '../stores'
import { POSTGREST_MAX_ROWS, manyRows } from '@/tests/helpers'

interface OrderRow {
  company_id: string
  platform: string
  store_scope: string
  store_label: string | null
  row_type: 'order' | 'refund'
}

/**
 * A webshop_orders table that answers like PostgREST: eq/gt filters, order,
 * limit, maybeSingle, and never more than POSTGREST_MAX_ROWS rows a read.
 */
function fakeOrdersTable(rows: OrderRow[], failWith?: { message: string }) {
  const reads: number[] = []
  const from = vi.fn((table: string) => {
    expect(table).toBe('webshop_orders')
    const eqs: Array<[keyof OrderRow, unknown]> = []
    const gts: Array<[keyof OrderRow, string]> = []
    let orderBy: keyof OrderRow | null = null
    let limit = POSTGREST_MAX_ROWS
    let single = false
    const run = () => {
      if (failWith) return { data: null, error: failWith }
      let out = rows.filter((r) => eqs.every(([c, v]) => r[c] === v) && gts.every(([c, v]) => String(r[c]) > v))
      if (orderBy) {
        const col = orderBy
        out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0))
      }
      out = out.slice(0, Math.min(limit, POSTGREST_MAX_ROWS))
      reads.push(out.length)
      return { data: single ? (out[0] ?? null) : out, error: null }
    }
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (c: keyof OrderRow, v: unknown) => (eqs.push([c, v]), chain),
      gt: (c: keyof OrderRow, v: string) => (gts.push([c, v]), chain),
      order: (c: keyof OrderRow) => ((orderBy = c), chain),
      limit: (n: number) => ((limit = n), chain),
      maybeSingle: () => ((single = true), chain),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    }
    return chain
  })
  return { supabase: { from } as never, reads }
}

const order = (store_scope: string, over: Partial<OrderRow> = {}): OrderRow => ({
  company_id: 'company-1',
  platform: 'woocommerce',
  store_scope,
  store_label: store_scope.toUpperCase(),
  row_type: 'order',
  ...over,
})

describe('listWebshopStores', () => {
  it('finds a store whose orders all sit past the first 1,000 rows', async () => {
    // 1,500 orders from one store ahead of the one order from the second:
    // a read off order rows stops at PostgREST's 1,000 and never sees it.
    const rows = [...manyRows(1500, () => order('a.se')), order('b.se')]
    const { supabase } = fakeOrdersTable(rows)

    const stores = await listWebshopStores(supabase, 'company-1')

    expect(stores).toEqual([
      { platform: 'woocommerce', store_scope: 'a.se', store_label: 'A.SE' },
      { platform: 'woocommerce', store_scope: 'b.se', store_label: 'B.SE' },
    ])
  })

  it('reads one row per store, not per order', async () => {
    const rows = [...manyRows(5000, (i) => order(i % 2 ? 'a.se' : 'b.se')), order('pos-1', { platform: 'zettle' })]
    const { supabase, reads } = fakeOrdersTable(rows)

    const stores = await listWebshopStores(supabase, 'company-1')

    expect(stores.map((s) => `${s.platform}:${s.store_scope}`)).toEqual(['woocommerce:a.se', 'woocommerce:b.se', 'zettle:pos-1'])
    // Every read asks for one row; three platforms each end on an empty read.
    expect(reads.every((n) => n <= 1)).toBe(true)
    expect(reads).toHaveLength(3 + 3)
  })

  it('keeps one entry per platform and store, other companies and refund-only rows out', async () => {
    const rows = [
      order('a.se'),
      order('a.se', { platform: 'shopify', store_label: 'A Shopify' }),
      order('other.se', { company_id: 'company-2' }),
      order('refunds-only.se', { row_type: 'refund' }),
    ]
    const { supabase } = fakeOrdersTable(rows)

    const stores = await listWebshopStores(supabase, 'company-1')

    expect(stores).toEqual([
      { platform: 'shopify', store_scope: 'a.se', store_label: 'A Shopify' },
      { platform: 'woocommerce', store_scope: 'a.se', store_label: 'A.SE' },
    ])
  })

  it('returns an empty list for a company without orders', async () => {
    const { supabase } = fakeOrdersTable([])
    expect(await listWebshopStores(supabase, 'company-1')).toEqual([])
  })

  it('throws the read error', async () => {
    const { supabase } = fakeOrdersTable([order('a.se')], { message: 'boom' })
    await expect(listWebshopStores(supabase, 'company-1')).rejects.toEqual({ message: 'boom' })
  })
})
