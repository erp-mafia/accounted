import { describe, expect, it } from 'vitest'
import { makeCustomer, makeInvoice, makeSupplier, makeSupplierInvoice } from '@/tests/helpers'
import type { BankTransactionPartInput } from '@/types'
import {
  BANKGIRO_SPLIT_CONFIDENCE,
  BANKGIRO_SPLIT_METHOD,
  splitIsComplete,
  suggestPartInvoices,
  type PartSuggestionInput,
} from '../part-suggestions'

/** One part of a Bankgirot split as the bank feed delivers it. */
function part(overrides: Partial<BankTransactionPartInput> = {}): BankTransactionPartInput {
  return {
    amount: 500,
    currency: 'SEK',
    counterparty_name: null,
    counterparty_org_number: null,
    counterparty_account: null,
    reference: null,
    invoice_numbers: [],
    message: null,
    provider_part_id: null,
    ...overrides,
  }
}

const kundAb = makeCustomer({ id: 'cust-kund', name: 'Kund AB', org_number: '5560160680' })
const bolaget = makeCustomer({ id: 'cust-bolaget', name: 'Bolaget i Norr AB', org_number: '5591234567' })

// OCR references print the invoice number's digits plus a Luhn check digit
// (lib/invoices/ocr-keys.ts): 1001 -> 10017, 1002 -> 10025, 1003 -> 10033.
const invoice1001 = { ...makeInvoice({ id: 'inv-1001', invoice_number: '1001', status: 'sent', total: 500, remaining_amount: 500, customer_id: kundAb.id }), customer: kundAb }
const invoice1002 = { ...makeInvoice({ id: 'inv-1002', invoice_number: '1002', status: 'sent', total: 1000, remaining_amount: 1000, customer_id: bolaget.id }), customer: bolaget }
const invoice1003 = { ...makeInvoice({ id: 'inv-1003', invoice_number: '1003', status: 'overdue', total: 250, remaining_amount: 250, customer_id: kundAb.id }), customer: kundAb }

const deposit = (parts: BankTransactionPartInput[], overrides: Partial<PartSuggestionInput> = {}): PartSuggestionInput => ({
  parentAmount: parts.reduce((sum, p) => sum + p.amount, 0),
  parts,
  customerInvoices: [invoice1001, invoice1002, invoice1003],
  supplierInvoices: [],
  ...overrides,
})

