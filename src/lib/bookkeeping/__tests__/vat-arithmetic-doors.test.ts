import { describe, expect, it } from 'vitest'
import { CreateSupplierInvoiceItemSchema } from '@/lib/api/schemas'
import { lineVatFromPercent } from '@/lib/providers/amounts'
import { mapFortnoxToSalesInvoice } from '@/lib/providers/fortnox/mapper'
import { rowNetFromInvoiceTotals } from '@/lib/supplier-invoices/total-first'
import { computeLineVat } from '../invoice-line-amounts'
import { buildCreditNoteLines, buildInvoiceCashLines, buildInvoiceRegistrationLines, splitDeductionShare } from '../invoice-lines'
import { groupVatByRate } from '../supplier-invoice-registration-lines'
import { applyTemplate } from '../template-library'
import { generateReverseChargePurchaseLines } from '../vat-entries'
import { validateBalance } from '../engine'
import type { CreateJournalEntryLineInput, EntityType, InvoiceItem } from '@/types'

/**
 * The rule behind each describe block has one definition. These are the
 * disagreements a line-by-line audit proved (2026-11-01): the same amount
 * through two doors answered one öre apart, because the doors held their own
 * arithmetic. Each door here fails if it stops calling the definition.
 */

function credit(lines: CreateJournalEntryLineInput[], account: string): number {
  return lines.filter((l) => l.account_number === account).reduce((sum, l) => sum + l.credit_amount, 0)
}

describe('VAT on a net amount: exact half öre up at every door', () => {
  // 14,5 öre, 16,5 öre and 37,5 öre: exact halves the binary float puts below the half.
  const cases: Array<[net: number, rate: number, vat: number]> = [
    [0.58, 0.25, 0.15],
    [2.75, 0.06, 0.17],
    [6.25, 0.06, 0.38],
    [1.14, 0.25, 0.29],
    [9.25, 0.06, 0.56],
  ]

  it.each(cases)('the invoice line rule: %s at %s is %s', (net, rate, vat) => {
    expect(computeLineVat(net, rate * 100)).toBe(vat)
  })

  it.each(cases)('the fiktiv moms of a reverse-charge purchase: %s at %s is %s on both legs', (base, rate, vat) => {
    const lines = generateReverseChargePurchaseLines({ base, rate, kind: 'eu_services' })
    const output = rate === 0.25 ? '2614' : '2634'
    expect(lines.find((l) => l.account_number === '2645')?.debit_amount).toBe(vat)
    expect(lines.find((l) => l.account_number === output)?.credit_amount).toBe(vat)
  })

  it.each(cases)('a template line on a fiktiv-moms account: %s at %s is %s', (total, rate, vat) => {
    const form = applyTemplate(
      [{ account: rate === 0.25 ? '2614' : '2634', label: 'Fiktiv moms', side: 'credit', type: 'vat', vat_rate: rate }],
      total,
    )
    expect(Number(form[0].credit_amount)).toBe(vat)
  })

  it.each(cases)('a provider import line: %s at %s is %s, whichever unit the provider states', (net, rate, vat) => {
    expect(lineVatFromPercent(net, rate)).toBe(vat)
    expect(lineVatFromPercent(net, rate * 100)).toBe(vat)
  })

  it.each(cases)('a supplier invoice row with no stored VAT: %s at %s is %s', (net, rate, vat) => {
    const byRate = groupVatByRate([{ line_total: net, vat_rate: rate, vat_amount: 0 }], (amount) => amount, 'standard_25')
    expect(byRate.get(rate)).toBe(vat)
  })

  it.each(cases)('the VAT ceiling of a supplier invoice row: %s at %s allows %s and one öre of POS rounding', (amount, rate, vat) => {
    const item = { description: 'Inköp', amount, account_number: '6110', vat_rate: rate }
    expect(CreateSupplierInvoiceItemSchema.safeParse({ ...item, vat_amount: vat + 0.01 }).success).toBe(true)
    expect(CreateSupplierInvoiceItemSchema.safeParse({ ...item, vat_amount: vat + 0.02 }).success).toBe(false)
  })
})

