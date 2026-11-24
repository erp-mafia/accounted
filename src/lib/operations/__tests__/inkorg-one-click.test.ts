import { describe, expect, it } from 'vitest'
import type { InvoiceExtractionResult } from '@/types'
import { costAccountFor, planOneClick, purchaseEntryDate, type OneClickInput, type OneClickLine, type OneClickPlan } from '../inkorg-one-click'

type Extraction = InvoiceExtractionResult

function doc(overrides: {
  supplier?: Partial<Extraction['supplier']>
  invoice?: Partial<Extraction['invoice']>
  totals?: Partial<Extraction['totals']>
  lineItems?: Extraction['lineItems']
  vatBreakdown?: Extraction['vatBreakdown']
  documentKind?: Extraction['documentKind']
} = {}): Extraction {
  return {
    supplier: { name: null, orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null, iban: null, bic: null, ...overrides.supplier },
    invoice: { invoiceNumber: null, invoiceDate: null, dueDate: null, paymentReference: null, currency: 'SEK', ...overrides.invoice },
    lineItems: overrides.lineItems ?? [],
    totals: { subtotal: null, vatAmount: null, total: null, ...overrides.totals },
    vatBreakdown: overrides.vatBreakdown ?? [],
    confidence: 0.9,
    documentKind: overrides.documentKind ?? null,
  } as Extraction
}

const BANK = { transactionId: 'tx-1', date: '2026-10-14', amountSek: -150, settlementAccount: '1930', source: 'proposal' as const }

function input(overrides: Partial<OneClickInput> = {}): OneClickInput {
  return {
    kind: 'receipt',
    reading: doc(),
    paidByReceipt: false,
    receiptDate: null,
    bank: BANK,
    company: { vatRegistered: true, cashMethod: false, supplierInvoices: true },
    category: 'expense.software.saas',
    supplier: null,
    counterpartyAccount: null,
    sellerRegionAnswer: null,
    invoiceRate: null,
    ...overrides,
  }
}

function balanced(lines: OneClickLine[]): boolean {
  const debit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
  const credit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
  return Math.abs(debit - credit) < 0.005 && debit > 0
}

function pairs(plan: OneClickPlan): Array<[string, number, number]> {
  return plan.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])
}

/** Wispr Flow, 2026-10-20: a US SaaS invoice and its receipt in one mail, paid by card ••3667, 150 kr, no VAT. */
const WISPR = doc({
  documentKind: 'supplier_invoice',
  supplier: { name: 'Wispr Flow', address: '2261 Market Street #4512, San Francisco, CA 94114' },
  invoice: { invoiceNumber: 'WF-1043', invoiceDate: '2026-10-13', currency: 'SEK' },
  totals: { subtotal: 150, vatAmount: 0, total: 150 },
})

describe('planOneClick: the Wispr case', () => {
  const plan = planOneClick(input({ kind: 'supplier_invoice', reading: WISPR, paidByReceipt: true, receiptDate: '2026-10-13' }))

  it('is one verifikat against the bank row, with nothing to ask', () => {
    expect(plan.form).toBe('direct')
    expect(plan.ask).toBeNull()
    expect(plan.reason).toBe('paid_by_receipt')
    expect(plan.transactionId).toBe('tx-1')
  })

  it('books the SaaS on 5420 with reverse charge from outside the EU at 25 %', () => {
    expect(plan.vat).toEqual({ kind: 'reverse_charge', rcKind: 'non_eu_services', rate: 0.25 })
    expect(plan.seller).toEqual({ country: 'US', region: 'non_eu' })
    expect(pairs(plan)).toEqual([
      ['5420', 150, 0],
      ['1930', 0, 150],
      ['2645', 37.5, 0],
      ['2614', 0, 37.5],
      ['4531', 150, 0],
      ['4598', 0, 150],
    ])
    expect(balanced(plan.lines)).toBe(true)
  })

  it('is dated the purchase date, the invoice date the day before the bank', () => {
    expect(plan.entryDate).toBe('2026-10-13')
  })

  it('books against the card account when the card settles there', () => {
    const card = planOneClick(input({ kind: 'supplier_invoice', reading: WISPR, paidByReceipt: true, bank: { ...BANK, settlementAccount: '2890' } }))
    expect(card.lines.find((l) => l.credit_amount === 150 && l.account_number !== '4598')?.account_number).toBe('2890')
    expect(card.lines.some((l) => l.account_number === '1930')).toBe(false)
  })

  it('names no supplier to create on a direct booking, and the matched one when there is one', () => {
    expect(plan.supplier).toBeNull()
    const matched = planOneClick(input({
      kind: 'supplier_invoice',
      reading: WISPR,
      paidByReceipt: true,
      supplier: { id: 'sup-1', supplierType: 'non_eu_business', defaultExpenseAccount: null, paymentTermsDays: 30 },
    }))
    expect(matched.supplier).toEqual({ id: 'sup-1' })
  })
})

