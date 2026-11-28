/**
 * The webshop-order-booked guard catches an order's booked state read from
 * its pointer alone, and leaves the rule's own calls alone.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/webshop-order-booked.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('webshop-order-booked', () => {
  it.each([
    "query = query.or('journal_entry_id.not.is.null,manually_booked_at.not.is.null')",
    "  'journal_entry_id.not.is.null,and(manually_booked_at.not.is.null,manually_voided.is.false)'",
    'booking_status: webshopOrderBookingStatus(order),',
    'const booked = order.journal_entry_id !== null',
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    "query = whereWebshopOrderBooked(query, 'unbooked', released)",
    'booking_status: webshopOrderBookingStatus(order, { released }),',
    'namesVerifikat: order.journal_entry_id !== null,',
    "  .or('journal_entry_id.not.is.null,invoice_id.not.is.null,manually_booked_at.not.is.null')",
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})
