/**
 * A reskontra row shows the buckets the PDF and the xlsx print. Both pages hid
 * a bucket unless it was above zero, so a credit note not yet due left the
 * customer's row at 7 000 in 90+ with Totalt 2 000, and a footer of -5 000
 * under an empty column.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const reportData = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('@/components/icons', () => ({
  ChevronDownIcon: () => null,
  ChevronRightIcon: () => null,
  DocumentTextIcon: () => null,
  ExclamationCircleIcon: () => null,
}))
vi.mock('@/components/reports/ReportRowExpansion', () => ({
  useReportRowExpansion: () => ({ toggle: null, panel: () => null }),
}))
vi.mock('@/components/reports/ReportExportMenu', () => ({ ReportExportMenu: () => null }))
vi.mock('@/lib/hooks/use-report-data', () => ({ useReportData: () => reportData.value }))

import ARLedgerView from '@/components/reports/lazy-views/ARLedgerView'
import SupplierLedgerView from '@/components/reports/lazy-views/SupplierLedgerView'
import { agingCell } from '@/components/reports/report-view-shared'

const buckets = { current: -5_000, days_1_30: 0, days_31_60: 0, days_61_90: 0, days_90_plus: 7_000, total_outstanding: 2_000 }
const ledger = (entry: Record<string, unknown>) => ({
  entries: [{ ...entry, ...buckets, invoices: [] }],
  total_outstanding: 2_000,
  total_current: -5_000,
  total_overdue: 7_000,
  unpaid_count: 2,
  unconverted_fx_count: 0,
})

/** The cells of the view's first body row, spaces normalised. */
function firstRow(html: string): string[] {
  const body = html.slice(html.indexOf('<tbody'), html.indexOf('</tbody>'))
  return [...body.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1].replace(/\s/g, ' '))
}

describe('agingCell', () => {
  it('is blank at zero only', () => {
    expect(agingCell(0)).toBe('')
    expect(agingCell(1_000).replace(/\s/g, ' ')).toBe('1 000,00')
    expect(agingCell(-5_000).replace(/\s/g, ' ')).toMatch(/^.5 000,00$/)
  })
})

describe('the row on the page', () => {
  it.each([
    ['kundreskontran', ARLedgerView, { customer_id: 'c', customer_name: 'Kund' }],
    ['leverantörsreskontran', SupplierLedgerView, { supplier_id: 's', supplier_name: 'Leverantör' }],
  ])('of %s shows a negative bucket, so it adds up', (_name, View, entry) => {
    reportData.value = { data: { ledger: ledger(entry), reconciliation: null }, loading: false, error: null, refetch: () => {} }
    const cells = firstRow(renderToStaticMarkup(createElement(View, { periodId: 'p' })))
    expect(cells).toEqual(expect.arrayContaining([expect.stringMatching(/^.5 000,00$/), '7 000,00', '2 000,00']))
  })

  it.each([
    ['kundreskontran', ARLedgerView],
    ['leverantörsreskontran', SupplierLedgerView],
  ])('of %s keeps the date field when the date is refused', (_name, View) => {
    reportData.value = { data: null, loading: false, error: 'Året måste ligga mellan 2000 och 2027.', refetch: () => {} }
    const html = renderToStaticMarkup(createElement(View, { periodId: 'p' }))
    expect(html).toContain('type="date"')
    expect(html).toContain('Året måste ligga')
  })
})
