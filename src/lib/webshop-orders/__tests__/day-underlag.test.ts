import { describe, expect, it } from 'vitest'
import { buildDayUnderlagModel, dayUnderlagFilename, renderWebshopDayUnderlagPdf } from '../day-underlag'

const base = {
  row_type: 'order' as const,
  order_date: '2026-10-14',
  paid_date: '2026-10-14',
  customer_country: 'se',
  currency: 'SEK',
  total_sek: null,
  exchange_rate: null,
}

function model() {
  return buildDayUnderlagModel({
    platform: 'shopify',
    storeLabel: 'Butiken',
    date: '2026-10-14',
    paymentMethod: 'paypal',
    orders: [
      { ...base, order_number: '#1001', total: 125, total_tax: 25 },
      // A euro order books in SEK at its own rate.
      { ...base, order_number: '#1002', customer_country: 'DE', currency: 'EUR', total: 10, total_tax: 2, total_sek: 115.5, exchange_rate: 11.55 },
      { ...base, order_number: '#1001', row_type: 'refund' as const, paid_date: null, total: -50, total_tax: -10 },
    ],
    lines: [
      { account_number: '1686', debit_amount: 240.5, credit_amount: 0 },
      { account_number: '1686', debit_amount: 0, credit_amount: 50 },
      { account_number: '3001', debit_amount: 0, credit_amount: 152.4 },
      { account_number: '2611', debit_amount: 0, credit_amount: 38.1 },
    ],
    voucherLabel: 'L41',
  })
}

describe('buildDayUnderlagModel', () => {
  it('lists every order with its SEK amount and VAT, and sums the day', () => {
    const m = model()
    expect(m.rows.map((r) => [r.orderNumber, r.kind, r.paidDate, r.country, r.totalSek, r.vatSek])).toEqual([
      ['#1001', 'Order', '2026-10-14', 'SE', 125, 25],
      ['#1002', 'Order', '2026-10-14', 'DE', 115.5, 23.1],
      ['#1001', 'Återbetalning', '2026-10-14', 'SE', -50, -10],
    ])
    expect(m).toMatchObject({ orderCount: 2, refundCount: 1, totalSek: 190.5, vatSek: 38.1, totalDebit: 240.5, totalCredit: 240.5, platformLabel: 'Shopify' })
  })

  it('names the file after the platform, day and payment method', () => {
    expect(dayUnderlagFilename(model())).toBe('Dagssammanstallning_Shopify_2026-10-14_paypal.pdf')
  })

  it('renders a PDF', async () => {
    const { bytes, filename } = await renderWebshopDayUnderlagPdf({
      model: model(),
      company: { company_name: 'Exempel AB', org_number: '556677-8899' },
      generatedAt: '2026-10-15',
    })
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    expect(filename).toBe('Dagssammanstallning_Shopify_2026-10-14_paypal.pdf')
  })
})