describe('planOneClick: VAT by where the seller is', () => {
  it('an EU SaaS with an Irish VAT number is reverse charge in ruta 21 (4535)', () => {
    const plan = planOneClick(input({
      reading: doc({ supplier: { name: 'Notion Labs', vatNumber: 'IE3668997OH' }, invoice: { currency: 'EUR' }, totals: { total: 10, vatAmount: 0 } }),
      bank: { ...BANK, amountSek: -115.4 },
    }))
    expect(plan.form).toBe('direct')
    expect(plan.vat).toEqual({ kind: 'reverse_charge', rcKind: 'eu_services', rate: 0.25 })
    expect(pairs(plan)).toEqual([
      ['5420', 115.4, 0],
      ['1930', 0, 115.4],
      ['2645', 28.85, 0],
      ['2614', 0, 28.85],
      ['4535', 115.4, 0],
      ['4598', 0, 115.4],
    ])
  })

  it('a Swedish receipt at 25 % books the document\'s input VAT', () => {
    const plan = planOneClick(input({
      category: 'expense.office.supplies',
      reading: doc({ supplier: { name: 'Clas Ohlson', orgNumber: '556035-8672' }, totals: { subtotal: 100, vatAmount: 25, total: 125 } }),
      bank: { ...BANK, amountSek: -125 },
    }))
    expect(plan.ask).toBeNull()
    expect(plan.vat).toEqual({ kind: 'input', amount: 25, rates: [0.25] })
    expect(pairs(plan)).toEqual([
      ['6110', 100, 0],
      ['2641', 25, 0],
      ['1930', 0, 125],
    ])
  })

  it('a Swedish receipt at 12 % books 12 % input VAT', () => {
    const plan = planOneClick(input({
      category: 'expense.personnel.refreshments',
      reading: doc({
        supplier: { name: 'ICA Nära', address: 'Storgatan 1, 123 45 Stockholm' },
        totals: { subtotal: 100, vatAmount: 12, total: 112 },
        lineItems: [{ description: 'Kaffe', quantity: 1, unitPrice: 100, lineTotal: 100, vatRate: 12, accountSuggestion: null }],
      }),
      bank: { ...BANK, amountSek: -112 },
    }))
    expect(plan.vat).toEqual({ kind: 'input', amount: 12, rates: [0.12] })
    expect(pairs(plan)).toEqual([
      ['7690', 100, 0],
      ['2641', 12, 0],
      ['1930', 0, 112],
    ])
  })

  it('a breakdown at two rates books the sum of both on input VAT', () => {
    const plan = planOneClick(input({
      category: 'expense.personnel.refreshments',
      reading: doc({
        supplier: { name: 'ICA', orgNumber: '5560219090' },
        totals: { subtotal: 200, vatAmount: 37, total: 237 },
        vatBreakdown: [{ rate: 25, base: 100, amount: 25 }, { rate: 12, base: 100, amount: 12 }],
      }),
      bank: { ...BANK, amountSek: -237 },
    }))
    expect(plan.vat).toEqual({ kind: 'input', amount: 37, rates: [0.25, 0.12] })
    expect(balanced(plan.lines)).toBe(true)
  })

  it('a Swedish document with no VAT books no VAT line', () => {
    const plan = planOneClick(input({ category: 'expense.bank_fees.fees', reading: doc({ supplier: { name: 'Banken' }, totals: { total: 150 } }) }))
    expect(plan.vat).toEqual({ kind: 'none' })
    expect(pairs(plan)).toEqual([['6570', 150, 0], ['1930', 0, 150]])
  })

  it('opens the editor for VAT above 25 % of the net, and for mixed rates without a breakdown', () => {
    const tooMuch = planOneClick(input({ reading: doc({ supplier: { orgNumber: '5560358672' }, totals: { subtotal: 100, vatAmount: 40, total: 140 } }), bank: { ...BANK, amountSek: -140 } }))
    expect([tooMuch.ask, tooMuch.reason]).toEqual(['editor', 'vat_exceeds_rate'])
    const mixed = planOneClick(input({
      reading: doc({
        supplier: { orgNumber: '5560358672' },
        totals: { subtotal: 200, vatAmount: 37, total: 237 },
        lineItems: [
          { description: 'a', quantity: 1, unitPrice: 100, lineTotal: 100, vatRate: 25, accountSuggestion: null },
          { description: 'b', quantity: 1, unitPrice: 100, lineTotal: 100, vatRate: 12, accountSuggestion: null },
        ],
      }),
      bank: { ...BANK, amountSek: -237 },
    }))
    expect([mixed.ask, mixed.reason]).toEqual(['editor', 'mixed_rates'])
  })

  it('opens the editor, prefilled with the cost and the bank, for a hotel abroad', () => {
    const plan = planOneClick(input({
      category: 'expense.travel.hotel',
      reading: doc({ supplier: { name: 'Hotel Adlon', vatNumber: 'DE123456789' }, invoice: { currency: 'EUR' }, totals: { total: 200 } }),
      bank: { ...BANK, amountSek: -2300 },
    }))
    expect([plan.ask, plan.reason]).toEqual(['editor', 'exception_abroad'])
    expect(pairs(plan)).toEqual([['5831', 2300, 0], ['1930', 0, 2300]])
  })

  it('opens the editor for goods bought abroad', () => {
    const plan = planOneClick(input({
      category: 'expense.equipment.hardware',
      reading: doc({ supplier: { name: 'Apple', address: 'One Apple Park Way, Cupertino, CA 95014, United States' }, invoice: { currency: 'USD' }, totals: { total: 999 } }),
      bank: { ...BANK, amountSek: -10500 },
    }))
    expect([plan.ask, plan.reason]).toEqual(['editor', 'goods_abroad'])
  })

  it('opens the editor when a foreign seller charged VAT', () => {
    const plan = planOneClick(input({
      reading: doc({ supplier: { vatNumber: 'DE123456789' }, invoice: { currency: 'EUR' }, totals: { subtotal: 10, vatAmount: 1.9, total: 11.9 } }),
      bank: { ...BANK, amountSek: -137 },
    }))
    expect([plan.ask, plan.reason]).toEqual(['editor', 'foreign_vat'])
  })

  it('opens the editor for a company that is not VAT-registered buying a service abroad', () => {
    const plan = planOneClick(input({
      kind: 'supplier_invoice',
      reading: WISPR,
      paidByReceipt: true,
      company: { vatRegistered: false, cashMethod: false, supplierInvoices: true },
    }))
    expect([plan.ask, plan.reason]).toEqual(['editor', 'not_vat_registered_abroad'])
  })

  it('books a Swedish seller\'s VAT on the cost for a company that is not VAT-registered', () => {
    const plan = planOneClick(input({
      category: 'expense.office.supplies',
      company: { vatRegistered: false, cashMethod: false, supplierInvoices: true },
      reading: doc({ supplier: { orgNumber: '556035-8672' }, totals: { subtotal: 100, vatAmount: 25, total: 125 } }),
      bank: { ...BANK, amountSek: -125 },
    }))
    expect(plan.vat).toEqual({ kind: 'cost', amount: 25 })
    expect(pairs(plan)).toEqual([['6110', 125, 0], ['1930', 0, 125]])
  })
})

