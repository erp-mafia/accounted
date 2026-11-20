import { describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { invoiceDueDate } from '@/lib/dates/iso'
import { invoiceTermsFor, loadInvoiceTerms } from '../due-date'

describe('invoiceDueDate', () => {
  it('is the invoice date plus the terms in calendar days', () => {
    expect(invoiceDueDate('2026-10-02', 0)).toBe('2026-10-02')
    expect(invoiceDueDate('2026-10-02', 14)).toBe('2026-10-16')
    expect(invoiceDueDate('2026-12-15', 30)).toBe('2027-01-14')
    expect(invoiceDueDate('2028-02-28', 1)).toBe('2028-02-29')
  })

  // A local setDate lost a day on the invoices dated before the spring clock
  // change: 30 invoice dates each year, in a process on Swedish time.
  it.each(['UTC', 'Europe/Stockholm', 'America/New_York'])('counts across the spring clock change in zone %s', (zone) => {
    vi.stubEnv('TZ', zone)
    try {
      expect(invoiceDueDate('2026-02-28', 30)).toBe('2026-03-30')
      expect(invoiceDueDate('2026-03-28', 1)).toBe('2026-03-29')
      expect(invoiceDueDate('2026-03-28', 2)).toBe('2026-03-30')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('invoiceTermsFor', () => {
  it('takes the customer first, 0 included: betalning direkt is a term', () => {
    expect(invoiceTermsFor(14, 10)).toBe(14)
    expect(invoiceTermsFor(0, 10)).toBe(0)
  })

  it('then the company default, then 30', () => {
    expect(invoiceTermsFor(null, 10)).toBe(10)
    expect(invoiceTermsFor(undefined, 10)).toBe(10)
    expect(invoiceTermsFor(null, null)).toBe(30)
    expect(invoiceTermsFor(null, undefined)).toBe(30)
  })

  it('a company default of 0 is not a setting', () => {
    expect(invoiceTermsFor(null, 0)).toBe(30)
  })

  it('anything but whole days falls through', () => {
    expect(invoiceTermsFor(1.5, 10)).toBe(10)
    expect(invoiceTermsFor(-1, 10)).toBe(10)
    expect(invoiceTermsFor(null, 2.5)).toBe(30)
  })
})

describe('loadInvoiceTerms', () => {
  it('reads nothing when the card has terms', async () => {
    const { supabase, findCalls } = createQueuedMockSupabase()
    expect(await loadInvoiceTerms(supabase as never, 'company-1', 0)).toBe(0)
    expect(findCalls('company_settings', 'select')).toEqual([])
  })

  it('reads the company default when it has none', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { invoice_default_days: 10 } })
    expect(await loadInvoiceTerms(supabase as never, 'company-1', null)).toBe(10)
  })

  it('a missing settings row is an answer: 30', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    expect(await loadInvoiceTerms(supabase as never, 'company-1', null)).toBe(30)
  })

  it('a failed read throws instead of dating the receivable on 30 days', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'timeout' } })
    await expect(loadInvoiceTerms(supabase as never, 'company-1', null)).rejects.toMatchObject({ message: 'timeout' })
  })
})
