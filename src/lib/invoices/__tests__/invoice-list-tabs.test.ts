import { describe, expect, it } from 'vitest'
import {
  INVOICE_LIST_TABS,
  QUOTE_LIST_TABS,
  isUnsentNumberedInvoice,
  matchesInvoiceListTab,
  matchesQuoteListTab,
  parseInvoiceListTab,
  parseQuoteListTab,
  type InvoiceListTab,
  type QuoteListTab,
} from '../invoice-list-tabs'

type Row = Parameters<typeof matchesInvoiceListTab>[0]

function row(overrides: Partial<Row> & { status: Row['status'] }): Row {
  return {
    invoice_number: null,
    credited_invoice_id: null,
    document_type: 'invoice',
    is_self_billed: false,
    ...overrides,
  }
}

function tabsFor(invoice: Row): InvoiceListTab[] {
  return INVOICE_LIST_TABS.filter((tab) => matchesInvoiceListTab(invoice, tab))
}

describe('isUnsentNumberedInvoice', () => {
  it('is the numbered draft faktura only', () => {
    expect(isUnsentNumberedInvoice(row({ status: 'draft', invoice_number: 'F-12' }))).toBe(true)
    expect(isUnsentNumberedInvoice(row({ status: 'draft' }))).toBe(false)
    expect(isUnsentNumberedInvoice(row({ status: 'sent', invoice_number: 'F-12' }))).toBe(false)
  })

  it('excludes credit notes, self-billed invoices and other document kinds', () => {
    expect(
      isUnsentNumberedInvoice(
        row({ status: 'draft', invoice_number: 'F-13', credited_invoice_id: 'orig' }),
      ),
    ).toBe(false)
    expect(
      isUnsentNumberedInvoice(row({ status: 'draft', invoice_number: 'F-14', is_self_billed: true })),
    ).toBe(false)
    expect(
      isUnsentNumberedInvoice(row({ status: 'draft', invoice_number: 'O-1', document_type: 'quote' })),
    ).toBe(false)
  })
})

describe('matchesInvoiceListTab', () => {
  it('splits DB status draft into unsent (numbered) and draft (unnumbered)', () => {
    expect(tabsFor(row({ status: 'draft', invoice_number: 'F-12' }))).toEqual(['all', 'unsent'])
    expect(tabsFor(row({ status: 'draft' }))).toEqual(['all', 'draft'])
  })

  it('keeps sent and overdue invoices in the unpaid view, never in unsent', () => {
    expect(tabsFor(row({ status: 'sent', invoice_number: 'F-12' }))).toEqual(['all', 'unpaid'])
    expect(tabsFor(row({ status: 'overdue', invoice_number: 'F-12' }))).toEqual([
      'all',
      'unpaid',
      'overdue',
    ])
  })

  it('does not put draft credit notes or drafts of other kinds in unsent or draft', () => {
    expect(
      tabsFor(row({ status: 'draft', invoice_number: 'F-13', credited_invoice_id: 'orig' })),
    ).toEqual(['all', 'credit'])
    expect(tabsFor(row({ status: 'draft', document_type: 'quote' }))).toEqual([])
    expect(tabsFor(row({ status: 'draft', document_type: 'proforma' }))).toEqual([
      'all',
      'proforma',
    ])
    expect(tabsFor(row({ status: 'draft', document_type: 'delivery_note' }))).toEqual([
      'all',
      'delivery_note',
    ])
  })

  it('treats a missing document_type as a faktura', () => {
    expect(
      tabsFor({ status: 'draft', invoice_number: 'F-12', credited_invoice_id: null }),
    ).toEqual(['all', 'unsent'])
  })

  it('keeps cancelled rows out of every view but cancelled', () => {
    expect(tabsFor(row({ status: 'cancelled', invoice_number: 'F-12' }))).toEqual(['cancelled'])
    expect(
      tabsFor(row({ status: 'cancelled', invoice_number: 'F-13', credited_invoice_id: 'orig' })),
    ).toEqual(['cancelled'])
  })

  it('counts every non-cancelled faktura in exactly one of unsent, draft, unpaid, paid', () => {
    const rows = [
      row({ status: 'draft' }),
      row({ status: 'draft', invoice_number: 'F-1' }),
      row({ status: 'sent', invoice_number: 'F-2' }),
      row({ status: 'overdue', invoice_number: 'F-3' }),
      row({ status: 'paid', invoice_number: 'F-4' }),
    ]
    const buckets: InvoiceListTab[] = ['unsent', 'draft', 'unpaid', 'paid']
    for (const invoice of rows) {
      expect(buckets.filter((tab) => matchesInvoiceListTab(invoice, tab))).toHaveLength(1)
    }
  })
})

describe('parseInvoiceListTab', () => {
  it('accepts tab ids and the documented aliases', () => {
    expect(parseInvoiceListTab('unsent')).toBe('unsent')
    expect(parseInvoiceListTab('drafts')).toBe('draft')
    expect(parseInvoiceListTab('godkanda')).toBe('unsent')
    expect(parseInvoiceListTab('approved')).toBe('unsent')
  })

  it('rejects unknown values', () => {
    expect(parseInvoiceListTab('bogus')).toBeNull()
    expect(parseInvoiceListTab(null)).toBeNull()
  })
})

describe('quotes', () => {
  function quoteTabsFor(invoice: Row & { quote_status?: string | null; valid_until?: string | null }): QuoteListTab[] {
    return QUOTE_LIST_TABS.filter((tab) => matchesQuoteListTab(invoice, tab, '2026-09-12'))
  }

  it('never appear in any invoice list view: a quote is not an invoice', () => {
    for (const status of ['draft', 'sent', 'paid', 'cancelled'] as const) {
      expect(tabsFor(row({ status, document_type: 'quote', invoice_number: 'OF-001' }))).toEqual([])
    }
  })

  it('bucket by decision, with expired derived from valid_until', () => {
    const open = { ...row({ status: 'sent', document_type: 'quote' }), quote_status: 'open', valid_until: '2026-12-31' }
    expect(quoteTabsFor(open)).toEqual(['all', 'open'])
    expect(quoteTabsFor({ ...open, valid_until: '2026-01-01' })).toEqual(['all', 'expired'])
    expect(quoteTabsFor({ ...open, quote_status: 'accepted', valid_until: '2026-01-01' })).toEqual([
      'all',
      'accepted',
    ])
    expect(quoteTabsFor({ ...open, quote_status: 'declined' })).toEqual(['all', 'declined'])
  })

  it('keep cancelled quotes in their own view only', () => {
    const cancelled = { ...row({ status: 'cancelled', document_type: 'quote' }), quote_status: 'open' }
    expect(quoteTabsFor(cancelled)).toEqual(['cancelled'])
  })

  it('ignore non-quote rows in the quote views', () => {
    expect(quoteTabsFor(row({ status: 'sent' }))).toEqual([])
  })

  it('parse the quote view ids and nothing else', () => {
    expect(parseQuoteListTab('open')).toBe('open')
    expect(parseQuoteListTab('unpaid')).toBeNull()
    expect(parseQuoteListTab(null)).toBeNull()
  })
})
