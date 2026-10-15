import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  mergeResumeItems,
  isSalaryRunLate,
  invoiceResumeItem,
  quoteResumeItem,
  listResumeItems,
  RESUME_MAX_ROWS,
  type ResumeItem,
  type ResumeInvoiceRow,
  type ResumeQuoteRow,
} from '../resume'

function item(overrides: Partial<ResumeItem>): ResumeItem {
  return {
    kind: 'journal_draft',
    ref: `journal:${Math.abs(overrides.updated_at?.length ?? 1)}`,
    href: '/bookkeeping/x',
    context: null,
    updated_at: '2026-07-01T10:00:00Z',
    ...overrides,
  }
}

describe('mergeResumeItems', () => {
  it('orders by updated_at desc', () => {
    const merged = mergeResumeItems([
      item({ ref: 'a', updated_at: '2026-07-01T10:00:00Z' }),
      item({ ref: 'b', updated_at: '2026-07-03T10:00:00Z' }),
      item({ ref: 'c', updated_at: '2026-07-02T10:00:00Z' }),
    ])
    expect(merged.map((i) => i.ref)).toEqual(['b', 'c', 'a'])
  })

  it('boosts late items above newer non-late items', () => {
    const merged = mergeResumeItems([
      item({ ref: 'fresh', updated_at: '2026-07-20T10:00:00Z' }),
      item({ ref: 'late-old', late: true, updated_at: '2026-05-01T10:00:00Z' }),
    ])
    expect(merged[0].ref).toBe('late-old')
  })

  it('caps at RESUME_MAX_ROWS', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      item({ ref: `r${i}`, updated_at: `2026-07-0${i + 1}T10:00:00Z` }),
    )
    expect(mergeResumeItems(many)).toHaveLength(RESUME_MAX_ROWS)
  })

  it('keeps late-first ordering stable within groups', () => {
    const merged = mergeResumeItems([
      item({ ref: 'late-new', late: true, updated_at: '2026-07-10T10:00:00Z' }),
      item({ ref: 'late-old', late: true, updated_at: '2026-06-10T10:00:00Z' }),
      item({ ref: 'plain', updated_at: '2026-07-22T10:00:00Z' }),
    ])
    expect(merged.map((i) => i.ref)).toEqual(['late-new', 'late-old', 'plain'])
  })

  it('does not mutate the input array', () => {
    const input = [
      item({ ref: 'a', updated_at: '2026-07-01T10:00:00Z' }),
      item({ ref: 'b', updated_at: '2026-07-02T10:00:00Z' }),
    ]
    const before = [...input]
    mergeResumeItems(input)
    expect(input).toEqual(before)
  })
})

describe('isSalaryRunLate', () => {
  const now = new Date('2026-07-23T12:00:00Z')

  it('flags a run two months past its period', () => {
    expect(isSalaryRunLate(2026, 5, now)).toBe(true)
  })

  it('does not flag last month', () => {
    expect(isSalaryRunLate(2026, 6, now)).toBe(false)
  })

  it('does not flag the current period', () => {
    expect(isSalaryRunLate(2026, 7, now)).toBe(false)
  })

  it('handles year boundaries', () => {
    expect(isSalaryRunLate(2025, 12, now)).toBe(true)
  })
})

const TODAY = '2026-10-14'

function invoiceRow(overrides: Partial<ResumeInvoiceRow> = {}): ResumeInvoiceRow {
  return {
    id: 'inv-1',
    invoice_number: null,
    invoice_date: TODAY,
    total: 1250,
    currency: 'SEK',
    updated_at: '2026-10-14T08:00:00Z',
    customer: { name: 'Kund AB' },
    ...overrides,
  }
}

function quoteRow(overrides: Partial<ResumeQuoteRow> = {}): ResumeQuoteRow {
  return {
    id: 'q-1',
    invoice_number: 'OF-002',
    status: 'draft',
    quote_status: 'open',
    valid_until: '2026-10-22',
    subtotal: 4000,
    total: 5000,
    currency: 'SEK',
    updated_at: '2026-10-14T09:00:00Z',
    customer: { name: 'Kund AB' },
    conversions: [],
    orders: [],
    ...overrides,
  }
}

describe('invoiceResumeItem', () => {
  it('lists an unnumbered draft as a draft, never late', () => {
    const item = invoiceResumeItem(invoiceRow({ invoice_date: '2026-09-01' }), TODAY)
    expect(item.kind).toBe('invoice_draft')
    expect(item.late).toBe(false)
    expect(item.context).toBe('Kund AB')
    expect(item.href).toBe('/invoices/inv-1')
  })

  it('lists a numbered draft as unsent, late once its invoice date has passed', () => {
    const item = invoiceResumeItem(invoiceRow({ invoice_number: 'F-101', invoice_date: '2026-10-13' }), TODAY)
    expect(item.kind).toBe('invoice_unsent')
    expect(item.number).toBe('F-101')
    expect(item.late).toBe(true)
  })

  it('does not mark a numbered draft dated today or later as late', () => {
    expect(invoiceResumeItem(invoiceRow({ invoice_number: 'F-101', invoice_date: TODAY }), TODAY).late).toBe(false)
    expect(invoiceResumeItem(invoiceRow({ invoice_number: 'F-101', invoice_date: '2026-11-01' }), TODAY).late).toBe(false)
  })

  it('reads an array-shaped customer embed', () => {
    expect(invoiceResumeItem(invoiceRow({ customer: [{ name: 'Array AB' }] }), TODAY).context).toBe('Array AB')
  })
})

