import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  SKIPPED_ORDERS_STATUS_LIMIT,
  SKIPPED_ORDERS_WRITE_ATTEMPTS,
  applySkippedOrdersChange,
  mergeSkippedOrders,
  parseSkippedOrders,
  skippedOrdersChanged,
  skippedOrdersKey,
  skippedOrdersStatus,
  type SkippedCurrencyOrder,
  type SkippedSighting,
} from '../lib/skipped-orders'

function sighting(overrides: Partial<SkippedSighting> = {}): SkippedSighting {
  return {
    order_id: 7,
    order_number: '7',
    order_date: '2026-08-01',
    currency: '&euro;',
    ...overrides,
  }
}

const T1 = '2026-09-01T00:00:00.000Z'
const T2 = '2026-09-02T00:00:00.000Z'

describe('mergeSkippedOrders', () => {
  it('adds a sighted order with first and last seen set to now', () => {
    expect(mergeSkippedOrders([], { sighted: [sighting()], resolvedOrderIds: [] }, T1)).toEqual([
      {
        order_id: 7,
        order_number: '7',
        order_date: '2026-08-01',
        currency: '&euro;',
        first_seen_at: T1,
        last_seen_at: T1,
      },
    ])
  })

  it('dedupes by order id, keeping first_seen_at and refreshing the rest', () => {
    const first = mergeSkippedOrders([], { sighted: [sighting()], resolvedOrderIds: [] }, T1)
    const second = mergeSkippedOrders(
      first,
      { sighted: [sighting({ order_number: 'W-7', currency: '??' })], resolvedOrderIds: [] },
      T2,
    )
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({
      order_number: 'W-7',
      currency: '??',
      first_seen_at: T1,
      last_seen_at: T2,
    })
  })

  it('removes a resolved order and leaves the others', () => {
    const listed = mergeSkippedOrders(
      [],
      { sighted: [sighting(), sighting({ order_id: 8 })], resolvedOrderIds: [] },
      T1,
    )
    const after = mergeSkippedOrders(listed, { sighted: [], resolvedOrderIds: [7] }, T2)
    expect(after.map((o) => o.order_id)).toEqual([8])
  })

  it('treats an order reported as both sighted and resolved as resolved', () => {
    expect(
      mergeSkippedOrders([], { sighted: [sighting()], resolvedOrderIds: [7] }, T1),
    ).toEqual([])
  })

  it('orders the list by order date, then id', () => {
    const merged = mergeSkippedOrders(
      [],
      {
        sighted: [
          sighting({ order_id: 3, order_date: '2026-08-05' }),
          sighting({ order_id: 2, order_date: '2026-08-01' }),
          sighting({ order_id: 1, order_date: '2026-08-01' }),
        ],
        resolvedOrderIds: [],
      },
      T1,
    )
    expect(merged.map((o) => o.order_id)).toEqual([1, 2, 3])
  })

  it('truncates a runaway currency value', () => {
    const [entry] = mergeSkippedOrders(
      [],
      { sighted: [sighting({ currency: 'x'.repeat(500) })], resolvedOrderIds: [] },
      T1,
    )
    expect(entry.currency).toHaveLength(32)
  })
})

describe('skippedOrdersChanged', () => {
  it('sees additions, removals and refreshed fields, and nothing else', () => {
    const a = mergeSkippedOrders([], { sighted: [sighting()], resolvedOrderIds: [] }, T1)
    expect(skippedOrdersChanged(a, a.map((o) => ({ ...o })))).toBe(false)
    expect(skippedOrdersChanged(a, [])).toBe(true)
    expect(skippedOrdersChanged(a, [{ ...a[0], last_seen_at: T2 }])).toBe(true)
  })
})

describe('parseSkippedOrders', () => {
  it('drops malformed entries and tolerates a missing value', () => {
    const good: SkippedCurrencyOrder = {
      order_id: 7,
      order_number: '7',
      order_date: null,
      currency: 'kr',
      first_seen_at: T1,
      last_seen_at: T1,
    }
    expect(parseSkippedOrders({ orders: [good, { order_id: 'x' }, null] })).toEqual([good])
    expect(parseSkippedOrders(null)).toEqual([])
    expect(parseSkippedOrders({ orders: 'nope' })).toEqual([])
  })
})

