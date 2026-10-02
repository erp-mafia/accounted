import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeSupplier } from '@/tests/helpers'
import { SupplierInvoiceReviewContent } from '@/components/suppliers/SupplierInvoiceReviewContent'
import { invoiceBookingMoment, type InvoiceBookingMoment } from '@/lib/bookkeeping/booking-mode'
import { formatAmount } from '@/lib/utils'

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/components/ui/account-number', () => ({ AccountNumber: ({ number }: { number: string }) => number }))

// The review dialog opened before an AB registers a supplier invoice. It used
// to always preview the faktureringsmetoden registration verifikat (credit
// 2440), also for kontantmetoden companies, where nothing is booked at
// registration and the payment books a cash entry with no 2440 at all.
function render(bookingMoment: InvoiceBookingMoment, reverseCharge = false): string {
  return renderToStaticMarkup(createElement(SupplierInvoiceReviewContent, {
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
        ? { description: 'Hosting', amount: 1000, account_number: '6540', vat_rate: 0, reverse_charge_rate: 0.25 }
        : { description: 'Kontorsmaterial', amount: 1000, account_number: '6110', vat_rate: 0.25 },
    ],
  }))
}

/** [account, debit, credit] for each row of the voucher preview table. */
function voucherRows(html: string): string[][] {
  const body = [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].at(-1)![1]
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) => {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1])
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
