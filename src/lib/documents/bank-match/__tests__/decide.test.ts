import { describe, expect, it } from 'vitest'
import { findSupplierInvoiceMatch } from '@/lib/invoices/supplier-invoice-matching'
import { counterpartyGiroDigits, giroKey } from '@/lib/transactions/giro-counterparty'
import type { ProposableBankRow } from '@/lib/documents/inbox-bank-match'
import { bankRowClaims, decideBankMatch, type BankMatchRules } from '../decide'
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

  it('never before the payment window: last month\'s payment to the same giro is not this invoice\'s', () => {
    expect(decideBankMatch(invoice({ reference: null }), [row({ counterparty_account: '999-0003', date: '2026-08-02' })], RULES, 1250)).toBeNull()
    expect(decideBankMatch(invoice({ reference: null }), [row({ counterparty_account: '999-0003', date: '2026-08-26' })], RULES, 1250)).toBeNull()
    expect(decideBankMatch(invoice({ reference: null }), [row({ counterparty_account: '999-0003', date: '2026-08-27' })], RULES, 1250)?.evidenceLevel).toBe('stark')
  })
})

describe('decideBankMatch: a late payment', () => {
  // Due 2026-09-30; the window ends five days after, 2026-10-05.
  const noOcr = invoice({ reference: null })
  const byName = invoice({ reference: null, bankgiro: null })
  // As an internet bank prints a giro payment: the payee, its padded bankgiro, the payment kind.
  const giroRow = (overrides: Partial<ProposableBankRow> = {}) =>
    row({
      description: 'KONTORSBOLAGET BG 0000009990003',
      original_description: 'KONTORSBOLAGET BG 0000009990003 Bg-bet. via internet',
      ...overrides,
    })

  it('the amount and the payee giro after the due date: stark, the basis the giro', () => {
    expect(decideBankMatch(noOcr, [giroRow({ date: '2026-10-12' })], RULES, 1250)).toEqual({
      transactionId: 'tx-1',
      basis: 'rule_counterparty',
      evidenceLevel: 'stark',
    })
  })

  it('the giro needs no end: the bank feed\'s own bankgiro pass reads no date', () => {
    expect(decideBankMatch(noOcr, [giroRow({ date: '2026-12-20' })], RULES, 1250)?.evidenceLevel).toBe('stark')
  })

  it('the giro still has to agree to the öre', () => {
    expect(decideBankMatch(noOcr, [giroRow({ date: '2026-10-12', amount: -1250.5 })], RULES, 1250)).toBeNull()
  })

  it('the amount and the name alone, within thirty days of the due date: trolig', () => {
    expect(decideBankMatch(byName, [row({ date: '2026-10-20', merchant_name: 'KONTORSBOLAGET' })], RULES, 1250)).toEqual({
      transactionId: 'tx-1',
      basis: 'rule_amount_date',
      evidenceLevel: 'trolig',
    })
    expect(decideBankMatch(byName, [row({ date: '2026-10-30', merchant_name: 'KONTORSBOLAGET' })], RULES, 1250)?.evidenceLevel).toBe('trolig')
  })

  it('too late on the name alone: nothing', () => {
    expect(decideBankMatch(byName, [row({ date: '2026-10-31', merchant_name: 'KONTORSBOLAGET' })], RULES, 1250)).toBeNull()
    expect(decideBankMatch(byName, [row({ date: '2026-12-01', merchant_name: 'KONTORSBOLAGET' })], RULES, 1250)).toBeNull()
  })

  it('late on the name alone needs the amount to the öre and no other payee\'s giro on the row', () => {
    expect(decideBankMatch(byName, [row({ date: '2026-10-20', amount: -1251, merchant_name: 'KONTORSBOLAGET' })], RULES, 1250)).toBeNull()
    // The document names its giro; the row pays another one.
    const otherGiro = row({ date: '2026-10-20', description: 'KONTORSBOLAGET BG 5050-1055', original_description: null })
    expect(decideBankMatch(noOcr, [otherGiro], RULES, 1250)).toBeNull()
    // Inside the window the same row stays what it was: the name and the window agree.
    expect(decideBankMatch(noOcr, [{ ...otherGiro, date: '2026-09-25' }], RULES, 1250)?.evidenceLevel).toBe('trolig')
  })

  it('never on the amount and a late date alone', () => {
    expect(decideBankMatch(byName, [row({ date: '2026-10-12', merchant_name: 'IKEA' })], RULES, 1250)).toBeNull()
  })

  it('without a due date the thirty days of credit the window assumes come first', () => {
    const undated = invoice({ reference: null, bankgiro: null, dueDate: null })
    expect(decideBankMatch(undated, [row({ date: '2026-10-31', merchant_name: 'KONTORSBOLAGET' })], RULES, 1250)?.evidenceLevel).toBe('trolig')
    expect(decideBankMatch(undated, [row({ date: '2026-11-01', merchant_name: 'KONTORSBOLAGET' })], RULES, 1250)).toBeNull()
  })

  it('a row inside the window outranks a late one at the same level', () => {
    const rows = [giroRow({ id: 'late', date: '2026-10-15' }), giroRow({ id: 'on-time', date: '2026-09-28' })]
    expect(decideBankMatch(noOcr, rows, RULES, 1250)?.transactionId).toBe('on-time')
  })

  it('the levels come first: a late giro outranks a name inside the window', () => {
    const rows = [row({ id: 'name', date: '2026-09-25', merchant_name: 'KONTORSBOLAGET' }), giroRow({ id: 'giro', date: '2026-10-15' })]
    expect(decideBankMatch(noOcr, rows, RULES, 1250)?.transactionId).toBe('giro')
  })

  it('late rows are ranked by how late they are, and a tie proposes nothing', () => {
    const rows = [giroRow({ id: 'later', date: '2026-10-22' }), giroRow({ id: 'late', date: '2026-10-12' })]
    expect(decideBankMatch(noOcr, rows, RULES, 1250)?.transactionId).toBe('late')
    expect(decideBankMatch(noOcr, [giroRow({ id: 'a', date: '2026-10-12' }), giroRow({ id: 'b', date: '2026-10-12' })], RULES, 1250)).toBeNull()
  })

  it('a receipt is never late, whatever agrees', () => {
    const receipt = invoice({ kind: 'receipt', reference: null, issueDate: '2026-09-10', dueDate: null })
    expect(decideBankMatch(receipt, [giroRow({ date: '2026-09-19' })], RULES, 1250)?.evidenceLevel).toBe('stark')
    expect(decideBankMatch(receipt, [giroRow({ date: '2026-09-21' })], RULES, 1250)).toBeNull()
  })

  it('a late row naming another card is another payment', () => {
    const otherCard = row({ date: '2026-10-12', merchant_name: 'KONTORSBOLAGET', description: 'KONTORSBOLAGET K1234' })
    expect(decideBankMatch({ ...byName, cardLast4: '3667' }, [otherCard], RULES, 1250)).toBeNull()
  })
})

