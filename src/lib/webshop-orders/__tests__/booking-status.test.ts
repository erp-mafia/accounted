import { describe, expect, it } from 'vitest'
import type { WebshopOrder } from '@/types'
import {
  isCancelledInStore,
  isCancelledWithoutRefund,
  isVoidable,
  isVoidOutdated,
  isWebshopBookingReleased,
  webshopOrderBookingStatus,
  whereWebshopOrderBooked,
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

describe('isVoidOutdated', () => {
  const voided = { manually_booked_at: MARKED, manually_voided: true }

  it('holds while the store still reports the order cancelled with nothing refunded', () => {
    expect(isVoidOutdated(row({ status: 'cancelled', ...voided }))).toBe(false)
  })

  it('flags a void once the store reopens the order or refunds money on it', () => {
    expect(isVoidOutdated(row({ status: 'processing', ...voided }))).toBe(true)
    expect(isVoidOutdated(row({ status: 'cancelled', refunded_total: 100, ...voided }))).toBe(true)
  })

  it('says nothing about a row that is not voided', () => {
    expect(isVoidOutdated(row({ status: 'processing', manually_booked_at: MARKED }))).toBe(false)
    expect(isVoidOutdated(row({ status: 'processing' }))).toBe(false)
  })
})

describe('isWebshopBookingReleased', () => {
  it('releases the order from a verifikat a plain storno reversed', () => {
    expect(isWebshopBookingReleased({ status: 'reversed' }, false)).toBe(true)
  })

  it('keeps the order booked by a posted verifikat, one a rättelse replaced, and one in flight', () => {
    expect(isWebshopBookingReleased({ status: 'posted' }, false)).toBe(false)
    expect(isWebshopBookingReleased({ status: 'reversed' }, true)).toBe(false)
    expect(isWebshopBookingReleased({ status: 'draft' }, false)).toBe(false)
    expect(isWebshopBookingReleased({ status: 'cancelled' }, false)).toBe(false)
    expect(isWebshopBookingReleased(null, false)).toBe(false)
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

  it('reads a released order as if it had never been booked', () => {
    expect(webshopOrderBookingStatus(row({ journal_entry_id: 'je-1' }), { released: true })).toBe('to_book')
    expect(
      webshopOrderBookingStatus(row({ journal_entry_id: 'je-1', legacy_transaction_id: 'tx-1' }), { released: true }),
    ).toBe('in_transactions')
    expect(webshopOrderBookingStatus(row({ journal_entry_id: 'je-1', status: 'cancelled' }), { released: true })).toBe(
      'cancelled',
    )
  })
})

describe('whereWebshopOrderBooked', () => {
  interface RecordingQuery {
    calls: unknown[][]
    or(filters: string): RecordingQuery
    is(column: string, value: null): RecordingQuery
  }
  const query = (): RecordingQuery => {
    const q: RecordingQuery = {
      calls: [],
      or: (filters) => {
        q.calls.push(['or', filters])
        return q
      },
      is: (column, value) => {
        q.calls.push(['is', column, value])
        return q
      },
    }
    return q
  }

  it('reads the pointer alone while no verifikat released an order, and leaves a voided row out of booked', () => {
    const unbooked = whereWebshopOrderBooked(query(), 'unbooked', [])
    expect(unbooked.calls).toEqual([
      ['is', 'journal_entry_id', null],
      ['is', 'manually_booked_at', null],
    ])
    const booked = whereWebshopOrderBooked(query(), 'booked', [])
    expect(booked.calls).toEqual([
      ['or', 'journal_entry_id.not.is.null,and(manually_booked_at.not.is.null,manually_voided.is.false)'],
    ])
  })

  it('moves the orders of a released verifikat from booked to unbooked', () => {
    const unbooked = whereWebshopOrderBooked(query(), 'unbooked', ['je-a', 'je-b'])
    expect(unbooked.calls).toEqual([
      ['or', 'journal_entry_id.is.null,journal_entry_id.in.(je-a,je-b)'],
      ['is', 'manually_booked_at', null],
    ])
    const booked = whereWebshopOrderBooked(query(), 'booked', ['je-a', 'je-b'])
    expect(booked.calls).toEqual([
      [
        'or',
        'and(journal_entry_id.not.is.null,journal_entry_id.not.in.(je-a,je-b)),and(manually_booked_at.not.is.null,manually_voided.is.false)',
      ],
    ])
  })
})
