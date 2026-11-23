/**
 * What the verifikat side panel shows for each state of its reads: number
 * and date, description, the markers of a reversed or corrected verifikat,
 * the lines with their totals, the underlag as links, and one link to the
 * verifikat page. It offers nothing that writes.
 */
import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { makeJournalEntry, makeJournalEntryLine } from '@/tests/helpers'
import type { JournalEntry } from '@/types'

vi.mock('next-intl', () => {
  const t = (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key)
  return { useTranslations: () => Object.assign(t, { has: () => true }) }
})

vi.mock('next/link', () => ({
  // prefetch is next/link's own prop, not an anchor attribute.
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) =>
    createElement('a', { href, ...rest }, children),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ prefetch: () => undefined }) }))

// The chart of accounts is session data the panel does not own: no company chart here, so names come from BAS.
vi.mock('@/lib/reference-data/hooks', () => ({ useAccounts: () => ({ accounts: [] }) }))

const { VoucherPeekView, VoucherPeekUnderlagView } = await import('../VoucherPeek')
const { SlideOver } = await import('@/components/ui/slide-over')
const { TooltipProvider } = await import('@/components/ui/tooltip-provider')

/** The views read the slide-over's dialog context (title, close) and the app's tooltip provider. */
const render = (view: ReactElement) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(SlideOver, { open: true }, view)))

const entry = (overrides: Partial<JournalEntry> = {}): JournalEntry =>
  makeJournalEntry({
    id: 'entry-1',
    voucher_series: 'A',
    voucher_number: 12,
    entry_date: '2026-03-14',
    description: 'Office chairs',
    status: 'posted',
    source_type: 'manual',
    lines: [
      makeJournalEntryLine({ id: 'line-bank', account_number: '1930', credit_amount: 1250.5, sort_order: 2 }),
      makeJournalEntryLine({ id: 'line-cost', account_number: '5410', debit_amount: 1000.4, line_description: 'Two chairs', sort_order: 0 }),
      makeJournalEntryLine({ id: 'line-vat', account_number: '2641', debit_amount: 250.1, line_description: 'Office chairs', sort_order: 1 }),
    ],
    ...overrides,
  })

const view = (read: Parameters<typeof VoucherPeekView>[0]['read']) =>
  render(createElement(VoucherPeekView, { entryId: 'entry-1', read, onRetry: () => undefined }))

/** Intl sv-SE groups thousands with a no-break space; the assertions read plain spaces. */
const plain = (html: string) => html.replace(/[  ]/g, ' ')

