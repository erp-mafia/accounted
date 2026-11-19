/**
 * The settlements view's own decisions: which rows a click books or
 * rebooks, the wording key per reason, and the account choices sent with
 * a booking (VAT prefilled as deductible, an unknown line only once a
 * person typed a whole account).
 */
import { describe, expect, it } from 'vitest'
import {
  attentionCount,
  bookingChoices,
  formatSettlementAmount,
  settlementVoucherRows,
  PAYMENT_STATUSES_TO_BOOK,
  SETTLEMENT_STATUSES_TO_BOOK,
  paymentBookable,
  paymentRebookable,
  paymentReviewKey,
  settlementBookable,
  settlementReasonKey,
  type SettlementDetail,
  settlementBookingSentenceKey,
} from '../settlements-ui'

type Line = SettlementDetail['lines'][number]

function line(position: number, extra: Partial<Line> = {}): Line {
  return {
    position,
    kind: 'principal',
    inPayout: true,
    recipient: 'creditor',
    amount: 100,
    taxAmount: 0,
    caseId: null,
    invoiceId: null,
    originalInvoiceIds: [],
    providerType: 'p',
    accountNumber: '1689',
    vatAccountNumber: null,
    chosenByPerson: false,
    booked: false,
    needsAccount: null,
    needsVatAccount: false,
    direction: 'credit',
    ...extra,
  }
}

describe('row actions', () => {
  it('books a pending or reviewed payment and rebooks only a booked one no payout settled', () => {
    expect(paymentBookable({ status: 'pending' })).toBe(true)
    expect(paymentBookable({ status: 'needs_review' })).toBe(true)
    expect(paymentBookable({ status: 'booked' })).toBe(false)
    expect(paymentBookable({ status: 'ignored' })).toBe(false)
    expect(paymentRebookable({ status: 'booked', settlementId: null, journalEntryId: 'je' })).toBe(true)
    expect(paymentRebookable({ status: 'booked', settlementId: 's1', journalEntryId: 'je' })).toBe(false)
    expect(paymentRebookable({ status: 'pending', settlementId: null, journalEntryId: null })).toBe(false)
  })

  it('books a received or waiting payout, never a possible duplicate through the plain button', () => {
    expect(settlementBookable({ status: 'received', needsMappingReason: null })).toBe(true)
    expect(settlementBookable({ status: 'needs_mapping', needsMappingReason: 'vat_unconfirmed' })).toBe(true)
    expect(settlementBookable({ status: 'needs_mapping', needsMappingReason: 'possible_duplicate' })).toBe(false)
    expect(settlementBookable({ status: 'booked', needsMappingReason: null })).toBe(false)
    expect(settlementBookable({ status: 'ignored', needsMappingReason: null })).toBe(false)
  })

  it('counts what waits for a person', () => {
    expect(
      attentionCount({
        collectedPayments: [{ status: 'pending' }, { status: 'booked' }, { status: 'needs_review' }] as never,
        settlements: [{ status: 'needs_mapping' }, { status: 'received' }, { status: 'booked' }, { status: 'failed' }, { status: 'ignored' }] as never,
      }),
    ).toBe(4)
  })

  it('counts the same statuses as the Att göra rows, and never a payout the provider marked invalid', () => {
    expect([...PAYMENT_STATUSES_TO_BOOK]).toEqual(['pending', 'needs_review'])
    expect([...SETTLEMENT_STATUSES_TO_BOOK]).toEqual(['received', 'needs_mapping'])
    expect(attentionCount({ collectedPayments: [], settlements: [{ status: 'failed' }] as never })).toBe(0)
  })
})

describe('wording keys', () => {
  it('words known reasons and falls back for others', () => {
    expect(settlementReasonKey('vat_unconfirmed')).toBe('reason_vat_unconfirmed')
    expect(settlementReasonKey('possible_duplicate')).toBe('reason_possible_duplicate')
    expect(settlementReasonKey('commit_failed')).toBe('reason_default')
    expect(settlementReasonKey(null)).toBeNull()
    expect(paymentReviewKey('NO_CAPITAL')).toBe('review_NO_CAPITAL')
    expect(paymentReviewKey('INVOICE_PAID_NO_FISCAL_PERIOD')).toBeNull()
  })
})

