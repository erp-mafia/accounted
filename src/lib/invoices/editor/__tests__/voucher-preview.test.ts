import { describe, it, expect } from 'vitest'
import {
  draftAccrualEntryDates,
  proposeCreditNoteSendLines,
  proposeDraftCashLines,
  proposeDraftSendLines,
  type DraftVoucherInput,
} from '@/lib/invoices/editor/voucher-preview'
import { makeInvoice } from '@/tests/helpers'
import type { InvoiceItem } from '@/types'

function input(overrides: Partial<DraftVoucherInput> = {}): DraftVoucherInput {
  return {
    invoiceNumber: '1043',
    invoiceDate: '2026-10-26',
    currency: 'SEK',
    vatTreatment: 'standard_25',
    vatRegistered: true,
    defaultVatRate: 25,
    items: [
      { line_type: 'product', quantity: 2, unit_price: 1000, vat_rate: 25 },
      { line_type: 'text' },
      { line_type: 'product', quantity: 1, unit_price: 500, discount_percent: 10, vat_rate: 25 },
    ],
    entityType: 'aktiebolag',
    ...overrides,
  }
}

function amounts(lines: ReturnType<typeof proposeDraftSendLines>) {
  return lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])
}

describe('proposeDraftSendLines', () => {
  it('proposes the accrual voucher from the form rows (discount net, text rows ignored)', () => {
    // 2000 + 450 net, 25 % VAT 612.50, receivable 3062.50
    expect(amounts(proposeDraftSendLines(input()))).toEqual([
      ['1510', '3062.5', ''],
      ['3001', '', '2450'],
      ['2611', '', '612.5'],
    ])
  })

  it('splits revenue and VAT per rate', () => {
    const lines = proposeDraftSendLines(
      input({
        items: [
          { line_type: 'product', quantity: 1, unit_price: 1000, vat_rate: 25 },
          { line_type: 'product', quantity: 1, unit_price: 100, vat_rate: 12 },
        ],
      }),
    )
    expect(amounts(lines)).toEqual([
      ['1510', '1362', ''],
      ['3001', '', '1000'],
      ['2611', '', '250'],
      ['3002', '', '100'],
      ['2621', '', '12'],
    ])
  })

  it('falls back to the customer default rate for a row without one', () => {
    const lines = proposeDraftSendLines(
      input({ items: [{ line_type: 'product', quantity: 1, unit_price: 100, vat_rate: null }] }),
    )
    expect(amounts(lines)).toEqual([
      ['1510', '125', ''],
      ['3001', '', '100'],
      ['2611', '', '25'],
    ])
  })

  it('books no VAT for a seller that is not momsregistrerad', () => {
    const lines = proposeDraftSendLines(input({ vatRegistered: false }))
    expect(lines.some((l) => l.account_number.startsWith('26'))).toBe(false)
  })

  it('splits a ROT row into 1510 and 1513', () => {
    const lines = proposeDraftSendLines(
      input({
        items: [
          { line_type: 'product', quantity: 10, unit_price: 800, vat_rate: 25, deduction_type: 'rot', work_type: 'bygg' },
        ],
      }),
    )
    const accounts = lines.map((l) => l.account_number)
    expect(accounts).toContain('1513')
    expect(accounts[0]).toBe('1510')
  })

  it('shows nothing for a foreign currency (the SEK amounts need the send-time rate)', () => {
    expect(proposeDraftSendLines(input({ currency: 'EUR' }))).toEqual([])
  })

  it('shows nothing without a priced row', () => {
    expect(proposeDraftSendLines(input({ items: [{ line_type: 'text' }] }))).toEqual([])
    expect(proposeDraftSendLines(input({ items: [] }))).toEqual([])
  })
})

/** A periodiserad 100 000 kr row at 25 %. */
function accrualLine(start: string, end: string, account: string) {
  return {
    line_type: 'product' as const,
    quantity: 1,
    unit_price: 100000,
    vat_rate: 25,
    accrual_period_start: start,
    accrual_period_end: end,
    accrual_balance_account: account,
  }
}

