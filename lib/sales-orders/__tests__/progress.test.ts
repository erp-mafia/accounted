/**
 * Pure tests for the derived delivery / invoicing progress and the
 * invoiced_qty / remaining_qty decoration.
 */
import { describe, it, expect } from 'vitest'
import {
  QTY_DECIMALS,
  QTY_EPSILON,
  deliveryProgress,
  invoicingProgress,
  qtyGreater,
  roundQty,
  withInvoicedQuantities,
} from '../progress'
import { IDS, makeSalesOrderItem } from './fixtures'

describe('roundQty', () => {
  it('rounds to 6 decimals (Postgres numeric precision for quantities)', () => {
    expect(QTY_DECIMALS).toBe(6)
    expect(roundQty(1.23456789)).toBe(1.234568)
    expect(roundQty(1.2345644)).toBe(1.234564)
    expect(roundQty(3)).toBe(3)
  })

  it('collapses double drift onto the exact decimal value', () => {
    expect(7.5 - 6.9).not.toBe(0.6)
    expect(roundQty(7.5 - 6.9)).toBe(0.6)
    expect(roundQty(0.3 - 0.2)).toBe(0.1)
    expect(roundQty(0.1 + 0.2)).toBe(0.3)
  })

  it('returns a plain 0 for zero (never -0)', () => {
    expect(Object.is(roundQty(0), 0)).toBe(true)
    expect(Object.is(roundQty(-0), 0)).toBe(true)
  })

  it('handles negative quantities symmetrically', () => {
    expect(roundQty(-0.6000000000000001)).toBe(-0.6)
    expect(roundQty(-1.2345678)).toBe(-1.234568)
  })
})

describe('qtyGreater', () => {
  it('is half a quantity unit of tolerance', () => {
    expect(QTY_EPSILON).toBe(0.0000005)
  })

  it('ignores float drift below quantity precision', () => {
    expect(qtyGreater(0.1 + 0.2, 0.3)).toBe(false)
    expect(qtyGreater(0.6, 7.5 - 6.9)).toBe(false)
    expect(qtyGreater(5, 5)).toBe(false)
    expect(qtyGreater(4.9999999, 5)).toBe(false)
  })

  it('detects a real difference at or above one quantity unit', () => {
    expect(qtyGreater(5.000001, 5)).toBe(true)
    expect(qtyGreater(5.1, 5)).toBe(true)
    expect(qtyGreater(9, 8)).toBe(true)
    expect(qtyGreater(8, 9)).toBe(false)
  })
})

describe('deliveryProgress', () => {
  it('is none when no line has been delivered', () => {
    const items = [
      makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 0 }),
      makeSalesOrderItem({ id: IDS.item2, quantity: 5, delivered_qty: 0 }),
    ]
    expect(deliveryProgress(items)).toBe('none')
  })

  it('is partial when some quantity is delivered but not everything', () => {
    const items = [
      makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 10 }),
      makeSalesOrderItem({ id: IDS.item2, quantity: 5, delivered_qty: 0 }),
    ]
    expect(deliveryProgress(items)).toBe('partial')
  })

  it('is partial when a single line is half delivered', () => {
    expect(deliveryProgress([makeSalesOrderItem({ quantity: 10, delivered_qty: 4 })])).toBe('partial')
  })

  it('is full when every product line is delivered in full', () => {
    const items = [
      makeSalesOrderItem({ id: IDS.item1, quantity: 10, delivered_qty: 10 }),
      makeSalesOrderItem({ id: IDS.item2, quantity: 5, delivered_qty: 5 }),
    ]
    expect(deliveryProgress(items)).toBe('full')
  })

  it('ignores text rows and zero-quantity rows', () => {
    const items = [
      makeSalesOrderItem({ id: IDS.item1, line_type: 'text', quantity: 0, delivered_qty: 0 }),
      makeSalesOrderItem({ id: IDS.item2, quantity: 0, delivered_qty: 0 }),
      makeSalesOrderItem({ id: IDS.item3, quantity: 2, delivered_qty: 2 }),
    ]
    expect(deliveryProgress(items)).toBe('full')
  })

  it('is none for an order with only text rows or no lines', () => {
    expect(deliveryProgress([])).toBe('none')
    expect(deliveryProgress([makeSalesOrderItem({ line_type: 'text', quantity: 0 })])).toBe('none')
  })
})