describe('suggestPartInvoices: a deposit split per payer', () => {
  it('resolves three parts by OCR reference, by the invoice number the payer listed, and by the payer\'s one open invoice for the amount', () => {
    const parts = [
      part({ amount: 500, reference: '10017', counterparty_name: 'Kund AB' }),
      part({ amount: 1000, reference: null, invoice_numbers: ['1002'], counterparty_name: 'Bolaget i Norr AB' }),
      part({ amount: 250, reference: null, counterparty_org_number: '5560160680', counterparty_name: 'KUND AB' }),
    ]
    const suggestions = suggestPartInvoices(deposit(parts))
    expect(suggestions).toEqual([
      { seq: 1, suggested_invoice_id: 'inv-1001', suggested_supplier_invoice_id: null, suggestion_reason: 'ocr_exact' },
      { seq: 2, suggested_invoice_id: 'inv-1002', suggested_supplier_invoice_id: null, suggestion_reason: 'invoice_number' },
      { seq: 3, suggested_invoice_id: 'inv-1003', suggested_supplier_invoice_id: null, suggestion_reason: 'amount_only' },
    ])
    expect(splitIsComplete(1750, parts, suggestions)).toBe(true)
    expect(BANKGIRO_SPLIT_METHOD).toBe('bankgiro_split')
    expect(BANKGIRO_SPLIT_CONFIDENCE).toBe(0.95)
  })

  it('takes the bare invoice number as the reference too, and a reference with separators', () => {
    const [bare, spaced] = suggestPartInvoices(deposit([
      part({ amount: 500, reference: '1001' }),
      part({ amount: 1000, reference: '1 002' }),
    ]))
    expect(bare).toMatchObject({ suggested_invoice_id: 'inv-1001', suggestion_reason: 'ocr_exact' })
    expect(spaced).toMatchObject({ suggested_invoice_id: 'inv-1002', suggestion_reason: 'ocr_exact' })
  })

  it('accepts a partial payment only when the payer named the invoice, never on the amount alone', () => {
    const [byReference, byNumber, byAmount] = suggestPartInvoices(deposit([
      part({ amount: 300, reference: '10017' }),
      part({ amount: 600, invoice_numbers: ['1002'] }),
      part({ amount: 200, counterparty_name: 'Kund AB' }),
    ]))
    expect(byReference).toMatchObject({ suggested_invoice_id: 'inv-1001', suggestion_reason: 'ocr_exact' })
    expect(byNumber).toMatchObject({ suggested_invoice_id: 'inv-1002', suggestion_reason: 'invoice_number' })
    expect(byAmount).toMatchObject({ suggested_invoice_id: null, suggestion_reason: null })
    // Above the remaining amount, a reference is not enough either.
    const [over] = suggestPartInvoices(deposit([part({ amount: 501, reference: '10017' })]))
    expect(over.suggested_invoice_id).toBeNull()
  })

  it('finds nothing for an unknown reference, an unknown payer, or a payer with two open invoices for the amount', () => {
    const twin = { ...makeInvoice({ id: 'inv-1004', invoice_number: '1004', status: 'sent', total: 500, remaining_amount: 500, customer_id: kundAb.id }), customer: kundAb }
    const suggestions = suggestPartInvoices(deposit(
      [
        part({ amount: 500, reference: '99999' }),
        part({ amount: 500, counterparty_name: 'Okänd AB' }),
        part({ amount: 500, counterparty_name: 'Kund AB' }),
      ],
      { customerInvoices: [invoice1001, invoice1002, twin] },
    ))
    expect(suggestions.map((s) => s.suggested_invoice_id)).toEqual([null, null, null])
    expect(splitIsComplete(1500, suggestions.map(() => part()), suggestions)).toBe(false)
  })

  it('never suggests one invoice to two parts, an invoice another row claimed, an invoice in another currency, or a settled one', () => {
    const eur = { ...makeInvoice({ id: 'inv-eur', invoice_number: '1005', status: 'sent', currency: 'EUR', total: 500, remaining_amount: 500, customer_id: kundAb.id }), customer: kundAb }
    const settled = { ...makeInvoice({ id: 'inv-paid', invoice_number: '1006', status: 'sent', total: 500, remaining_amount: 0, customer_id: kundAb.id }), customer: kundAb }
    const suggestions = suggestPartInvoices(deposit(
      [
        part({ amount: 500, reference: '10017' }),
        part({ amount: 500, reference: '10017' }),
        part({ amount: 1000, reference: '10025' }),
        part({ amount: 500, reference: '10058' }),
        part({ amount: 500, reference: '10066' }),
      ],
      { customerInvoices: [invoice1001, invoice1002, eur, settled], excludeInvoiceIds: new Set(['inv-1002']) },
    ))
    expect(suggestions.map((s) => s.suggested_invoice_id)).toEqual(['inv-1001', null, null, null, null])
  })

  it('leaves every part unsuggested on a zero row and on a payout against customer invoices', () => {
    expect(suggestPartInvoices(deposit([part({ amount: 500, reference: '10017' })], { parentAmount: 0 }))[0]!.suggested_invoice_id).toBeNull()
    expect(suggestPartInvoices(deposit([part({ amount: -500, reference: '10017' })], { parentAmount: -500 }))[0]!.suggested_invoice_id).toBeNull()
  })
})