describe('planOneClick: where the seller is, when nothing says', () => {
  const unknown = doc({ supplier: { name: 'Acme', address: '12 Harbour Road, Unit 4' }, totals: { total: 150 } })

  it('asks, for a document with no VAT that looks foreign', () => {
    const plan = planOneClick(input({ reading: unknown }))
    expect([plan.ask, plan.reason]).toEqual(['seller_country', 'seller_country_unknown'])
  })

  it('books with the person\'s answer', () => {
    const plan = planOneClick(input({ reading: unknown, sellerRegionAnswer: 'eu' }))
    expect(plan.ask).toBeNull()
    expect(plan.vat).toEqual({ kind: 'reverse_charge', rcKind: 'eu_services', rate: 0.25 })
    expect(plan.seller).toEqual({ country: null, region: 'eu' })
  })

  it('asks for a foreign currency too', () => {
    const plan = planOneClick(input({ reading: doc({ supplier: { name: 'Acme' }, invoice: { currency: 'USD' }, totals: { total: 15 } }) }))
    expect(plan.ask).toBe('seller_country')
  })

  it('takes a Swedish-looking document without a country as Swedish', () => {
    const plan = planOneClick(input({ category: 'expense.office.supplies', reading: doc({ supplier: { name: 'Kontorsvaruhuset' }, totals: { subtotal: 120, vatAmount: 30, total: 150 } }) }))
    expect(plan.ask).toBeNull()
    expect(plan.seller.region).toBe('se')
    expect(plan.vat).toEqual({ kind: 'input', amount: 30, rates: [0.25] })
  })
})

// A Swedish VAT number beside an address abroad: whether the seller is
// established here for the sale decides who owes the VAT (ML 2023:200
// 16 kap. 4 och 9 §§), and the document cannot tell. One click asks.
describe('planOneClick: a Swedish VAT number beside an address abroad', () => {
  const supplier = { name: 'Example Cloud Pte. Ltd.', vatNumber: 'SE502012345601', address: '1 Example Road\nSingapore 123456\nSingapore' }

  it('opens the editor for a charge, never deducting it as Swedish input VAT', () => {
    const reading = doc({ supplier, totals: { subtotal: 120, vatAmount: 30, total: 150 } })
    const plan = planOneClick(input({ reading }))
    expect([plan.ask, plan.reason]).toEqual(['editor', 'swedish_vat_number_abroad'])
    expect(plan.vat).toEqual({ kind: 'none' })
    expect(pairs(plan).map(([account]) => account)).not.toContain('2641')
  })

  it('says why in a foreign currency too', () => {
    const reading = doc({ supplier, invoice: { currency: 'USD' }, totals: { subtotal: 52.24, vatAmount: 13.06, total: 65.3 } })
    const plan = planOneClick(input({ reading, bank: { ...BANK, amountSek: -620 } }))
    expect([plan.ask, plan.reason]).toEqual(['editor', 'swedish_vat_number_abroad'])
  })

  it('reads a Peppol delivery\'s address, which ends with the country code', () => {
    const reading = doc({ supplier: { ...supplier, address: 'Hauptstr. 1, 10117 Berlin, DE' }, totals: { subtotal: 120, vatAmount: 30, total: 150 } })
    const plan = planOneClick(input({ reading }))
    expect([plan.ask, plan.reason]).toEqual(['editor', 'swedish_vat_number_abroad'])
  })

  it('reads an address that ends with UK and a phone number', () => {
    const reading = doc({
      supplier: { ...supplier, address: '10 Example Street, London EC1A 1BB, UK\nTel +44 20 7946 0000' },
      totals: { subtotal: 120, vatAmount: 30, total: 150 },
    })
    const plan = planOneClick(input({ reading }))
    expect([plan.ask, plan.reason]).toEqual(['editor', 'swedish_vat_number_abroad'])
    expect(pairs(plan).map(([account]) => account)).not.toContain('2641')
  })

  it('asks where the seller is for a document without a charge', () => {
    const plan = planOneClick(input({ reading: doc({ supplier, totals: { vatAmount: 0, total: 150 } }) }))
    expect([plan.ask, plan.reason]).toEqual(['seller_country', 'seller_country_unknown'])
  })

  it('books with the person\'s answer', () => {
    const plan = planOneClick(input({ reading: doc({ supplier, totals: { vatAmount: 0, total: 150 } }), sellerRegionAnswer: 'non_eu' }))
    expect(plan.ask).toBeNull()
    expect(plan.vat).toMatchObject({ kind: 'reverse_charge', rcKind: 'non_eu_services' })
  })
})

describe('planOneClick: the category and the account', () => {
  it('asks for a category when there is none, with nothing proposed', () => {
    const plan = planOneClick(input({ category: null }))
    expect([plan.ask, plan.reason]).toEqual(['category', 'no_category'])
    expect(plan.lines).toEqual([])
    expect(plan.form).toBe('direct')
  })

  it('takes the counterparty\'s booked account when it belongs to the category', () => {
    expect(costAccountFor('expense.software.saas', '6540', '5420')).toBe('6540')
  })

  it('then the supplier\'s default account when it does', () => {
    expect(costAccountFor('expense.software.saas', '6990', '6540')).toBe('6540')
  })

  it('then the category\'s usual account', () => {
    expect(costAccountFor('expense.software.saas', '6990', '4010')).toBe('5420')
    expect(costAccountFor('expense.software.saas', null, null)).toBe('5420')
  })

  it('reads a company sub-account as its main account', () => {
    expect(costAccountFor('expense.software.saas', '5421', null)).toBe('5421')
  })

  // accounted#86: a customer meal is not income-tax deductible since 2017
  // (IL 16 kap. 2 §), so the category's usual account is 6072. A company
  // that books the counterparty on 6071 keeps it: its own history wins.
  it('takes 6072 for a customer meal, unless the counterparty is booked on 6071', () => {
    expect(costAccountFor('expense.representation.client', null, null)).toBe('6072')
    expect(costAccountFor('expense.representation.client', '6071', null)).toBe('6071')
  })
})