describe('bookingChoices', () => {
  it('sends nothing when no line waits', () => {
    expect(bookingChoices({ lines: [line(0)] }, {})).toEqual([])
  })

  it('prefills nothing: the VAT waits for the person to pick deductible input VAT or a cost', () => {
    const lines = [line(0, { kind: 'agency_fee_vat', accountNumber: null, needsAccount: 'vat' }), line(1, { kind: 'agency_commission', taxAmount: 25, needsVatAccount: true })]
    expect(bookingChoices({ lines }, {})).toBeNull()
    expect(bookingChoices({ lines }, { 0: { account: '6062' } })).toBeNull()
    expect(bookingChoices({ lines }, { 0: { account: '6062' }, 1: { vatAccount: '2641' } })).toEqual([
      { position: 0, account_number: '6062' },
      { position: 1, vat_account_number: '2641' },
    ])
    expect(bookingChoices({ lines }, { 0: { account: '1930' }, 1: { vatAccount: '2641' } })).toBeNull()
  })

  it('waits for a whole account on an unknown line', () => {
    const lines = [line(3, { kind: 'unknown', accountNumber: null, needsAccount: 'any' })]
    expect(bookingChoices({ lines }, {})).toBeNull()
    expect(bookingChoices({ lines }, { 3: { account: '30' } })).toBeNull()
    expect(bookingChoices({ lines }, { 3: { account: '3990' } })).toEqual([{ position: 3, account_number: '3990' }])
  })
})

describe('amounts', () => {
  // Intl separates groups and the unit with no-break spaces; compare with plain ones.
  const plain = (text: string) => text.replace(/\s/g, ' ')

  it('prints whole kronor without decimals and öre with both digits', () => {
    expect(plain(formatSettlementAmount(12187.5))).toBe('12 187,50 kr')
    expect(plain(formatSettlementAmount(62.5))).toBe('62,50 kr')
    expect(plain(formatSettlementAmount(1000))).toBe('1 000 kr')
    expect(plain(formatSettlementAmount(0.07))).toBe('0,07 kr')
  })

  it('keeps the sign of a deduction', () => {
    expect(plain(formatSettlementAmount(-62.5))).toMatch(/^[-\u2212]62,50 kr$/)
  })
})

describe('settlementBookingSentenceKey', () => {
  it('names the provider fees only when the payout carries any', () => {
    expect(settlementBookingSentenceKey([{ kind: 'principal', inPayout: true }])).toBe('confirm_book_plain')
    expect(
      settlementBookingSentenceKey([
        { kind: 'principal', inPayout: true },
        { kind: 'agency_commission', inPayout: true },
      ]),
    ).toBe('confirm_book_plain_fees')
  })

  it('ignores a charge shown for information only', () => {
    expect(
      settlementBookingSentenceKey([
        { kind: 'principal', inPayout: true },
        { kind: 'fee_charged_to_creditor', inPayout: false },
      ]),
    ).toBe('confirm_book_plain')
  })
})

describe('settlementVoucherRows', () => {
  const voucherDraft: SettlementDetail['voucherDraft'] = [
    { accountNumber: '1930', waitsFor: null, debit: 843.75, credit: 0 },
    { accountNumber: '1689', waitsFor: null, debit: 0, credit: 1000 },
    { accountNumber: '6062', waitsFor: null, debit: 125, credit: 0 },
    { accountNumber: null, waitsFor: { position: 1, field: 'vatAccount' }, debit: 31.25, credit: 0 },
  ]

  it('shows every row before the choice, the VAT row as waiting for it', () => {
    expect(settlementVoucherRows({ voucherDraft }, {})).toEqual([
      { accountNumber: '1930', debit: 843.75, credit: 0, waiting: false },
      { accountNumber: '1689', debit: 0, credit: 1000, waiting: false },
      { accountNumber: '6062', debit: 125, credit: 0, waiting: false },
      { accountNumber: null, debit: 31.25, credit: 0, waiting: true },
    ])
  })

  it('takes the person\'s choice live, and follows a change of mind', () => {
    expect(settlementVoucherRows({ voucherDraft }, { 1: { vatAccount: '2641' } })?.[3]).toEqual({ accountNumber: '2641', debit: 31.25, credit: 0, waiting: false })
    expect(settlementVoucherRows({ voucherDraft }, { 1: { vatAccount: '6062' } })?.[3]).toEqual({ accountNumber: '6062', debit: 31.25, credit: 0, waiting: false })
  })

  it('shows no voucher while something other than a choice holds the payout', () => {
    expect(settlementVoucherRows({ voucherDraft: null }, {})).toBeNull()
  })
})
