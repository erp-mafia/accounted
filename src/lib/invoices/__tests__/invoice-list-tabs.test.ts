import { describe, expect, it } from 'vitest'
import {
  INVOICE_LIST_TABS,
  QUOTE_LIST_TABS,
  isUnsentNumberedInvoice,
  matchesInvoiceListTab,
  matchesQuoteListTab,
  parseInvoiceListTab,
  parseQuoteListTab,
  segmentViewActive,
  statusPickerTabs,
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

const TODAY = '2026-10-13'

function tabsFor(invoice: Row): InvoiceListTab[] {
  return INVOICE_LIST_TABS.filter((tab) => matchesInvoiceListTab(invoice, tab, { today: TODAY }))
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
    expect(tabsFor(row({ status: 'sent', invoice_number: 'F-12', due_date: '2026-10-30' }))).toEqual(['all', 'unpaid'])
    expect(tabsFor(row({ status: 'overdue', invoice_number: 'F-12', due_date: '2026-09-30', remaining_amount: 100 }))).toEqual([
      'all',
      'unpaid',
      'overdue',
    ])
  })

  // Obetalda is the owed population (lib/invoices/overdue.ts isInvoiceOwed).
  // It read sent and overdue only, and the first consolidation of the owed
  // statuses pinned that for the founders to settle: a partly paid invoice
  // with money left was missing from the view and its count, and sat under
  // the settled section, while Att göra, the reminders and the reskontra
  // counted it as owed.
  describe('Obetalda is what the customer still owes', () => {
    const unpaid = (invoice: Row) => matchesInvoiceListTab(invoice, 'unpaid', { today: TODAY })

    it('lists a partly paid invoice with money left, due or not', () => {
      expect(tabsFor(row({ status: 'partially_paid', invoice_number: 'F-7', due_date: '2026-10-30', remaining_amount: 200 }))).toEqual([
        'all',
        'unpaid',
      ])
      expect(tabsFor(row({ status: 'partially_paid', invoice_number: 'F-8', due_date: '2026-09-01', remaining_amount: 200 }))).toEqual([
        'all',
        'unpaid',
        'overdue',
      ])
    })

    it('counts a missing remainder as owed', () => {
      expect(unpaid(row({ status: 'partially_paid', invoice_number: 'F-9' }))).toBe(true)
      expect(unpaid(row({ status: 'sent', invoice_number: 'F-10', remaining_amount: null }))).toBe(true)
    })

    it('leaves out an invoice with nothing left, a credit note and a document that is not a faktura', () => {
      expect(unpaid(row({ status: 'partially_paid', invoice_number: 'F-11', remaining_amount: 0 }))).toBe(false)
      expect(unpaid(row({ status: 'sent', invoice_number: 'F-12', remaining_amount: 0 }))).toBe(false)
      expect(unpaid(row({ status: 'sent', invoice_number: 'K-1', credited_invoice_id: 'orig', remaining_amount: 500 }))).toBe(false)
      expect(unpaid(row({ status: 'sent', document_type: 'proforma', remaining_amount: 500 }))).toBe(false)
      expect(unpaid(row({ status: 'paid', invoice_number: 'F-13', remaining_amount: 0 }))).toBe(false)
    })
  })

  describe('Förfallna follows the due date, not the stored status (crm#1084)', () => {
    const overdue = (invoice: Row) => matchesInvoiceListTab(invoice, 'overdue', { today: TODAY })

    it('lists a sent invoice past its due date that no reminder ever flipped', () => {
      expect(overdue(row({ status: 'sent', invoice_number: 'F-1', due_date: '2026-10-12', remaining_amount: 500 }))).toBe(true)
    })

    it('lists a partly paid invoice whose remainder is past due', () => {
      expect(overdue(row({ status: 'partially_paid', invoice_number: 'F-2', due_date: '2026-09-01', remaining_amount: 200 }))).toBe(true)
    })

    it('leaves out an invoice due today or later, and a stored overdue whose due date moved', () => {
      expect(overdue(row({ status: 'sent', invoice_number: 'F-3', due_date: TODAY, remaining_amount: 500 }))).toBe(false)
      expect(overdue(row({ status: 'overdue', invoice_number: 'F-4', due_date: '2026-11-01', remaining_amount: 500 }))).toBe(false)
    })

    it('leaves out paid, cancelled, credited, draft and fully settled invoices', () => {
      const past = { due_date: '2026-09-01', remaining_amount: 500 }
      for (const status of ['paid', 'cancelled', 'credited', 'draft'] as const) {
        expect(overdue(row({ status, invoice_number: 'F-5', ...past }))).toBe(false)
      }
      expect(overdue(row({ status: 'sent', invoice_number: 'F-6', due_date: '2026-09-01', remaining_amount: 0 }))).toBe(false)
    })

    it('leaves out credit notes and documents that are not fakturor', () => {
      const past = { due_date: '2026-09-01', remaining_amount: 500 }
      expect(overdue(row({ status: 'sent', invoice_number: 'K-1', credited_invoice_id: 'orig', ...past }))).toBe(false)
      expect(overdue(row({ status: 'sent', document_type: 'proforma', ...past }))).toBe(false)
      expect(overdue(row({ status: 'sent', document_type: 'quote', ...past }))).toBe(false)
    })
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
      row({ status: 'partially_paid', invoice_number: 'F-5', remaining_amount: 300 }),
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

describe('the collections tab', () => {
  it('shows exactly the invoices the context marks as with the collections provider', () => {
    const invoice = { id: 'inv-1', status: 'sent', invoice_number: '1', credited_invoice_id: null, document_type: 'invoice' } as const
    expect(matchesInvoiceListTab(invoice, 'collections', { inCollection: new Set(['inv-1']) })).toBe(true)
    expect(matchesInvoiceListTab(invoice, 'collections', { inCollection: new Set(['inv-2']) })).toBe(false)
    expect(matchesInvoiceListTab(invoice, 'collections')).toBe(false)
    // A case that needs a person (the Att göra row lands on this view).
    expect(matchesInvoiceListTab(invoice, 'collections', { collectionAttention: new Set(['inv-1']) })).toBe(true)
    expect(parseInvoiceListTab('collections')).toBe('collections')
    expect(INVOICE_LIST_TABS).toContain('collections')
  })

  it('an overdue invoice "Hos inkasso" lists is that view\'s, never Förfallna\'s too (crm#1084)', () => {
    const overdue = row({ id: 'inv-1', status: 'sent', invoice_number: 'F-1', due_date: '2026-09-01', remaining_amount: 500 })
    const views = (context: Parameters<typeof matchesInvoiceListTab>[2]) =>
      INVOICE_LIST_TABS.filter((tab) => matchesInvoiceListTab(overdue, tab, { today: TODAY, ...context }))
    expect(views({})).toContain('overdue')
    // With the provider (an open case past delivery).
    expect(views({ inCollection: new Set(['inv-1']) })).toEqual(['all', 'unpaid', 'collections'])
    // A case a person must look at (a refused handover, a failed read).
    expect(views({ collectionAttention: new Set(['inv-1']) })).toEqual(['all', 'unpaid', 'collections'])
    // Another invoice's case changes nothing for this one.
    expect(views({ inCollection: new Set(['inv-2']) })).toEqual(['all', 'unpaid', 'overdue'])
  })
})


describe('Förfallna follows the due date (crm#1084), with collections in play', () => {
  const today = '2026-10-09'
  const context = { today, inCollection: new Set(['at-provider']) }

  it('follows the due date: a sent invoice past it is overdue though no reminder set the status', () => {
    const sent = row({ status: 'sent', id: 'a', due_date: '2026-09-02', remaining_amount: 1250 })
    expect(matchesInvoiceListTab(sent, 'overdue', context)).toBe(true)
  })

  it('includes a partly paid invoice past its due date', () => {
    expect(matchesInvoiceListTab(row({ status: 'partially_paid', id: 'b', due_date: '2026-09-02', remaining_amount: 100 }), 'overdue', context)).toBe(
      true,
    )
  })

  it('leaves out an invoice not due yet, a paid one and one already at the provider', () => {
    expect(matchesInvoiceListTab(row({ status: 'sent', id: 'c', due_date: today, remaining_amount: 1 }), 'overdue', context)).toBe(false)
    expect(matchesInvoiceListTab(row({ status: 'overdue', id: 'd', due_date: '2026-09-02', remaining_amount: 0 }), 'overdue', context)).toBe(false)
    expect(
      matchesInvoiceListTab(row({ status: 'overdue', id: 'at-provider', due_date: '2026-09-02', remaining_amount: 10 }), 'overdue', context),
    ).toBe(false)
  })

  it('never lists a credit note', () => {
    expect(
      matchesInvoiceListTab(row({ status: 'sent', id: 'e', due_date: '2026-09-02', remaining_amount: -10, credited_invoice_id: 'x' }), 'overdue', context),
    ).toBe(false)
  })
})

describe('one door for Förfallna and Hos inkasso', () => {
  it('leaves the segmented views out of the status picker while the segmented control shows', () => {
    const picker = statusPickerTabs(INVOICE_LIST_TABS, true)
    expect(picker).not.toContain('overdue')
    expect(picker).not.toContain('collections')
    expect(picker).toContain('all')
    expect(picker).toContain('unpaid')
  })

  it('keeps every view in the picker while collections is not in play', () => {
    expect(statusPickerTabs(INVOICE_LIST_TABS, false)).toEqual([...INVOICE_LIST_TABS])
  })

  it('says when the active view is the segmented control\'s', () => {
    expect(segmentViewActive('overdue', true)).toBe(true)
    expect(segmentViewActive('collections', true)).toBe(true)
    expect(segmentViewActive('paid', true)).toBe(false)
    expect(segmentViewActive('overdue', false)).toBe(false)
  })
})

// Three of four credit notes in production carry no link to their original
// (the provider named none, or the import predates the pairing): every view
// reads the one identity, a link or a total below zero.
describe('matchesInvoiceListTab: a credit note imported without a link', () => {
  const imported = (status: Row['status'], extra: Partial<Row> = {}) =>
    row({ status, invoice_number: 'K1', total: -500, due_date: '2026-01-01', remaining_amount: 0, ...extra })

  it('is in Kreditfakturor, whatever status the import gave it', () => {
    for (const status of ['paid', 'credited', 'draft', 'overdue', 'sent'] as const) {
      expect(tabsFor(imported(status)), status).toEqual(['all', 'credit'])
    }
  })

  it('leaves Kreditfakturor when it is cancelled, like a linked one', () => {
    expect(tabsFor(imported('cancelled'))).toEqual(['cancelled'])
  })

  it('a zero total is no credit note', () => {
    expect(tabsFor(row({ status: 'paid', total: 0 }))).toEqual(['all', 'paid'])
  })
})