describe('planOneClick: the form', () => {
  const invoice = doc({
    documentKind: 'supplier_invoice',
    supplier: { name: 'Konsult AB', orgNumber: '556677-8899', address: 'Kungsgatan 1, 111 22 Stockholm', bankgiro: '5050-1055' },
    invoice: { invoiceNumber: 'F-1001', invoiceDate: '2026-09-01', dueDate: '2026-09-30', paymentReference: '1234567897' },
    totals: { subtotal: 1000, vatAmount: 250, total: 1250 },
  })
  const consulting = { category: 'expense.professional_services.consulting' as const, kind: 'supplier_invoice' as const, reading: invoice }

  it('registers and settles an invoice paid later than a week after its date, the package on', () => {
    const plan = planOneClick(input({ ...consulting, bank: { ...BANK, date: '2026-09-28', amountSek: -1250 } }))
    expect(plan.form).toBe('register_and_settle')
    expect(plan.reason).toBe('paid_later')
    expect(plan.entryDate).toBe('2026-09-01')
    expect(plan.paymentDate).toBe('2026-09-28')
    expect(plan.transactionId).toBe('tx-1')
    expect(plan.invoice).toEqual({
      supplier_invoice_number: 'F-1001',
      invoice_date: '2026-09-01',
      due_date: '2026-09-30',
      currency: 'SEK',
      reverse_charge: false,
      payment_reference: '1234567897',
      // The document's VAT for the rate, booked as stated (crm#1367).
      vat_breakdown: [{ vat_rate: 0.25, vat_amount: 250 }],
      items: [{ description: 'Konsult AB', amount: 1000, account_number: '6550', vat_rate: 0.25 }],
    })
    expect(pairs(plan)).toEqual([['6550', 1000, 0], ['2641', 250, 0], ['2440', 0, 1250]])
    expect(plan.supplier).toEqual({
      create: {
        name: 'Konsult AB',
        supplier_type: 'swedish_business',
        org_number: '556677-8899',
        address_line1: 'Kungsgatan 1, 111 22 Stockholm',
        country: 'SE',
        bankgiro: '5050-1055',
      },
    })
  })

  it('registers the VAT the invoice states when it is the net x rate within an öre (crm#1367)', () => {
    // 1 000,03 x 25 % = 250,0075, which rounds to 250,01; the invoice says 250,00.
    const reading = { ...invoice, totals: { subtotal: 1000.03, vatAmount: 250, total: 1250.03 }, vatBreakdown: [{ rate: 25, base: 1000.03, amount: 250 }] }
    const plan = planOneClick(input({ ...consulting, reading, bank: { ...BANK, date: '2026-09-28', amountSek: -1250.03 } }))
    expect(plan.form).toBe('register_and_settle')
    expect(plan.invoice?.vat_breakdown).toEqual([{ vat_rate: 0.25, vat_amount: 250 }])
    expect(pairs(plan)).toEqual([['6550', 1000.03, 0], ['2641', 250, 0], ['2440', 0, 1250.03]])
  })

  it('reads the stated VAT against the exact VAT on the net: 9,25 kr at 6 % is 0,56 kr', () => {
    // A seller's 0,57 kr is within the öre rounding allows of 0,56 kr; against
    // the float product's 0,55 kr it read as a mismatch and opened the editor.
    const reading = { ...invoice, totals: { subtotal: 9.25, vatAmount: 0.57, total: 9.82 }, vatBreakdown: [{ rate: 6, base: 9.25, amount: 0.57 }] }
    const plan = planOneClick(input({ ...consulting, reading, bank: { ...BANK, date: '2026-09-28', amountSek: -9.82 } }))
    expect(plan.reason).toBe('paid_later')
    expect(pairs(plan)).toEqual([['6550', 9.25, 0], ['2641', 0.57, 0], ['2440', 0, 9.82]])
  })

  it('books it like a receipt when Leverantörsfakturor is off', () => {
    const plan = planOneClick(input({ ...consulting, bank: { ...BANK, date: '2026-09-28', amountSek: -1250 }, company: { vatRegistered: true, cashMethod: false, supplierInvoices: false } }))
    expect(plan.form).toBe('direct')
    expect(plan.reason).toBe('paid_package_off')
    expect(pairs(plan)).toEqual([['6550', 1000, 0], ['2641', 250, 0], ['1930', 0, 1250]])
    // Within 31 days before the bank date: the invoice's own date.
    expect(plan.entryDate).toBe('2026-09-01')
  })

  it('books an invoice paid within a week of its date directly', () => {
    const plan = planOneClick(input({ ...consulting, bank: { ...BANK, date: '2026-09-06', amountSek: -1250 } }))
    expect([plan.form, plan.reason]).toEqual(['direct', 'paid_at_purchase'])
  })

  it('registers an unpaid invoice, with its due date and number from the reading', () => {
    const plan = planOneClick(input({ ...consulting, bank: null }))
    expect(plan.form).toBe('register')
    expect(plan.ask).toBeNull()
    expect(plan.transactionId).toBeNull()
    expect(plan.entryDate).toBe('2026-09-01')
    expect(plan.invoice?.due_date).toBe('2026-09-30')
    expect(balanced(plan.lines)).toBe(true)
  })

  it('opens the editor for an invoice whose Att betala is öresavrundad, even by one öre', () => {
    // 132,81 + 25 % moms 33,20 = 166,01; the supplier bills 166. Registering
    // the rows left the reskontra an öre above what the invoice asks for.
    const oneOre = { ...invoice, totals: { subtotal: 132.81, vatAmount: 33.2, total: 166 }, vatBreakdown: [{ rate: 25, base: 132.81, amount: 33.2 }] }
    const plan = planOneClick(input({ ...consulting, bank: null, reading: oneOre }))
    expect([plan.form, plan.ask, plan.reason]).toEqual(['register', 'editor', 'amount_mismatch'])
    const fortyOre = { ...invoice, totals: { subtotal: 4990, vatAmount: 299.4, total: 5289 }, vatBreakdown: [{ rate: 6, base: 4990, amount: 299.4 }] }
    expect(planOneClick(input({ ...consulting, bank: null, reading: fortyOre })).reason).toBe('amount_mismatch')
  })

  it('names the matched supplier on a register path', () => {
    const plan = planOneClick(input({ ...consulting, bank: null, supplier: { id: 'sup-9', supplierType: 'swedish_business', defaultExpenseAccount: '6550', paymentTermsDays: 30 } }))
    expect(plan.supplier).toEqual({ id: 'sup-9' })
  })

  it('opens the form when the matched supplier card is typed for another country than the document', () => {
    const plan = planOneClick(input({ ...consulting, bank: null, supplier: { id: 'sup-9', supplierType: 'eu_business', defaultExpenseAccount: null, paymentTermsDays: 30 } }))
    expect([plan.form, plan.ask, plan.reason]).toEqual(['register', 'editor', 'supplier_type_mismatch'])
  })

  it('opens the form for an unpaid invoice without its due date or its number', () => {
    const noDue = planOneClick(input({ ...consulting, bank: null, reading: { ...invoice, invoice: { ...invoice.invoice, dueDate: null } } }))
    expect([noDue.form, noDue.ask, noDue.reason]).toEqual(['register', 'editor', 'missing_due_date'])
    const noNumber = planOneClick(input({ ...consulting, bank: null, reading: { ...invoice, invoice: { ...invoice.invoice, invoiceNumber: null } } }))
    expect([noNumber.ask, noNumber.reason]).toEqual(['editor', 'missing_invoice_number'])
    // Its account still reaches the form.
    expect(noNumber.costAccount).toBe('6550')
  })

  it('defaults a paid invoice\'s missing due date from the supplier\'s terms', () => {
    const plan = planOneClick(input({ ...consulting, reading: { ...invoice, invoice: { ...invoice.invoice, dueDate: null } }, bank: { ...BANK, date: '2026-09-28', amountSek: -1250 } }))
    expect(plan.invoice?.due_date).toBe('2026-10-01')
  })

  it('leaves an unpaid invoice under kontantmetoden or with the package off to its own answers', () => {
    expect(planOneClick(input({ ...consulting, bank: null, company: { vatRegistered: true, cashMethod: true, supplierInvoices: true } })).reason).toBe('cash_method_unpaid')
    expect(planOneClick(input({ ...consulting, bank: null, company: { vatRegistered: true, cashMethod: false, supplierInvoices: false } })).reason).toBe('package_off_unpaid')
  })

  it('has no one-click answer for a receipt without a bank row, or a credit note', () => {
    expect(planOneClick(input({ bank: null })).form).toBeNull()
    expect(planOneClick(input({ kind: 'credit_note' })).reason).toBe('credit_note')
  })

  it('books an item already linked to its bank row directly', () => {
    const plan = planOneClick(input({ ...consulting, bank: { ...BANK, date: '2026-09-28', amountSek: -1250, source: 'matched' } }))
    expect([plan.form, plan.reason]).toEqual(['direct', 'linked'])
  })

  it('refuses money in, and a bank row without kronor', () => {
    expect(planOneClick(input({ bank: { ...BANK, amountSek: 150 } })).reason).toBe('not_money_out')
    expect(planOneClick(input({ bank: { ...BANK, amountSek: null } })).reason).toBe('no_kronor_amount')
  })

  it('opens the editor when the document\'s total is not what the bank paid', () => {
    const plan = planOneClick(input({ category: 'expense.office.supplies', reading: doc({ supplier: { orgNumber: '5560358672' }, totals: { subtotal: 100, vatAmount: 25, total: 125 } }), bank: { ...BANK, amountSek: -200 } }))
    expect([plan.ask, plan.reason]).toEqual(['editor', 'amount_mismatch'])
  })

  it('registers a foreign invoice at the invoice date\'s rate', () => {
    const plan = planOneClick(input({
      kind: 'supplier_invoice',
      category: 'expense.software.saas',
      bank: null,
      invoiceRate: 11.5,
      reading: doc({
        documentKind: 'supplier_invoice',
        supplier: { name: 'Atlassian', vatNumber: 'IE9822351I' },
        invoice: { invoiceNumber: 'AT-1', invoiceDate: '2026-10-01', dueDate: '2026-10-31', currency: 'EUR' },
        totals: { total: 100, vatAmount: 0 },
      }),
    }))
    expect(plan.form).toBe('register')
    expect(plan.invoice).toMatchObject({ currency: 'EUR', exchange_rate: 11.5, reverse_charge: true, vat_treatment: 'reverse_charge', reverse_charge_kind: 'eu_services' })
    expect(plan.invoice?.items).toEqual([{ description: 'Atlassian', amount: 100, account_number: '5420', vat_rate: 0, reverse_charge_rate: 0.25 }])
    expect(pairs(plan)).toEqual([
      ['5420', 1150, 0],
      ['2440', 0, 1150],
      ['2645', 287.5, 0],
      ['2614', 0, 287.5],
      ['4535', 1150, 0],
      ['4598', 0, 1150],
    ])
    expect((plan.supplier as { create: { supplier_type: string } }).create.supplier_type).toBe('eu_business')
  })

  it('opens the form for a foreign invoice whose rate could not be read', () => {
    const plan = planOneClick(input({
      kind: 'supplier_invoice',
      bank: null,
      reading: doc({ documentKind: 'supplier_invoice', supplier: { name: 'Atlassian', vatNumber: 'IE9822351I' }, invoice: { invoiceNumber: 'AT-1', invoiceDate: '2026-10-01', dueDate: '2026-10-31', currency: 'EUR' }, totals: { total: 100 } }),
    }))
    expect([plan.ask, plan.reason]).toEqual(['editor', 'fx_rate_missing'])
  })
})

