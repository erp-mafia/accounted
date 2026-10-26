import { describe, expect, it } from 'vitest'
import { planCreditNoteRefund } from '../credit-note-refund-plan'

const creditNote = (over: Record<string, unknown> = {}) => ({
  status: 'sent',
  total: -10000,
  paid_amount: null,
  currency: 'SEK',
  journal_entry_id: 'je-credit',
  deduction_total: 0,
  ...over,
})

describe('planCreditNoteRefund', () => {
  it('owes the whole credit when the original was paid in full', () => {
    expect(planCreditNoteRefund(creditNote(), { total: 10000, paid_amount: 10000 })).toEqual({
      ok: true,
      owed: 10000,
      refunded: 0,
    })
  })

  it('owes only what was paid when the original was paid in part', () => {
    expect(planCreditNoteRefund(creditNote(), { total: 10000, paid_amount: 7000 })).toMatchObject({ ok: true, owed: 7000 })
  })

  it('owes nothing when the original was never paid (the credit only cancels the receivable)', () => {
    expect(planCreditNoteRefund(creditNote(), { total: 10000, paid_amount: 0 })).toEqual({
      ok: false,
      code: 'CREDIT_NOTE_REFUND_NOTHING_OWED',
      details: { refunded: 0, credit_used: 0 },
    })
  })

  it('owes the rest after a part refund and nothing after the full one', () => {
    expect(planCreditNoteRefund(creditNote({ paid_amount: -4000 }), { total: 10000, paid_amount: 10000 })).toEqual({
      ok: true,
      owed: 6000,
      refunded: 4000,
    })
    expect(planCreditNoteRefund(creditNote({ paid_amount: -10000 }), { total: 10000, paid_amount: 10000 })).toMatchObject({
      ok: false,
      code: 'CREDIT_NOTE_REFUND_NOTHING_OWED',
    })
  })

  it('takes off the credit a set-off already used', () => {
    expect(planCreditNoteRefund(creditNote(), { total: 10000, paid_amount: 10000 }, 2500)).toMatchObject({ ok: true, owed: 7500 })
    expect(planCreditNoteRefund(creditNote(), { total: 10000, paid_amount: 10000 }, 10000)).toMatchObject({
      ok: false,
      code: 'CREDIT_NOTE_REFUND_NOTHING_OWED',
      details: { credit_used: 10000 },
    })
  })

  it('reads amounts stored as strings to the öre', () => {
    expect(planCreditNoteRefund(creditNote({ total: '-1.25' }), { total: '1.25', paid_amount: '1.25' })).toMatchObject({
      ok: true,
      owed: 1.25,
    })
  })

  it.each([
    ['draft', { status: 'draft' }, 'not_issued'],
    ['cancelled', { status: 'cancelled' }, 'not_issued'],
    ['an imported settled credit note', { status: 'credited' }, 'not_issued'],
    ['no verifikat', { journal_entry_id: null }, 'not_booked'],
    ['a foreign currency', { currency: 'EUR' }, 'foreign_currency'],
    ['ROT/RUT', { deduction_total: 3000 }, 'rot_rut'],
  ])('refuses %s', (_label, over, reason) => {
    expect(planCreditNoteRefund(creditNote(over), { total: 10000, paid_amount: 10000 })).toEqual({
      ok: false,
      code: 'CREDIT_NOTE_REFUND_UNSUPPORTED',
      details: { reason },
    })
  })

  it('refuses without the original', () => {
    expect(planCreditNoteRefund(creditNote(), null)).toMatchObject({ details: { reason: 'no_original' } })
  })
})