describe('quoteResumeItem', () => {
  it('asks to send an open quote that was never sent, not late', () => {
    const item = quoteResumeItem(quoteRow(), TODAY)
    expect(item?.kind).toBe('quote_unsent')
    expect(item?.number).toBe('OF-002')
    expect(item?.late).toBe(false)
    expect(item?.href).toBe('/invoices/q-1')
  })

  it('leaves out an open quote that was sent: the customer decides', () => {
    expect(quoteResumeItem(quoteRow({ status: 'sent' }), TODAY)).toBeNull()
  })

  it('leaves out an expired open quote', () => {
    expect(quoteResumeItem(quoteRow({ valid_until: '2026-10-13' }), TODAY)).toBeNull()
  })

  it('asks to create the invoice for an accepted quote, never late (crm#1199)', () => {
    // The ticket's shape: accepted, still status draft, dates in the future.
    const item = quoteResumeItem(quoteRow({ quote_status: 'accepted' }), TODAY)
    expect(item?.kind).toBe('quote_to_invoice')
    expect(item?.late).toBe(false)
    // valid_until passing does not expire an accepted quote, nor make it late.
    const later = quoteResumeItem(quoteRow({ quote_status: 'accepted', valid_until: '2026-10-01' }), TODAY)
    expect(later?.kind).toBe('quote_to_invoice')
    expect(later?.late).toBe(false)
  })

  it('asks to create the invoice for an accepted quote that was sent first', () => {
    expect(quoteResumeItem(quoteRow({ status: 'sent', quote_status: 'accepted' }), TODAY)?.kind).toBe('quote_to_invoice')
  })

  it('leaves out an accepted quote that is fully invoiced or has a live kundorder', () => {
    expect(quoteResumeItem(quoteRow({ quote_status: 'accepted', conversions: [{ status: 'draft', subtotal: 4000 }] }), TODAY)).toBeNull()
    expect(quoteResumeItem(quoteRow({ quote_status: 'accepted', orders: [{ status: 'confirmed' }] }), TODAY)).toBeNull()
  })

  it('keeps an accepted quote invoiced in part until the rest is invoiced (crm#1196)', () => {
    const half = quoteResumeItem(quoteRow({ quote_status: 'accepted', conversions: [{ status: 'sent', subtotal: 2000 }] }), TODAY)
    expect(half?.kind).toBe('quote_to_invoice')
    const both = quoteResumeItem(
      quoteRow({ quote_status: 'accepted', conversions: [{ status: 'sent', subtotal: 2000 }, { status: 'draft', subtotal: 2000 }] }),
      TODAY,
    )
    expect(both).toBeNull()
  })

  it('lists an accepted quote again once its converted invoice was cancelled', () => {
    const item = quoteResumeItem(quoteRow({ quote_status: 'accepted', conversions: [{ status: 'cancelled' }] }), TODAY)
    expect(item?.kind).toBe('quote_to_invoice')
  })

  it('leaves out declined and cancelled quotes', () => {
    expect(quoteResumeItem(quoteRow({ quote_status: 'declined' }), TODAY)).toBeNull()
    expect(quoteResumeItem(quoteRow({ status: 'cancelled' }), TODAY)).toBeNull()
    expect(quoteResumeItem(quoteRow({ status: 'cancelled', quote_status: 'accepted' }), TODAY)).toBeNull()
  })
})

describe('listResumeItems', () => {
  const now = new Date('2026-10-14T10:00:00Z')

  it('reads fakturor and quotes apart and never calls a quote an unsent invoice (crm#1199)', async () => {
    const { supabase, findCalls } = createTableMockSupabase({
      invoices: [
        // 1st read: fakturor (document_type 'invoice')
        {
          data: [
            invoiceRow({ id: 'inv-late', invoice_number: 'F-090', invoice_date: '2026-10-01', updated_at: '2026-10-02T08:00:00Z' }),
          ],
        },
        // 2nd read: quotes
        {
          data: [
            quoteRow({ id: 'q-2', invoice_number: 'OF-002', quote_status: 'accepted', updated_at: '2026-10-14T09:03:00Z' }),
            quoteRow({ id: 'q-3', invoice_number: 'OF-003', quote_status: 'accepted', updated_at: '2026-10-14T09:02:00Z' }),
            quoteRow({ id: 'q-9', invoice_number: 'OF-009', quote_status: 'accepted', conversions: [{ status: 'sent', subtotal: 4000 }], updated_at: '2026-10-14T09:05:00Z' }),
          ],
        },
      ],
    })

    const items = await listResumeItems(supabase as unknown as SupabaseClient, 'company-1', now)

    expect(items.map((i) => [i.kind, i.number, i.late])).toEqual([
      ['invoice_unsent', 'F-090', true],
      ['quote_to_invoice', 'OF-002', false],
      ['quote_to_invoice', 'OF-003', false],
    ])
    const docTypeFilters = findCalls('invoices', 'eq').filter((args) => args[0] === 'document_type')
    expect(docTypeFilters).toEqual([
      ['document_type', 'invoice'],
      ['document_type', 'quote'],
    ])
  })

  it('soft-fails to an empty list when every read errors', async () => {
    const { supabase } = createTableMockSupabase({
      journal_entries: { error: { message: 'boom' } },
      invoices: { error: { message: 'boom' } },
      salary_runs: { error: { message: 'boom' } },
    })
    const items = await listResumeItems(supabase as unknown as SupabaseClient, 'company-1', now)
    expect(items).toEqual([])
  })
})