describe('purchaseEntryDate (R4)', () => {
  it('takes the document\'s date within 31 days before and 3 days after the bank date', () => {
    expect(purchaseEntryDate('2026-09-14', '2026-10-14', false)).toBe('2026-09-14')
    expect(purchaseEntryDate('2026-10-17', '2026-10-14', false)).toBe('2026-10-17')
  })

  it('takes the bank date outside that window', () => {
    expect(purchaseEntryDate('2026-09-12', '2026-10-14', false)).toBe('2026-10-14')
    expect(purchaseEntryDate('2026-10-18', '2026-10-14', false)).toBe('2026-10-14')
    expect(purchaseEntryDate(null, '2026-10-14', false)).toBe('2026-10-14')
  })

  it('always takes the bank date under kontantmetoden', () => {
    expect(purchaseEntryDate('2026-10-13', '2026-10-14', true)).toBe('2026-10-14')
    const plan = planOneClick(input({ kind: 'supplier_invoice', reading: WISPR, paidByReceipt: true, company: { vatRegistered: true, cashMethod: true, supplierInvoices: true } }))
    expect(plan.entryDate).toBe('2026-10-14')
  })

  it('books a kontantmetoden register-and-settle on the bank date, against the bank', () => {
    const plan = planOneClick(input({
      kind: 'supplier_invoice',
      category: 'expense.professional_services.consulting',
      company: { vatRegistered: true, cashMethod: true, supplierInvoices: true },
      bank: { ...BANK, date: '2026-09-28', amountSek: -1250 },
      reading: doc({
        documentKind: 'supplier_invoice',
        supplier: { name: 'Konsult AB', orgNumber: '5566778899' },
        invoice: { invoiceNumber: 'F-1', invoiceDate: '2026-09-01', dueDate: '2026-09-30' },
        totals: { subtotal: 1000, vatAmount: 250, total: 1250 },
      }),
    }))
    expect(plan.form).toBe('register_and_settle')
    expect(plan.entryDate).toBe('2026-09-28')
    expect(pairs(plan)).toEqual([['6550', 1000, 0], ['2641', 250, 0], ['1930', 0, 1250]])
  })
})

