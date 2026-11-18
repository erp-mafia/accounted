import { describe, expect, it } from 'vitest'
import {
  deliveryKeys,
  mayPair,
  normaliseInvoiceNumber,
  normaliseSupplierName,
  pairInboxItems,
  pairWithBookedHalves,
  purchaseAgreement,
  purchaseFacts,
  type PairableItem,
} from '../pairs'
import { makeItem, reading } from './fixtures'

/** The X subscription mail (a real case): one forwarded mail, two PDFs. */
const MAIL = 'resend-mail-x'

function invoice(overrides: Partial<PairableItem> = {}): PairableItem {
  return {
    ...makeItem({
      id: 'invoice',
      source: 'email',
      document_id: 'doc-invoice',
      extracted_data: reading({
        documentKind: 'supplier_invoice',
        supplier: { name: 'X Corp.' },
        invoice: { invoiceNumber: 'J0LVRPBD-0003', invoiceDate: '2026-10-03', dueDate: '2026-10-03', currency: 'SEK' },
        totals: { total: 83 },
      }),
    }),
    resend_email_id: MAIL,
    ...overrides,
  }
}

function receipt(overrides: Partial<PairableItem> = {}): PairableItem {
  return {
    ...makeItem({
      id: 'receipt',
      source: 'email',
      document_id: 'doc-receipt',
      extracted_data: reading({
        documentKind: 'receipt',
        supplier: { name: 'X Corp.' },
        invoice: { invoiceNumber: 'J0LVRPBD-0003', invoiceDate: '2026-10-03', currency: 'SEK' },
        totals: { total: 83 },
        payment: { method: 'card', cardLast4: '3667' },
      }),
    }),
    resend_email_id: MAIL,
    ...overrides,
  }
}

function withReading(item: PairableItem, overrides: Parameters<typeof reading>[0]): PairableItem {
  return { ...item, extracted_data: reading(overrides) }
}

describe('purchaseFacts', () => {
  it('reads an invoice and a receipt, normalised', () => {
    expect(purchaseFacts(invoice())).toEqual({
      kind: 'supplier_invoice',
      invoiceNumber: 'J0LVRPBD-0003',
      supplier: 'x corp',
      total: 83,
      currency: 'SEK',
      date: '2026-10-03',
    })
    expect(purchaseFacts(receipt())?.kind).toBe('receipt')
  })

  it('reads nothing for another kind, a credit or a document without a total', () => {
    expect(purchaseFacts(withReading(invoice(), { documentKind: 'government_letter', totals: { total: 83 } }))).toBeNull()
    expect(purchaseFacts(withReading(invoice(), { documentKind: 'credit_note', totals: { total: -83 } }))).toBeNull()
    expect(purchaseFacts(withReading(invoice(), { documentKind: 'supplier_invoice' }))).toBeNull()
    expect(purchaseFacts({ extracted_data: null })).toBeNull()
  })

  it('normalises invoice numbers and supplier names, never inventing one', () => {
    expect(normaliseInvoiceNumber(' #j0lvrpbd - 0003 ')).toBe('J0LVRPBD-0003')
    expect(normaliseInvoiceNumber('  ')).toBeNull()
    expect(normaliseSupplierName('X Corp.')).toBe('x corp')
    expect(normaliseSupplierName('Åhléns AB')).toBe('åhléns ab')
    expect(normaliseSupplierName('...')).toBeNull()
  })
})

describe('purchaseAgreement', () => {
  const inv = purchaseFacts(invoice())!
  const rec = purchaseFacts(receipt())!

  it('agrees on the invoice number when both carry one', () => {
    expect(purchaseAgreement(inv, rec)).toBe('invoice_number')
  })

  it('two different invoice numbers are two purchases, whatever else agrees', () => {
    expect(purchaseAgreement(inv, { ...rec, invoiceNumber: 'J0LVRPBD-0004' })).toBeNull()
  })

  it('without a number on one side: the same supplier, amount and date', () => {
    expect(purchaseAgreement(inv, { ...rec, invoiceNumber: null })).toBe('supplier_amount_date')
    expect(purchaseAgreement(inv, { ...rec, invoiceNumber: null, date: '2026-10-04' })).toBeNull()
    expect(purchaseAgreement(inv, { ...rec, invoiceNumber: null, supplier: 'y corp' })).toBeNull()
    expect(purchaseAgreement(inv, { ...rec, invoiceNumber: null, date: null })).toBeNull()
  })

  it('never agrees on a different amount or currency, the number included', () => {
    expect(purchaseAgreement(inv, { ...rec, total: 83.01 })).toBeNull()
    expect(purchaseAgreement(inv, { ...rec, total: 83.004 })).toBe('invoice_number')
    expect(purchaseAgreement(inv, { ...rec, currency: 'USD' })).toBeNull()
  })

  it('pairs an invoice with a receipt only, in that order', () => {
    expect(purchaseAgreement(rec, inv)).toBeNull()
    expect(purchaseAgreement(inv, inv)).toBeNull()
  })
})