describe('skippedOrdersStatus', () => {
  it('keeps the exact count but hands the panel a bounded slice', () => {
    const many = mergeSkippedOrders(
      [],
      {
        sighted: Array.from({ length: SKIPPED_ORDERS_STATUS_LIMIT + 5 }, (_, i) =>
          sighting({ order_id: i + 1 }),
        ),
        resolvedOrderIds: [],
      },
      T1,
    )
    const status = skippedOrdersStatus(many)
    expect(status.count).toBe(SKIPPED_ORDERS_STATUS_LIMIT + 5)
    expect(status.orders).toHaveLength(SKIPPED_ORDERS_STATUS_LIMIT)
  })
})

describe('skippedOrdersKey', () => {
  it('is per store scope, so a reconnect of the same store keeps the list', () => {
    expect(skippedOrdersKey('shop.example.se')).toBe('skipped_currency_orders:shop.example.se')
  })
})

describe('applySkippedOrdersChange (compare-and-swap)', () => {
  const V0 = '2026-09-30T10:00:00.000001+00:00'
  const V1 = '2026-09-30T10:00:00.000002+00:00'
  const asClient = (supabase: unknown) => supabase as SupabaseClient

  function entry(orderId: number): SkippedCurrencyOrder {
    return {
      order_id: orderId,
      order_number: String(orderId),
      order_date: '2026-08-01',
      currency: '??',
      first_seen_at: T1,
      last_seen_at: T1,
    }
  }

  function writtenIds(update: unknown[] | undefined): number[] {
    const value = (update?.[0] as { value: { orders: SkippedCurrencyOrder[] } }).value
    return value.orders.map((o) => o.order_id)
  }

  function updatedAtFilters(calls: Array<{ table: string; method: string; args: unknown[] }>) {
    return calls
      .filter((c) => c.method === 'eq' && c.args[0] === 'updated_at')
      .map((c) => c.args[1])
  }

  it('merges into the fresh row when another writer changed it after the stale read', async () => {
    const { supabase, enqueueMany, findCalls, calls } = createQueuedMockSupabase()
    enqueueMany([
      // Round 1: reads [7] at V0; the conditional update matches nothing
      // because another run stored order 9 in between.
      { data: { value: { orders: [entry(7)] }, updated_at: V0 } },
      { data: [] },
      // Round 2: reads [7, 9] at V1 and wins.
      { data: { value: { orders: [entry(7), entry(9)] }, updated_at: V1 } },
      { data: [{ id: 'row-1' }] },
    ])

    const result = await applySkippedOrdersChange(
      asClient(supabase),
      'company-1',
      'user-1',
      'shop.example.se',
      { sighted: [sighting({ order_id: 8, order_number: '8' })], resolvedOrderIds: [] },
      T2,
    )

    expect(result).toBe('written')
    const writes = findCalls('extension_data', 'update')
    expect(writes).toHaveLength(2)
    expect(writtenIds(writes[1])).toEqual([7, 8, 9])
    // Each write is conditioned on the version its own round read.
    expect(updatedAtFilters(calls)).toEqual([V0, V1])
  })

  it('keeps one run\'s removal and another run\'s addition', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      // This run resolves order 7 against a read of [7, 8] ...
      { data: { value: { orders: [entry(7), entry(8)] }, updated_at: V0 } },
      { data: [] },
      // ... while another run added order 9 first.
      { data: { value: { orders: [entry(7), entry(8), entry(9)] }, updated_at: V1 } },
      { data: [{ id: 'row-1' }] },
    ])

    const result = await applySkippedOrdersChange(
      asClient(supabase),
      'company-1',
      'user-1',
      'shop.example.se',
      { sighted: [], resolvedOrderIds: [7] },
      T2,
    )

    expect(result).toBe('written')
    expect(writtenIds(findCalls('extension_data', 'update')[1])).toEqual([8, 9])
  })

  it('does not resurrect an entry another run removed after the stale read', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: { value: { orders: [entry(7), entry(8)] }, updated_at: V0 } },
      { data: [] },
      // The other run imported order 7 in between.
      { data: { value: { orders: [entry(8)] }, updated_at: V1 } },
      { data: [{ id: 'row-1' }] },
    ])

    await applySkippedOrdersChange(
      asClient(supabase),
      'company-1',
      'user-1',
      'shop.example.se',
      { sighted: [sighting({ order_id: 10, order_number: '10' })], resolvedOrderIds: [] },
      T2,
    )

    expect(writtenIds(findCalls('extension_data', 'update')[1])).toEqual([8, 10])
  })

  it('retries on a lost insert race and then updates the row the other run created', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: null },
      { error: { code: '23505', message: 'duplicate key value' } },
      { data: { value: { orders: [entry(9)] }, updated_at: V1 } },
      { data: [{ id: 'row-1' }] },
    ])

    const result = await applySkippedOrdersChange(
      asClient(supabase),
      'company-1',
      'user-1',
      'shop.example.se',
      { sighted: [sighting()], resolvedOrderIds: [] },
      T2,
    )

    expect(result).toBe('written')
    expect(writtenIds(findCalls('extension_data', 'update')[0])).toEqual([7, 9])
  })

  it('removes the row under the same condition when the list empties', async () => {
    const { supabase, enqueueMany, findCalls, calls } = createQueuedMockSupabase()
    enqueueMany([
      { data: { value: { orders: [entry(7)] }, updated_at: V0 } },
      { data: [{ id: 'row-1' }] },
    ])

    const result = await applySkippedOrdersChange(
      asClient(supabase),
      'company-1',
      'user-1',
      'shop.example.se',
      { sighted: [], resolvedOrderIds: [7] },
      T2,
    )

    expect(result).toBe('written')
    expect(findCalls('extension_data', 'delete')).toHaveLength(1)
    expect(findCalls('extension_data', 'update')).toHaveLength(0)
    expect(updatedAtFilters(calls)).toEqual([V0])
  })

  it('reports contention after the bounded attempts, having stored nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    for (let i = 0; i < SKIPPED_ORDERS_WRITE_ATTEMPTS; i++) {
      enqueue({ data: { value: { orders: [entry(9)] }, updated_at: `v${i}` } })
      enqueue({ data: [] })
    }

    const result = await applySkippedOrdersChange(
      asClient(supabase),
      'company-1',
      'user-1',
      'shop.example.se',
      { sighted: [sighting()], resolvedOrderIds: [] },
      T2,
    )

    expect(result).toBe('contended')
    expect(findCalls('extension_data', 'update')).toHaveLength(SKIPPED_ORDERS_WRITE_ATTEMPTS)
  })

  it('fails on a read error instead of merging into an empty list', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ error: { message: 'timeout' } })

    const result = await applySkippedOrdersChange(
      asClient(supabase),
      'company-1',
      'user-1',
      'shop.example.se',
      { sighted: [sighting()], resolvedOrderIds: [] },
      T2,
    )

    expect(result).toBe('failed')
    expect(findCalls('extension_data', 'update')).toHaveLength(0)
    expect(findCalls('extension_data', 'insert')).toHaveLength(0)
  })

  it('skips the round trip for a page with nothing to record, and writes nothing when the merge is a no-op', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    expect(
      await applySkippedOrdersChange(
        asClient(supabase),
        'company-1',
        'user-1',
        'shop.example.se',
        { sighted: [], resolvedOrderIds: [] },
        T2,
      ),
    ).toBe('unchanged')
    expect(supabase.from).not.toHaveBeenCalled()

    enqueue({ data: { value: { orders: [entry(9)] }, updated_at: V0 } })
    expect(
      await applySkippedOrdersChange(
        asClient(supabase),
        'company-1',
        'user-1',
        'shop.example.se',
        { sighted: [], resolvedOrderIds: [7] },
        T2,
      ),
    ).toBe('unchanged')
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })
})
