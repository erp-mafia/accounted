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
