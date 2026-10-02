import { describe, it, expect } from 'vitest'
import { proposeDraftSendLines, type DraftVoucherInput } from '@/lib/invoices/editor/voucher-preview'

function input(overrides: Partial<DraftVoucherInput> = {}): DraftVoucherInput {
  return {
    invoiceNumber: '1043',
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
