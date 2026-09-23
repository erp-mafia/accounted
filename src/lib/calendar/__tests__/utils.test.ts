import { describe, it, expect } from 'vitest'
import { invoiceSekAmount, calculatePeriodSummary, createPaymentCalendarDay } from '../utils'
import { makeInvoice } from '@/tests/helpers'

describe('invoiceSekAmount', () => {
  it('prefers the stored SEK conversion', () => {
    const inv = makeInvoice({ total: 100, total_sek: 1150, currency: 'EUR' })
    expect(invoiceSekAmount(inv)).toBe(1150)
  })

  it('uses total directly for SEK invoices without a conversion', () => {
    const inv = makeInvoice({ total: 100, total_sek: null, currency: 'SEK' })
    expect(invoiceSekAmount(inv)).toBe(100)
  })

  it('returns null for a non-SEK invoice without a stored conversion', () => {
    // total_sek stays NULL when the rate fetch failed at creation: the raw
    // EUR total must never be treated as kronor.
    const inv = makeInvoice({ total: 100, total_sek: null, currency: 'EUR' })
    expect(invoiceSekAmount(inv)).toBeNull()
  })
})

describe('calculatePeriodSummary', () => {
  it('excludes unconverted foreign invoices from totals and counts them', () => {
    const past = '2000-01-01'
    const invoices = [
      makeInvoice({ status: 'sent', due_date: past, total: 1000, total_sek: null, currency: 'SEK' }),
      // Unconverted EUR invoice: counted, never summed as kr.
      makeInvoice({ status: 'sent', due_date: past, total: 500, total_sek: null, currency: 'EUR' }),
      makeInvoice({ status: 'paid', total: 200, total_sek: 2300, currency: 'EUR' }),
    ]

    const summary = calculatePeriodSummary(invoices)

    expect(summary.totalExpected).toBe(1000)
    expect(summary.totalOverdue).toBe(1000)
    expect(summary.totalPaid).toBe(2300)
    expect(summary.pendingCount).toBe(2)
    expect(summary.unconvertedCount).toBe(1)
  })
})

describe('createPaymentCalendarDay', () => {
  it('skips unconverted foreign invoices in the day total', () => {
    const date = '2026-07-25'
    const invoices = [
      makeInvoice({ status: 'sent', due_date: date, total: 1000, total_sek: null, currency: 'SEK' }),
      makeInvoice({ status: 'sent', due_date: date, total: 500, total_sek: null, currency: 'EUR' }),
    ]

    const day = createPaymentCalendarDay(date, invoices)

    expect(day.totalExpected).toBe(1000)
    expect(day.invoices).toHaveLength(2)
  })
})
