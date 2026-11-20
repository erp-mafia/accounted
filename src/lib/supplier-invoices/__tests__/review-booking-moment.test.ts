import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeSupplier } from '@/tests/helpers'
import { SupplierInvoiceReviewContent } from '@/components/suppliers/SupplierInvoiceReviewContent'
import { invoiceBookingMoment, type InvoiceBookingMoment } from '@/lib/bookkeeping/booking-mode'
import { formatAmount } from '@/lib/utils'
import { chartVatTreatmentsOf, type ChartVatTreatments } from '@/lib/bookkeeping/vat-entries'

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/components/ui/account-number', () => ({ AccountNumber: ({ number }: { number: string }) => number }))

// The review dialog opened before an AB registers a supplier invoice. It used
// to always preview the faktureringsmetoden registration verifikat (credit
// 2440), also for kontantmetoden companies, where nothing is booked at
// registration and the payment books a cash entry with no 2440 at all.
function render(
  bookingMoment: InvoiceBookingMoment,
  reverseCharge = false,
  chartVatTreatments: ChartVatTreatments = new Map(),
  rcItem: Record<string, unknown> = {},
): string {
  return renderToStaticMarkup(createElement(SupplierInvoiceReviewContent, {
    chartVatTreatments,
    supplier: makeSupplier({ supplier_type: reverseCharge ? 'eu_business' : 'swedish_business' }),
    invoiceNumber: 'F-1',
    invoiceDate: '2026-09-01',
    dueDate: '2026-09-30',
    currency: 'SEK',
    reverseCharge,
    oreRounding: false,
    bookingMoment,
    items: [
      reverseCharge
        ? { description: 'Hosting', amount: 1000, account_number: '6540', vat_rate: 0, reverse_charge_rate: 0.25, ...rcItem }
        : { description: 'Kontorsmaterial', amount: 1000, account_number: '6110', vat_rate: 0.25 },
    ],
  }))
}

/**
 * [account, debit, credit] for each line row of the voucher preview table
 * (VoucherLinesTable): cell text without its markup, and without the Summa
 * row, the one row that spans columns.
 */
function voucherRows(html: string): string[][] {
  const body = [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].at(-1)![1]
  const text = (cell: string) => cell.replace(/<[^>]+>/g, '')
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .filter((row) => !row[1].includes('colSpan') && !row[1].includes('colspan'))
    .map((row) => {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => text(cell[1]))
      return [cells[0], cells[2], cells[3]]
    })
}

describe('SupplierInvoiceReviewContent booking moment', () => {
  it('previews the registration verifikat when the confirm books it (faktureringsmetoden)', () => {
    const html = render('issue')
    expect(html).toContain('review_voucher_preview_title')
    expect(html).not.toContain('review_books_at_payment')
    expect(voucherRows(html)).toEqual([
      ['6110', formatAmount(1000), ''],
      ['2641', formatAmount(250), ''],
      ['2440', '', formatAmount(1250)],
    ])
  })

  it.each([false, true])('shows no verifikat and no 2440 under kontantmetoden (reverse charge %s)', (reverseCharge) => {
    const html = render('payment', reverseCharge)
    expect(html).not.toContain('review_voucher_preview_title')
    expect(html).not.toContain('2440')
    expect(html).not.toContain('2641')
    expect(html).not.toContain('2645')
    expect(html).toContain('review_books_at_payment')
  })

  it('previews the reverse-charge basis pair on an ordinary cost account', () => {
    const accounts = voucherRows(render('issue', true)).map((row) => row[0])
    expect(accounts).toEqual(['6540', '2645', '2614', '4535', '4598', '2440'])
  })

  it('previews no basis pair on an account whose momskod reports ruta 20-24 itself, as registration books it (crm#1096)', () => {
    const rows = voucherRows(render('issue', true, chartVatTreatmentsOf([
      { account_number: '6540', default_vat_treatment: 'reverse_charge_eu_services' },
    ])))
    expect(rows).toEqual([
      ['6540', formatAmount(1000), ''],
      ['2645', formatAmount(250), ''],
      ['2614', '', formatAmount(250)],
      ['2440', '', formatAmount(1000)],
    ])
  })

  it('previews an account at 12 % self-assessed at 12 %, and a periodiserad item with its pair, as registration books them (crm#1096)', () => {
    const chart = chartVatTreatmentsOf([
      { account_number: '6540', default_vat_treatment: 'reverse_charge_eu_services', default_vat_rate: 0.12 },
    ])
    expect(voucherRows(render('issue', true, chart))).toEqual([
      ['6540', formatAmount(1000), ''],
      ['2645', formatAmount(120), ''],
      ['2624', '', formatAmount(120)],
      ['2440', '', formatAmount(1000)],
    ])
    const accrued = { accrual_period_start: '2026-09-01', accrual_period_end: '2027-08-31', accrual_balance_account: '1790' }
    expect(voucherRows(render('issue', true, chart, accrued)).map((row) => row[0]))
      .toEqual(['1790', '2645', '2614', '4535', '4598', '2440'])
  })

  it('shows no verifikat when booking is deferred to the explicit Bokför step', () => {
    const html = render('manual')
    expect(html).not.toContain('review_voucher_preview_title')
    expect(html).not.toContain('2440')
    expect(html).toContain('review_books_on_book_step')
  })

  it('takes the moment from the company settings, cash winning over the defer flag', () => {
    expect(invoiceBookingMoment({ accounting_method: 'cash', defer_invoice_booking: true })).toBe('payment')
    expect(render(invoiceBookingMoment({ accounting_method: 'cash' }))).not.toContain('2440')
    expect(render(invoiceBookingMoment({ accounting_method: 'accrual' }))).toContain('2440')
  })
})