describe('deliveryKeys', () => {
  it('names the arrivals, the inbound mail and the hunted message', () => {
    expect(deliveryKeys(invoice(), ['arr-1'])).toEqual(['arrival:arr-1', `email:${MAIL}`])
    expect(
      deliveryKeys({ ...invoice(), resend_email_id: null, source: 'mail_hunt', channel_context: { mail_message_id: 'gm-1' } }),
    ).toEqual(['message:gm-1'])
    expect(deliveryKeys({ ...invoice(), resend_email_id: null })).toEqual([])
  })
})

describe('pairInboxItems', () => {
  it('pairs the invoice and the receipt of one mail on the invoice number', () => {
    const pairs = pairInboxItems([invoice(), receipt()])
    expect(pairs.get('invoice')).toEqual({ role: 'invoice', receipt_item_id: 'receipt', basis: 'invoice_number' })
    expect(pairs.get('receipt')).toEqual({ role: 'receipt', invoice_item_id: 'invoice', basis: 'invoice_number' })
  })

  it('pairs on the supplier, amount and date when the receipt carries no number', () => {
    const pairs = pairInboxItems([
      invoice(),
      withReading(receipt(), {
        documentKind: 'receipt',
        supplier: { name: 'X CORP' },
        invoice: { invoiceDate: '2026-10-03', currency: 'SEK' },
        totals: { total: 83 },
      }),
    ])
    expect(pairs.get('invoice')).toMatchObject({ basis: 'supplier_amount_date' })
  })

  it('pairs through an arrival when the items carry no mail id (a newer door)', () => {
    const pairs = pairInboxItems(
      [{ ...invoice(), resend_email_id: null }, { ...receipt(), resend_email_id: null }],
      { arrivalIds: new Map([['invoice', ['arr-1']], ['receipt', ['arr-1', 'arr-2']]]) },
    )
    expect(pairs.get('receipt')).toMatchObject({ role: 'receipt', invoice_item_id: 'invoice' })
  })

  it('does not pair different amounts', () => {
    const other = withReading(receipt(), {
      documentKind: 'receipt',
      invoice: { invoiceNumber: 'J0LVRPBD-0003', invoiceDate: '2026-10-03', currency: 'SEK' },
      totals: { total: 166 },
    })
    expect(pairInboxItems([invoice(), other]).size).toBe(0)
  })

  it('does not pair a receipt from another mail', () => {
    expect(pairInboxItems([invoice(), receipt({ resend_email_id: 'another-mail' })]).size).toBe(0)
    // No delivery key at all: never one arrival.
    expect(pairInboxItems([{ ...invoice(), resend_email_id: null }, { ...receipt(), resend_email_id: null }]).size).toBe(0)
  })

  it('does not pair two invoices with one receipt that fits both', () => {
    const second = { ...invoice(), id: 'invoice-2', document_id: 'doc-invoice-2' }
    const noNumber = withReading(receipt(), {
      documentKind: 'receipt',
      supplier: { name: 'X Corp.' },
      invoice: { invoiceDate: '2026-10-03', currency: 'SEK' },
      totals: { total: 83 },
    })
    const plain = withReading(invoice(), {
      documentKind: 'supplier_invoice',
      supplier: { name: 'X Corp.' },
      invoice: { invoiceDate: '2026-10-03', currency: 'SEK' },
      totals: { total: 83 },
    })
    expect(pairInboxItems([plain, { ...plain, id: 'invoice-2' }, noNumber]).size).toBe(0)
    // Two invoices with the same number and amount: no telling which one the receipt pays.
    expect(pairInboxItems([invoice(), second, receipt()]).size).toBe(0)
  })

  it('pairs the one invoice the receipt names when the mail carries two', () => {
    const other = withReading({ ...invoice(), id: 'invoice-2' }, {
      documentKind: 'supplier_invoice',
      supplier: { name: 'X Corp.' },
      invoice: { invoiceNumber: 'J0LVRPBD-0004', invoiceDate: '2026-10-03', currency: 'SEK' },
      totals: { total: 83 },
    })
    const pairs = pairInboxItems([invoice(), other, receipt()])
    expect(pairs.get('receipt')).toMatchObject({ invoice_item_id: 'invoice' })
    expect(pairs.has('invoice-2')).toBe(false)
  })

  it('does not pair one invoice with two receipts', () => {
    const second = { ...receipt(), id: 'receipt-2' }
    expect(pairInboxItems([invoice(), receipt(), second]).size).toBe(0)
  })

  it('pairs only what is still waiting in the inbox', () => {
    expect(pairInboxItems([invoice({ created_supplier_invoice_id: 'si-1' }), receipt()]).size).toBe(0)
    expect(pairInboxItems([invoice(), receipt({ created_journal_entry_id: 'je-1' })]).size).toBe(0)
    expect(pairInboxItems([invoice(), receipt({ routed_to_arkiv_at: '2026-10-04T00:00:00Z' })]).size).toBe(0)
    expect(pairInboxItems([invoice(), receipt({ status: 'processing' })]).size).toBe(0)
    expect(pairInboxItems([invoice(), receipt({ status: 'error' })]).size).toBe(0)
    // Booked through its matched bank row, its underlag on the verifikat.
    expect(pairInboxItems([invoice({ matched_transaction_id: 'tx-1', matched_transaction_journal_entry_id: 'je-1', underlag_status: 'anchored' }), receipt()]).size).toBe(0)
  })

  it('keeps a pair while one is matched to a bank row, not when they name two rows', () => {
    expect(pairInboxItems([invoice({ matched_transaction_id: 'tx-1' }), receipt()]).size).toBe(2)
    expect(pairInboxItems([invoice({ matched_transaction_id: 'tx-1' }), receipt({ matched_transaction_id: 'tx-1' })]).size).toBe(2)
    expect(pairInboxItems([invoice({ matched_transaction_id: 'tx-1' }), receipt({ matched_transaction_id: 'tx-2' })]).size).toBe(0)
  })

  it('reads an invoice whose booking just landed as open when asked to (its receipt follows it)', () => {
    const booked = invoice({ created_supplier_invoice_id: 'si-1' })
    expect(pairInboxItems([booked, receipt()], { assumeOpen: new Set(['invoice']) }).get('receipt')).toMatchObject({ invoice_item_id: 'invoice' })
  })

  it('reads which is which off each document, not off the mail\'s tag that says the same of both', () => {
    expect(pairInboxItems([invoice({ kind_hint: 'supplier_invoice' }), receipt({ kind_hint: 'supplier_invoice' })]).size).toBe(2)
    expect(pairInboxItems([invoice({ kind_hint: 'receipt' }), receipt({ kind_hint: 'receipt' })]).size).toBe(2)
    // An unread kind falls back to the declared one.
    const unlabelled = withReading(receipt({ kind_hint: 'receipt' }), {
      supplier: { name: 'X Corp.' },
      invoice: { invoiceNumber: 'J0LVRPBD-0003', invoiceDate: '2026-10-03', currency: 'SEK' },
      totals: { total: 83 },
    })
    expect(pairInboxItems([invoice(), unlabelled]).get('receipt')).toMatchObject({ role: 'receipt' })
  })

  it('reads each item once, however often it is listed', () => {
    expect(pairInboxItems([invoice(), invoice(), receipt()]).size).toBe(2)
  })

  it('keeps the receipt with an invoice registered and still unpaid: the payment it proves is not booked yet', () => {
    const registered = invoice({ created_supplier_invoice_id: 'si-1' })
    const pairs = pairInboxItems([registered, receipt()], { awaitingPayment: new Set(['invoice']) })
    expect(pairs.get('invoice')).toEqual({ role: 'invoice', receipt_item_id: 'receipt', basis: 'invoice_number' })
    expect(pairs.get('receipt')).toEqual({ role: 'receipt', invoice_item_id: 'invoice', basis: 'invoice_number' })
  })

  it('lets go of the receipt once the invoice is paid, so a receipt that did not follow stands on its own', () => {
    // Paid: the caller no longer names it as awaiting payment.
    expect(pairInboxItems([invoice({ created_supplier_invoice_id: 'si-1' }), receipt()], { awaitingPayment: new Set() }).size).toBe(0)
  })

  it('an unpaid registration counts for an invoice only, never for a receipt, a verifikat or Arkiv', () => {
    // A receipt registered as a supplier invoice is not a purchase waiting for its receipt.
    const registeredReceipt = receipt({ created_supplier_invoice_id: 'si-2' })
    expect(pairInboxItems([invoice(), registeredReceipt], { awaitingPayment: new Set(['receipt']) }).size).toBe(0)
    // Booked on a verifikat as well, or moved to Arkiv: not waiting for anything.
    const booked = invoice({ created_supplier_invoice_id: 'si-1', created_journal_entry_id: 'je-1' })
    expect(pairInboxItems([booked, receipt()], { awaitingPayment: new Set(['invoice']) }).size).toBe(0)
    const archived = invoice({ created_supplier_invoice_id: 'si-1', routed_to_arkiv_at: '2026-10-04T00:00:00Z' })
    expect(pairInboxItems([archived, receipt()], { awaitingPayment: new Set(['invoice']) }).size).toBe(0)
    // The receipt still has to be open.
    expect(pairInboxItems([invoice({ created_supplier_invoice_id: 'si-1' }), receipt({ created_journal_entry_id: 'je-pay' })], { awaitingPayment: new Set(['invoice']) }).size).toBe(0)
  })
})

