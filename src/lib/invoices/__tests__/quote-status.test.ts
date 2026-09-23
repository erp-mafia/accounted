import { describe, it, expect } from 'vitest'
import { effectiveQuoteStatus, formatQuoteNumber, isQuoteExpired } from '@/lib/invoices/quote-status'

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

  it('formats quote numbers like generate_quote_number', () => {
    expect(formatQuoteNumber(1)).toBe('OF-001')
    expect(formatQuoteNumber(42)).toBe('OF-042')
    expect(formatQuoteNumber(1234)).toBe('OF-1234')
  })
})
