/**
 * Pure tests for the derived delivery / invoicing progress and the
 * invoiced_qty / remaining_qty decoration.
 */
import { describe, it, expect } from 'vitest'
import { deliveryProgress, invoicingProgress, withInvoicedQuantities } from '../progress'
import { IDS, makeSalesOrderItem } from './fixtures'

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
})