describe('planOneClick: deductions a click cannot settle', () => {
  /** A restaurant receipt like Arcim's A407, 2026-10-20: 370 kr, 12 %. */
  const LUNCH = doc({
    supplier: { name: 'Restaurang Exempel AB', orgNumber: '5560000001', address: 'Storgatan 1, 111 22 Stockholm' },
    invoice: { invoiceDate: '2026-10-13' },
    totals: { subtotal: 330.35, vatAmount: 39.65, total: 370 },
    vatBreakdown: [{ rate: 12, base: 330.35, amount: 39.65 }],
  })

  it('opens the editor for representation, prefilled with the receipt\'s VAT (ML 13 kap 25 §: 300 kr per person)', () => {
    const plan = planOneClick(input({ category: 'expense.representation.staff', reading: LUNCH, bank: { ...BANK, amountSek: -370 } }))
    expect(plan.ask).toBe('editor')
    expect(plan.reason).toBe('limited_deduction')
    expect(plan.vat).toEqual({ kind: 'input', amount: 39.65, rates: [0.12] })
    expect(pairs(plan)).toEqual([
      ['7632', 330.35, 0],
      ['2641', 39.65, 0],
      ['1930', 0, 370],
    ])
    expect(balanced(plan.lines)).toBe(true)
  })

  it.each([
    'expense.representation.client',
    'expense.travel.meals',
    'expense.travel.car_rental',
    'expense.vehicle.leasing',
    'expense.marketing.gifts',
    'expense.personnel.gifts',
    'expense.personnel.wellness',
  ] as const)('opens the editor for %s from a Swedish seller', (category) => {
    const plan = planOneClick(input({ category, reading: LUNCH, bank: { ...BANK, amountSek: -370 } }))
    expect(plan.ask).toBe('editor')
    expect(plan.reason).toBe('limited_deduction')
  })

  it('refuses the one click on the book door too: a registration of a representation invoice opens the form', () => {
    const plan = planOneClick(input({
      kind: 'supplier_invoice',
      bank: null,
      category: 'expense.representation.client',
      reading: doc({
        documentKind: 'supplier_invoice',
        supplier: { name: 'Restaurang Exempel AB', orgNumber: '5560000001' },
        invoice: { invoiceNumber: 'R-1', invoiceDate: '2026-10-13', dueDate: '2026-11-12' },
        totals: { subtotal: 1000, vatAmount: 120, total: 1120 },
      }),
    }))
    expect(plan.form).toBe('register')
    expect(plan.ask).toBe('editor')
    expect(plan.reason).toBe('limited_deduction')
  })

  it('still books fuel, a running cost of the car, in one click (ML 13 kap 23 §)', () => {
    const plan = planOneClick(input({
      category: 'expense.vehicle.fuel',
      reading: doc({ supplier: { name: 'Bensinstation AB', orgNumber: '5560000002' }, totals: { subtotal: 400, vatAmount: 100, total: 500 } }),
      bank: { ...BANK, amountSek: -500 },
    }))
    expect(plan.ask).toBeNull()
    expect(plan.vat).toEqual({ kind: 'input', amount: 100, rates: [0.25] })
  })

  const LAPTOP = (total: number) =>
    doc({ supplier: { name: 'Datorbutiken AB', orgNumber: '5560000003' }, totals: { subtotal: total * 0.8, vatAmount: total * 0.2, total } })

  it('opens the editor for equipment above half a prisbasbelopp, an inventarie to capitalise (IL 18 kap 4 §)', () => {
    const plan = planOneClick(input({ category: 'expense.equipment.hardware', reading: LAPTOP(37_500), bank: { ...BANK, amountSek: -37_500 } }))
    expect(plan.ask).toBe('editor')
    expect(plan.reason).toBe('possible_asset')
  })

  it('books equipment below the limit as a cost in one click', () => {
    const plan = planOneClick(input({ category: 'expense.equipment.hardware', reading: LAPTOP(12_500), bank: { ...BANK, amountSek: -12_500 } }))
    expect(plan.ask).toBeNull()
    expect(plan.form).toBe('direct')
  })
})

