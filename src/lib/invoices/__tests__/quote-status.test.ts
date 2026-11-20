import { describe, it, expect } from 'vitest'
import {
  effectiveQuoteStatus,
  formatQuoteNumber,
  isQuoteExpired,
  isUnsentQuote,
  quoteAwaitsSending,
  quoteDisplayStatus,
  quoteHasLiveFollowUp,
} from '@/lib/invoices/quote-status'

describe('quote status helpers', () => {
  it('derives expired only for an open quote past valid_until', () => {
    expect(isQuoteExpired({ quote_status: 'open', valid_until: '2026-05-31' }, '2026-06-01')).toBe(true)
    expect(isQuoteExpired({ quote_status: 'open', valid_until: '2026-06-01' }, '2026-06-01')).toBe(false)
    expect(isQuoteExpired({ quote_status: 'accepted', valid_until: '2026-05-31' }, '2026-06-01')).toBe(false)
    expect(isQuoteExpired({ quote_status: 'declined', valid_until: '2026-05-31' }, '2026-06-01')).toBe(false)
    expect(isQuoteExpired({ quote_status: 'open', valid_until: null }, '2026-06-01')).toBe(false)
  })

  it('reports the stored decision, expired, or null for non-quotes', () => {
    expect(effectiveQuoteStatus({ quote_status: 'open', valid_until: '2026-05-31' }, '2026-06-01')).toBe('expired')
    expect(effectiveQuoteStatus({ quote_status: 'open', valid_until: '2026-06-30' }, '2026-06-01')).toBe('open')
    expect(effectiveQuoteStatus({ quote_status: 'accepted', valid_until: '2026-05-31' }, '2026-06-01')).toBe('accepted')
    expect(effectiveQuoteStatus({ quote_status: null, valid_until: null })).toBeNull()
  })

  it('treats a quote as done once fully invoiced or while a kundorder from it lives', () => {
    expect(quoteHasLiveFollowUp({})).toBe(false)
    expect(quoteHasLiveFollowUp({ subtotal: 1000, conversions: null, orders: null })).toBe(false)
    expect(quoteHasLiveFollowUp({ subtotal: 1000, conversions: [{ status: 'draft', subtotal: 1000 }] })).toBe(true)
    expect(quoteHasLiveFollowUp({ subtotal: 1000, conversions: [{ status: 'paid', subtotal: 1000 }] })).toBe(true)
    expect(quoteHasLiveFollowUp({ subtotal: 1000, orders: [{ status: 'confirmed' }] })).toBe(true)
    // A part invoice (crm#1196) leaves the rest to invoice: not done yet.
    expect(quoteHasLiveFollowUp({ subtotal: 1000, conversions: [{ status: 'sent', subtotal: 500 }] })).toBe(false)
    expect(quoteHasLiveFollowUp({ subtotal: 1000, conversions: [{ status: 'sent', subtotal: 500 }, { status: 'draft', subtotal: 500 }] })).toBe(true)
    // A cancelled follow-up frees the quote again, as convertToInvoice does.
    expect(quoteHasLiveFollowUp({ subtotal: 1000, conversions: [{ status: 'cancelled', subtotal: 1000 }], orders: [{ status: 'cancelled' }] })).toBe(false)
    expect(quoteHasLiveFollowUp({ subtotal: 1000, conversions: [{ status: 'cancelled', subtotal: 1000 }, { status: 'sent', subtotal: 1000 }] })).toBe(true)
  })

  it('formats quote numbers like generate_quote_number', () => {
    expect(formatQuoteNumber(1)).toBe('OF-001')
    expect(formatQuoteNumber(42)).toBe('OF-042')
    expect(formatQuoteNumber(1234)).toBe('OF-1234')
  })

  // crm#1202: the delivery axis (status) is separate from the decision axis
  // (quote_status); only the first says whether the customer has seen it.
  it('treats a quote as unsent only while its status is draft', () => {
    expect(isUnsentQuote({ document_type: 'quote', status: 'draft', quote_status: 'open' })).toBe(true)
    expect(isUnsentQuote({ document_type: 'quote', status: 'draft', quote_status: 'accepted' })).toBe(true)
    expect(isUnsentQuote({ document_type: 'quote', status: 'sent', quote_status: 'open' })).toBe(false)
    expect(isUnsentQuote({ document_type: 'quote', status: 'cancelled', quote_status: 'open' })).toBe(false)
    expect(isUnsentQuote({ document_type: 'invoice', status: 'draft', quote_status: null })).toBe(false)
    expect(isUnsentQuote({ document_type: 'proforma', status: 'draft' })).toBe(false)
  })

  it('waits for sending until the quote leaves or the customer says yes', () => {
    expect(quoteAwaitsSending({ document_type: 'quote', status: 'draft', quote_status: 'open' })).toBe(true)
    expect(quoteAwaitsSending({ document_type: 'quote', status: 'draft', quote_status: 'declined' })).toBe(true)
    expect(quoteAwaitsSending({ document_type: 'quote', status: 'draft', quote_status: 'accepted' })).toBe(false)
    expect(quoteAwaitsSending({ document_type: 'quote', status: 'sent', quote_status: 'open' })).toBe(false)
    expect(quoteAwaitsSending({ document_type: 'invoice', status: 'draft', quote_status: null })).toBe(false)
  })

  it('shows an open quote that never left as unsent, and every decision as it is', () => {
    const today = '2026-06-01'
    const quote = (status: string, quote_status: string, valid_until = '2026-06-30') =>
      ({ document_type: 'quote', status, quote_status, valid_until })
    expect(quoteDisplayStatus(quote('draft', 'open'), today)).toBe('unsent')
    expect(quoteDisplayStatus(quote('sent', 'open'), today)).toBe('open')
    expect(quoteDisplayStatus(quote('draft', 'accepted'), today)).toBe('accepted')
    expect(quoteDisplayStatus(quote('draft', 'declined'), today)).toBe('declined')
    // An expired offer needs a new date before it is worth sending.
    expect(quoteDisplayStatus(quote('draft', 'open', '2026-05-31'), today)).toBe('expired')
    expect(quoteDisplayStatus({ document_type: 'invoice', status: 'draft', quote_status: null }, today)).toBeNull()
  })
})