describe('the VAT inside a gross amount: VAT first, net as what is left', () => {
  it('a Fortnox row stated including VAT', () => {
    const dto = mapFortnoxToSalesInvoice({
      DocumentNumber: 4,
      InvoiceDate: '2025-11-01',
      DueDate: '2025-12-01',
      CustomerName: 'Kund AB',
      Currency: 'SEK',
      Total: 1.26,
      Balance: 1.26,
      Sent: true,
      VATIncluded: true,
      Net: 1.12,
      TotalVAT: 0.14,
      InvoiceRows: [{ RowId: 1, Description: 'Rad', DeliveredQuantity: 1, Price: 1.26, Total: 1.26, VAT: 12 }],
    })
    expect(dto.lines[0].lineExtensionAmount.value).toBe(1.12)
  })

  it('the total-first row of a supplier invoice', () => {
    expect(rowNetFromInvoiceTotals({ total: 1.26, vat: null, rate: 0.12, reverseCharge: false })).toBe(1.12)
    expect(rowNetFromInvoiceTotals({ total: 0.14, vat: null, rate: 0.12, reverseCharge: false })).toBe(0.12)
  })

  it("Skatteverket's share of a ROT line at 12 %", () => {
    const item = {
      id: 'item-1', line_type: 'product', description: 'Arbete', quantity: 1, unit: 'st', unit_price: 1.25,
      discount_percent: 0, line_total: 1.25, vat_rate: 12, vat_amount: 0.15,
      deduction_type: 'rot', deduction_amount: 0.7,
    } as unknown as InvoiceItem
    const split = splitDeductionShare([item], 'SEK')
    expect(split?.deductionItems[0]).toMatchObject({ line_total: 0.62, vat_amount: 0.08 })
    expect(split?.customerItems[0]).toMatchObject({ line_total: 0.63, vat_amount: 0.07 })
  })
})

describe('a verifikat balances on the amounts it stores', () => {
  it('three decimals that only balance before each line is rounded are refused', () => {
    const lines = [
      { account_number: '6110', debit_amount: 100.004, credit_amount: 0 },
      { account_number: '6230', debit_amount: 100.004, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 200.01 },
    ]
    expect(validateBalance(lines).valid).toBe(false)
  })

  it('a half öre rounds as roundOre rounds it, on every line', () => {
    // 1,005 stores as 1,01 (storedLineValues) and the check has to see that, not 1,00.
    const lines = [
      { account_number: '6110', debit_amount: 1.005, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1.01 },
    ]
    expect(validateBalance(lines).valid).toBe(true)
  })
})

