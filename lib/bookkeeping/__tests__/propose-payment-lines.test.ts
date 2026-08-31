import { describe, it, expect } from 'vitest'
import { proposePaymentLines } from '../propose-payment-lines'
import type { InvoiceItem, VatTreatment } from '@/types'

function makeItem(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'inv-1',
    description: 'Konsulttjänst',
    quantity: 1,
    unit: 'st',
    unit_price: 10000,
    line_total: 10000,
    vat_rate: 25,
    vat_amount: 2500,
    sort_order: 0,
    created_at: '2025-01-01',
    ...overrides,
  }
}

function makeInvoiceInput(overrides: Partial<{
  invoice_number: string
  total: number
  total_sek: number | null
  subtotal: number
  subtotal_sek: number | null
  vat_amount: number
  vat_amount_sek: number | null
  currency: string
  exchange_rate: number | null
  vat_treatment: VatTreatment
  items: InvoiceItem[]
}> = {}) {
  return {
    invoice_number: '2025-001',
    total: 12500,
    total_sek: null,
    subtotal: 10000,
    subtotal_sek: null,
    vat_amount: 2500,
    vat_amount_sek: null,
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25' as VatTreatment,
    items: [makeItem()],
    ...overrides,
  }
}

describe('proposePaymentLines', () => {
  describe('accrual method', () => {
    it('SEK invoice → 2 lines (debit payment account, credit 1510)', () => {
      const lines = proposePaymentLines({
        invoice: makeInvoiceInput(),
        accountingMethod: 'accrual',
        entityType: 'enskild_firma',
      })

      expect(lines).toHaveLength(2)
      expect(lines[0]).toEqual({
        account_number: '1930',
        debit_amount: '12500',
        credit_amount: '',
        line_description: 'Betalning faktura 2025-001',
      })
      expect(lines[1]).toEqual({
        account_number: '1510',
        debit_amount: '',
        credit_amount: '12500',
        line_description: 'Betalning faktura 2025-001',
      })
    })

    it('custom bank account (1920) → debit goes to 1920', () => {
      const lines = proposePaymentLines({
        invoice: makeInvoiceInput(),
        accountingMethod: 'accrual',
        entityType: 'enskild_firma',
        paymentAccount: '1920',
      })

      expect(lines).toHaveLength(2)
      expect(lines[0].account_number).toBe('1920')
      expect(lines[1].account_number).toBe('1510')
    })

    it('foreign currency with exchange rate gain → 3 lines', () => {
      const lines = proposePaymentLines({
        invoice: makeInvoiceInput({
          total: 1000,
          total_sek: 10000,
          currency: 'EUR',
          exchange_rate: 10,
        }),
        accountingMethod: 'accrual',
        entityType: 'enskild_firma',
        exchangeRateDifference: 500,
      })

      expect(lines).toHaveLength(3)
      // Bank: actual received = 10000 + 500 = 10500
      expect(lines[0].account_number).toBe('1930')
      expect(lines[0].debit_amount).toBe('10500')
      // Clear receivable at booked amount
      expect(lines[1].account_number).toBe('1510')
      expect(lines[1].credit_amount).toBe('10000')
      // Exchange gain
      expect(lines[2].account_number).toBe('3960')
      expect(lines[2].credit_amount).toBe('500')
    })

    it('foreign currency with exchange rate loss → 3 lines with 7960 debit', () => {
      const lines = proposePaymentLines({
        invoice: makeInvoiceInput({
          total: 1000,
          total_sek: 10000,
          currency: 'EUR',
          exchange_rate: 10,
        }),
        accountingMethod: 'accrual',
        entityType: 'enskild_firma',
        exchangeRateDifference: -300,
      })

      expect(lines).toHaveLength(3)
      expect(lines[0].debit_amount).toBe('9700')
      expect(lines[2].account_number).toBe('7960')
      expect(lines[2].debit_amount).toBe('300')
    })
  })

  describe('cash method', () => {
    it('single VAT rate → debit 1930, credit 3001, credit 2611', () => {
      const lines = proposePaymentLines({
        invoice: makeInvoiceInput(),
        accountingMethod: 'cash',
        entityType: 'enskild_firma',
      })

      expect(lines).toHaveLength(3)
      expect(lines[0]).toEqual({
        account_number: '1930',
        debit_amount: '12500',
        credit_amount: '',
        line_description: 'Betalning faktura 2025-001',
      })
      expect(lines[1]).toEqual({
        account_number: '3001',
        debit_amount: '',
        credit_amount: '10000',
        line_description: 'Försäljning faktura 2025-001',
      })
      expect(lines[2]).toEqual({
        account_number: '2611',
        debit_amount: '',
        credit_amount: '2500',
        line_description: 'Utgående moms 25%',
      })
    })

    it('mixed VAT rates → multiple credit lines', () => {
      const items = [
        makeItem({ id: 'i1', vat_rate: 25, line_total: 8000, vat_amount: 2000, unit_price: 8000 }),
        makeItem({ id: 'i2', vat_rate: 12, line_total: 2000, vat_amount: 240, unit_price: 2000 }),
      ]

      const lines = proposePaymentLines({
        invoice: makeInvoiceInput({
          total: 12240,
          subtotal: 10000,
          vat_amount: 2240,
          items,
        }),
        accountingMethod: 'cash',
        entityType: 'enskild_firma',
      })

      // 1 debit + 2 revenue + 2 VAT = 5 lines
      expect(lines).toHaveLength(5)
      expect(lines[0].account_number).toBe('1930')

      // Find the revenue/VAT lines by account
      const accounts = lines.slice(1).map((l) => l.account_number)
      expect(accounts).toContain('3001') // 25% revenue
      expect(accounts).toContain('2611') // 25% VAT
      expect(accounts).toContain('3002') // 12% revenue
      expect(accounts).toContain('2621') // 12% VAT
    })

    it('defaults payment account to 1930', () => {
      const lines = proposePaymentLines({
        invoice: makeInvoiceInput(),
        accountingMethod: 'cash',
        entityType: 'enskild_firma',
      })

      expect(lines[0].account_number).toBe('1930')
    })

    it('uses custom payment account', () => {
      const lines = proposePaymentLines({
        invoice: makeInvoiceInput(),
        accountingMethod: 'cash',
        entityType: 'enskild_firma',
        paymentAccount: '1910',
      })

      expect(lines[0].account_number).toBe('1910')
    })
  })
})