describe('suggestPartInvoices: a payout split per payee', () => {
  const tele = makeSupplier({ id: 'sup-tele', name: 'Tele2 Sverige AB', org_number: '5562673733', bankgiro: '5020-3103', plusgiro: null })
  const el = makeSupplier({ id: 'sup-el', name: 'Elbolaget AB', org_number: '5590000001', bankgiro: null, plusgiro: '12 34 56-7' })
  const teleInvoice = makeSupplierInvoice({ id: 'si-tele', supplier_id: tele.id, supplier_invoice_number: 'INV-2026-77', payment_reference: '4711000000009', total: 1200, remaining_amount: 1200, supplier: tele })
  const elInvoice = makeSupplierInvoice({ id: 'si-el', supplier_id: el.id, supplier_invoice_number: '88012', payment_reference: null, total: 800, remaining_amount: 800, supplier: el })
  const elOther = makeSupplierInvoice({ id: 'si-el-2', supplier_id: el.id, supplier_invoice_number: '88013', payment_reference: null, total: 300, remaining_amount: 300, supplier: el })

  const payout = (parts: BankTransactionPartInput[], overrides: Partial<PartSuggestionInput> = {}): PartSuggestionInput => ({
    parentAmount: parts.reduce((sum, p) => sum + p.amount, 0),
    parts,
    customerInvoices: [],
    supplierInvoices: [teleInvoice, elInvoice, elOther],
    ...overrides,
  })

  it('resolves two parts: one by the payment reference, one by the payee\'s plusgiro and the amount', () => {
    const parts = [
      part({ amount: -1200, reference: '4711 0000 00009', counterparty_name: 'TELE2', counterparty_account: '5020-3103' }),
      part({ amount: -800, counterparty_name: 'ELBOLAGET', counterparty_account: '1234567' }),
    ]
    const suggestions = suggestPartInvoices(payout(parts))
    expect(suggestions).toEqual([
      { seq: 1, suggested_invoice_id: null, suggested_supplier_invoice_id: 'si-tele', suggestion_reason: 'ocr_exact' },
      { seq: 2, suggested_invoice_id: null, suggested_supplier_invoice_id: 'si-el', suggestion_reason: 'amount_only' },
    ])
    expect(splitIsComplete(-2000, parts, suggestions)).toBe(true)
  })

  it('takes the supplier\'s invoice number in any punctuation, the bankgiro of the invoice\'s own payee, and the organisationsnummer', () => {
    const stated = makeSupplierInvoice({ id: 'si-stated', supplier_id: 'sup-x', supplier_invoice_number: null, payee_bankgiro: '991-2345', total: 150, remaining_amount: 150, supplier: makeSupplier({ id: 'sup-x', name: 'X', bankgiro: null, org_number: null }) })
    const [byNumber, byPayee, byOrg] = suggestPartInvoices(payout(
      [
        part({ amount: -800, invoice_numbers: ['88 012'] }),
        part({ amount: -150, counterparty_account: '9912345' }),
        part({ amount: -300, counterparty_org_number: '5590000001' }),
      ],
      { supplierInvoices: [teleInvoice, elInvoice, elOther, stated] },
    ))
    expect(byNumber).toMatchObject({ suggested_supplier_invoice_id: 'si-el', suggestion_reason: 'invoice_number' })
    expect(byPayee).toMatchObject({ suggested_supplier_invoice_id: 'si-stated', suggestion_reason: 'amount_only' })
    expect(byOrg).toMatchObject({ suggested_supplier_invoice_id: 'si-el-2', suggestion_reason: 'amount_only' })
  })

  it('accepts a partial payment only with the reference, and leaves a payee with no open invoice for the amount alone', () => {
    const [partial, byAmountOnly, nothing] = suggestPartInvoices(payout([
      part({ amount: -700, reference: '4711000000009' }),
      part({ amount: -700, counterparty_account: '5020-3103' }),
      part({ amount: -42, counterparty_name: 'Elbolaget AB' }),
    ]))
    expect(partial).toMatchObject({ suggested_supplier_invoice_id: 'si-tele', suggestion_reason: 'ocr_exact' })
    expect(byAmountOnly.suggested_supplier_invoice_id).toBeNull()
    expect(nothing.suggested_supplier_invoice_id).toBeNull()
  })
})

describe('splitIsComplete', () => {
  const suggested = (seq: number) => ({ seq, suggested_invoice_id: `inv-${seq}`, suggested_supplier_invoice_id: null, suggestion_reason: 'ocr_exact' as const })
  const unsuggested = (seq: number) => ({ seq, suggested_invoice_id: null, suggested_supplier_invoice_id: null, suggestion_reason: null })

  it('needs two or more parts, every part suggested, and the parts summing to the row to the öre', () => {
    expect(splitIsComplete(1500, [part({ amount: 500 }), part({ amount: 1000 })], [suggested(1), suggested(2)])).toBe(true)
    expect(splitIsComplete(1500.01, [part({ amount: 500 }), part({ amount: 1000 })], [suggested(1), suggested(2)])).toBe(false)
    expect(splitIsComplete(1500, [part({ amount: 500 }), part({ amount: 1000 })], [suggested(1), unsuggested(2)])).toBe(false)
    // One part is the single-invoice path, not a split.
    expect(splitIsComplete(500, [part({ amount: 500 })], [suggested(1)])).toBe(false)
    // Floating sums: 0.1 + 0.2 against 0.3.
    expect(splitIsComplete(0.3, [part({ amount: 0.1 }), part({ amount: 0.2 })], [suggested(1), suggested(2)])).toBe(true)
  })
})