describe('VoucherPeekView', () => {
  it('shows number, date, description, the lines in their order and the totals', () => {
    const html = plain(view({ state: 'ready', entry: entry(), corrected: false }))
    expect(html).toContain('title:{&quot;label&quot;:&quot;A12&quot;}')
    expect(html).toContain('2026-03-14')
    expect(html).toContain('Office chairs')
    // Lines by sort_order: the cost, the VAT, then the bank account.
    const cost = html.indexOf('5410')
    const vat = html.indexOf('2641')
    const bank = html.indexOf('1930')
    expect(cost).toBeGreaterThan(-1)
    expect(vat).toBeGreaterThan(cost)
    expect(bank).toBeGreaterThan(vat)
    // A line text that adds something shows; one that repeats the verifikat's description does not.
    expect(html).toContain('Two chairs')
    expect(html.split('Office chairs').length - 1).toBe(1)
    // The Summa row: both sides, to the öre, written as on the verifikat page (no currency label).
    expect(html.split('1 250,50').length - 1).toBe(3)
    expect(html).not.toContain('1 250,50 kr')
    expect(html).toContain('1 000,40')
    expect(html).toContain('250,10')
  })

  it('carries no marker on a plainly posted verifikat', () => {
    const html = view({ state: 'ready', entry: entry(), corrected: false })
    expect(html).not.toContain('status_')
    expect(html).not.toContain('source_storno')
    expect(html).not.toContain('rattelse_badge')
  })

  it('marks a reversed verifikat, a storno, a rättelse and an inline rättelse as the verifikat page does', () => {
    expect(view({ state: 'ready', entry: entry({ status: 'reversed' }), corrected: false })).toContain('status_reversed')
    expect(view({ state: 'ready', entry: entry({ source_type: 'storno' }), corrected: false })).toContain('source_storno')
    expect(view({ state: 'ready', entry: entry({ source_type: 'correction' }), corrected: false })).toContain(
      'source_correction',
    )
    const corrected = view({ state: 'ready', entry: entry(), corrected: true })
    expect(corrected).toContain('>rattelse_badge<')
    expect(corrected).toContain('title="rattelse_badge_tooltip"')
  })

  it('titles a draft as the verifikat page does, without a number', () => {
    const html = view({ state: 'ready', entry: entry({ status: 'draft', voucher_number: 0 }), corrected: false })
    expect(html).toContain('title_draft')
    expect(html).toContain('status_draft')
  })

  it('links to the verifikat page in every state, and offers nothing that writes', () => {
    const states: Array<Parameters<typeof VoucherPeekView>[0]['read']> = [
      null,
      { state: 'failed' },
      { state: 'missing' },
      { state: 'ready', entry: entry(), corrected: true },
    ]
    for (const read of states) {
      const html = view(read)
      expect(html).toMatch(/<a href="\/bookkeeping\/entry-1"[^>]*>open_full<\/a>/)
      expect(html).not.toMatch(/<input|<textarea|<form|<select/)
    }
    // The one button of a loaded panel is the close button.
    const ready = view({ state: 'ready', entry: entry(), corrected: true })
    expect(ready.split('<button').length - 1).toBe(1)
    expect(ready).toContain('aria-label="close"')
  })

  it('holds a skeleton while the read is out', () => {
    const html = view(null)
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('<table')
  })

  it('says a failed read failed and offers the retry', () => {
    const html = view({ state: 'failed' })
    expect(html).toContain('error_load_failed')
    expect(html).toContain('>retry<')
  })

  it('says a missing verifikat is missing, with nothing to retry', () => {
    const html = view({ state: 'missing' })
    expect(html).toContain('error_not_found')
    expect(html).not.toContain('>retry<')
  })
})

describe('VoucherPeekUnderlagView', () => {
  const underlag = (read: Parameters<typeof VoucherPeekUnderlagView>[0]['read']) =>
    render(createElement(VoucherPeekUnderlagView, { read, onRetry: () => undefined }))

  it('links each document to the stored file, opened in a new tab', () => {
    const html = underlag({
      state: 'ready',
      documents: [
        { id: 'doc-1', source: 'entry', fileName: 'receipt.pdf' },
        { id: 'doc-2', source: 'supplier_invoice', invoiceNumber: 'F-100' },
      ],
      none: false,
    })
    expect(html).toMatch(/<a href="\/api\/documents\/doc-1\/inline" target="_blank" rel="noopener noreferrer"[^>]*data-ph-mask=""/)
    expect(html).toContain('receipt.pdf')
    expect(html).toContain('href="/api/documents/doc-2/inline"')
    expect(html).toContain('reference_supplier_invoice:{&quot;number&quot;:&quot;F-100&quot;}')
    expect(html).not.toContain('<button')
  })

  it('says no underlag is attached only when the read says none', () => {
    expect(underlag({ state: 'ready', documents: [], none: true })).toContain('>empty<')
    // A verifikat whose underlag is a linked record: the section stays out.
    const linkedOnly = underlag({ state: 'ready', documents: [], none: false })
    expect(linkedOnly).not.toContain('empty')
    expect(linkedOnly).not.toContain('<section')
  })

  it('says a failed read failed and offers the retry', () => {
    const html = underlag({ state: 'failed' })
    expect(html).toContain('load_failed')
    expect(html).toContain('>retry<')
  })

  it('holds a skeleton while the read is out', () => {
    expect(underlag(null)).toContain('aria-busy="true"')
  })
})