describe('proposePaymentLines: öresavrundning (3740)', () => {
  it('accrual: rounded-up total → bank leg at "Att betala", 3740 credit carries the residual', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({
        total: 1234.75,
        subtotal: 987.8,
        vat_amount: 246.95,
        items: [makeItem({ line_total: 987.8, vat_amount: 246.95, unit_price: 987.8 })],
      }),
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      companyOreRounding: true,
    })

    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatchObject({ account_number: '1930', debit_amount: '1235' })
    expect(lines[1]).toMatchObject({ account_number: '1510', credit_amount: '1234.75' })
    expect(lines[2]).toEqual({
      account_number: '3740',
      debit_amount: '',
      credit_amount: '0.25',
      line_description: 'Öresavrundning',
    })
  })

  it('accrual: rounded-down total → 3740 debit', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({ total: 1234.25 }),
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      companyOreRounding: true,
    })

    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatchObject({ account_number: '1930', debit_amount: '1234' })
    expect(lines[1]).toMatchObject({ account_number: '1510', credit_amount: '1234.25' })
    expect(lines[2]).toMatchObject({ account_number: '3740', debit_amount: '0.25', credit_amount: '' })
  })

  it('cash: bank leg is the rounded amount and 3740 balances the exact revenue + VAT credits', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({
        total: 1234.75,
        subtotal: 987.8,
        vat_amount: 246.95,
        items: [makeItem({ line_total: 987.8, vat_amount: 246.95, unit_price: 987.8 })],
      }),
      accountingMethod: 'cash',
      entityType: 'enskild_firma',
      companyOreRounding: true,
    })

    expect(lines[0]).toMatchObject({ account_number: '1930', debit_amount: '1235' })
    const last = lines[lines.length - 1]
    expect(last).toMatchObject({ account_number: '3740', credit_amount: '0.25' })
    const debit = lines.reduce((s, l) => s + (parseFloat(l.debit_amount) || 0), 0)
    const credit = lines.reduce((s, l) => s + (parseFloat(l.credit_amount) || 0), 0)
    expect(Math.round((debit - credit) * 100)).toBe(0)
  })

  it('company setting off and no invoice override → unchanged 2-line proposal', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({ total: 1234.75 }),
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      companyOreRounding: false,
    })

    expect(lines).toHaveLength(2)
    expect(lines[0].debit_amount).toBe('1234.75')
  })

  it('per-invoice override wins over the company setting', () => {
    const lines = proposePaymentLines({
      invoice: { ...makeInvoiceInput({ total: 1234.75 }), ore_rounding: true },
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      companyOreRounding: false,
    })

    expect(lines).toHaveLength(3)
    expect(lines[2].account_number).toBe('3740')
  })

  it('whole-krona total → no 3740 line even when rounding is on', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({ total: 12500 }),
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      companyOreRounding: true,
    })

    expect(lines).toHaveLength(2)
  })

  it('non-SEK invoice → rounding never applies', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({
        total: 1000.4,
        total_sek: 10004,
        currency: 'EUR',
        exchange_rate: 10,
      }),
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      companyOreRounding: true,
    })

    expect(lines.every((l) => l.account_number !== '3740')).toBe(true)
  })
})