describe('an invoice booked from its header books the VAT it states', () => {
  const header = {
    id: 'inv-1', invoice_number: 'F-1', currency: 'SEK', vat_treatment: 'standard_25' as const, items: [],
  }
  const entity: EntityType = 'aktiebolag'

  // Three lines of 0,33 kr: 0,08 kr each per line, 0,24 kr stored, 0,25 kr on the subtotal.
  const lineVat = { ...header, subtotal: 0.99, vat_amount: 0.24, total: 1.23 }

  it('the registration entry credits the stored VAT and balances', () => {
    const lines = buildInvoiceRegistrationLines(lineVat, entity)
    expect(credit(lines, '2611')).toBe(0.24)
    expect(validateBalance(lines).valid).toBe(true)
  })

  it('the kontantmetod entry books the same', () => {
    const { lines } = buildInvoiceCashLines(lineVat, entity)
    expect(credit(lines, '2611')).toBe(0.24)
    expect(validateBalance(lines).valid).toBe(true)
  })

  it('and so does the credit note', () => {
    const lines = buildCreditNoteLines({ ...lineVat, subtotal: -0.99, vat_amount: -0.24, total: -1.23 }, entity)
    expect(lines.find((l) => l.account_number === '2611')?.debit_amount).toBe(0.24)
    expect(validateBalance(lines).valid).toBe(true)
  })

  it('the legacy rows without a per-line rate book the VAT they state too', () => {
    const rows = [0.33, 0.33, 0.33].map((line_total, index) => ({
      id: `item-${index}`, line_type: 'product', line_total, vat_amount: 0.08, vat_rate: null,
    })) as unknown as InvoiceItem[]
    const lines = buildInvoiceRegistrationLines({ ...lineVat, items: rows }, entity)
    expect(credit(lines, '2611')).toBe(0.24)
    expect(validateBalance(lines).valid).toBe(true)
  })

  // The stored header adds up on every invoice in production (0 of 205 411
  // differ, 2026-11-01), so a door that books the stated figures balances by
  // construction. The VAT here sits up to 3 öre from subtotal × rate: per-line
  // rounding, or several rates on one invoice, puts it there.
  it.each(['standard_25', 'reduced_12', 'reduced_6'] as const)('every door balances on every header that adds up, %s', (vat_treatment) => {
    const rate = vat_treatment === 'standard_25' ? 0.25 : vat_treatment === 'reduced_12' ? 0.12 : 0.06
    for (let subtotalOre = 100; subtotalOre <= 30000; subtotalOre += 37) {
      for (let drift = -3; drift <= 3; drift++) {
        const vatOre = Math.round(subtotalOre * rate) + drift
        const invoice = {
          ...header, vat_treatment,
          subtotal: subtotalOre / 100, vat_amount: vatOre / 100, total: (subtotalOre + vatOre) / 100,
        }
        const note = { ...invoice, subtotal: -invoice.subtotal, vat_amount: -invoice.vat_amount, total: -invoice.total }
        expect(validateBalance(buildInvoiceRegistrationLines(invoice, entity)).valid).toBe(true)
        expect(validateBalance(buildInvoiceCashLines(invoice, entity).lines).valid).toBe(true)
        expect(validateBalance(buildCreditNoteLines(note, entity)).valid).toBe(true)
      }
    }
  })

  it('a foreign header balances on its converted amounts, its 1510 taken from them', () => {
    const invoice = {
      ...header, currency: 'EUR', exchange_rate: 11.37,
      subtotal: 0.99, vat_amount: 0.24, total: 1.23, subtotal_sek: 11.26, vat_amount_sek: 2.73, total_sek: 13.99,
    }
    const lines = buildInvoiceRegistrationLines(invoice, entity)
    expect(credit(lines, '2611')).toBe(2.73)
    expect(validateBalance(lines).valid).toBe(true)
  })

  // A header that does not add up is not bookable: the entry stays unbalanced
  // and the engine refuses it, as the trigger would.
  it('a header that does not add up does not balance', () => {
    const lines = buildInvoiceRegistrationLines({ ...header, subtotal: 100, vat_amount: 24.99, total: 125 }, entity)
    expect(validateBalance(lines).valid).toBe(false)
  })

  // A treatment without Swedish VAT, or none, has no output account: the debit
  // stays above the credits and the engine refuses it, as this door always has.
  it.each(['reverse_charge', 'export', 'exempt', null] as const)('a SEK header stating VAT under %s stays refused', (vat_treatment) => {
    const stated = { ...header, vat_treatment: vat_treatment as never, subtotal: 100, vat_amount: 25, total: 125 }
    const lines = buildInvoiceRegistrationLines(stated, entity)
    expect(lines.some((l) => l.account_number.startsWith('26'))).toBe(false)
    expect(validateBalance(lines).valid).toBe(false)
    expect(validateBalance(buildInvoiceCashLines(stated, entity).lines).valid).toBe(false)
  })

  // One treatment has one account. VAT further from its rate than rounding
  // explains is several rates or a momsfri part, and the items that could
  // split it are not loaded: booking it on one account puts moms in the wrong
  // ruta, so the entry stays refused.
  it.each([
    ['100 at 25 % + 100 at 12 %', 'standard_25', 200, 37],
    ['100 at 25 % + 100 at 6 %', 'reduced_6', 200, 31],
    ['half of it momsfri', 'standard_25', 200, 25],
    ['VAT above any rate', 'standard_25', 100, 80],
  ] as const)('a SEK header with VAT that does not fit its rate stays refused: %s', (_case, vat_treatment, subtotal, vat_amount) => {
    const stated = { ...header, vat_treatment, subtotal, vat_amount, total: subtotal + vat_amount }
    expect(validateBalance(buildInvoiceRegistrationLines(stated, entity)).valid).toBe(false)
    expect(validateBalance(buildInvoiceCashLines(stated, entity).lines).valid).toBe(false)
  })

  it('the legacy rows without a per-line rate are held to the same fit', () => {
    const rows = [
      { id: 'item-1', line_type: 'product', line_total: 100, vat_amount: 25, vat_rate: null },
      { id: 'item-2', line_type: 'product', line_total: 100, vat_amount: 12, vat_rate: null },
    ] as unknown as InvoiceItem[]
    const stated = { ...header, subtotal: 200, vat_amount: 37, total: 237, items: rows }
    expect(validateBalance(buildInvoiceRegistrationLines(stated, entity)).valid).toBe(false)
  })
})