// #114: the preview copied a hand-picked subset of the form row and credited
// 3001 where the booking credits the line's interim or own account.
describe('proposeDraftSendLines books what the send books (#114)', () => {
  // The issue's sandbox invoice F005: 100 000 kr for September on an
  // invoice dated 2026-10-26, Balanskonto 1790.
  const september = accrualLine('2026-09-01', '2026-09-30', '1790')

  it('credits 1790 for an upplupen intäkt, as the posted B verifikat does', () => {
    expect(amounts(proposeDraftSendLines(input({ items: [september] })))).toEqual([
      ['1510', '125000', ''],
      ['1790', '', '100000'],
      ['2611', '', '25000'],
    ])
  })

  it('credits 2970 for a förutbetald intäkt, and 2970 when no account was picked (the write default)', () => {
    const novemberDecember = accrualLine('2026-11-01', '2026-12-31', '2970')
    expect(amounts(proposeDraftSendLines(input({ items: [novemberDecember] })))[1]).toEqual(['2970', '', '100000'])
    expect(
      amounts(proposeDraftSendLines(input({ items: [{ ...novemberDecember, accrual_balance_account: null }] })))[1],
    ).toEqual(['2970', '', '100000'])
  })

  it('credits revenue for a row with half a period, and never defers a ROT row', () => {
    expect(
      amounts(proposeDraftSendLines(input({ items: [{ ...september, accrual_period_end: '' }] })))[1],
    ).toEqual(['3001', '', '100000'])
    const rot = proposeDraftSendLines(
      input({ items: [{ ...september, unit_price: 800, deduction_type: 'rot', work_type: 'bygg' }] }),
    )
    expect(rot.map((l) => l.account_number)).toEqual(['1510', '1513', '3001', '2611'])
  })

  it("credits the line's own account (an article's or the Konto strip's)", () => {
    const lines = proposeDraftSendLines(
      input({ items: [{ line_type: 'product', quantity: 1, unit_price: 1000, vat_rate: 25, revenue_account: '3041' }] }),
    )
    expect(amounts(lines)).toEqual([
      ['1510', '1250', ''],
      ['3041', '', '1000'],
      ['2611', '', '250'],
    ])
  })

  it("puts the line's dimensions over the invoice's on its revenue line", () => {
    const lines = proposeDraftSendLines(
      input({
        defaultDimensions: { '6': 'P1' },
        items: [
          { line_type: 'product', quantity: 1, unit_price: 1000, vat_rate: 25, dimensions: { '1': 'KS1' } },
          { line_type: 'product', quantity: 1, unit_price: 500, vat_rate: 25, dimensions: null },
        ],
      }),
    )
    expect(lines.filter((l) => l.account_number === '3001').map((l) => [l.credit_amount, l.dimensions])).toEqual([
      ['1000', { '1': 'KS1', '6': 'P1' }],
      ['500', { '6': 'P1' }],
    ])
  })
})

describe('draftAccrualEntryDates (#114)', () => {
  it('an upplupen intäkt books on the last day of each month (the posted H verifikat: 2026-09-30)', () => {
    expect(draftAccrualEntryDates(input({ items: [accrualLine('2026-09-01', '2026-09-30', '1790')] }))).toEqual(['2026-09-30'])
    expect(draftAccrualEntryDates(input({ items: [accrualLine('2026-07-01', '2026-09-30', '1790')] }))).toEqual([
      '2026-07-31',
      '2026-08-31',
      '2026-09-30',
    ])
  })

  it('a förutbetald intäkt dissolves on the first of each month, never before the invoice date', () => {
    expect(draftAccrualEntryDates(input({ items: [accrualLine('2026-11-01', '2026-12-31', '2970')] }))).toEqual([
      '2026-11-01',
      '2026-12-01',
    ])
    // Months already begun book on the invoice date (catch-up), the rest on their first.
    expect(draftAccrualEntryDates(input({ items: [accrualLine('2026-09-01', '2026-11-30', '2970')] }))).toEqual([
      '2026-10-26',
      '2026-10-26',
      '2026-11-01',
    ])
  })

  it('merges every line in date order and skips the rows the send does not defer', () => {
    expect(
      draftAccrualEntryDates(
        input({
          items: [
            accrualLine('2026-11-01', '2026-11-30', '2970'),
            { line_type: 'product', quantity: 1, unit_price: 10, vat_rate: 25 },
            accrualLine('2026-09-01', '2026-09-30', '1790'),
            { ...accrualLine('2026-11-01', '2026-12-31', '2970'), deduction_type: 'rot', work_type: 'bygg' },
          ],
        }),
      ),
    ).toEqual(['2026-09-30', '2026-11-01'])
    // Reverse charge and export keep their statutory account: never deferred.
    expect(
      draftAccrualEntryDates(
        input({ vatTreatment: 'reverse_charge_domestic', items: [{ ...accrualLine('2026-11-01', '2026-12-31', '2970'), vat_rate: 0 }] }),
      ),
    ).toEqual([])
    expect(draftAccrualEntryDates(input())).toEqual([])
  })
})

