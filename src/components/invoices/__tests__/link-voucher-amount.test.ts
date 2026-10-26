/**
 * The amount LinkVoucherPicker states on a "Koppla till verifikat" link
 * (crm#1434): proposed, checked and sent. Synthetic amounts.
 */
import { describe, it, expect } from 'vitest'
import {
  canChooseAmount,
  checkLinkAmount,
  defaultLinkAmount,
  leavesPartOfVoucher,
  linkRequestBody,
  voucherLeft,
  voucherTotal,
  type LinkableVoucher,
} from '../link-voucher-amount'

/** A kundförlust verifikat of 8 000 for several invoices; this one has 2 000 left. */
const shared: LinkableVoucher = { journal_entry_id: 'je-1', ar_credit_amount: 8000, link_amount: 2000 }
/** The same verifikat after three other invoices took 6 000 of it. */
const partlyLinked: LinkableVoucher = { journal_entry_id: 'je-1', ar_credit_amount: 2000, already_linked: 6000 }
/** A payment of exactly the invoice. */
const exact: LinkableVoucher = { journal_entry_id: 'je-2', ar_credit_amount: 2000 }
/** A part payment: less than the invoice needs. */
const part: LinkableVoucher = { journal_entry_id: 'je-3', ar_credit_amount: 900 }
/** A foreign invoice paid by a verifikat booked in kronor only. */
const sekBooked: LinkableVoucher = { journal_entry_id: 'je-4', ar_credit_amount: 1008.7, whole_remainder: true }

describe('the amounts a candidate shows', () => {
  it('shows what the verifikat has left, and its whole amount when others use part of it', () => {
    expect(voucherLeft(partlyLinked)).toBe(2000)
    expect(voucherTotal(partlyLinked)).toBe(8000)
    expect(voucherTotal(exact)).toBe(2000)
  })

  it('reads the supplier side the same way', () => {
    expect(voucherLeft({ journal_entry_id: 'je-s', ap_debit_amount: 5250, link_amount: 1250 })).toBe(5250)
    expect(defaultLinkAmount({ journal_entry_id: 'je-s', ap_debit_amount: 5250, link_amount: 1250 })).toBe(1250)
  })
})

describe('defaultLinkAmount: the smaller of the invoice remainder and what the verifikat has left', () => {
  it.each([
    ['a verifikat with more than the invoice needs', shared, 2000],
    ['a partly linked verifikat', partlyLinked, 2000],
    ['an exact payment', exact, 2000],
    ['a part payment', part, 900],
  ])('%s', (_label, c, expected) => {
    expect(defaultLinkAmount(c)).toBe(expected)
  })
})

describe('checkLinkAmount', () => {
  it('accepts the proposal and any lower positive amount, Swedish or dotted', () => {
    expect(checkLinkAmount(shared, '2000,00')).toEqual({ ok: true, amount: 2000 })
    expect(checkLinkAmount(shared, '1 000,50')).toEqual({ ok: true, amount: 1000.5 })
    expect(checkLinkAmount(shared, '999.99')).toEqual({ ok: true, amount: 999.99 })
  })

  it('refuses nothing, zero, a negative amount and text', () => {
    for (const text of ['', '0', '-5', 'abc']) {
      expect(checkLinkAmount(shared, text)).toMatchObject({ ok: false, reason: 'invalid' })
    }
  })

  it('refuses more than the invoice has left on a verifikat that has more', () => {
    expect(checkLinkAmount(shared, '2000,01')).toEqual({ ok: false, reason: 'exceeds_invoice', max: 2000 })
  })

  it('refuses more than the verifikat has left', () => {
    expect(checkLinkAmount(part, '901')).toEqual({ ok: false, reason: 'exceeds_voucher', max: 900 })
    expect(checkLinkAmount(partlyLinked, '2100')).toEqual({ ok: false, reason: 'exceeds_voucher', max: 2000 })
  })

  it('on the SEK-booked fallback the amount is not the person\'s to choose', () => {
    expect(canChooseAmount(sekBooked)).toBe(false)
    expect(checkLinkAmount(sekBooked, 'whatever')).toEqual({ ok: true, amount: 1008.7 })
  })
})

describe('linkRequestBody: amount only when the link needs it', () => {
  it('states the share of a verifikat that has more than the invoice needs', () => {
    expect(linkRequestBody(shared, 2000)).toEqual({ journal_entry_id: 'je-1', amount: 2000 })
    expect(linkRequestBody(shared, 700)).toEqual({ journal_entry_id: 'je-1', amount: 700 })
  })

  it('states a share lower than what the verifikat has left', () => {
    expect(leavesPartOfVoucher(exact, 1000)).toBe(true)
    expect(linkRequestBody(exact, 1000)).toEqual({ journal_entry_id: 'je-2', amount: 1000 })
  })

  it('sends no amount when the link takes all the verifikat has left, as before', () => {
    expect(leavesPartOfVoucher(exact, 2000)).toBe(false)
    expect(linkRequestBody(exact, 2000)).toEqual({ journal_entry_id: 'je-2' })
    expect(linkRequestBody(partlyLinked, 2000)).toEqual({ journal_entry_id: 'je-1' })
    expect(linkRequestBody(part, 900)).toEqual({ journal_entry_id: 'je-3' })
  })

  it('never sends a share on the SEK-booked fallback, which refuses one', () => {
    expect(linkRequestBody(sekBooked, 1008.7)).toEqual({ journal_entry_id: 'je-4' })
  })
})
