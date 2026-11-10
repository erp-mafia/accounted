'use client'

import React, { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { usePageState } from '@/lib/hooks/use-page-state'
import { expandableSurface } from '@/components/ui/expandable-surface'
import { ResponsiveTable } from '@/components/ui/responsive-table'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { Label } from '@/components/ui/label'
import { AccountNumber } from '@/components/ui/account-number'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { formatAmount, formatDate } from '@/lib/utils'
import { isActiveLedgerAccount } from '@/lib/reports/general-ledger-activity'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { DateRangeValue } from '@/components/common/ReportDateRange'
import type { DimensionFilterValue } from '@/components/reports/DimensionFilter'
import { ReportLoadingCard, ReportErrorCard, ReportEmptyState, reportQuery } from '../report-view-shells'

// --- General Ledger (Huvudbok) ---

interface GeneralLedgerData {
  accounts: {
    account_number: string
    account_name: string
    opening_balance: number
    lines: {
      date: string
      voucher_series: string
      voucher_number: number
      journal_entry_id: string
      description: string
      source_type: string
      debit: number
      credit: number
      balance: number
      dimensions?: Record<string, string>
    }[]
    closing_balance: number
    total_debit: number
    total_credit: number
  }[]
  period: { start: string; end: string }
}

// Stable default: an inline `= {}` would change identity every render and
// re-trigger the fetch effect for callers that omit the prop.
const EMPTY_DATE_RANGE: DateRangeValue = {}

/** Display the filtered ledger with on-demand account details and matching export bounds. */
export default function GeneralLedgerView({ periodId, initialAccountFilter, dimensionFilter = null, dateRange = EMPTY_DATE_RANGE }: { periodId: string; initialAccountFilter: string | null; dimensionFilter?: DimensionFilterValue | null; dateRange?: DateRangeValue }) {
  const t = useTranslations('reports')
  const [hideInactive, setHideInactive, viewReady] = usePageState('ledger-hide-inactive', true)
  const [expandedAccounts, setExpandedAccounts] = usePageState<Set<string>>(`ledger-expanded:${periodId}:${initialAccountFilter ?? ''}`, new Set())
  const toggleAccount = (number: string) => setExpandedAccounts(previous => {
    const next = new Set(previous)
    if (next.has(number)) next.delete(number)
    else next.add(number)
    return next
  })
  const [data, setData] = useState<GeneralLedgerData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [accountFrom, setAccountFrom] = usePageState(`ledger-from:${periodId}`, '')
  const [accountTo, setAccountTo] = usePageState(`ledger-to:${periodId}`, '')
  const [appliedAccountRange, setAppliedAccountRange] = usePageState(`ledger-range:${periodId}`, { from: '', to: '' })
  const previousAccountFilter = React.useRef(initialAccountFilter)
  // Only the newest request may land. The window changes right after mount
  // (the date-range control resolves its preset, or a drill-down's window),
  // and the superseded request must not overwrite the ledger it was
  // replaced by when it happens to finish last.
  const requestSeq = React.useRef(0)
  useEffect(() => () => { requestSeq.current++ }, [])

  const fetchData = useCallback(async (fromOverride?: string, toOverride?: string) => {
    const seq = ++requestSeq.current
    const from = fromOverride ?? accountFrom
    const to = toOverride ?? accountTo
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ period_id: periodId, include_inactive: 'true' })
      if (from) params.set('account_from', from)
      if (to) params.set('account_to', to)
      if (dateRange.fromDate) params.set('from_date', dateRange.fromDate)
      if (dateRange.toDate) params.set('to_date', dateRange.toDate)
      if (dimensionFilter) {
        params.set('dim_no', dimensionFilter.dimNo)
        params.set('dim_code', dimensionFilter.code)
      }
      const res = await fetch(`/api/reports/general-ledger?${params}`)
      const result = await res.json()
      if (seq !== requestSeq.current) return
      if (result.error) {
        // Envelope object, not a string: see the note on the other report
        // fetches. Rendering it bare blanks the page.
        setError(getErrorMessage(result))
      } else {
        setData(result.data)
        setAppliedAccountRange({ from, to })
      }
    } catch {
      if (seq === requestSeq.current) setError('Kunde inte hämta huvudbok')
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [periodId, accountFrom, accountTo, dimensionFilter, dateRange])

  // When initialAccountFilter changes (drill-down from another report), apply it
  useEffect(() => {
    if (!viewReady) return
    const accountFilterChanged = previousAccountFilter.current !== initialAccountFilter
    previousAccountFilter.current = initialAccountFilter
    if (initialAccountFilter || accountFilterChanged) {
      if (initialAccountFilter && !expandedAccounts.has(initialAccountFilter)) {
        setExpandedAccounts(previous => new Set([...previous, initialAccountFilter]))
      }
      const account = initialAccountFilter ?? ''
      setAccountFrom(account)
      setAccountTo(account)
      fetchData(account, account)
    } else {
      fetchData()
    }
  }, [periodId, initialAccountFilter, dimensionFilter, dateRange, viewReady])

  const visibleAccounts = (data?.accounts ?? []).filter(
    account => !hideInactive || isActiveLedgerAccount(account),
  )

  // Keep range controls available to recover from empty results or errors.
  const filterToolbar = (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <Label htmlFor="gl-account-from" className="field-label">Konto från</Label>
        <Input
          id="gl-account-from"
          type="text"
          value={accountFrom}
          onChange={(e) => setAccountFrom(e.target.value)}
          placeholder="Från konto"
          aria-label="Konto från"
          className="mt-1 w-32"
        />
      </div>
      <div>
        <Label htmlFor="gl-account-to" className="field-label">Konto till</Label>
        <Input
          id="gl-account-to"
          type="text"
          value={accountTo}
          onChange={(e) => setAccountTo(e.target.value)}
          placeholder="Till konto"
          aria-label="Konto till"
          className="mt-1 w-32"
        />
      </div>
      <Button onClick={() => fetchData()} variant="outline">
        Filtrera
      </Button>
      <div className="flex min-h-10 items-center gap-2">
        <Checkbox
          id="gl-hide-inactive"
          checked={hideInactive}
          onCheckedChange={checked => setHideInactive(checked === true)}
        />
        <Label htmlFor="gl-hide-inactive" className="cursor-pointer text-sm">
          <InfoTooltip variant="help" content={t('ledger_hide_inactive_help')}>
            <span>{t('ledger_hide_inactive')}</span>
          </InfoTooltip>
        </Label>
      </div>
    </div>
  )

  if (loading || error || !data || visibleAccounts.length === 0) {
    return (
      <div className="space-y-4">
        {filterToolbar}
        {loading ? (
          <ReportLoadingCard />
        ) : error ? (
          <ReportErrorCard message={error} />
        ) : (
          <ReportEmptyState
            title={data && data.accounts.length > 0 ? t('ledger_no_active_accounts') : t('ledger_empty_title')}
            description={data && data.accounts.length > 0 ? t('ledger_show_inactive_hint') : t('ledger_empty_description')}
          />
        )}
      </div>
    )
  }

  const exportParams = new URLSearchParams(reportQuery(periodId, dateRange, dimensionFilter))
  exportParams.set('hide_inactive', String(hideInactive))
  if (appliedAccountRange.from) exportParams.set('account_from', appliedAccountRange.from)
  if (appliedAccountRange.to) exportParams.set('account_to', appliedAccountRange.to)

  return (
    <div className="space-y-4">
      <ReportExportMenu items={[{ format: 'xlsx', href: `/api/reports/general-ledger/xlsx?${exportParams}` }]} />
      {filterToolbar}

      {data.period.start && (
        <p className="text-sm text-muted-foreground tabular-nums">
          {t('ledger_period_summary', { start: data.period.start, end: data.period.end, count: visibleAccounts.length })}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setExpandedAccounts(new Set(visibleAccounts.map(account => account.account_number)))}>
          {t('ledger_expand_all')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setExpandedAccounts(new Set())}>
          {t('ledger_collapse_all')}
        </Button>
      </div>

      {visibleAccounts.map((account) => (
        <Card key={account.account_number} className="cursor-pointer" {...expandableSurface(() => toggleAccount(account.account_number))}>
          <CardHeader className="pb-2">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 sm:flex sm:items-center sm:justify-between">
              {/* data-ph-mask: account number and name are user chart data */}
              <div className="flex min-w-0 items-start gap-2 sm:items-center">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="hidden shrink-0 sm:inline-flex"
                  aria-label={t(expandedAccounts.has(account.account_number) ? 'ledger_collapse_account' : 'ledger_expand_account', { number: account.account_number })}
                  aria-expanded={expandedAccounts.has(account.account_number)}
                  aria-controls={`ledger-account-${account.account_number}`}
                  onClick={() => toggleAccount(account.account_number)}
                >
                  {expandedAccounts.has(account.account_number) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </Button>
                <CardTitle data-ph-mask="" className="min-w-0 text-base">
                  <button
                    type="button"
                    className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:hidden"
                    aria-label={t(expandedAccounts.has(account.account_number) ? 'ledger_collapse_account' : 'ledger_expand_account', { number: account.account_number })}
                    aria-expanded={expandedAccounts.has(account.account_number)}
                    aria-controls={`ledger-account-${account.account_number}`}
                    onClick={() => toggleAccount(account.account_number)}
                  >
                    <span className="mr-2 font-mono text-sm">{account.account_number}</span>
                    <span className="break-words text-sm">{account.account_name}</span>
                  </button>
                  <span className="hidden sm:inline">
                    <AccountNumber number={account.account_number} name={account.account_name} showName />
                  </span>
                </CardTitle>
              </div>
              <span className="col-span-2 text-right text-sm text-muted-foreground sm:shrink-0">
                IB: {formatAmount(account.opening_balance)} kr
              </span>
            </div>
          </CardHeader>
          {expandedAccounts.has(account.account_number) && <CardContent id={`ledger-account-${account.account_number}`}>
            <ResponsiveTable primaryColumn={3}><table className="w-full text-sm">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-2 w-16">Ver.nr</th>
                  <th className="py-2 w-24">Datum</th>
                  <th className="py-2">Beskrivning</th>
                  <th className="py-2 w-24 text-right">Debet</th>
                  <th className="py-2 w-24 text-right">Kredit</th>
                  <th className="py-2 w-28 text-right">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {account.lines.map((line, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-1.5 font-mono text-xs">
                      <Link
                        href={`/bookkeeping/${line.journal_entry_id}`}
                        className="text-foreground underline underline-offset-4 decoration-muted-foreground/40 hover:decoration-foreground transition-colors"
                      >
                        {formatVoucher(line)}
                      </Link>
                    </td>
                    <td className="py-1.5">{formatDate(line.date)}</td>
                    <td className="py-1.5 max-w-[240px]">
                      <span className="truncate block">{line.description}</span>
                      {line.dimensions && Object.keys(line.dimensions).length > 0 && (
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          {Object.entries(line.dimensions)
                            .sort(([a], [b]) => Number(a) - Number(b))
                            .map(([, code]) => code)
                            .join(' · ')}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {line.debit > 0 ? formatAmount(line.debit) : ''}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {line.credit > 0 ? formatAmount(line.credit) : ''}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatAmount(line.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold border-t-2">
                  <td colSpan={3} className="py-2">Summa / Utgående balans</td>
                  <td className="py-2 text-right tabular-nums">{formatAmount(account.total_debit)}</td>
                  <td className="py-2 text-right tabular-nums">{formatAmount(account.total_credit)}</td>
                  <td className="py-2 text-right tabular-nums">{formatAmount(account.closing_balance)}</td>
                </tr>
              </tfoot>
            </table></ResponsiveTable>
          </CardContent>}
        </Card>
      ))}
    </div>
  )
}