describe('proposeDraftCashLines (kontantfaktura, crm#1281)', () => {
  function cash(lines: ReturnType<typeof proposeDraftCashLines>) {
    return lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])
  }

  it('debits the chosen payment account against revenue and VAT: no 1510', () => {
    expect(cash(proposeDraftCashLines(input(), '1940'))).toEqual([
      ['1940', 3062.5, 0],
      ['3001', 0, 2450],
      ['2611', 0, 612.5],
    ])
  })

  it('keeps the Skatteverket share of a ROT row on 1513; the customer share is what was paid', () => {
    const lines = proposeDraftCashLines(
      input({ items: [{ line_type: 'product', quantity: 1, unit_price: 1000, vat_rate: 25, deduction_type: 'rot', work_type: 'bygg' }] }),
      '1930',
    )
    const byAccount = Object.fromEntries(lines.map((l) => [l.account_number, l]))
    expect(byAccount['1510']).toBeUndefined()
    expect(byAccount['1513'].debit_amount).toBeGreaterThan(0)
    expect(byAccount['1930'].debit_amount + byAccount['1513'].debit_amount).toBe(1250)
  })

  it('shows nothing for a foreign currency or without a priced row', () => {
    expect(proposeDraftCashLines(input({ currency: 'EUR' }), '1930')).toEqual([])
    expect(proposeDraftCashLines(input({ items: [{ line_type: 'text' }] }), '1930')).toEqual([])
  })
})

describe('proposeCreditNoteSendLines', () => {
  const original = () => ({
    ...makeInvoice({
      id: 'original-1',
      invoice_number: '1043',
      status: 'sent',
      currency: 'SEK',
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      vat_treatment: 'standard_25',
    }),
    items: [
      {
        id: 'item-1',
        invoice_id: 'original-1',
        sort_order: 0,
        line_type: 'product',
        description: 'Konsulttid',
        quantity: 1,
        unit: 'st',
        unit_price: 1000,
        line_total: 1000,
        vat_rate: 25,
        vat_amount: 250,
      } as InvoiceItem,
    ],
  })

  it('reverses the original: 1510 credited, sales and VAT debited', () => {
    const lines = proposeCreditNoteSendLines(original(), { entityType: 'aktiebolag', today: '2026-10-05' })
    const byAccount = Object.fromEntries(lines.map((l) => [l.account_number, l]))
    expect(byAccount['1510'].credit_amount).toBe('1250')
    expect(byAccount['1510'].debit_amount).toBe('')
    expect(byAccount['2611'].debit_amount).toBe('250')
    const sales = lines.find((l) => l.account_number.startsWith('30'))
    expect(sales?.debit_amount).toBe('1000')
  })

  it('shows nothing for an original without a number', () => {
    const unnumbered = { ...original(), invoice_number: null, external_invoice_number: null }
    expect(proposeCreditNoteSendLines(unnumbered, { entityType: 'aktiebolag', today: '2026-10-05' })).toEqual([])
  })
})

describe('proposeDraftSendLines: the öresavrundning the send books (crm#2283)', () => {
  it('with the toggle on, 1510 takes the rounded total and 3740 the öre', () => {
    // 3062,50 rounds to 3063: 0,50 on 3740.
    expect(amounts(proposeDraftSendLines(input({ oreRounding: true })))).toEqual([
      ['1510', '3063', ''],
      ['3001', '', '2450'],
      ['2611', '', '612.5'],
      ['3740', '', '0.5'],
    ])
  })

  it('with the toggle off, the exact total as before', () => {
    expect(amounts(proposeDraftSendLines(input({ oreRounding: false })))[0]).toEqual(['1510', '3062.5', ''])
  })
})