describe('invoicingProgress', () => {
  it('treats a missing invoiced_qty as zero', () => {
    expect(invoicingProgress([makeSalesOrderItem({ quantity: 10 })])).toBe('none')
  })

  it('reports none / partial / full from invoiced_qty', () => {
    expect(
      invoicingProgress([
        makeSalesOrderItem({ id: IDS.item1, quantity: 10, invoiced_qty: 0 }),
        makeSalesOrderItem({ id: IDS.item2, quantity: 5, invoiced_qty: 0 }),
      ]),
    ).toBe('none')
    expect(
      invoicingProgress([
        makeSalesOrderItem({ id: IDS.item1, quantity: 10, invoiced_qty: 3 }),
        makeSalesOrderItem({ id: IDS.item2, quantity: 5, invoiced_qty: 5 }),
      ]),
    ).toBe('partial')
    expect(
      invoicingProgress([
        makeSalesOrderItem({ id: IDS.item1, quantity: 10, invoiced_qty: 10 }),
        makeSalesOrderItem({ id: IDS.item2, quantity: 5, invoiced_qty: 5 }),
      ]),
    ).toBe('full')
  })

  it('is independent of delivery', () => {
    const items = [makeSalesOrderItem({ quantity: 10, delivered_qty: 10, invoiced_qty: 0 })]
    expect(deliveryProgress(items)).toBe('full')
    expect(invoicingProgress(items)).toBe('none')
  })
})

describe('withInvoicedQuantities', () => {
  it('attaches invoiced_qty and remaining_qty from the RPC map', () => {
    const items = [
      makeSalesOrderItem({ id: IDS.item1, quantity: 10 }),
      makeSalesOrderItem({ id: IDS.item2, quantity: 5 }),
    ]
    const decorated = withInvoicedQuantities(items, new Map([[IDS.item1, 4]]))
    expect(decorated[0]).toMatchObject({ invoiced_qty: 4, remaining_qty: 6 })
    // Not in the map: nothing invoiced yet.
    expect(decorated[1]).toMatchObject({ invoiced_qty: 0, remaining_qty: 5 })
  })

  it('never reports a negative remaining_qty when more was invoiced than ordered', () => {
    const decorated = withInvoicedQuantities(
      [makeSalesOrderItem({ id: IDS.item1, quantity: 3 })],
      new Map([[IDS.item1, 7]]),
    )
    expect(decorated[0].invoiced_qty).toBe(7)
    expect(decorated[0].remaining_qty).toBe(0)
  })

  it('does not mutate the input items', () => {
    const item = makeSalesOrderItem({ id: IDS.item1, quantity: 3 })
    withInvoicedQuantities([item], new Map([[IDS.item1, 1]]))
    expect(item.invoiced_qty).toBeUndefined()
    expect(item.remaining_qty).toBeUndefined()
  })

  it('reports an exact remaining_qty for fractional quantities (7.5 - 6.9, 0.3 - 0.2)', () => {
    const decorated = withInvoicedQuantities(
      [makeSalesOrderItem({ id: IDS.item1, quantity: 7.5 }), makeSalesOrderItem({ id: IDS.item2, quantity: 0.3 })],
      new Map([
        [IDS.item1, 6.9],
        [IDS.item2, 0.2],
      ]),
    )
    // Raw doubles give 0.5999999999999996 and 0.09999999999999998, which the
    // DB refuses as "0.6 > remaining". The decorated values must be exact.
    expect(decorated[0].remaining_qty).toBe(0.6)
    expect(decorated[1].remaining_qty).toBe(0.1)
    expect(decorated[0].invoiced_qty).toBe(6.9)
    expect(decorated[1].invoiced_qty).toBe(0.2)
  })

  it('rounds the invoiced quantity coming from the RPC to quantity precision', () => {
    const decorated = withInvoicedQuantities(
      [makeSalesOrderItem({ id: IDS.item1, quantity: 10 })],
      new Map([[IDS.item1, 2.0000000004]]),
    )
    expect(decorated[0].invoiced_qty).toBe(2)
    expect(decorated[0].remaining_qty).toBe(8)
  })

  it('counts a line as fully invoiced when the float remainder is below quantity precision', () => {
    const items = withInvoicedQuantities(
      [makeSalesOrderItem({ id: IDS.item1, quantity: 0.3 })],
      new Map([[IDS.item1, 0.1 + 0.2]]),
    )
    expect(items[0].remaining_qty).toBe(0)
    expect(invoicingProgress(items)).toBe('full')
  })
})