describe('planOneClick: construction work with no VAT on it', () => {
  const SUBCONTRACTOR = doc({
    supplier: { name: 'Snickeri Exempel AB', orgNumber: '5560000004' },
    totals: { subtotal: 8000, vatAmount: 0, total: 8000 },
  })

  it('opens the editor: the buyer may be the one to pay the VAT (ML 16 kap 13 §)', () => {
    const plan = planOneClick(input({ category: 'expense.goods.subcontracting', reading: SUBCONTRACTOR, bank: { ...BANK, amountSek: -8000 } }))
    expect(plan.ask).toBe('editor')
    expect(plan.reason).toBe('possible_domestic_reverse_charge')
  })

  it('books the same work with Swedish VAT on it in one click', () => {
    const plan = planOneClick(input({
      category: 'expense.premises.repairs',
      reading: doc({ supplier: { name: 'Snickeri Exempel AB', orgNumber: '5560000004' }, totals: { subtotal: 8000, vatAmount: 2000, total: 10_000 } }),
      bank: { ...BANK, amountSek: -10_000 },
    }))
    expect(plan.ask).toBeNull()
    expect(plan.vat).toEqual({ kind: 'input', amount: 2000, rates: [0.25] })
  })
})

describe('planOneClick: the company and the rule ask for a review (accounted#130)', () => {
  const wispr = { kind: 'supplier_invoice' as const, reading: WISPR, paidByReceipt: true, receiptDate: '2026-10-13' }

  it('books in one click while the switch is on and the rule does not ask', () => {
    expect(planOneClick(input({ ...wispr, directBooking: { enabled: true }, counterpartyAlwaysReview: false })).ask).toBeNull()
  })

  it('opens the editor on the whole plan when the company switched one click off', () => {
    const plan = planOneClick(input({ ...wispr, directBooking: { enabled: false } }))
    expect(plan).toMatchObject({ form: 'direct', ask: 'editor', reason: 'review_required', transactionId: 'tx-1' })
    // Prefilled with what one click would have booked: nothing is lost by asking.
    expect(plan.vat).toEqual({ kind: 'reverse_charge', rcKind: 'non_eu_services', rate: 0.25 })
    expect(balanced(plan.lines)).toBe(true)
  })

  it("opens the editor when the counterpart's rule always asks", () => {
    expect(planOneClick(input({ ...wispr, counterpartyAlwaysReview: true }))).toMatchObject({ ask: 'editor', reason: 'review_required' })
  })

  it('keeps a more specific question: the category is asked before the review', () => {
    expect(planOneClick(input({ ...wispr, category: null, directBooking: { enabled: false } }))).toMatchObject({ ask: 'category', reason: 'no_category' })
  })

  // Step 2: a booking review rule that matches the plan's lines and its bank
  // row (or the supplier) opens the editor; one that does not leaves it.
  const blockRule = (overrides: Record<string, unknown>) => ({
    id: 'r-1', rule_id: 'r-1', version: 1, accounts: null, counterparty_key: null, counterparty_label: null,
    amount_from_sek: null, vat_treatment: null, note: null, valid_from: '2026-10-29T00:00:00Z', created_by: 'u-1',
    created_at: '2026-10-29T00:00:00Z', revoked_at: null, revoked_by: null, revoked_reason: null,
    ...overrides,
  })

  it('opens the editor when a booking review rule matches the plan', () => {
    const review = (rules: ReturnType<typeof blockRule>[]) => ({ rules, counterpartyKey: 'wispr', amountSek: -150 }) as never
    expect(planOneClick(input({ ...wispr, bookingReview: review([blockRule({ vat_treatment: 'reverse_charge' })]) }))).toMatchObject({
      ask: 'editor',
      reason: 'review_required',
    })
    expect(planOneClick(input({ ...wispr, bookingReview: review([blockRule({ counterparty_key: 'wispr', amount_from_sek: 100 })]) })).ask).toBe('editor')
    expect(planOneClick(input({ ...wispr, bookingReview: review([blockRule({ counterparty_key: 'wispr', amount_from_sek: 1000 })]) })).ask).toBeNull()
    expect(planOneClick(input({ ...wispr, bookingReview: review([blockRule({ vat_treatment: 'reduced_6' })]) })).ask).toBeNull()
  })

  it('reads an unknown bank amount as meeting an amount criterion', () => {
    const review = { rules: [blockRule({ amount_from_sek: 1_000_000 })], counterpartyKey: 'wispr', amountSek: null } as never
    expect(planOneClick(input({ ...wispr, bookingReview: review })).ask).toBe('editor')
  })

  it('judges the matched supplier card too, by whose name the database keys a registered invoice', () => {
    const review = (supplierKey: string) =>
      ({ rules: [blockRule({ counterparty_key: 'wispr flow' })], counterpartyKey: 'wispr', supplierKey, amountSek: -150 }) as never
    expect(planOneClick(input({ ...wispr, bookingReview: review('wispr flow') })).ask).toBe('editor')
    expect(planOneClick(input({ ...wispr, bookingReview: review('') })).ask).toBeNull()
  })
})

