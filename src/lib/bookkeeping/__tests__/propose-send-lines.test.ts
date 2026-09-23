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
  credited_invoice_id: string | null
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

  it('does not create zero-value revenue rows for informational invoice items', () => {
    const lines = proposeSendLines({
      invoice: makeInvoiceInput({
        items: [
          makeItem(),
          makeItem({
            id: 'text-1',
            line_type: 'text',
            description: 'Information shown on the invoice',
            quantity: 0,
            unit_price: 0,
            line_total: 0,
            vat_rate: 0,
            vat_amount: 0,
          }),
        ],
      }),
      entityType: 'enskild_firma',
    })

    expect(lines.map((line) => line.account_number)).toEqual(['1510', '3001', '2611'])
    expect(lines.some((line) =>
      (parseFloat(line.debit_amount) || 0) === 0
      && (parseFloat(line.credit_amount) || 0) === 0
    )).toBe(false)
  })

  it('ignores informational rows when selecting the legacy invoice VAT treatment', () => {
    const lines = proposeSendLines({
      invoice: makeInvoiceInput({
        items: [
          makeItem({ vat_rate: undefined }),
          makeItem({
            id: 'text-1',
            line_type: 'text',
            quantity: 0,
            unit_price: 0,
            line_total: 0,
            vat_rate: 0,
            vat_amount: 0,
          }),
        ],
      }),
      entityType: 'enskild_firma',
    })

    expect(lines.map((line) => line.account_number)).toEqual(['1510', '3001', '2611'])
  })

  it('returns no booking proposal for an invoice containing only informational rows', () => {
    const lines = proposeSendLines({
      invoice: makeInvoiceInput({
        total: 0,
        subtotal: 0,
        vat_amount: 0,
        items: [
          makeItem({
            line_type: 'text',
            quantity: 0,
            unit_price: 0,
            line_total: 0,
            vat_rate: 0,
            vat_amount: 0,
          }),
        ],
      }),
      entityType: 'enskild_firma',
    })

    expect(lines).toEqual([])
  })

  it('rejects a non-zero invoice containing only informational rows', () => {
    const lines = proposeSendLines({
      invoice: makeInvoiceInput({
        items: [
          makeItem({
            line_type: 'text',
            quantity: 0,
            unit_price: 0,
            line_total: 0,
            vat_rate: 0,
            vat_amount: 0,
          }),
        ],
      }),
      entityType: 'enskild_firma',
    })

    expect(lines).toEqual([])
  })

  it('credit note uses positive amounts on the reversed sides', () => {
    const lines = proposeSendLines({
      invoice: makeInvoiceInput({
        invoice_number: 'KR-2025-001',
        credited_invoice_id: 'invoice-1',
        total: -12500,
        subtotal: -10000,
        vat_amount: -2500,
        items: [
          makeItem({ quantity: -1, line_total: -10000, vat_amount: -2500 }),
        ],
      }),
      entityType: 'enskild_firma',
    })

    expect(lines).toEqual([
      {
        account_number: '1510',
        debit_amount: '',
        credit_amount: '12500',
        line_description: 'Kreditfaktura KR-2025-001',
      },
      {
        account_number: '3001',
        debit_amount: '10000',
        credit_amount: '',
        line_description: 'Kreditfaktura KR-2025-001',
      },
      {
        account_number: '2611',
        debit_amount: '2500',
        credit_amount: '',
        line_description: 'Moms kreditfaktura 25%',
      },
    ])
  })

  it('credit-note preview reverses the ROT receivable split', () => {
    const lines = proposeSendLines({
      invoice: makeInvoiceInput({
        invoice_number: 'KR-2025-002',
        credited_invoice_id: 'invoice-2',
        total: -12500,
        subtotal: -10000,
        vat_amount: -2500,
        items: [
          makeItem({
            quantity: -1,
            line_total: -10000,
            vat_amount: -2500,
            deduction_type: 'rot',
          }),
        ],
      }),
      entityType: 'enskild_firma',
    })

    // ROT is 30% of the line total incl. moms (HUSFL 6-9 §§): 30% x 12 500 = 3 750.
    expect(lines.find((line) => line.account_number === '1510')?.credit_amount).toBe('8750')
    expect(lines.find((line) => line.account_number === '1513')?.credit_amount).toBe('3750')
    expect(lines.reduce((sum, line) => sum + (parseFloat(line.debit_amount) || 0), 0))
      .toBe(12500)
    expect(lines.reduce((sum, line) => sum + (parseFloat(line.credit_amount) || 0), 0))
      .toBe(12500)
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

/**
 * The preview is not decoration: `editable` is SEK-only, so for an FX invoice the
 * read-only grid is exactly what the server generator will post. A foreign
 * invoice with no exchange rate has no SEK value at item granularity, and because
 * the 1510 debit is derived from the sum of the credits the grid would even read
 * "Balanserar" while showing 1 000 kr where 11 500 kr belongs. No proposal is the
 * honest answer; the send itself is refused server-side with
 * INVOICE_FX_RATE_MISSING.
 */
describe('proposeSendLines: foreign currency without an exchange rate', () => {
  it('returns no proposal instead of relabelling EUR amounts as kronor', () => {
    const lines = proposeSendLines({
      invoice: makeInvoiceInput({ currency: 'EUR', exchange_rate: null }),
      entityType: 'enskild_firma',
    })

    expect(lines).toEqual([])
  })

  it('returns no proposal for a zero or negative rate', () => {
    for (const rate of [0, -11.5]) {
      expect(
        proposeSendLines({
          invoice: makeInvoiceInput({ currency: 'EUR', exchange_rate: rate }),
          entityType: 'enskild_firma',
        })
      ).toEqual([])
    }
  })

  it('does not throw: it runs inside a useMemo during render', () => {
    expect(() =>
      proposeSendLines({
        invoice: makeInvoiceInput({ currency: 'EUR', exchange_rate: null }),
        entityType: 'enskild_firma',
      })
    ).not.toThrow()
  })

  it('EUR with a rate proposes converted, balanced lines', () => {
    const lines = proposeSendLines({
      invoice: makeInvoiceInput({
        currency: 'EUR',
        exchange_rate: 11.5,
        subtotal: 1000,
        vat_amount: 250,
        total: 1250,
        items: [makeItem({ line_total: 1000, unit_price: 1000, vat_rate: 25, vat_amount: 250 })],
      }),
      entityType: 'enskild_firma',
    })

    expect(lines.find((l) => l.account_number === '3001')?.credit_amount).toBe('11500')
    expect(lines.find((l) => l.account_number === '2611')?.credit_amount).toBe('2875')
    expect(lines.find((l) => l.account_number === '1510')?.debit_amount).toBe('14375')

    const debit = lines.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0)
    const credit = lines.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0)
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100))
  })

  it('SEK without a rate is unaffected', () => {
    const lines = proposeSendLines({
      invoice: makeInvoiceInput({ currency: 'SEK', exchange_rate: null }),
      entityType: 'enskild_firma',
    })

    expect(lines.find((l) => l.account_number === '1510')?.debit_amount).toBe('12500')
    const debit = lines.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0)
    const credit = lines.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0)
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100))
  })

  // The invoice-level fallback (no items at all) has a genuine second source in
  // subtotal_sek / vat_amount_sek and is deliberately left lenient: killing it
  // would blank the preview for rows that CAN be expressed in kronor.
  it('still proposes from invoice-level *_sek when there are no items', () => {
    const lines = proposeSendLines({
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
      entityType: 'enskild_firma',
    })

    expect(lines.find((l) => l.account_number === '3001')?.credit_amount).toBe('11500')
    expect(lines.find((l) => l.account_number === '2611')?.credit_amount).toBe('2875')
    expect(lines.find((l) => l.account_number === '1510')?.debit_amount).toBe('14375')
  })
})
