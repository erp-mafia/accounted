/**
 * The huvudbok's table and its search box on a narrow or a touch screen.
 *
 * The table's cells have no side padding, and below about 500 px every column
 * is as narrow as its content. A sortable head on the left ends in its arrow,
 * flush with the edge of its cell, so the arrow met the next head; and the
 * English "Voucher" with its arrow was wider than the 64 px its column has on
 * any screen. The search box showed a placeholder that fits at 13 px and lost
 * its last letter at the 16 px a field has on a touch screen.
 *
 * Widths are measured in a browser, not here (2026-11-18, headless Chrome,
 * the app's own font): these are tripwires on the classes and the lengths
 * the measure was taken with.
 */
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { describe, expect, it, vi } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

const reportData = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('@/components/reports/ReportExportMenu', () => ({ ReportExportMenu: () => null }))
vi.mock('@/lib/hooks/use-report-data', () => ({ useReportData: () => reportData.value }))

import GeneralLedgerView from '@/components/reports/lazy-views/GeneralLedgerView'
import { TooltipProvider } from '@/components/ui/info-tooltip'

const MESSAGES = { sv, en }
type Locale = keyof typeof MESSAGES

const IntlProvider = NextIntlClientProvider as (
  props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>,
) => ReturnType<typeof NextIntlClientProvider>

const line = (voucher_number: number, debit: number, credit: number, balance: number) => ({
  date: '2026-03-15',
  voucher_series: 'A',
  voucher_number,
  journal_entry_id: `entry-${voucher_number}`,
  description: 'Hyra mars',
  source_type: 'manual',
  debit,
  credit,
  balance,
})

/** One account in range, as a drill-down opens it: its rows and its search box are there at once. */
function render(locale: Locale): string {
  reportData.value = {
    data: {
      period: { start: '2026-01-01', end: '2026-12-31' },
      lines_included: true,
      accounts: [{
        account_number: '1930',
        account_name: 'Företagskonto',
        opening_balance: 1_000,
        closing_balance: 13_000,
        total_debit: 12_500,
        total_credit: 500,
        line_count: 2,
        lines: [line(70, 12_500, 0, 13_500), line(71, 0, 500, 13_000)],
      }],
    },
    loading: false,
    error: null,
    refetch: () => {},
  }
  return renderToStaticMarkup(
    createElement(
      IntlProvider,
      { locale, messages: MESSAGES[locale], timeZone: 'Europe/Stockholm' },
      // The app's layout holds the tooltips' provider (the account name has one).
      createElement(TooltipProvider, null, createElement(GeneralLedgerView, { periodId: 'p', initialAccountFilter: '1930' })),
    ),
  )
}

/** The class lists of the table's six heads, and of the sort button inside each sortable one. */
function heads(html: string): Array<{ th: string[]; button: string[] | null }> {
  const thead = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'))
  return thead.split('<th').slice(2).map((chunk) => {
    const classOf = (tag: string) => tag.match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? []
    const button = chunk.match(/<button[^>]*>/)?.[0]
    return { th: classOf(chunk.slice(0, chunk.indexOf('>'))), button: button ? classOf(button) : null }
  })
}

describe.each(['sv', 'en'] as const)('the huvudbok in %s', (locale) => {
  const html = render(locale)
  const messages = MESSAGES[locale].general_ledger

  it('keeps 8px between each head and the next', () => {
    const [voucher, date, description, debit, credit, balance] = heads(html)
    // On the left the arrow is the end of the cell: the cell keeps its own 8px after it.
    for (const head of [voucher, date]) {
      expect(head.th).toEqual(expect.arrayContaining(['pl-0', 'pr-2']))
      expect(head.th).not.toContain('px-0')
    }
    // On the right the head starts with the 8px of its button (SortableTh:
    // the left margin that would cancel it is the one a right-aligned head
    // drops), which is what keeps it off the description and off each other.
    expect(description.button).toBeNull()
    for (const head of [debit, credit]) {
      expect(head.button).toEqual(expect.arrayContaining(['px-2', 'ml-auto']))
    }
    // The balance head is plain text after the last arrow.
    expect(balance.button).toBeNull()
    expect(balance.th).toContain('pl-2')
  })

  it('names the voucher column in a word that fits its 64px with the arrow', () => {
    // "Ver.nr" with its arrow is 56px, and with the 8px after it the 64px of
    // the column (w-16). "Voucher" with its arrow was 70px: it widened the
    // column on every screen and met "Date".
    expect(html).toContain(`<span>${messages.th_voucher}</span>`)
    expect(messages.th_voucher.length, messages.th_voucher).toBeLessThanOrEqual(6)
  })

  it('shows a placeholder that fits the box at the 16px of a touch screen', () => {
    // The box is 240px and at 16px a search field gives its text 183px of
    // them (32px for the magnifier, a 10px inset, and the 15px the browser
    // keeps for its own clear button, also while the field is empty). There
    // "Ver.nr, belopp, datum" is 162px and "Voucher, amount, date" 170px, 21
    // characters each; the 25 of "Sök ver.nr, belopp, datum" were 193px.
    // Measure a longer text in a browser before raising this.
    expect(html).toContain(`placeholder="${messages.search_placeholder}"`)
    expect(messages.search_placeholder.length, messages.search_placeholder).toBeLessThanOrEqual(21)
    // The full sentence is still there for a pointer and a screen reader.
    expect(html).toContain(`title="${messages.search_hint}"`)
  })
})
