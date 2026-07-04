import { describe, it, expect } from 'vitest'
import { proposeSendLines } from '../propose-send-lines'
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
  default_dimensions: Record<string, string> | null
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

describe('proposeSendLines', () => {
  it('single VAT rate → debit 1510, credit 3001, credit 2611', () => {
    const lines = proposeSendLines({
      invoice: makeInvoiceInput(),
      entityType: 'enskild_firma',
    })

    expect(lines).toHaveLength(3)
    expect(lines[0]).toEqual({
      account_number: '1510',
      debit_amount: '12500',
      credit_amount: '',
      line_description: 'Försäljning faktura 2025-001',
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

  describe('dimensions propagation (PR7)', () => {
    const bag = { '1': 'KS01', '6': 'P001' }

    it('every proposed line carries a copy of the invoice default bag', () => {
      const lines = proposeSendLines({
        invoice: makeInvoiceInput({ default_dimensions: bag }),
        entityType: 'enskild_firma',
      })

      expect(lines).toHaveLength(3)
      for (const line of lines) {
        expect(line.dimensions).toEqual(bag)
        // A copy, not the shared reference: editing one line must not mutate
        // the invoice bag or a sibling line.
        expect(line.dimensions).not.toBe(bag)
      }
      expect(lines[0].dimensions).not.toBe(lines[1].dimensions)
    })

    it('mixed rates: 1510 + both revenue and both VAT lines carry the bag', () => {
      const items = [
        makeItem({ id: 'i1', vat_rate: 25, line_total: 8000, vat_amount: 2000, unit_price: 8000 }),
        makeItem({ id: 'i2', vat_rate: 12, line_total: 2000, vat_amount: 240, unit_price: 2000 }),
      ]

      const lines = proposeSendLines({
        invoice: makeInvoiceInput({
          total: 12240,
          subtotal: 10000,
          vat_amount: 2240,
          items,
          default_dimensions: bag,
        }),
        entityType: 'enskild_firma',
      })

      expect(lines).toHaveLength(5)
      for (const line of lines) {
        expect(line.dimensions).toEqual(bag)
      }
    })

    it('absent or empty bag → no dimensions key on any line', () => {
      const withoutBag = proposeSendLines({
        invoice: makeInvoiceInput(),
        entityType: 'enskild_firma',
      })
      for (const line of withoutBag) {
        expect('dimensions' in line).toBe(false)
      }

      const withEmptyBag = proposeSendLines({
        invoice: makeInvoiceInput({ default_dimensions: {} }),
        entityType: 'enskild_firma',
      })
      for (const line of withEmptyBag) {
        expect('dimensions' in line).toBe(false)
      }
    })
  })
})