describe('planOneClick: a payment reference another invoice of the supplier already carries', () => {
  // The same OCR on one other live invoice may be the same invoice under
  // another number: a person acknowledges it in the editor's review step
  // ("Registrera ändå"), so one click never registers past it.
  const invoice = doc({
    documentKind: 'supplier_invoice',
    supplier: { name: 'Konsult AB', orgNumber: '556677-8899', address: 'Kungsgatan 1, 111 22 Stockholm' },
    invoice: { invoiceNumber: 'F-1002', invoiceDate: '2026-09-01', dueDate: '2026-09-30', paymentReference: '1234567897' },
    totals: { subtotal: 1000, vatAmount: 250, total: 1250 },
  })
  const card = { id: 'sup-9', supplierType: 'swedish_business', defaultExpenseAccount: '6550', paymentTermsDays: 30 }
  const unpaid = {
    category: 'expense.professional_services.consulting' as const,
    kind: 'supplier_invoice' as const,
    reading: invoice,
    supplier: card,
    bank: null,
  }
  const paidLater = { ...BANK, date: '2026-09-28', amountSek: -1250 }

  it('registers in one click while the reference is new to the supplier, or its normal', () => {
    expect(planOneClick(input(unpaid))).toMatchObject({ form: 'register', ask: null, reason: 'unpaid' })
    expect(planOneClick(input({ ...unpaid, referenceToAcknowledge: false }))).toMatchObject({ form: 'register', ask: null })
  })

  it('opens the editor, on the whole plan, when the reference is on one other invoice', () => {
    const plan = planOneClick(input({ ...unpaid, referenceToAcknowledge: true }))
    expect([plan.form, plan.ask, plan.reason]).toEqual(['register', 'editor', 'payment_reference_reused'])
    expect(plan.invoice?.payment_reference).toBe('1234567897')
    expect(plan.costAccount).toBe('6550')
    expect(plan.supplier).toEqual({ id: 'sup-9' })
    expect(balanced(plan.lines)).toBe(true)
  })

  it('opens it for an invoice paid later too, which one click would register and settle', () => {
    expect(planOneClick(input({ ...unpaid, bank: paidLater }))).toMatchObject({ form: 'register_and_settle', ask: null })
    const plan = planOneClick(input({ ...unpaid, bank: paidLater, referenceToAcknowledge: true }))
    expect([plan.form, plan.ask, plan.reason]).toEqual(['register_and_settle', 'editor', 'payment_reference_reused'])
  })

  it('still books a purchase paid at once as one verifikat: no supplier invoice, so no reference is stored', () => {
    const plan = planOneClick(input({ ...unpaid, referenceToAcknowledge: true, bank: { ...BANK, date: '2026-09-03', amountSek: -1250 } }))
    expect([plan.form, plan.ask, plan.reason]).toEqual(['direct', null, 'paid_at_purchase'])
  })

  it('asks nothing for a reading without a reference: none is stored', () => {
    const noReference = { ...invoice, invoice: { ...invoice.invoice, paymentReference: null } }
    expect(planOneClick(input({ ...unpaid, reading: noReference, referenceToAcknowledge: true }))).toMatchObject({ form: 'register', ask: null })
  })

  it('keeps a more specific question, and names the reference before the general review switch', () => {
    const noDueDate = { ...invoice, invoice: { ...invoice.invoice, dueDate: null } }
    expect(planOneClick(input({ ...unpaid, reading: noDueDate, referenceToAcknowledge: true })).reason).toBe('missing_due_date')
    expect(planOneClick(input({ ...unpaid, referenceToAcknowledge: true, directBooking: { enabled: false } })).reason).toBe('payment_reference_reused')
  })
})

describe('oneClickOutcome', () => {
  it('says the Wispr plan books in one click, in codes only', async () => {
    const { oneClickOutcome } = await import('../inkorg-one-click')
    const wispr = input({ kind: 'supplier_invoice', reading: WISPR, paidByReceipt: true, receiptDate: '2026-10-13' })
    const outcome = oneClickOutcome(wispr, planOneClick(wispr), { category: false, seller: false })
    expect(outcome).toEqual({
      oneClick: true,
      form: 'direct',
      ask: null,
      reason: 'paid_by_receipt',
      vat: 'reverse_charge',
      category: 'expense.software.saas',
      region: 'non_eu',
      bank: 'proposal',
      kind: 'supplier_invoice',
      answered: { category: false, seller: false },
    })
    // Nothing a person wrote, no amount and no name, reaches the log.
    const text = JSON.stringify(outcome)
    expect(text).not.toMatch(/Wispr|150|Market Street/)
  })

  it('names why a plan does not book', async () => {
    const { oneClickOutcome } = await import('../inkorg-one-click')
    const noCategory = input({ category: null })
    expect(oneClickOutcome(noCategory, planOneClick(noCategory), { category: false, seller: false })).toMatchObject({
      oneClick: false,
      ask: 'category',
      reason: 'no_category',
    })
    const noBank = input({ bank: null })
    expect(oneClickOutcome(noBank, planOneClick(noBank), { category: false, seller: false })).toMatchObject({ oneClick: false, bank: 'none' })
  })
})

describe("the company's own invoice (crm#1830)", () => {
  it('is never booked as a cost in one click, with or without a bank row', () => {
    const own = { ...doc({ documentKind: 'other', totals: { subtotal: 120, vatAmount: 30, total: 150 } }), sellerIsOwnCompany: true }
    for (const bank of [BANK, { ...BANK, source: 'matched' as const }, null]) {
      const plan = planOneClick(input({ kind: 'other', reading: own, bank }))
      expect(plan.form).toBeNull()
      expect(plan.reason).toBe('own_invoice')
      expect(plan.lines).toEqual([])
    }
  })
})