describe('proposePaymentLines: remaining-aware partials (#1717)', () => {
  it('sub-krona remaining → bank-less öre write-off (Dr 3740 / Cr 1510)', () => {
    const lines = proposePaymentLines({
      invoice: {
        ...makeInvoiceInput({ total: 12500.4 }),
        paid_amount: 12500,
        remaining_amount: 0.4,
      },
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
    })

    expect(lines).toEqual([
      {
        account_number: '3740',
        debit_amount: '0.4',
        credit_amount: '',
        line_description: 'Öresavrundning',
      },
      {
        account_number: '1510',
        debit_amount: '',
        credit_amount: '0.4',
        line_description: 'Betalning faktura 2025-001',
      },
    ])
  })

  it('remaining >= 1 kr → clears the remaining, not the total', () => {
    const lines = proposePaymentLines({
      invoice: {
        ...makeInvoiceInput({ total: 12500 }),
        paid_amount: 5000,
        remaining_amount: 7500,
      },
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      paymentAccount: '1920',
    })

    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ account_number: '1920', debit_amount: '7500' })
    expect(lines[1]).toMatchObject({ account_number: '1510', credit_amount: '7500' })
  })

  it('derives remaining from paid_amount when remaining_amount is absent', () => {
    const lines = proposePaymentLines({
      invoice: { ...makeInvoiceInput({ total: 12500.4 }), paid_amount: 12500 },
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
    })

    expect(lines[0]).toMatchObject({ account_number: '3740', debit_amount: '0.4' })
    expect(lines[1]).toMatchObject({ account_number: '1510', credit_amount: '0.4' })
  })

  it('fully unpaid invoice keeps the fresh proposal byte-identical (incl. öresavrundning)', () => {
    const fresh = proposePaymentLines({
      invoice: makeInvoiceInput({ total: 1234.75 }),
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      companyOreRounding: true,
    })
    const withZeroPaid = proposePaymentLines({
      invoice: {
        ...makeInvoiceInput({ total: 1234.75 }),
        paid_amount: 0,
        remaining_amount: 1234.75,
      },
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      companyOreRounding: true,
    })

    expect(withZeroPaid).toEqual(fresh)
    expect(withZeroPaid[2]).toMatchObject({ account_number: '3740' })
  })

  it('cash method partial keeps the legacy full-invoice proposal', () => {
    // The server refuses cash partial completion (cashPartialBlockReason), so
    // a remaining-based cash proposal would only dress up a rejected booking.
    const lines = proposePaymentLines({
      invoice: {
        ...makeInvoiceInput(),
        paid_amount: 5000,
        remaining_amount: 7500,
      },
      accountingMethod: 'cash',
      entityType: 'enskild_firma',
    })

    expect(lines[0]).toMatchObject({ account_number: '1930', debit_amount: '12500' })
  })

  it('foreign-currency partial keeps the legacy proposal', () => {
    const lines = proposePaymentLines({
      invoice: {
        ...makeInvoiceInput({
          total: 1000,
          total_sek: 10000,
          currency: 'EUR',
          exchange_rate: 10,
        }),
        paid_amount: 500,
        remaining_amount: 500,
      },
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
    })

    expect(lines[0]).toMatchObject({ account_number: '1930', debit_amount: '10000' })
    expect(lines.every((l) => l.account_number !== '3740')).toBe(true)
  })

  it('ROT/RUT invoice with a partial keeps the deduction-aware proposal', () => {
    // The outstanding remainder on a ROT/RUT invoice is Skatteverket's share
    // on 1513, settled by the ROT/RUT payout flow: never proposed as a 1510
    // clearing here.
    const lines = proposePaymentLines({
      invoice: {
        ...makeInvoiceInput(),
        deduction_total: 3750,
        paid_amount: 8750,
        remaining_amount: 3750,
      },
      accountingMethod: 'accrual',
      entityType: 'aktiebolag',
    })

    expect(lines[0]).toMatchObject({ account_number: '1930', debit_amount: '8750' })
    expect(lines[1]).toMatchObject({ account_number: '1510', credit_amount: '8750' })
  })

  it('write-off lines carry the invoice default dimensions', () => {
    const bag = { '6': 'P001' }
    const lines = proposePaymentLines({
      invoice: {
        ...makeInvoiceInput({ total: 1000.25 }),
        paid_amount: 1000,
        remaining_amount: 0.25,
        default_dimensions: bag,
      },
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
    })

    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line.dimensions).toEqual(bag)
      expect(line.dimensions).not.toBe(bag)
    }
  })
})

