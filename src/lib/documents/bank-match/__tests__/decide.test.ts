import { describe, expect, it } from 'vitest'
import { findSupplierInvoiceMatch } from '@/lib/invoices/supplier-invoice-matching'
import { counterpartyGiroDigits, giroKey } from '@/lib/transactions/giro-counterparty'
import type { ProposableBankRow } from '@/lib/documents/inbox-bank-match'
import { decideBankMatch, type BankMatchRules } from '../decide'
import type { BankMatchFacts } from '../facts'

/** The rules the callers bind (lib/operations/inbox-bank-match.ts), real, not mocked. */
const RULES: BankMatchRules = { matchSupplierInvoice: findSupplierInvoiceMatch, counterpartyGiroDigits, giroKey }

function invoice(overrides: Partial<BankMatchFacts> = {}): BankMatchFacts {
  return {
    kind: 'supplier_invoice',
    direction: 'out',
    amount: 1250,
    currency: 'SEK',
    reference: '4711000123',
    bankgiro: '999-0003',
    plusgiro: null,
    supplierBankgiro: null,
    supplierPlusgiro: null,
    issueDate: '2026-09-01',
    dueDate: '2026-09-30',
    names: ['Kontorsbolaget AB'],
    arrivedOn: '2026-09-02',
    ...overrides,
  }
}

function row(overrides: Partial<ProposableBankRow> = {}): ProposableBankRow {
  return {
    id: 'tx-1',
    date: '2026-09-25',
    amount: -1250,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    description: 'Betalning',
    original_description: 'Betalning',
    merchant_name: null,
    reference: null,
    counterparty_account: null,
    ...overrides,
  }
}

describe('decideBankMatch: exakt (the OCR and the amount)', () => {
  it('pairs the row the OCR names when the amount agrees, outside the window too', () => {
    const decision = decideBankMatch(invoice(), [row({ reference: '4711 0001 23', date: '2026-12-15' })], RULES, 1250)
    expect(decision).toEqual({ transactionId: 'tx-1', basis: 'rule_ocr_reference', evidenceLevel: 'exakt' })
  })

  it('is not exakt when the OCR matches but the amount does not (a part payment, or another invoice)', () => {
    expect(decideBankMatch(invoice(), [row({ reference: '4711000123', amount: -1000 })], RULES, 1250)).toBeNull()
  })

  it('is not exakt when the row pays another giro than the document names', () => {
    const decision = decideBankMatch(
      invoice({ names: ['Kontorsbolaget AB'] }),
      [row({ reference: '4711000123', counterparty_account: '5050-1055' })],
      RULES,
      1250,
    )
    // No name on the row and another giro: nothing at all.
    expect(decision).toBeNull()
  })

  it('a row that carries no giro does not contradict', () => {
    expect(decideBankMatch(invoice(), [row({ reference: '4711000123' })], RULES, 1250)?.evidenceLevel).toBe('exakt')
  })

  it('a payment made twice under one OCR proposes the first', () => {
    const decision = decideBankMatch(
      invoice(),
      [row({ id: 'tx-late', reference: '4711000123', date: '2026-09-28' }), row({ id: 'tx-early', reference: '4711000123', date: '2026-09-20' })],
      RULES,
      1250,
    )
    expect(decision?.transactionId).toBe('tx-early')
  })

  it('outranks a stark row', () => {
    const decision = decideBankMatch(
      invoice(),
      [row({ id: 'tx-giro', counterparty_account: '999-0003' }), row({ id: 'tx-ocr', reference: '4711000123' })],
      RULES,
      1250,
    )
    expect(decision).toEqual({ transactionId: 'tx-ocr', basis: 'rule_ocr_reference', evidenceLevel: 'exakt' })
  })
})

describe('decideBankMatch: stark (the amount and the payee giro, in the window)', () => {
  it('pairs the row whose counterparty giro is the one the document names', () => {
    expect(decideBankMatch(invoice({ reference: null }), [row({ counterparty_account: '999-0003' })], RULES, 1250)).toEqual({
      transactionId: 'tx-1',
      basis: 'rule_counterparty',
      evidenceLevel: 'stark',
    })
  })

  it('reads the supplier card giro as the bank feed does', () => {
    const decision = decideBankMatch(
      invoice({ reference: null, bankgiro: null, supplierBankgiro: '999-0003' }),
      [row({ description: 'BG 999-0003', original_description: 'BG 999-0003' })],
      RULES,
      1250,
    )
    expect(decision?.evidenceLevel).toBe('stark')
  })

  it('never outside the payment window: last month\'s payment to the same giro is not this invoice\'s', () => {
    expect(decideBankMatch(invoice({ reference: null }), [row({ counterparty_account: '999-0003', date: '2026-08-02' })], RULES, 1250)).toBeNull()
  })
})