describe('decideBankMatch: the payee\'s bank account in place of a giro', () => {
  // A made-up Swedbank account: clearing 81234, account 123 456 789-0, inside the IBAN's last seventeen digits.
  const byAccount = invoice({ reference: null, bankgiro: null, iban: 'SE78 8000 0812 3412 3456 7890' })
  const transfer = (overrides: Partial<ProposableBankRow> = {}) =>
    row({ description: 'Överföring', original_description: 'Överföring', reference: '812341234567890', ...overrides })

  it('the row\'s reference is the clearing and account number inside the IBAN: stark, like a giro', () => {
    expect(decideBankMatch(byAccount, [transfer()], RULES, 1250)).toEqual({ transactionId: 'tx-1', basis: 'rule_counterparty', evidenceLevel: 'stark' })
  })

  it('in the counterparty account too, spaced or hyphenated, and late like a giro', () => {
    expect(decideBankMatch(byAccount, [transfer({ reference: null, counterparty_account: '81234-123 456 789-0' })], RULES, 1250)?.evidenceLevel).toBe('stark')
    expect(decideBankMatch(byAccount, [transfer({ date: '2026-11-20' })], RULES, 1250)?.basis).toBe('rule_counterparty')
  })

  it('a bank whose IBAN carries the clearing with a four-digit one', () => {
    const seb = invoice({ reference: null, bankgiro: null, iban: 'SE45 5000 0000 0583 9825 7466' })
    expect(decideBankMatch(seb, [transfer({ reference: '5839 8257466' })], RULES, 1250)?.evidenceLevel).toBe('stark')
  })

  it('never on part of the number, another account, text around it, another amount, or an IBAN that is not Swedish', () => {
    expect(decideBankMatch(byAccount, [transfer({ reference: '1234567890' })], RULES, 1250)).toBeNull()
    expect(decideBankMatch(byAccount, [transfer({ reference: '812341234567891' })], RULES, 1250)).toBeNull()
    expect(decideBankMatch(byAccount, [transfer({ reference: 'Faktura 812341234567890' })], RULES, 1250)).toBeNull()
    expect(decideBankMatch(byAccount, [transfer({ amount: -1200 })], RULES, 1250)).toBeNull()
    expect(decideBankMatch({ ...byAccount, iban: 'DE89 3704 0044 0532 0130 00' }, [transfer({ reference: '370400440532013000' })], RULES, 1250)).toBeNull()
  })

  it('an IBAN whose account part is too short to hold a clearing never agrees', () => {
    const short = invoice({ reference: null, bankgiro: null, iban: 'SE21 6000 0000 0001 2345 6789' })
    expect(decideBankMatch(short, [transfer({ reference: '123456789' })], RULES, 1250)).toBeNull()
  })
})