describe('proposePaymentLines: dimensions propagation (PR7)', () => {
  const bag = { '1': 'KS01', '6': 'P001' }

  it('accrual: every proposed line carries a copy of the invoice default bag', () => {
    const lines = proposePaymentLines({
      invoice: { ...makeInvoiceInput(), default_dimensions: bag },
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
    })

    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line.dimensions).toEqual(bag)
      // A copy, not the shared reference: editing one line must not mutate
      // the invoice bag or a sibling line.
      expect(line.dimensions).not.toBe(bag)
    }
    expect(lines[0].dimensions).not.toBe(lines[1].dimensions)
  })

  it('accrual with FX difference: the 3960 line carries the bag too', () => {
    const lines = proposePaymentLines({
      invoice: {
        ...makeInvoiceInput({
          total: 1000,
          total_sek: 10000,
          currency: 'EUR',
          exchange_rate: 10,
        }),
        default_dimensions: bag,
      },
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      exchangeRateDifference: 500,
    })

    expect(lines).toHaveLength(3)
    expect(lines[2].account_number).toBe('3960')
    for (const line of lines) {
      expect(line.dimensions).toEqual(bag)
    }
  })

  it('cash: payment, revenue and VAT lines all carry the bag', () => {
    const lines = proposePaymentLines({
      invoice: { ...makeInvoiceInput(), default_dimensions: bag },
      accountingMethod: 'cash',
      entityType: 'enskild_firma',
    })

    expect(lines).toHaveLength(3)
    expect(lines.map((l) => l.account_number)).toEqual(['1930', '3001', '2611'])
    for (const line of lines) {
      expect(line.dimensions).toEqual(bag)
    }
  })

  it('absent or empty bag → no dimensions key on any line', () => {
    const withoutBag = proposePaymentLines({
      invoice: makeInvoiceInput(),
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
    })
    for (const line of withoutBag) {
      expect('dimensions' in line).toBe(false)
    }

    const withEmptyBag = proposePaymentLines({
      invoice: { ...makeInvoiceInput(), default_dimensions: {} },
      accountingMethod: 'cash',
      entityType: 'enskild_firma',
    })
    for (const line of withEmptyBag) {
      expect('dimensions' in line).toBe(false)
    }
  })
})

