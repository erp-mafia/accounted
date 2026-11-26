import { describe, expect, it } from 'vitest'
import { creditNoteBookedOre, creditNoteRefundedAmount, planCreditNoteRefund, refundLedgerAmount } from '../credit-note-refund-plan'

const creditNote = (over: Record<string, unknown> = {}) => ({
  status: 'sent',
  total: -10000,
  paid_amount: null,
  currency: 'SEK',
  journal_entry_id: 'je-credit',
  deduction_total: 0,
  ...over,
})

describe('creditNoteRefundedAmount', () => {
  it('reads what the refund door paid back on a linked credit note', () => {
    expect(creditNoteRefundedAmount({ credited_invoice_id: 'inv-1', paid_amount: -500 })).toBe(500)
    expect(creditNoteRefundedAmount({ credited_invoice_id: 'inv-1', paid_amount: null })).toBeCloseTo(0)
  })

  it('is nothing on a note imported without a link: the provider netted it, nobody refunded it', () => {
    expect(creditNoteRefundedAmount({ credited_invoice_id: null, paid_amount: -500 })).toBe(0)
  })
})

describe('planCreditNoteRefund', () => {
  it('owes the whole credit when the original was paid in full', () => {
    expect(planCreditNoteRefund(creditNote(), { total: 10000, paid_amount: 10000 })).toEqual({
      ok: true,
      owed: 10000,
      refunded: 0,
      settlesCredit: true,
    })
  })

  it('owes only what was paid when the original was paid in part', () => {
    // The rest of the credit cancels what is still open on the original.
    expect(planCreditNoteRefund(creditNote(), { total: 10000, paid_amount: 7000 })).toMatchObject({
      ok: true,
      owed: 7000,
      settlesCredit: false,
    })
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
      settlesCredit: true,
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

describe('creditNoteBookedOre', () => {
  const lines = (receivableCredit: number, oreDebit: number, oreCredit = 0) => [
    { account_number: '1510', debit_amount: 0, credit_amount: receivableCredit },
    { account_number: '3001', debit_amount: 799.8, credit_amount: 0 },
    { account_number: '2611', debit_amount: 199.95, credit_amount: 0 },
    { account_number: '3740', debit_amount: oreDebit, credit_amount: oreCredit },
  ]

  it('reads the öre a credit rounded up booked: Cr 1510 1 000 / Dr 3740 0,25 on 999,75', () => {
    expect(creditNoteBookedOre(-999.75, lines(1000, 0.25))).toBe(0.25)
  })

  it('reads the öre a credit rounded down booked, as strings too', () => {
    expect(
      creditNoteBookedOre('-1000.25', [
        { account_number: '1510', debit_amount: '0', credit_amount: '1000' },
        { account_number: '3001', debit_amount: '800.2', credit_amount: '0' },
        { account_number: '2611', debit_amount: '200.05', credit_amount: '0' },
        { account_number: '3740', debit_amount: '0', credit_amount: '0.25' },
      ]),
    ).toBe(-0.25)
  })

  it('is 0 for a credit note booked at its exact total', () => {
    expect(
      creditNoteBookedOre(-999.75, [
        { account_number: '1510', debit_amount: 0, credit_amount: 999.75 },
        { account_number: '3001', debit_amount: 799.8, credit_amount: 0 },
        { account_number: '2611', debit_amount: 199.95, credit_amount: 0 },
      ]),
    ).toBe(0)
  })

  it('is 0 when 1510 and 3740 disagree: the gap is no rounding the credit note booked', () => {
    // 1510 credited 1 000 but the 0,25 went to revenue, not 3740.
    expect(creditNoteBookedOre(-999.75, lines(1000, 0))).toBe(0)
    // A krona or more is never rounding.
    expect(creditNoteBookedOre(-998.75, lines(1000, 1.25))).toBe(0)
  })
})

describe('refundLedgerAmount', () => {
  it('pays back what 1510 carries when the refund settles the credit', () => {
    expect(refundLedgerAmount({ owed: 999.75, settlesCredit: true }, 0.25)).toBe(1000)
    expect(refundLedgerAmount({ owed: 1000.25, settlesCredit: true }, -0.25)).toBe(1000)
  })

  it('never pays out below zero', () => {
    expect(refundLedgerAmount({ owed: 0.25, settlesCredit: true }, -0.25)).toBe(0)
  })

  it('pays back the reskontra figure when nothing was booked on 3740', () => {
    expect(refundLedgerAmount({ owed: 999.75, settlesCredit: true }, 0)).toBe(999.75)
  })

  it('leaves the öre to the credit that cancels an original still open', () => {
    // Original 999,75 issued at 1 000 and paid 500: 1510 carries 500 for it,
    // the credit 1 000; the pair leaves 500 to pay back, owed by the reskontra too.
    expect(refundLedgerAmount({ owed: 500, settlesCredit: false }, 0.25)).toBe(500)
  })

  it('takes the öre with the last part refund', () => {
    const plan = planCreditNoteRefund(
      { status: 'sent', total: -999.75, paid_amount: -400, currency: 'SEK', journal_entry_id: 'je-credit', deduction_total: 0 },
      { total: 999.75, paid_amount: 999.75 },
    )
    expect(plan).toMatchObject({ ok: true, owed: 599.75, settlesCredit: true })
    if (plan.ok) expect(refundLedgerAmount(plan, 0.25)).toBe(600)
  })
})