describe('decideBankMatch: another open item the late row could pay (rivals)', () => {
  // The same amount to the same giro every month: September's and October's invoices.
  const september = invoice({ reference: null, issueDate: '2026-09-01', dueDate: '2026-09-30' })
  const october = invoice({ reference: null, issueDate: '2026-10-01', dueDate: '2026-10-31', arrivedOn: '2026-10-02' })
  const rival = (facts: BankMatchFacts) => ({ facts, amountSek: facts.amount })
  const giroRow = (overrides: Partial<ProposableBankRow> = {}) => row({ counterparty_account: '999-0003', ...overrides })

  it('a row inside this month\'s window is never last month\'s, late', () => {
    const onTime = [giroRow({ date: '2026-10-25' })]
    expect(decideBankMatch(september, onTime, RULES, 1250, [rival(october)])).toBeNull()
    expect(decideBankMatch(october, onTime, RULES, 1250, [rival(september)])).toEqual({
      transactionId: 'tx-1',
      basis: 'rule_counterparty',
      evidenceLevel: 'stark',
    })
  })

  it('without this month\'s item in the inbox, last month\'s late claim stands', () => {
    expect(decideBankMatch(september, [giroRow({ date: '2026-10-25' })], RULES, 1250, [])?.evidenceLevel).toBe('stark')
  })

  it('each month keeps its own row when both are there', () => {
    const rows = [giroRow({ id: 'sep-paid', date: '2026-09-24' }), giroRow({ id: 'oct-paid', date: '2026-10-26' })]
    expect(decideBankMatch(september, rows, RULES, 1250, [rival(october)])?.transactionId).toBe('sep-paid')
    expect(decideBankMatch(october, rows, RULES, 1250, [rival(september)])?.transactionId).toBe('oct-paid')
  })

  it('two open items, the same amount, one late row: the nearer item gets it', () => {
    const first = invoice({ reference: null, issueDate: '2026-09-01', dueDate: '2026-09-30' })
    const second = invoice({ reference: null, issueDate: '2026-09-08', dueDate: '2026-10-07' })
    const late = [giroRow({ date: '2026-10-20' })]
    expect(decideBankMatch(first, late, RULES, 1250, [rival(second)])).toBeNull()
    expect(decideBankMatch(second, late, RULES, 1250, [rival(first)])?.transactionId).toBe('tx-1')
  })

  it('two open items as late as each other: neither gets the row, since the date cannot say whose it is', () => {
    const twin = invoice({ reference: null, issueDate: '2026-09-02', dueDate: '2026-09-30' })
    const late = [giroRow({ date: '2026-10-20' })]
    expect(decideBankMatch(september, late, RULES, 1250, [rival(twin)])).toBeNull()
    expect(decideBankMatch(twin, late, RULES, 1250, [rival(september)])).toBeNull()
  })

  it('a rival the row fits at a higher level takes it, however late', () => {
    // This item knows only the name; the rival knows the giro too.
    const byName = invoice({ reference: null, bankgiro: null, issueDate: '2026-09-08', dueDate: '2026-10-07' })
    const late = [giroRow({ date: '2026-10-20', merchant_name: 'KONTORSBOLAGET' })]
    expect(decideBankMatch(byName, late, RULES, 1250)?.evidenceLevel).toBe('trolig')
    expect(decideBankMatch(byName, late, RULES, 1250, [rival(september)])).toBeNull()
    expect(decideBankMatch(september, late, RULES, 1250, [rival(byName)])?.evidenceLevel).toBe('stark')
  })

  it('a rival holding the row inside its window takes it, whatever its level', () => {
    const octoberByName = invoice({ reference: null, bankgiro: null, issueDate: '2026-10-01', dueDate: '2026-10-31' })
    const rows = [giroRow({ date: '2026-10-25', merchant_name: 'KONTORSBOLAGET' })]
    expect(decideBankMatch(september, rows, RULES, 1250, [rival(octoberByName)])).toBeNull()
    expect(decideBankMatch(octoberByName, rows, RULES, 1250, [rival(september)])?.evidenceLevel).toBe('trolig')
  })

  it('a rival whose OCR names the row takes it', () => {
    const named = invoice({ reference: '5550001', issueDate: '2026-09-15', dueDate: '2026-10-15' })
    const rows = [giroRow({ date: '2026-10-25', reference: '5550001' })]
    expect(decideBankMatch(september, rows, RULES, 1250, [rival(named)])).toBeNull()
  })

  it('a rival the row does not fit changes nothing', () => {
    const other = invoice({ reference: null, bankgiro: '5050-1055', names: ['Annan Leverantör AB'], issueDate: '2026-10-01', dueDate: '2026-10-31' })
    const pricier = invoice({ reference: null, amount: 1300, issueDate: '2026-10-01', dueDate: '2026-10-31' })
    const late = [giroRow({ date: '2026-10-25' })]
    expect(decideBankMatch(september, late, RULES, 1250, [rival(other), rival(pricier)])?.evidenceLevel).toBe('stark')
  })

  it('a rival whose money goes the other way never holds the row (crm#1779)', () => {
    // October's credit note from the same supplier and giro: money that comes back, never this payment out.
    const creditNote = invoice({ kind: 'credit_note', direction: 'in', reference: null, issueDate: '2026-10-01', dueDate: '2026-10-31' })
    const late = [giroRow({ date: '2026-10-25' })]
    expect(decideBankMatch(september, late, RULES, 1250, [rival(creditNote)])?.evidenceLevel).toBe('stark')
  })

  it('a claim inside the window is decided as it always was', () => {
    // Two open invoices the same row pays inside both windows: neither is late, both propose it.
    const sameWeek = invoice({ reference: null, issueDate: '2026-09-03', dueDate: '2026-10-02' })
    const rows = [giroRow({ date: '2026-09-25' })]
    expect(decideBankMatch(september, rows, RULES, 1250, [rival(sameWeek)])?.transactionId).toBe('tx-1')
  })
})

