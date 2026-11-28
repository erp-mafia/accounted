/**
 * The huvudbok's Excel file holds what the screen shows.
 *
 * The screen fetched the ledger for the applied account range ("Konto från",
 * "Konto till", or a drill-down's one account), while the export link was
 * built from the period, window and dimension only. The route reads
 * account_from and account_to, so a huvudbok filtered to one account (a
 * kontoanalys) downloaded every account in the period.
 *
 * This repo runs Vitest in the node environment: the view is rendered to
 * static markup, and the export menu and the data hook are stand-ins that
 * record what the view hands them.
 */
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { describe, expect, it, vi } from 'vitest'
import sv from '@/messages/sv.json'

const seen = vi.hoisted(() => ({ fetched: [] as string[], exported: [] as string[] }))
vi.mock('@/components/reports/ReportExportMenu', () => ({
  ReportExportMenu: ({ items }: { items: Array<{ href: string }> }) => {
    for (const item of items) seen.exported.push(item.href)
    return null
  },
}))
vi.mock('@/lib/hooks/use-report-data', () => ({
  useReportData: (url: string) => {
    seen.fetched.push(url)
    return {
      data: {
        period: { start: '2026-01-01', end: '2026-12-31' },
        lines_included: true,
        accounts: [{
          account_number: '1930',
          account_name: 'Företagskonto',
          opening_balance: 0,
          closing_balance: 100,
          total_debit: 100,
          total_credit: 0,
          line_count: 0,
          lines: [],
        }],
      },
      loading: false,
      error: null,
      refetch: () => {},
    }
  },
}))

import GeneralLedgerView from '@/components/reports/lazy-views/GeneralLedgerView'
import { TooltipProvider } from '@/components/ui/info-tooltip'

const IntlProvider = NextIntlClientProvider as (
  props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>,
) => ReturnType<typeof NextIntlClientProvider>

function render(props: ComponentProps<typeof GeneralLedgerView>) {
  seen.fetched.length = 0
  seen.exported.length = 0
  renderToStaticMarkup(
    createElement(
      IntlProvider,
      { locale: 'sv', messages: sv, timeZone: 'Europe/Stockholm' },
      createElement(TooltipProvider, null, createElement(GeneralLedgerView, props)),
    ),
  )
  const query = (url: string | undefined) => new URLSearchParams(url?.slice(url.indexOf('?') + 1) ?? '')
  return { fetched: query(seen.fetched.at(-1)), exported: query(seen.exported.at(-1)), exportUrl: seen.exported.at(-1) }
}

describe('the huvudbok export', () => {
  it('downloads the one account a drill-down or kontoanalys shows', () => {
    const { fetched, exported, exportUrl } = render({ periodId: 'p', initialAccountFilter: '1930' })
    expect(fetched.get('account_from')).toBe('1930')
    expect(exportUrl).toMatch(/^\/api\/reports\/general-ledger\/xlsx\?/)
    expect(exported.get('account_from')).toBe('1930')
    expect(exported.get('account_to')).toBe('1930')
  })

  it('asks the file for the same ledger as the screen, window and dimension included', () => {
    const { fetched, exported } = render({
      periodId: 'p',
      initialAccountFilter: '1930',
      dateRange: { fromDate: '2026-03-01', toDate: '2026-03-31' },
      dimensionFilter: { dimNo: '1', code: 'KS01' },
    })
    expect(Object.fromEntries(exported)).toEqual(Object.fromEntries(fetched))
    expect(exported.get('from_date')).toBe('2026-03-01')
    expect(exported.get('to_date')).toBe('2026-03-31')
    expect(exported.get('dim_no')).toBe('1')
    expect(exported.get('dim_code')).toBe('KS01')
  })

  it('downloads every account when no range is applied', () => {
    const { exported } = render({ periodId: 'p', initialAccountFilter: null })
    expect(exported.get('period_id')).toBe('p')
    expect(exported.has('account_from')).toBe(false)
    expect(exported.has('account_to')).toBe(false)
  })
})