describe('mayPair', () => {
  it('is an open invoice or receipt with a total', () => {
    expect(mayPair(invoice())).toBe(true)
    expect(mayPair(receipt({ created_journal_entry_id: 'je-1' }))).toBe(false)
    expect(mayPair(withReading(invoice(), { documentKind: 'other', totals: { total: 83 } }))).toBe(false)
  })

  it('is also an invoice registered and still unpaid, when the caller says so', () => {
    const registered = invoice({ created_supplier_invoice_id: 'si-1' })
    expect(mayPair(registered)).toBe(false)
    expect(mayPair(registered, new Set(['invoice']))).toBe(true)
  })
})

describe('pairWithBookedHalves: an open half whose other half is booked already', () => {
  it('the invoice open, its receipt booked: the invoice is the booking\'s companion', () => {
    const pairs = pairWithBookedHalves([invoice(), receipt({ created_journal_entry_id: 'je-1' })])
    expect(pairs.get('invoice')).toEqual({ role: 'booked_companion', booked_item_id: 'receipt', booked_kind: 'receipt', basis: 'invoice_number' })
    expect(pairs.has('receipt')).toBe(false)
  })

  it('the receipt open, its invoice registered and paid: the receipt is the booking\'s companion', () => {
    const paid = invoice({ created_supplier_invoice_id: 'si-1' })
    expect(pairWithBookedHalves([paid, receipt()], { paidSupplierInvoices: new Set(['invoice']) }).get('receipt')).toEqual({
      role: 'booked_companion',
      booked_item_id: 'invoice',
      booked_kind: 'invoice',
      basis: 'invoice_number',
    })
    // Registered and not paid (nor named paid): not a booked half, the unpaid pair rule applies instead.
    expect(pairWithBookedHalves([paid, receipt()]).size).toBe(0)
  })

  it('a half booked through its matched bank row, its underlag on the verifikat, is booked too', () => {
    const onRow = receipt({ matched_transaction_id: 'tx-1', matched_transaction_journal_entry_id: 'je-1', underlag_status: 'anchored' })
    expect(pairWithBookedHalves([invoice(), onRow]).get('invoice')).toMatchObject({ booked_item_id: 'receipt' })
  })

  it('never pairs different amounts, another mail, or two halves both open', () => {
    expect(pairWithBookedHalves([invoice(), withReading(receipt({ created_journal_entry_id: 'je-1' }), { documentKind: 'receipt', supplier: { name: 'X Corp.' }, invoice: { invoiceNumber: 'J0LVRPBD-0003', invoiceDate: '2026-10-03', currency: 'SEK' }, totals: { total: 90 } })]).size).toBe(0)
    expect(pairWithBookedHalves([invoice(), receipt({ created_journal_entry_id: 'je-1', resend_email_id: 'other-mail' })]).size).toBe(0)
    expect(pairWithBookedHalves([invoice(), receipt()]).size).toBe(0)
  })

  it('one to one: an open half that fits a booked half and another document pairs with neither', () => {
    const booked = receipt({ created_journal_entry_id: 'je-1' })
    const secondOpen = { ...receipt(), id: 'receipt-2' }
    expect(pairWithBookedHalves([invoice(), booked, secondOpen]).size).toBe(0)
    // Two open invoices that both fit one booked receipt: neither.
    const secondInvoice = { ...invoice(), id: 'invoice-2' }
    expect(pairWithBookedHalves([invoice(), secondInvoice, booked]).size).toBe(0)
  })

  it('leaves an open half already in a pair of two open halves, and one matched to a bank row of its own, alone', () => {
    expect(pairWithBookedHalves([invoice(), receipt({ created_journal_entry_id: 'je-1' })], { paired: new Set(['invoice']) }).size).toBe(0)
    expect(pairWithBookedHalves([invoice({ matched_transaction_id: 'tx-own' }), receipt({ created_journal_entry_id: 'je-1' })]).size).toBe(0)
    // An Arkiv document is neither half.
    expect(pairWithBookedHalves([invoice(), receipt({ created_journal_entry_id: 'je-1', routed_to_arkiv_at: '2026-10-04T00:00:00Z' })]).size).toBe(0)
  })
})