/**
 * The cash-method proposal IS the entry: PaymentBookingDialog pre-fills its
 * editable grid from these lines and submits them. A foreign invoice with no
 * exchange rate has no SEK value at item granularity, so pre-filling the raw
 * foreign numbers would post 1 000 kr of revenue and 250 kr of moms where 11 500
 * kr and 2 875 kr belong: balanced, undetectable, and an understated ruta 05/10.
 * The dialog resolves the proposal inside a try/catch, so throwing surfaces as a
 * translated toast (INVOICE_FX_RATE_MISSING) rather than a crash.
 */
describe('proposePaymentLines: foreign currency without an exchange rate', () => {
  it('cash method refuses with INVOICE_FX_RATE_MISSING', () => {
    expect(() =>
      proposePaymentLines({
        invoice: makeInvoiceInput({ currency: 'EUR', exchange_rate: null }),
        accountingMethod: 'cash',
        entityType: 'enskild_firma',
      })
    ).toThrowError(expect.objectContaining({ code: 'INVOICE_FX_RATE_MISSING', currency: 'EUR' }))
  })

  it('cash method refuses a zero rate the same way', () => {
    expect(() =>
      proposePaymentLines({
        invoice: makeInvoiceInput({ currency: 'EUR', exchange_rate: 0 }),
        accountingMethod: 'cash',
        entityType: 'enskild_firma',
      })
    ).toThrowError(expect.objectContaining({ code: 'INVOICE_FX_RATE_MISSING' }))
  })

  it('cash method with a rate proposes converted, balanced lines', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({
        currency: 'EUR',
        exchange_rate: 11.5,
        subtotal: 1000,
        vat_amount: 250,
        total: 1250,
        items: [makeItem({ line_total: 1000, unit_price: 1000, vat_rate: 25, vat_amount: 250 })],
      }),
      accountingMethod: 'cash',
      entityType: 'enskild_firma',
    })

    expect(lines.find((l) => l.account_number === '3001')?.credit_amount).toBe('11500')
    expect(lines.find((l) => l.account_number === '2611')?.credit_amount).toBe('2875')
    expect(lines.find((l) => l.account_number === '1930')?.debit_amount).toBe('14375')

    const debit = lines.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0)
    const credit = lines.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0)
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100))
  })

  it('SEK cash method without a rate is unaffected', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({ currency: 'SEK', exchange_rate: null }),
      accountingMethod: 'cash',
      entityType: 'enskild_firma',
    })

    expect(lines.find((l) => l.account_number === '1930')?.debit_amount).toBe('12500')
    const debit = lines.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0)
    const credit = lines.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0)
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100))
  })

  // The invoice-level fallback (no items) reads subtotal_sek / vat_amount_sek and
  // is deliberately left lenient: those rows CAN be expressed in kronor.
  it('cash method still proposes from invoice-level *_sek when there are no items', () => {
    const lines = proposePaymentLines({
      invoice: makeInvoiceInput({
        currency: 'EUR',
        exchange_rate: null,
        items: [],
        subtotal: 1000,
        subtotal_sek: 11500,
        vat_amount: 250,
        vat_amount_sek: 2875,
        total: 1250,
        total_sek: 14375,
      }),
      accountingMethod: 'cash',
      entityType: 'enskild_firma',
    })

    expect(lines.find((l) => l.account_number === '3001')?.credit_amount).toBe('11500')
    expect(lines.find((l) => l.account_number === '2611')?.credit_amount).toBe('2875')
    expect(lines.find((l) => l.account_number === '1930')?.debit_amount).toBe('14375')
  })
})

