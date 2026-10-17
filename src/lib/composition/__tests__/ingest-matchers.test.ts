/**
 * The ingest matcher list is static and ordered: a change to who runs, in
 * which order, on which rows, is a change to this test. The behaviour of the
 * whole run is pinned by lib/transactions/__tests__/ingest-characterisation.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { MODULE_IDS } from '@/lib/modules/manifest'
import { INGEST_MATCHERS } from '../ingest-matchers'

describe('INGEST_MATCHERS', () => {
  it('runs the passes in the order ingest ran them before the list, each owned by its block', () => {
    expect(
      INGEST_MATCHERS.map((m) => ({
        order: m.order,
        id: m.id,
        module: m.module,
        direction: m.direction,
        onReread: m.onReread,
        prepare: typeof m.prepare === 'function',
        finish: typeof m.finish === 'function',
      })),
    ).toEqual([
      { order: 300, id: 'customer-invoice', module: 'invoicing', direction: 'income', onReread: true, prepare: false, finish: false },
      { order: 310, id: 'payment-order', module: 'payments', direction: 'expense', onReread: true, prepare: true, finish: false },
      { order: 320, id: 'supplier-invoice', module: 'supplier-invoices', direction: 'expense', onReread: true, prepare: false, finish: false },
      { order: 330, id: 'rot-rut-payout', module: 'invoicing', direction: 'income', onReread: false, prepare: true, finish: false },
      { order: 340, id: 'rot-rut-payout-set', module: 'invoicing', direction: 'income', onReread: false, prepare: true, finish: false },
      { order: 900, id: 'collections-sweep', module: 'collections', direction: 'income', onReread: false, prepare: false, finish: true },
    ])
  })

  it('is written in its run order, with unique ids and orders and known modules', () => {
    const orders = INGEST_MATCHERS.map((m) => m.order)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
    expect(new Set(orders).size).toBe(orders.length)
    expect(new Set(INGEST_MATCHERS.map((m) => m.id)).size).toBe(INGEST_MATCHERS.length)
    for (const m of INGEST_MATCHERS) expect(MODULE_IDS).toContain(m.module)
    expect(Object.isFrozen(INGEST_MATCHERS)).toBe(true)
  })
})
