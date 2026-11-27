import { describe, expect, it } from 'vitest'
import type { WebshopOrder } from '@/types'
import {
  isCancelledInStore,
  isCancelledWithoutRefund,
  isVoidable,
  webshopOrderBookingStatus,
} from '../booking-status'

function row(overrides: Partial<WebshopOrder> = {}): WebshopOrder {
  return {
    row_type: 'order',
    status: 'completed',
    is_paid: true,
    refunded_total: 0,
    journal_entry_id: null,
    invoice_id: null,
    legacy_transaction_id: null,
    manually_booked_at: null,
    manually_voided: false,
    ...overrides,
  } as WebshopOrder
}

const MARKED = '2026-11-20T10:00:00Z'

describe('isCancelledInStore', () => {
  it('reads the cancelled status on order rows only', () => {
    expect(isCancelledInStore(row({ status: 'cancelled' }))).toBe(true)
    expect(isCancelledInStore(row({ status: 'processing' }))).toBe(false)
    expect(isCancelledInStore(row({ row_type: 'refund', status: 'cancelled' }))).toBe(false)
  })
})

describe('isCancelledWithoutRefund and isVoidable', () => {
  it('a cancelled order with nothing refunded may be voided while it is open', () => {
    expect(isCancelledWithoutRefund(row({ status: 'cancelled' }))).toBe(true)
    expect(isVoidable(row({ status: 'cancelled' }))).toBe(true)
    expect(isVoidable(row({ status: 'cancelled', is_paid: false }))).toBe(true)
  })

  it('a refund in the store means money moved: not voidable', () => {
    expect(isCancelledWithoutRefund(row({ status: 'cancelled', refunded_total: 100 }))).toBe(false)
    expect(isVoidable(row({ status: 'cancelled', refunded_total: 100 }))).toBe(false)
  })

  it('a closed row is not voidable', () => {
    expect(isVoidable(row({ status: 'cancelled', journal_entry_id: 'je-1' }))).toBe(false)
    expect(isVoidable(row({ status: 'cancelled', invoice_id: 'inv-1' }))).toBe(false)
    expect(isVoidable(row({ status: 'cancelled', manually_booked_at: MARKED }))).toBe(false)
  })

  it('an order the store did not cancel is not voidable', () => {
    expect(isVoidable(row())).toBe(false)
  })
})

describe('webshopOrderBookingStatus', () => {
  it.each([
    ['booked', row({ journal_entry_id: 'je-1', status: 'cancelled' }), 'booked'],
    ['marked as booked outside', row({ manually_booked_at: MARKED }), 'marked_booked'],
    ['voided', row({ status: 'cancelled', manually_booked_at: MARKED, manually_voided: true }), 'voided'],
    ['invoiced', row({ invoice_id: 'inv-1', status: 'cancelled' }), 'invoiced'],
    ['in the legacy feed', row({ legacy_transaction_id: 'txn-1' }), 'in_transactions'],
    ['cancelled in the store and paid', row({ status: 'cancelled' }), 'cancelled'],
    ['cancelled in the store and unpaid', row({ status: 'cancelled', is_paid: false }), 'cancelled'],
    ['unpaid', row({ status: 'pending', is_paid: false }), 'unpaid'],
    ['paid and open', row(), 'to_book'],
    ['a refund row', row({ row_type: 'refund', status: 'refund' }), 'to_book'],
  ] as const)('%s', (_label, order, expected) => {
    expect(webshopOrderBookingStatus(order)).toBe(expected)
  })
})