describe('decideBankMatch: the way the money went (crm#1779)', () => {
  const purchase = invoice({ kind: 'receipt', reference: null, bankgiro: null, amount: 2390, issueDate: '2026-10-02', dueDate: null, names: ['Möbelvaruhuset'] })
  const refund = { ...purchase, direction: 'in' as const }
  const named = (overrides: Partial<ProposableBankRow> = {}) =>
    row({ date: '2026-10-02', merchant_name: 'MOBELVARUHUSET', ...overrides })

  it('a purchase receipt is never paid by money that came in, whatever else agrees', () => {
    expect(decideBankMatch(purchase, [named({ amount: 2390 })], RULES, 2390)).toBeNull()
    expect(decideBankMatch(purchase, [named({ amount: -2390 })], RULES, 2390)?.evidenceLevel).toBe('trolig')
  })

  it('a refund is never the money that went out for the purchase', () => {
    expect(decideBankMatch(refund, [named({ amount: -2390 })], RULES, 2390)).toBeNull()
    expect(decideBankMatch(refund, [named({ amount: 2390 })], RULES, 2390)?.evidenceLevel).toBe('trolig')
  })
})

describe('bankRowClaims', () => {
  const noOcr = invoice({ reference: null })
  const giroRow = (overrides: Partial<ProposableBankRow> = {}) => row({ counterparty_account: '999-0003', ...overrides })

  it('every row the item could be paid by, and the late claims whose rivals must be read', () => {
    const claims = bankRowClaims(noOcr, [giroRow({ id: 'late', date: '2026-10-20' }), row({ id: 'other', merchant_name: 'IKEA' })], RULES, 1250)
    expect(claims.claimable.map((r) => r.id)).toEqual(['late'])
    expect(claims.contested.map((r) => r.id)).toEqual(['late'])
  })

  it('no rival is needed when a claim inside the window outranks every late one', () => {
    const claims = bankRowClaims(noOcr, [giroRow({ id: 'late', date: '2026-10-20' }), giroRow({ id: 'on-time', date: '2026-09-28' })], RULES, 1250)
    expect(claims.claimable.map((r) => r.id).sort()).toEqual(['late', 'on-time'])
    expect(claims.contested).toEqual([])
  })

  it('a late claim at a higher level than the one inside the window is contested', () => {
    const rows = [giroRow({ id: 'late', date: '2026-10-20' }), row({ id: 'name', date: '2026-09-28', merchant_name: 'KONTORSBOLAGET' })]
    expect(bankRowClaims(noOcr, rows, RULES, 1250).contested.map((r) => r.id)).toEqual(['late'])
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

describe('decideBankMatch: the card the document says paid it', () => {
  // The X subscription (a real case): invoice J0LVRPBD-0003 from "X Internet Unlimited
  // Company", 83 kr, due 2026-10-03; its receipt from the same mail says card 3667; the bank row
  // reads "X CORP. PAID FEATURES K3667": the card network's brand, not the seller's name.
  const x = invoice({
    amount: 83,
    reference: null,
    bankgiro: null,
    issueDate: '2026-10-03',
    dueDate: '2026-10-03',
    names: ['X Internet Unlimited Company'],
    arrivedOn: '2026-10-03',
  })
  // The same purchase once the supplier card carries the bank's name for it (an alias).
  const xWithAlias = { ...x, names: ['X Internet Unlimited Company', 'X Corp.'] }
  const xRow = (overrides: Partial<ProposableBankRow> = {}) =>
    row({ date: '2026-10-05', amount: -83, description: 'X CORP. PAID FEATURES K3667', original_description: null, ...overrides })

  it('the real names do not agree with the bank text: without the card, nothing is proposed', () => {
    expect(decideBankMatch(x, [xRow()], RULES, 83)).toBeNull()
  })

  it('the row naming the same card, the same amount to the öre and inside the window: trolig without the name', () => {
    expect(decideBankMatch({ ...x, cardLast4: '3667' }, [xRow()], RULES, 83)).toEqual({
      transactionId: 'tx-1',
      basis: 'rule_amount_date',
      evidenceLevel: 'trolig',
    })
  })

  it('never above trolig without the name, whatever else agrees', () => {
    expect(decideBankMatch({ ...x, cardLast4: '3667' }, [xRow()], RULES, 83)?.evidenceLevel).toBe('trolig')
  })

  it('the same card and amount outside the payment window is no proposal', () => {
    expect(decideBankMatch({ ...x, cardLast4: '3667' }, [xRow({ date: '2026-11-20' })], RULES, 83)).toBeNull()
    expect(decideBankMatch({ ...x, cardLast4: '3667' }, [xRow({ date: '2026-09-20' })], RULES, 83)).toBeNull()
  })

  it('the same card with another amount is no proposal', () => {
    expect(decideBankMatch({ ...x, cardLast4: '3667' }, [xRow({ amount: -84 })], RULES, 83)).toBeNull()
    expect(decideBankMatch({ ...x, cardLast4: '3667' }, [xRow({ amount: -83.5 })], RULES, 83)).toBeNull()
  })

  it('a row naming another card is another payment, alias or not', () => {
    expect(decideBankMatch({ ...x, cardLast4: '1234' }, [xRow()], RULES, 83)).toBeNull()
    expect(decideBankMatch({ ...xWithAlias, cardLast4: '1234' }, [xRow()], RULES, 83)).toBeNull()
  })

  it('a row naming no card neither strengthens nor stands in for the name', () => {
    expect(decideBankMatch({ ...x, cardLast4: '3667' }, [xRow({ description: 'X CORP. PAID FEATURES' })], RULES, 83)).toBeNull()
    expect(decideBankMatch({ ...xWithAlias, cardLast4: '3667' }, [xRow({ description: 'X CORP. PAID FEATURES' })], RULES, 83)?.evidenceLevel).toBe('trolig')
  })

  it('with the name as well (the supplier card\'s alias), amount, name, window and card say stark, on the same basis', () => {
    expect(decideBankMatch(xWithAlias, [xRow()], RULES, 83)).toEqual({ transactionId: 'tx-1', basis: 'rule_amount_date', evidenceLevel: 'trolig' })
    expect(decideBankMatch({ ...xWithAlias, cardLast4: '3667' }, [xRow()], RULES, 83)).toEqual({
      transactionId: 'tx-1',
      basis: 'rule_amount_date',
      evidenceLevel: 'stark',
    })
  })

  it('the card picks the right row of two the date cannot tell apart', () => {
    const rows = [xRow({ id: 'other-card', description: 'X CORP. PAID FEATURES K1234' }), xRow({ id: 'this-card' })]
    expect(decideBankMatch(xWithAlias, rows, RULES, 83)).toBeNull()
    expect(decideBankMatch({ ...xWithAlias, cardLast4: '3667' }, rows, RULES, 83)).toEqual({
      transactionId: 'this-card',
      basis: 'rule_amount_date',
      evidenceLevel: 'stark',
    })
    // Without the name the card still picks it, at trolig.
    expect(decideBankMatch({ ...x, cardLast4: '3667' }, rows, RULES, 83)).toEqual({
      transactionId: 'this-card',
      basis: 'rule_amount_date',
      evidenceLevel: 'trolig',
    })
  })

  it('two rows naming the same card and amount the date cannot tell apart propose nothing', () => {
    const rows = [xRow({ id: 'first' }), xRow({ id: 'second' })]
    expect(decideBankMatch({ ...x, cardLast4: '3667' }, rows, RULES, 83)).toBeNull()
  })

  it('a converted amount stays trolig with the card: the amount does not agree to the öre', () => {
    const usd = invoice({ kind: 'receipt', currency: 'USD', amount: 20, reference: null, bankgiro: null, issueDate: '2026-09-10', dueDate: null, names: ['OpenAI, LLC'], cardLast4: '3667' })
    const decision = decideBankMatch(usd, [row({ date: '2026-09-11', amount: -215, merchant_name: 'OPENAI', description: 'OPENAI K3667' })], RULES, 210)
    expect(decision?.evidenceLevel).toBe('trolig')
  })

  it('a converted amount never gets a proposal from the card alone: the name still has to agree', () => {
    const usd = invoice({ kind: 'receipt', currency: 'USD', amount: 20, reference: null, bankgiro: null, issueDate: '2026-09-10', dueDate: null, names: ['OpenAI, LLC'], cardLast4: '3667' })
    expect(decideBankMatch(usd, [row({ date: '2026-09-11', amount: -215, description: 'CHATGPT SUBSCR K3667' })], RULES, 210)).toBeNull()
  })

  it('an OCR match stays exakt whatever card the row names', () => {
    const decision = decideBankMatch({ ...invoice(), cardLast4: '1234' }, [row({ reference: '4711000123', description: 'Betalning K9999' })], RULES, 1250)
    expect(decision?.evidenceLevel).toBe('exakt')
  })
})
