import { describe, it, expect } from 'vitest'
import { quoteInvoicingProgress } from '@/lib/invoices/quote-status'

// crm#1196: a quote can be invoiced in parts, so "done" means fully
// invoiced, derived from the live invoices converted from it.

describe('quoteInvoicingProgress', () => {
  it('derives invoiced so far and remaining from the live invoices made from the quote', () => {
    expect(quoteInvoicingProgress({ subtotal: 25000 }, [])).toEqual({
      quoteSubtotal: 25000,
      invoiced: 0,
      remaining: 25000,
      invoiceCount: 0,
      fullyInvoiced: false,
    })
    expect(
      quoteInvoicingProgress({ subtotal: 25000 }, [
        { status: 'sent', subtotal: 12500 },
        { status: 'cancelled', subtotal: 12500 },
      ]),
    ).toMatchObject({ invoiced: 12500, remaining: 12500, invoiceCount: 1, fullyInvoiced: false })
  })

  it('is done once fully invoiced, not once an invoice exists', () => {
    expect(
      quoteInvoicingProgress({ subtotal: '100.01' }, [
        { status: 'paid', subtotal: '30.00' },
        { status: 'sent', subtotal: 30 },
        { status: 'draft', subtotal: 40.01 },
      ]),
    ).toMatchObject({ invoiced: 100.01, remaining: 0, invoiceCount: 3, fullyInvoiced: true })
  })

  it('never reports a negative remainder, and a zero quote is done only once converted', () => {
    // A converted draft edited upwards.
    expect(quoteInvoicingProgress({ subtotal: 1000 }, [{ status: 'draft', subtotal: 1200 }])).toMatchObject({
      remaining: 0,
      fullyInvoiced: true,
    })
    expect(quoteInvoicingProgress({ subtotal: 0 }, [{ status: 'sent', subtotal: 0 }]).fullyInvoiced).toBe(true)
    expect(quoteInvoicingProgress({ subtotal: 0 }, []).fullyInvoiced).toBe(false)
  })
})