describe('proposePaymentLines: ROT/RUT-avdrag (fakturamodellen)', () => {
  // 10 000 labor + 25 % = 12 500; ROT 30 % of labor incl. moms = 3 750. The
  // customer pays 8 750; 3 750 is a receivable on Skatteverket (1513).
  const rotInvoice = () => ({ ...makeInvoiceInput(), deduction_total: 3750 })

  it('accrual: bank and 1510 legs carry the customer share (total minus avdrag)', () => {
    const lines = proposePaymentLines({
      invoice: rotInvoice(),
      accountingMethod: 'accrual',
      entityType: 'aktiebolag',
    })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ account_number: '1930', debit_amount: '8750' })
    expect(lines[1]).toMatchObject({ account_number: '1510', credit_amount: '8750' })
  })

  it('accrual + öresavrundning: bank leg is the rounded "Att betala", 3740 carries the öre', () => {
    const lines = proposePaymentLines({
      invoice: { ...makeInvoiceInput({ total: 12500.4 }), deduction_total: 3750 },
      accountingMethod: 'accrual',
      entityType: 'aktiebolag',
      companyOreRounding: true,
    })
    // Att betala on the PDF: round(12 500,40) - 3 750 = 8 750; 1510 clears
    // 8 750,40; the 0,40 lands on 3740 (same polarity as the bank match).
    expect(lines.find((l) => l.account_number === '1930')?.debit_amount).toBe('8750')
    expect(lines.find((l) => l.account_number === '1510')?.credit_amount).toBe('8750.4')
    expect(lines.find((l) => l.account_number === '3740')?.debit_amount).toBe('0.4')
  })

  it('cash method: bank gets the customer share, 1513 the avdrag, revenue + moms in full', () => {
    const lines = proposePaymentLines({
      invoice: rotInvoice(),
      accountingMethod: 'cash',
      entityType: 'aktiebolag',
    })
    expect(lines.find((l) => l.account_number === '1930')?.debit_amount).toBe('8750')
    expect(lines.find((l) => l.account_number === '1513')?.debit_amount).toBe('3750')
    expect(lines.find((l) => l.account_number === '3001')?.credit_amount).toBe('10000')
    expect(lines.find((l) => l.account_number === '2611')?.credit_amount).toBe('2500')
    const debits = lines.reduce((s, l) => s + (parseFloat(l.debit_amount) || 0), 0)
    const credits = lines.reduce((s, l) => s + (parseFloat(l.credit_amount) || 0), 0)
    expect(Math.round((debits - credits) * 100)).toBe(0)
  })

  it('foreign invoice with a deduction and no booking rate refuses (1513 is a kronor receivable)', () => {
    expect(() =>
      proposePaymentLines({
        invoice: { ...makeInvoiceInput({ currency: 'EUR', total_sek: 137500, exchange_rate: null }), deduction_total: 375 },
        accountingMethod: 'accrual',
        entityType: 'aktiebolag',
      }),
    ).toThrow()
  })

  it('no deduction: unchanged full-total proposal', () => {
    const lines = proposePaymentLines({
      invoice: { ...makeInvoiceInput(), deduction_total: 0 },
      accountingMethod: 'accrual',
      entityType: 'aktiebolag',
    })
    expect(lines[0]).toMatchObject({ account_number: '1930', debit_amount: '12500' })
  })
})