describe('decideBankMatch: trolig (the amount, the window and the name)', () => {
  it('pairs the row that names the seller', () => {
    expect(decideBankMatch(invoice({ reference: null, bankgiro: null }), [row({ merchant_name: 'KONTORSBOLAGET' })], RULES, 1250)).toEqual({
      transactionId: 'tx-1',
      basis: 'rule_amount_date',
      evidenceLevel: 'trolig',
    })
  })

  it('accepts the supplier card name as an alias', () => {
    const rows = [row({ description: 'TELENOR' })]
    const asRead = invoice({ reference: null, bankgiro: null, names: ['Bredbandsbolaget i Sverige AB'] })
    expect(decideBankMatch(asRead, rows, RULES, 1250)).toBeNull()
    const withCard = invoice({ reference: null, bankgiro: null, names: ['Bredbandsbolaget i Sverige AB', 'Telenor Sverige AB'] })
    expect(decideBankMatch(withCard, rows, RULES, 1250)?.evidenceLevel).toBe('trolig')
  })

  it('never on amount and date alone', () => {
    expect(decideBankMatch(invoice({ reference: null, bankgiro: null }), [row({ merchant_name: 'IKEA' })], RULES, 1250)).toBeNull()
  })

  it('never a near name: Telia is not Tele2', () => {
    expect(decideBankMatch(invoice({ reference: null, bankgiro: null, names: ['Telia'] }), [row({ merchant_name: 'Tele2' })], RULES, 1250)).toBeNull()
  })

  it('a tie the date cannot break proposes nothing', () => {
    const rows = [row({ id: 'a', date: '2026-09-10', merchant_name: 'Kontorsbolaget' }), row({ id: 'b', date: '2026-09-20', merchant_name: 'Kontorsbolaget' })]
    expect(decideBankMatch(invoice({ reference: null, bankgiro: null }), rows, RULES, 1250)).toBeNull()
  })

  it('the row inside the issue-to-due span wins over one after it', () => {
    const rows = [row({ id: 'late', date: '2026-10-03', merchant_name: 'Kontorsbolaget' }), row({ id: 'due', date: '2026-09-29', merchant_name: 'Kontorsbolaget' })]
    expect(decideBankMatch(invoice({ reference: null, bankgiro: null }), rows, RULES, 1250)?.transactionId).toBe('due')
  })

  it('a receipt: paid the day it is dated, settled up to ten days later', () => {
    const receipt = invoice({ kind: 'receipt', reference: null, bankgiro: null, issueDate: '2026-09-10', dueDate: null, names: ['Clas Ohlson'] })
    expect(decideBankMatch(receipt, [row({ date: '2026-09-17', merchant_name: 'CLAS OHLSON 123' })], RULES, 1250)?.evidenceLevel).toBe('trolig')
    expect(decideBankMatch(receipt, [row({ date: '2026-09-22', merchant_name: 'CLAS OHLSON 123' })], RULES, 1250)).toBeNull()
  })

  it('a credit note compares the refund the same way (the search reads its sign)', () => {
    const credit = invoice({ kind: 'credit_note', direction: 'in', reference: null, bankgiro: null })
    expect(decideBankMatch(credit, [row({ amount: 1250, merchant_name: 'Kontorsbolaget' })], RULES, 1250)?.evidenceLevel).toBe('trolig')
  })
})

describe('decideBankMatch: another currency', () => {
  const usd = invoice({ kind: 'receipt', currency: 'USD', amount: 20, reference: null, bankgiro: null, issueDate: '2026-09-10', dueDate: null, names: ['OpenAI, LLC'] })

  it('compares through kronor within the receipt matcher\'s converted tolerance, and says trolig', () => {
    const decision = decideBankMatch(usd, [row({ date: '2026-09-11', amount: -215, merchant_name: 'OPENAI' })], RULES, 210)
    expect(decision).toEqual({ transactionId: 'tx-1', basis: 'rule_amount_date', evidenceLevel: 'trolig' })
  })

  it('refuses a kronor amount too far from the rate', () => {
    expect(decideBankMatch(usd, [row({ date: '2026-09-11', amount: -250, merchant_name: 'OPENAI' })], RULES, 210)).toBeNull()
  })

  it('never without a rate: 20 USD is not 20 kr', () => {
    expect(decideBankMatch(usd, [row({ date: '2026-09-11', amount: -20, merchant_name: 'OPENAI' })], RULES, null)).toBeNull()
  })

  it('a row in the document\'s own currency compares raw', () => {
    const decision = decideBankMatch(usd, [row({ date: '2026-09-11', amount: -20, currency: 'USD', amount_sek: -212, merchant_name: 'OPENAI' })], RULES, 210)
    expect(decision?.evidenceLevel).toBe('trolig')
  })
})
