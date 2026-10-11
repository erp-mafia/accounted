'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AccountNumber } from '@/components/ui/account-number'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import {
  ReportEmptyState,
  ReportErrorCard,
  ReportLoadingCard,
  reportQuery,
} from '@/components/reports/report-view-shared'
import { useReportData } from '@/lib/hooks/use-report-data'
import { formatAmount, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { DateRangeValue } from '@/components/common/ReportDateRange'
import type { DimensionFilterValue } from '@/components/reports/DimensionFilter'

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

// Stable default for callers that omit the prop.
const EMPTY_DATE_RANGE: DateRangeValue = {}

export default function GeneralLedgerView({ periodId, initialAccountFilter, dimensionFilter = null, dateRange = EMPTY_DATE_RANGE }: { periodId: string; initialAccountFilter: string | null; dimensionFilter?: DimensionFilterValue | null; dateRange?: DateRangeValue }) {
  const [accountFrom, setAccountFrom] = useState(initialAccountFilter ?? '')
  const [accountTo, setAccountTo] = useState(initialAccountFilter ?? '')
  // The account range the ledger is fetched for: what Filtrera applied. A new
  // period, window, dimension or drill-down applies the drill-down's account
  // when there is one (into the fields too), else what the fields hold.
  const [applied, setApplied] = useState({ from: accountFrom, to: accountTo })
  const scope = `${reportQuery(periodId, dateRange, dimensionFilter)}|${initialAccountFilter ?? ''}`
  const [appliedScope, setAppliedScope] = useState(scope)
  if (appliedScope !== scope) {
    setAppliedScope(scope)
    if (initialAccountFilter) {
      setAccountFrom(initialAccountFilter)
      setAccountTo(initialAccountFilter)
      setApplied({ from: initialAccountFilter, to: initialAccountFilter })
    } else {
      setApplied({ from: accountFrom, to: accountTo })
    }
  }

  // Only the request for the current parameters may land: the window changes
  // right after mount (the date-range control resolves its preset, or a
  // drill-down's window), and the superseded answer is dropped.
  const params = new URLSearchParams({ period_id: periodId })
  if (applied.from) params.set('account_from', applied.from)
  if (applied.to) params.set('account_to', applied.to)
  if (dateRange.fromDate) params.set('from_date', dateRange.fromDate)
  if (dateRange.toDate) params.set('to_date', dateRange.toDate)
  if (dimensionFilter) {
    params.set('dim_no', dimensionFilter.dimNo)
    params.set('dim_code', dimensionFilter.code)
  }
  const { data, loading, error, refetch } = useReportData<GeneralLedgerData>(
    `/api/reports/general-ledger?${params}`,
    'Kunde inte hämta huvudbok',
  )

  // Filtrera with an unchanged range fetches again, as it always has.
  const applyAccountRange = () => {
    if (applied.from === accountFrom && applied.to === accountTo) refetch()
    else setApplied({ from: accountFrom, to: accountTo })
  }

  if (loading) {
    return <ReportLoadingCard />
  }

  if (error) {
    return <ReportErrorCard message={error} />
  }

  if (!data || data.accounts.length === 0) {
    return (
      <ReportEmptyState
        title="Inga verifikationer i perioden"
        description="Det finns inga bokförda verifikationer i den valda perioden."
      />
    )
  }

  return (
    <div className="space-y-4">
      <ReportExportMenu items={[{ format: 'xlsx', href: `/api/reports/general-ledger/xlsx?${reportQuery(periodId, dateRange, dimensionFilter)}` }]} />
      {/* Account range filter: flat toolbar on the panel, no box. The labels
          are hidden (field-label) and the placeholders say what the fields are. */}
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
        <Button onClick={applyAccountRange} variant="outline">
          Filtrera
        </Button>
      </div>

      {data.period.start && (
        <p className="text-sm text-muted-foreground tabular-nums">
          Period {data.period.start} till {data.period.end} · {data.accounts.length} konton
        </p>
      )}

      {data.accounts.map((account) => (
        <Card key={account.account_number}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              {/* data-ph-mask: account number and name are user chart data */}
              <CardTitle data-ph-mask="" className="text-base">
                <AccountNumber number={account.account_number} name={account.account_name} showName />
              </CardTitle>
              <span className="text-sm text-muted-foreground">
                IB: {formatAmount(account.opening_balance)} kr
              </span>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto -mx-2 px-2"><table className="w-full text-sm min-w-[500px]">
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
            </table></div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
