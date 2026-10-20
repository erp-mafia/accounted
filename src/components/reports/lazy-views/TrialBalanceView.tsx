'use client'

import React, { useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { AccountNumber } from '@/components/ui/account-number'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { accountDrilldownClick, type AccountDrilldown } from '@/components/reports/drilldown-click'
import { useReportRowExpansion } from '@/components/reports/ReportRowExpansion'
import {
  ReportEmptyState,
  ReportErrorCard,
  ReportLoadingCard,
} from '@/components/reports/report-view-shared'
import { useReportData } from '@/lib/hooks/use-report-data'
import { formatAmount } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import type { ReportSourceLine, ReportSourceFetcher } from '@/lib/reports/source-lines'
import type { TrialBalanceRow } from '@/types'

// Recharts is ~180KB: defer the chart so the report table (the regulated
// content) renders without waiting for the charting bundle.
const TrialBalanceChart = dynamic(
  () => import('@/components/reports/TrialBalanceChart').then((m) => m.TrialBalanceChart),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full" /> },
)

export default function TrialBalanceView({ periodId, drilldown }: { periodId: string; drilldown: AccountDrilldown }) {
  const { data, loading, error } = useReportData<{
    rows: TrialBalanceRow[]
    totalDebit: number
    totalCredit: number
    isBalanced: boolean
  }>(`/api/reports/trial-balance?period_id=${periodId}`, 'Kunde inte hämta saldobalans')
  const [viewMode, setViewMode] = useState<'simplified' | 'detailed'>('simplified')

  if (loading) {
    return <ReportLoadingCard />
  }

  if (error) {
    return <ReportErrorCard message={error} />
  }

  if (!data || data.rows.length === 0) {
    return (
      <ReportEmptyState
        title="Inga verifikationer i perioden"
        description="Det finns inga bokförda verifikationer i den valda perioden."
      />
    )
  }

  function getNetBalance(row: TrialBalanceRow, type: 'opening' | 'period' | 'closing'): number {
    let debit: number, credit: number
    if (type === 'opening') {
      debit = row.opening_debit; credit = row.opening_credit
    } else if (type === 'period') {
      debit = row.period_debit; credit = row.period_credit
    } else {
      debit = row.closing_debit; credit = row.closing_credit
    }
    // Credit-normal accounts (liabilities/equity class 2, revenue class 3): positive when credit > debit
    // Debit-normal accounts (assets class 1, expenses class 4-9): positive when debit > credit
    const creditNormal = row.account_class === 2 || row.account_class === 3
    return roundOre(creditNormal ? credit - debit : debit - credit)
  }

  function formatSigned(amount: number): string {
    if (amount === 0) return ''
    return amount < 0
      ? `−${formatAmount(Math.abs(amount))}`
      : formatAmount(amount)
  }

  return (
    <div className="space-y-4">
      <ReportExportMenu items={[{ format: 'xlsx', href: `/api/reports/trial-balance/xlsx?period_id=${periodId}` }]} />
      <TrialBalanceChart rows={data.rows} />
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Saldobalans</CardTitle>
            <div className="flex items-center gap-3">
              <SegmentedControl
                value={viewMode}
                onChange={setViewMode}
                options={[
                  { value: 'simplified', label: 'Förenklad' },
                  { value: 'detailed', label: 'Detaljerad' },
                ]}
              />
              {data.isBalanced ? (
                <span className="text-sm text-muted-foreground">Balanserad</span>
              ) : (
                <Badge variant="destructive">Ej balanserad</Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto -mx-2 px-2">
            {viewMode === 'simplified' ? (
              <table className="w-full text-sm min-w-[500px]">
                <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <tr className="border-b text-left">
                    <th className="py-2 w-8"></th>
                    <th className="py-2 w-20">Konto</th>
                    <th className="py-2">Namn</th>
                    <th className="py-2 w-32 text-right">Ingående saldo</th>
                    <th className="py-2 w-32 text-right">Förändring</th>
                    <th className="py-2 w-32 text-right">Utgående saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <TrialBalanceSimplifiedRow
                      key={row.account_number}
                      row={row}
                      periodId={periodId}
                      drilldown={drilldown}
                      getNetBalance={getNetBalance}
                      formatSigned={formatSigned}
                    />
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="w-full text-sm min-w-[600px]">
                <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <tr className="border-b text-left">
                    <th className="py-2 w-8"></th>
                    <th className="py-2 w-20">Konto</th>
                    <th className="py-2">Namn</th>
                    <th className="py-2 w-28 text-right">Period debet</th>
                    <th className="py-2 w-28 text-right">Period kredit</th>
                    <th className="py-2 w-28 text-right">Saldo debet</th>
                    <th className="py-2 w-28 text-right">Saldo kredit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <TrialBalanceDetailedRow
                      key={row.account_number}
                      row={row}
                      periodId={periodId}
                      drilldown={drilldown}
                    />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold border-t-2">
                    <td className="py-2"></td>
                    <td colSpan={2} className="py-2">Summa</td>
                    <td className="py-2 text-right">
                      {formatAmount(data.rows.reduce((s, r) => s + r.period_debit, 0))}
                    </td>
                    <td className="py-2 text-right">
                      {formatAmount(data.rows.reduce((s, r) => s + r.period_credit, 0))}
                    </td>
                    <td className={`py-2 text-right ${data.isBalanced ? 'text-success' : 'text-destructive'}`}>
                      {formatAmount(data.totalDebit)}
                    </td>
                    <td className={`py-2 text-right ${data.isBalanced ? 'text-success' : 'text-destructive'}`}>
                      {formatAmount(data.totalCredit)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// Lazy fetcher for a TB account's source lines. Memoised at the row level so
// repeated toggling never refetches.
function makeTrialBalanceFetcher(accountNumber: string, periodId: string): ReportSourceFetcher {
  return async () => {
    const res = await fetch(
      `/api/reports/trial-balance/account/${encodeURIComponent(accountNumber)}/sources?fiscal_period_id=${encodeURIComponent(periodId)}`
    )
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || 'Kunde inte hämta verifikat')
    const lines: ReportSourceLine[] = json.data?.lines || []
    return { lines, next_cursor: json.data?.next_cursor ?? null }
  }
}

function TrialBalanceSimplifiedRow({
  row,
  periodId,
  drilldown,
  getNetBalance,
  formatSigned,
}: {
  row: TrialBalanceRow
  periodId: string
  drilldown: AccountDrilldown
  getNetBalance: (row: TrialBalanceRow, type: 'opening' | 'period' | 'closing') => number
  formatSigned: (amount: number) => string
}) {
  const fetcher = React.useMemo(
    () => makeTrialBalanceFetcher(row.account_number, periodId),
    [row.account_number, periodId]
  )
  const { toggle, panel } = useReportRowExpansion(fetcher, `tb-${row.account_number}`)

  const ob = getNetBalance(row, 'opening')
  const ch = getNetBalance(row, 'period')
  const cb = getNetBalance(row, 'closing')

  return (
    <>
      <tr className="border-b last:border-0 hover:bg-secondary/35 transition-colors">
        <td className="py-2" onClick={(e) => e.stopPropagation()}>
          {toggle}
        </td>
        <td
          className="py-2 cursor-pointer"
          onClick={accountDrilldownClick(drilldown, row.account_number)}
        >
          <AccountNumber number={row.account_number} name={row.account_name} />
        </td>
        <td
          className="py-2 cursor-pointer"
          onClick={accountDrilldownClick(drilldown, row.account_number)}
        >
          <Link href={drilldown.href(row.account_number)} className="block">{row.account_name}</Link>
        </td>
        <td className={`py-2 text-right tabular-nums ${ob < 0 ? 'text-destructive' : ''}`}>
          {formatSigned(ob)}
        </td>
        <td className={`py-2 text-right tabular-nums ${ch < 0 ? 'text-destructive' : ''}`}>
          {formatSigned(ch)}
        </td>
        <td className={`py-2 text-right tabular-nums font-medium ${cb < 0 ? 'text-destructive' : ''}`}>
          {formatSigned(cb)}
        </td>
      </tr>
      {panel(6)}
    </>
  )
}

function TrialBalanceDetailedRow({
  row,
  periodId,
  drilldown,
}: {
  row: TrialBalanceRow
  periodId: string
  drilldown: AccountDrilldown
}) {
  const fetcher = React.useMemo(
    () => makeTrialBalanceFetcher(row.account_number, periodId),
    [row.account_number, periodId]
  )
  const { toggle, panel } = useReportRowExpansion(fetcher, `tb-det-${row.account_number}`)

  return (
    <>
      <tr className="border-b last:border-0 hover:bg-secondary/35 transition-colors">
        <td className="py-2" onClick={(e) => e.stopPropagation()}>
          {toggle}
        </td>
        <td
          className="py-2 cursor-pointer"
          onClick={accountDrilldownClick(drilldown, row.account_number)}
        >
          <AccountNumber number={row.account_number} name={row.account_name} />
        </td>
        <td
          className="py-2 cursor-pointer"
          onClick={accountDrilldownClick(drilldown, row.account_number)}
        >
          <Link href={drilldown.href(row.account_number)} className="block">{row.account_name}</Link>
        </td>
        <td className="py-2 text-right">
          {row.period_debit > 0 ? formatAmount(row.period_debit) : ''}
        </td>
        <td className="py-2 text-right">
          {row.period_credit > 0 ? formatAmount(row.period_credit) : ''}
        </td>
        <td className="py-2 text-right">
          {row.closing_debit > 0 ? formatAmount(row.closing_debit) : ''}
        </td>
        <td className="py-2 text-right">
          {row.closing_credit > 0 ? formatAmount(row.closing_credit) : ''}
        </td>
      </tr>
      {panel(7)}
    </>
  )
}
