'use client'

// Report view components, extracted verbatim from app/(dashboard)/reports/page.tsx.
// Rendered by the focused /reports/[slug] route (see components/reports/FocusedReport.tsx).
// The regulated table/figure rendering is unchanged from the original monolith.

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useDimensions } from '@/lib/reference-data/hooks'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { AlertCircle, Check, ChevronDown, ChevronRight, ExternalLink, FileCode, FileDown, FileText, Percent } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { EmptyState } from '@/components/ui/empty-state'
import { FyPicker } from '@/components/common/FyPicker'
import { mostRecentEndedVatPeriod } from '@/lib/vat/period-defaults'
import { resolveInitialVatPeriodSelection } from '@/lib/vat/period-selection'
import { ContextPicker } from '@/components/common/ContextPicker'
import { cn, formatDate } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { roundOre } from '@/lib/money'
import { formatLatestVouchers } from '@/lib/reports/latest-vouchers-format'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { AccountNumber } from '@/components/ui/account-number'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { PageHeader } from '@/components/ui/page-header'
import { VatChecksCard } from '@/components/reports/VatChecksCard'
import { runVatDeclarationChecks } from '@/lib/reports/vat-declaration-checks'
import { rcInputTotalsFromDeclaration } from '@/lib/reports/vat-declaration'
import {
  isFilingBlocked,
  withRcBasisGapFindings,
  type RcBasisGapScan,
} from '@/lib/reports/vat-filing-gate'
import { Table, TableBody } from '@/components/ui/table'
import { useCompanySettings } from '@/components/settings/useSettings'
import dynamic from 'next/dynamic'
import { SkatteverketPanel } from '@/components/reports/SkatteverketPanel'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import {
  vatDeadlineTaxPeriod,
  type VatSettlementExistingEntry,
  type VatSettlementProposal,
} from '@/lib/reports/vat-settlement'
import { VatAlreadyBookedBanner } from '@/components/reports/VatAlreadyBookedBanner'
import { useVatSettlementProposal } from '@/components/reports/use-vat-settlement-proposal'

// Recharts is ~180KB: defer the chart components so report tables (the
// regulated content) render without waiting for the charting bundle.
const chartFallback = () => <Skeleton className="h-64 w-full" />
const TrialBalanceChart = dynamic(
  () => import('@/components/reports/TrialBalanceChart').then((m) => m.TrialBalanceChart),
  { ssr: false, loading: chartFallback },
)
const IncomeExpenseChart = dynamic(
  () => import('@/components/reports/IncomeExpenseChart').then((m) => m.IncomeExpenseChart),
  { ssr: false, loading: chartFallback },
)
// The full journal entry editor is heavy (BAS catalogue, comboboxes, review
// dialogs): defer it until the user opens the momsverifikat dialog.
const JournalEntryForm = dynamic(() => import('@/components/bookkeeping/JournalEntryForm'), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />,
})
import { useReportRowExpansion } from '@/components/reports/ReportRowExpansion'
import type {
  ReportSourceLine,
  ReportSourceFetcher,
} from '@/lib/reports/source-lines'
import type { MonthlyDataPoint } from '@/components/reports/IncomeExpenseChart'
import type { DateRangeValue } from '@/components/common/ReportDateRange'
import type { DimensionFilterValue } from '@/components/reports/DimensionFilter'
import type {
  TrialBalanceRow,
  IncomeStatementReport,
  BalanceSheetReport,
  ResultatrapportReport,
  BalansrapportReport,
  DimensionPnlReport,
  VatDeclaration,
  VatPeriodType,
} from '@/types'

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Shared shells for the report bodies, so all views read as the same
// instrument: Skeleton while loading, EmptyState when the period has no data,
// a quiet destructive card on fetch errors (design.md primitives).
function ReportLoadingCard() {
  return (
    <Card>
      <CardContent className="p-6 space-y-2">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </CardContent>
    </Card>
  )
}

function ReportErrorCard({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="p-8 text-center text-destructive">
        <AlertCircle className="h-6 w-6 mx-auto mb-2" />
        {message}
      </CardContent>
    </Card>
  )
}

function ReportEmptyState({ title, description }: { title: string; description: string }) {
  return <EmptyState icon={FileText} title={title} description={description} />
}

function reportQuery(
  periodId: string,
  range?: DateRangeValue,
  dimensionFilter?: DimensionFilterValue | null,
): string {
  const params = new URLSearchParams({ period_id: periodId })
  if (range?.fromDate) params.set('from_date', range.fromDate)
  if (range?.toDate) params.set('to_date', range.toDate)
  if (dimensionFilter) {
    params.set('dim_no', dimensionFilter.dimNo)
    params.set('dim_code', dimensionFilter.code)
  }
  return params.toString()
}

export function TrialBalanceView({ periodId, onNavigateToAccount }: { periodId: string; onNavigateToAccount: (account: string) => void }) {
  const [data, setData] = useState<{
    rows: TrialBalanceRow[]
    totalDebit: number
    totalCredit: number
    isBalanced: boolean
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'simplified' | 'detailed'>('simplified')

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/reports/trial-balance?period_id=${periodId}`)
      .then((res) => res.json())
      .then((result) => {
        if (result.error) {
          // `result.error` is the canonical envelope OBJECT; assigning it to a
          // string state and rendering it bare threw "Objects are not valid as
          // a React child" and blanked the report page.
          setError(getErrorMessage(result))
        } else {
          setData(result.data)
        }
        setLoading(false)
      })
      .catch(() => {
        setError('Kunde inte hämta saldobalans')
        setLoading(false)
      })
  }, [periodId])

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
                      onNavigateToAccount={onNavigateToAccount}
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
                      onNavigateToAccount={onNavigateToAccount}
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
  onNavigateToAccount,
  getNetBalance,
  formatSigned,
}: {
  row: TrialBalanceRow
  periodId: string
  onNavigateToAccount: (account: string) => void
  getNetBalance: (row: TrialBalanceRow, type: 'opening' | 'period' | 'closing') => number
  formatSigned: (amount: number) => string
}) {
  const fetcher = React.useMemo(
    () => makeTrialBalanceFetcher(row.account_number, periodId),
    [row.account_number, periodId]
  )
  const { Toggle, Panel } = useReportRowExpansion(fetcher, `tb-${row.account_number}`)

  const ob = getNetBalance(row, 'opening')
  const ch = getNetBalance(row, 'period')
  const cb = getNetBalance(row, 'closing')

  return (
    <>
      <tr className="border-b last:border-0 hover:bg-muted/50 transition-colors">
        <td className="py-2" onClick={(e) => e.stopPropagation()}>
          <Toggle />
        </td>
        <td
          className="py-2 cursor-pointer"
          onClick={() => onNavigateToAccount(row.account_number)}
        >
          <AccountNumber number={row.account_number} name={row.account_name} />
        </td>
        <td
          className="py-2 cursor-pointer"
          onClick={() => onNavigateToAccount(row.account_number)}
        >
          {row.account_name}
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
      <Panel colSpan={6} />
    </>
  )
}

function TrialBalanceDetailedRow({
  row,
  periodId,
  onNavigateToAccount,
}: {
  row: TrialBalanceRow
  periodId: string
  onNavigateToAccount: (account: string) => void
}) {
  const fetcher = React.useMemo(
    () => makeTrialBalanceFetcher(row.account_number, periodId),
    [row.account_number, periodId]
  )
  const { Toggle, Panel } = useReportRowExpansion(fetcher, `tb-det-${row.account_number}`)

  return (
    <>
      <tr className="border-b last:border-0 hover:bg-muted/50 transition-colors">
        <td className="py-2" onClick={(e) => e.stopPropagation()}>
          <Toggle />
        </td>
        <td
          className="py-2 cursor-pointer"
          onClick={() => onNavigateToAccount(row.account_number)}
        >
          <AccountNumber number={row.account_number} name={row.account_name} />
        </td>
        <td
          className="py-2 cursor-pointer"
          onClick={() => onNavigateToAccount(row.account_number)}
        >
          {row.account_name}
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
      <Panel colSpan={7} />
    </>
  )
}
export function IncomeStatementView({ periodId, dateRange, dimensionFilter = null, onNavigateToAccount }: { periodId: string; dateRange: DateRangeValue; dimensionFilter?: DimensionFilterValue | null; onNavigateToAccount: (account: string) => void }) {
  const [data, setData] = useState<IncomeStatementReport | null>(null)
  const [monthlyData, setMonthlyData] = useState<MonthlyDataPoint[]>([])
  const [monthlyLoading, setMonthlyLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const reportQs = reportQuery(periodId, dateRange, dimensionFilter)

  useEffect(() => {
    setLoading(true)
    setError(null)
    setMonthlyLoading(true)

    fetch(`/api/reports/income-statement?${reportQs}`)
      .then((res) => res.json())
      .then((result) => {
        if (result.error) {
          // `result.error` is the canonical envelope OBJECT; assigning it to a
          // string state and rendering it bare threw "Objects are not valid as
          // a React child" and blanked the report page.
          setError(getErrorMessage(result))
        } else {
          setData(result.data)
        }
        setLoading(false)
      })
      .catch(() => {
        setError('Kunde inte hämta resultaträkning')
        setLoading(false)
      })

    // Monthly breakdown is full-period by design (it IS the per-month view),
    // so the date range only affects the headline numbers above the chart.
    // The dimension filter DOES apply: a dimension-scoped view must not
    // silently chart company-wide months.
    fetch(`/api/reports/monthly-breakdown?${reportQuery(periodId, undefined, dimensionFilter)}`)
      .then((res) => res.json())
      .then((result) => {
        if (result.data?.months) {
          setMonthlyData(result.data.months)
        }
        setMonthlyLoading(false)
      })
      .catch(() => {
        setMonthlyLoading(false)
      })
  }, [periodId, reportQs])

  if (loading) {
    return <ReportLoadingCard />
  }

  if (error) {
    return <ReportErrorCard message={error} />
  }

  if (!data) {
    return (
      <ReportEmptyState
        title="Ingen data för perioden"
        description="Det finns inget bokfört underlag för den valda perioden."
      />
    )
  }

  return (
    <div className="space-y-4">
      <ReportExportMenu
        items={[
          { format: 'pdf', href: `/api/reports/income-statement/pdf?${reportQs}` },
          { format: 'xlsx', href: `/api/reports/income-statement/xlsx?${reportQs}` },
        ]}
      />

      {!monthlyLoading && monthlyData.length > 0 && (
        <IncomeExpenseChart months={monthlyData} />
      )}

      {/* Revenue */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rörelseintäkter</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ReportSectionTable
            sections={data.revenue_sections}
            onNavigateToAccount={onNavigateToAccount}
            footer={{ label: 'Summa rörelseintäkter', amount: data.total_revenue }}
          />
        </CardContent>
      </Card>

      {/* Expenses */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rörelsekostnader</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ReportSectionTable
            sections={data.expense_sections}
            negate
            onNavigateToAccount={onNavigateToAccount}
            footer={{ label: 'Summa rörelsekostnader', amount: data.total_expenses, negate: true }}
          />
        </CardContent>
      </Card>

      {/* Operating result */}
      <Card>
        <CardContent className="flex items-baseline justify-between p-6">
          <span className="text-sm font-medium">Rörelseresultat</span>
          <span className={`font-display text-xl tabular-nums ${data.total_revenue - data.total_expenses >= 0 ? 'text-success' : 'text-destructive'}`}>
            {formatAmount(data.total_revenue - data.total_expenses)} kr
          </span>
        </CardContent>
      </Card>

      {/* Financial items */}
      {data.financial_sections.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Finansiella poster</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ReportSectionTable
              sections={data.financial_sections}
              onNavigateToAccount={onNavigateToAccount}
              footer={{ label: 'Summa finansiella poster', amount: data.total_financial }}
            />
          </CardContent>
        </Card>
      )}

      {/* Net result */}
      <Card>
        <CardContent className="flex items-baseline justify-between p-6">
          <span className="text-sm font-medium">Årets resultat</span>
          <span className={`font-display text-xl tabular-nums ${data.net_result >= 0 ? 'text-success' : 'text-destructive'}`}>
            {formatAmount(data.net_result)} kr
          </span>
        </CardContent>
      </Card>
    </div>
  )
}

export function BalanceSheetView({ periodId, dateRange, onNavigateToAccount }: { periodId: string; dateRange: DateRangeValue; onNavigateToAccount: (account: string) => void }) {
  const [data, setData] = useState<BalanceSheetReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const reportQs = reportQuery(periodId, dateRange)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/reports/balance-sheet?${reportQs}`)
      .then((res) => res.json())
      .then((result) => {
        if (result.error) {
          // `result.error` is the canonical envelope OBJECT; assigning it to a
          // string state and rendering it bare threw "Objects are not valid as
          // a React child" and blanked the report page.
          setError(getErrorMessage(result))
        } else {
          setData(result.data)
        }
        setLoading(false)
      })
      .catch(() => {
        setError('Kunde inte hämta balansräkning')
        setLoading(false)
      })
  }, [periodId, reportQs])

  if (loading) {
    return <ReportLoadingCard />
  }

  if (error) {
    return <ReportErrorCard message={error} />
  }

  if (!data) {
    return (
      <ReportEmptyState
        title="Ingen data för perioden"
        description="Det finns inget bokfört underlag för den valda perioden."
      />
    )
  }

  const isBalanced = Math.abs(data.total_assets - data.total_equity_liabilities) < 0.01

  return (
    <div className="space-y-4">
      <ReportExportMenu
        items={[
          { format: 'pdf', href: `/api/reports/balance-sheet/pdf?${reportQs}` },
          { format: 'xlsx', href: `/api/reports/balance-sheet/xlsx?${reportQs}` },
        ]}
      />

      {/* Assets */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tillgångar</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ReportSectionTable
            sections={data.asset_sections}
            onNavigateToAccount={onNavigateToAccount}
            footer={{ label: 'Summa tillgångar', amount: data.total_assets }}
          />
        </CardContent>
      </Card>

      {/* Equity and liabilities */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Eget kapital och skulder</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ReportSectionTable
            sections={data.equity_liability_sections}
            onNavigateToAccount={onNavigateToAccount}
            footer={{ label: 'Summa eget kapital och skulder', amount: data.total_equity_liabilities }}
          />
        </CardContent>
      </Card>

      {/* Balance check */}
      <Card>
        <CardContent className="p-6">
          <div className="flex justify-between items-center">
            <span className="text-sm font-medium">Balanscheck</span>
            {isBalanced ? (
              <span className="text-sm text-muted-foreground">Balanserar</span>
            ) : (
              <div className="text-right">
                <Badge variant="destructive">Balanserar ej</Badge>
                <p className="text-sm text-destructive mt-1 tabular-nums">
                  Differens: {formatAmount(Math.abs(data.total_assets - data.total_equity_liabilities))} kr
                </p>
              </div>
            )}
          </div>
          {!isBalanced && data.imbalance_diagnosis && (
            <p className="text-sm text-muted-foreground mt-3 pt-3 border-t">
              {data.imbalance_diagnosis.message}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export function ResultatrapportView({ periodId, dateRange, dimensionFilter = null, onNavigateToAccount }: { periodId: string; dateRange: DateRangeValue; dimensionFilter?: DimensionFilterValue | null; onNavigateToAccount: (account: string) => void }) {
  const t = useTranslations('reports')
  const [data, setData] = useState<ResultatrapportReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const reportQs = reportQuery(periodId, dateRange, dimensionFilter)
  const latestVouchers = formatLatestVouchers(data?.latest_vouchers)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/reports/resultatrapport?${reportQs}`)
      .then((res) => res.json())
      .then((result) => {
        if (result.error) {
          // `result.error` is the canonical envelope OBJECT; assigning it to a
          // string state and rendering it bare threw "Objects are not valid as
          // a React child" and blanked the report page.
          setError(getErrorMessage(result))
        } else {
          setData(result.data)
        }
        setLoading(false)
      })
      .catch(() => {
        setError('Kunde inte hämta resultatrapport')
        setLoading(false)
      })
  }, [periodId, reportQs])

  if (loading) {
    return <ReportLoadingCard />
  }

  if (error) {
    return <ReportErrorCard message={error} />
  }

  if (!data || data.groups.length === 0) {
    return (
      <ReportEmptyState
        title="Inga intäkter eller kostnader"
        description="Det finns inga bokförda intäkter eller kostnader i den valda perioden."
      />
    )
  }

  const hasPrior = data.prior_period !== null
  const colCount = 4

  return (
    <div className="space-y-4">
      <ReportExportMenu
        items={[
          { format: 'pdf', href: `/api/reports/resultatrapport/pdf?${reportQs}` },
          { format: 'xlsx', href: `/api/reports/resultatrapport/xlsx?${reportQs}` },
        ]}
      />
      {latestVouchers && (
        <p className="text-sm text-muted-foreground">
          {t('latest_posted_vouchers')}: {latestVouchers}
        </p>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-medium px-4 py-2 w-20">Konto</th>
                  <th className="text-left font-medium px-4 py-2">Kontonamn</th>
                  <th
                    className="text-right font-medium px-4 py-2 w-32 tabular-nums"
                    title={`${data.period.start} till ${data.period.end}`}
                  >
                    Innevarande
                  </th>
                  <th
                    className="text-right font-medium px-4 py-2 w-32 tabular-nums"
                    title={hasPrior ? `${data.prior_period!.start} till ${data.prior_period!.end}` : undefined}
                  >
                    Föregående
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((group) => (
                  <React.Fragment key={group.class}>
                    <tr className="bg-muted/30">
                      <td colSpan={colCount} className="px-4 py-2 text-[12px] font-semibold text-muted-foreground">
                        {group.class_label}
                      </td>
                    </tr>
                    {group.rows.map((row) => (
                      <tr
                        key={row.account_number}
                        className="border-b last:border-0 cursor-pointer hover:bg-muted/50 transition-colors"
                        onClick={() => onNavigateToAccount(row.account_number)}
                      >
                        <td className="px-4 py-1.5">
                          <AccountNumber number={row.account_number} name={row.account_name} />
                        </td>
                        <td className="px-4 py-1.5">{row.account_name}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{formatAmount(row.current_period)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">
                          {hasPrior ? formatAmount(row.prior_period) : '-'}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-b font-medium">
                      <td colSpan={2} className="px-4 py-1.5 text-right text-muted-foreground">
                        Summa
                      </td>
                      <td className="px-4 py-1.5 text-right tabular-nums">{formatAmount(group.subtotal_current)}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">
                        {hasPrior ? formatAmount(group.subtotal_prior) : '-'}
                      </td>
                    </tr>
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <div className="grid gap-x-6 items-baseline grid-cols-[1fr_auto_auto]">
            <span className="text-sm font-medium">Beräknat resultat</span>
            <span className={`font-display text-xl tabular-nums w-32 text-right ${data.net_result_current >= 0 ? 'text-success' : 'text-destructive'}`}>
              {formatAmount(data.net_result_current)} kr
            </span>
            <span className="tabular-nums text-sm text-muted-foreground w-32 text-right">
              {hasPrior ? `${formatAmount(data.net_result_prior)} kr` : '-'}
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export function BalansrapportView({ periodId, dateRange, onNavigateToAccount }: { periodId: string; dateRange: DateRangeValue; onNavigateToAccount: (account: string) => void }) {
  const t = useTranslations('reports')
  const [data, setData] = useState<BalansrapportReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const reportQs = reportQuery(periodId, dateRange)
  const latestVouchers = formatLatestVouchers(data?.latest_vouchers)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/reports/balansrapport?${reportQs}`)
      .then((res) => res.json())
      .then((result) => {
        if (result.error) {
          // `result.error` is the canonical envelope OBJECT; assigning it to a
          // string state and rendering it bare threw "Objects are not valid as
          // a React child" and blanked the report page.
          setError(getErrorMessage(result))
        } else {
          setData(result.data)
        }
        setLoading(false)
      })
      .catch(() => {
        setError('Kunde inte hämta balansrapport')
        setLoading(false)
      })
  }, [periodId, reportQs])

  if (loading) {
    return <ReportLoadingCard />
  }

  if (error) {
    return <ReportErrorCard message={error} />
  }

  if (!data || data.groups.length === 0) {
    return (
      <ReportEmptyState
        title="Inga balansposter"
        description="Det finns inga bokförda balansposter i den valda perioden."
      />
    )
  }

  return (
    <div className="space-y-4">
      <ReportExportMenu
        items={[
          { format: 'pdf', href: `/api/reports/balansrapport/pdf?${reportQs}` },
          { format: 'xlsx', href: `/api/reports/balansrapport/xlsx?${reportQs}` },
        ]}
      />
      {latestVouchers && (
        <p className="text-sm text-muted-foreground">
          {t('latest_posted_vouchers')}: {latestVouchers}
        </p>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-medium px-4 py-2 w-20">Konto</th>
                  <th className="text-left font-medium px-4 py-2">Kontonamn</th>
                  <th className="text-right font-medium px-4 py-2 w-32 tabular-nums">Ingående balans</th>
                  <th className="text-right font-medium px-4 py-2 w-32 tabular-nums">Förändring</th>
                  <th className="text-right font-medium px-4 py-2 w-32 tabular-nums">Utgående balans</th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((group) => (
                  <React.Fragment key={group.class}>
                    <tr className="bg-muted/30">
                      <td colSpan={5} className="px-4 py-2 text-[12px] font-semibold text-muted-foreground">
                        {group.class_label}
                      </td>
                    </tr>
                    {group.rows.map((row) => (
                      <tr
                        key={row.account_number}
                        className="border-b last:border-0 cursor-pointer hover:bg-muted/50 transition-colors"
                        onClick={() => onNavigateToAccount(row.account_number)}
                      >
                        <td className="px-4 py-1.5">
                          <AccountNumber number={row.account_number} name={row.account_name} />
                        </td>
                        <td className="px-4 py-1.5">{row.account_name}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">{formatAmount(row.ib)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">{formatAmount(row.period_change)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{formatAmount(row.ub)}</td>
                      </tr>
                    ))}
                    <tr className="border-b font-medium">
                      <td colSpan={2} className="px-4 py-1.5 text-right text-muted-foreground">
                        Summa
                      </td>
                      <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">{formatAmount(group.subtotal_ib)}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">
                        {formatAmount(group.subtotal_ub - group.subtotal_ib)}
                      </td>
                      <td className="px-4 py-1.5 text-right tabular-nums">{formatAmount(group.subtotal_ub)}</td>
                    </tr>
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Summa tillgångar</span>
            <span className="tabular-nums">{formatAmount(data.total_assets_ub)} kr</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Summa eget kapital, reserver, avsättningar och skulder</span>
            <span className="tabular-nums">{formatAmount(data.total_equity_liabilities_ub)} kr</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Beräknat resultat (ej bokslutsjusterat)</span>
            <span className="tabular-nums">{formatAmount(data.beraknat_resultat)} kr</span>
          </div>
          <div className="flex justify-between items-center pt-2 border-t">
            <span className="text-sm font-medium">Balanscheck</span>
            {data.is_balanced ? (
              <span className="text-sm text-muted-foreground">Balanserar</span>
            ) : (
              <div className="text-right">
                <Badge variant="destructive">Balanserar ej</Badge>
                {data.imbalance_diagnosis && (
                  <p className="text-sm text-destructive mt-1 tabular-nums">
                    Differens: {formatAmount(Math.abs(data.imbalance_diagnosis.differens))} kr
                  </p>
                )}
              </div>
            )}
          </div>
          {!data.is_balanced && data.imbalance_diagnosis && (
            <p className="text-sm text-muted-foreground pt-2 border-t">
              {data.imbalance_diagnosis.message}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ReportSectionTable({
  sections,
  negate,
  onNavigateToAccount,
  footer,
}: {
  sections: { title: string; rows: { account_number: string; account_name: string; amount: number }[]; subtotal: number }[]
  negate?: boolean
  onNavigateToAccount?: (account: string) => void
  /** Report total, rendered as the table's tfoot (e.g. "Summa tillgångar"). */
  footer?: { label: string; amount: number; negate?: boolean }
}) {
  const fmt = (amount: number, neg?: boolean) =>
    neg ? `-${formatAmount(amount)}` : formatAmount(amount)

  if (sections.length === 0) {
    return <p className="p-6 pt-0 text-sm text-muted-foreground">Inga poster.</p>
  }

  // One table with group-band rows (design.md tabular rules), matching the
  // Resultatrapport/Balansrapport idiom, instead of one boxed sub-table per
  // section with a repeated title line.
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[400px]">
        <tbody>
          {sections.map((section) => (
            <React.Fragment key={section.title}>
              <tr className="bg-muted/30">
                <td colSpan={3} className="px-4 py-2 text-[12px] font-semibold text-muted-foreground">
                  {section.title}
                </td>
              </tr>
              {section.rows.map((row) => (
                <tr
                  key={row.account_number}
                  className={`border-b last:border-0 ${onNavigateToAccount ? 'cursor-pointer hover:bg-muted/50 transition-colors' : ''}`}
                  onClick={onNavigateToAccount ? () => onNavigateToAccount(row.account_number) : undefined}
                >
                  <td className="px-4 py-1.5 w-20"><AccountNumber number={row.account_number} name={row.account_name} /></td>
                  <td className="px-4 py-1.5">{row.account_name}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums w-32 whitespace-nowrap">
                    {fmt(row.amount, negate)} kr
                  </td>
                </tr>
              ))}
              <tr className="border-b font-medium">
                <td colSpan={2} className="px-4 py-1.5 text-right text-muted-foreground">Summa</td>
                <td className="px-4 py-1.5 text-right tabular-nums whitespace-nowrap">{fmt(section.subtotal, negate)} kr</td>
              </tr>
            </React.Fragment>
          ))}
        </tbody>
        {footer && (
          <tfoot>
            <tr className="font-medium">
              <td colSpan={2} className="px-4 py-2">{footer.label}</td>
              <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{fmt(footer.amount, footer.negate)} kr</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

// Carries the selected fiscal period into the ruta drill-down rows so their
// source-verifikat query matches the report's period. Only set for yearly
// (räkenskapsår); undefined for monthly/quarterly (calendar periods).
const VatDrillContext = React.createContext<{ fiscalPeriodId?: string }>({})

// Skatteverket's e-service entry point for manually filing the momsdeklaration.
// Manual filing needs no connection, so this link is the default path for
// anyone who hasn't set up (or doesn't want) the direct-submission integration.
const SKATTEVERKET_MOMS_URL =
  'https://www.skatteverket.se/foretag/etjansterochblanketter/etjanster/momsocharbetsgivardeklarationer'

/**
 * Manual-filing affordance shown directly under the calculated momsdeklaration.
 * The report is generated purely from the bookkeeping and never depends on the
 * Skatteverket connection, so every user (including core builds with the
 * skatteverket extension disabled) can file manually. Two paths are offered:
 * an eSKD XML file to upload directly under "Deklarera via fil" (the fast path),
 * and a PDF (in hela kronor) to read off if the user would rather type the
 * boxes into the form. A PDF cannot be uploaded to Skatteverket, only the XML.
 */
function VatManualFilingCard({ xmlHref, pdfHref }: { xmlHref: string; pdfHref: string }) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-3 px-1">
        <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Lämna in själv, med fil
        </h3>
        <div className="h-px flex-1 bg-border/60" />
      </div>
      <div className="space-y-4">
        <p className="text-[13px] leading-6 text-muted-foreground">
          Du behöver inte vara ansluten till Skatteverket för att lämna in.
        </p>
        <ol className="list-decimal pl-6 space-y-1 text-sm text-muted-foreground">
          <li>Ladda ner XML-filen nedan.</li>
          <li>Logga in på skatteverket.se med BankID.</li>
          <li>Öppna Moms- och arbetsgivardeklarationer och välj Deklarera via fil.</li>
          <li>Ladda upp filen, granska och signera.</li>
        </ol>
        <p className="text-xs text-muted-foreground">
          Vill du hellre fylla i rutorna för hand laddar du ner PDF:en och skriver av
          beloppen (i hela kronor).
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild className="gap-2">
            <a href={xmlHref} target="_blank" rel="noopener noreferrer">
              <FileCode className="h-4 w-4" />
              Ladda ner fil för uppladdning (XML)
            </a>
          </Button>
          <Button variant="outline" asChild className="gap-2">
            <a href={pdfHref} target="_blank" rel="noopener noreferrer">
              <FileDown className="h-4 w-4" />
              Ladda ner momsdeklaration (PDF)
            </a>
          </Button>
          <Button variant="outline" asChild className="gap-2">
            <a href={SKATTEVERKET_MOMS_URL} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" />
              Öppna skatteverket.se
            </a>
          </Button>
        </div>
      </div>
    </section>
  )
}

/**
 * "Bokför momsrapport" (issue #980): builds an editable verifikat proposal
 * from the momsrapport (clearing the period's 26xx accounts to 2650/1650,
 * öre gap on 3740) and books it through the ordinary journal entry form, so
 * every line can be adjusted before committing. The proposal comes from
 * /api/reports/vat-declaration/settlement-proposal; booking goes through
 * POST /api/bookkeeping/journal-entries with source_type 'vat_settlement',
 * which the declaration projection excludes, so the report above keeps
 * showing the declared figures after booking.
 */
function VatBookingCard({
  checksBlocked,
  proposal,
  failed,
  upToDate,
  booked,
  draft,
  onRetry,
}: {
  /**
   * True when the local pre-flight checks found ERRORs. Booking stays
   * possible (the RC-basis fixes only touch 44xx/45xx pairs, never the 26xx
   * accounts the settlement clears), but the user should know before filing.
   */
  checksBlocked?: boolean
  /** Settlement proposal loaded by the parent so Granska can reuse it. */
  proposal: VatSettlementProposal | null
  failed: boolean
  upToDate: boolean
  booked?: VatSettlementExistingEntry
  draft?: VatSettlementExistingEntry
  onRetry: () => void
}) {
  const { canWrite } = useCanWrite()
  const [dialogOpen, setDialogOpen] = useState(false)

  // FormLine amounts are input strings; the proposal's numbers are already
  // öre-rounded server-side, so this is display formatting, not money math.
  const initialLines: FormLine[] = (proposal?.lines ?? []).map((l) => ({
    account_number: l.account_number,
    debit_amount: l.debit_amount > 0 ? l.debit_amount.toFixed(2) : '',
    credit_amount: l.credit_amount > 0 ? l.credit_amount.toFixed(2) : '',
    line_description: l.line_description ?? '',
  }))

  return (
    <div className="space-y-4">
        <p className="text-[13px] leading-6 text-muted-foreground">
          Skapa ett verifikat som nollställer periodens momskonton och bokför
          momsen att betala eller få tillbaka på redovisningskontot. Du granskar
          förslaget och kan ändra raderna innan verifikatet bokförs.
        </p>

        {booked && (
          <div className="flex items-start gap-2 text-[13px] leading-6 text-muted-foreground">
            <AlertCircle className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>
              Momsen för perioden är redan bokförd:{' '}
              <Link
                href={`/bookkeeping/${booked.id}`}
                className="underline underline-offset-2 hover:text-foreground"
              >
                verifikat {formatVoucher(booked)} ({formatDate(booked.entry_date)})
              </Link>
              . Annullera det verifikatet först om perioden behöver bokföras om.
            </p>
          </div>
        )}
        {draft && (
          <div className="flex items-start gap-2 text-[13px] leading-6 text-muted-foreground">
            <AlertCircle className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>
              Det finns redan ett{' '}
              <Link
                href={`/bookkeeping/${draft.id}`}
                className="underline underline-offset-2 hover:text-foreground"
              >
                utkast för momsen i perioden
              </Link>
              .
            </p>
          </div>
        )}

        {checksBlocked && (
          <p className="text-[12.5px] leading-5 text-attn">
            Det finns fel under steg 1, Kontrollera. Du kan bokföra momsen ändå, men
            åtgärda felen innan du lämnar in.
          </p>
        )}

        {failed ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-destructive">Kunde inte hämta verifikatförslaget.</p>
            <Button variant="outline" onClick={onRetry}>
              Försök igen
            </Button>
          </div>
        ) : !upToDate ? (
          <Skeleton className="h-10 w-40" />
        ) : proposal?.is_empty ? (
          <p className="text-sm text-muted-foreground">Ingen moms att bokföra för perioden.</p>
        ) : (
          <div className="space-y-2">
            <Button
              // A posted settlement blocks re-booking: the proposal re-clears the
              // FULL period (it is not delta-aware), so booking twice would
              // corrupt the 26xx balances. Annulling the verifikat restores them
              // and re-enables the button.
              disabled={!proposal || !canWrite || !!booked}
              onClick={() => setDialogOpen(true)}
            >
              Skapa verifikat
            </Button>
            {!canWrite && (
              <p className="text-xs text-muted-foreground">
                Du har läsbehörighet och kan inte bokföra.
              </p>
            )}
          </div>
        )}

      {proposal && (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent
            className="sm:max-w-3xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto"
            // A reviewed-but-unbooked proposal must survive an accidental
            // backdrop click or stray Escape (same rationale as
            // NewJournalEntryDialog): closing is explicit via the header X.
            onEscapeKeyDown={(e) => e.preventDefault()}
            onPointerDownOutside={(e) => e.preventDefault()}
            onInteractOutside={(e) => e.preventDefault()}
          >
            <DialogHeader>
              <DialogTitle>Bokför momsrapport</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Förslaget bygger på momsrapporten för {proposal.period_label}. Justera
              datum, konton eller belopp vid behov och bokför sedan verifikatet.
            </p>
            {dialogOpen && (
              <JournalEntryForm
                bare
                sourceType="vat_settlement"
                initialDate={proposal.entry_date}
                initialDescription={proposal.description}
                initialLines={initialLines}
                onCreated={() => {
                  setDialogOpen(false)
                  onRetry()
                }}
              />
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}


/** The Stegen header (concept Moms C): the filing pipeline as a clickable
 *  horizontal stepper with honest per-step status subs. Statutory surface,
 *  Swedish in both locales like the rest of the declaration. */
function VatStepper({
  active,
  onSelect,
  errorCount,
  warningCount,
  ruta49,
  bookingStatus,
}: {
  active: number
  onSelect: (step: number) => void
  errorCount: number
  warningCount: number
  ruta49: number
  bookingStatus: 'booked' | 'draft' | 'none' | null
}) {
  const steps = [
    {
      n: 1,
      label: 'Kontrollera',
      sub:
        errorCount > 0
          ? `${errorCount} fel`
          : warningCount > 0
            ? `${warningCount} ${warningCount === 1 ? 'varning' : 'varningar'}`
            : 'klart',
      done: errorCount === 0,
      warn: errorCount > 0,
    },
    {
      n: 2,
      label: 'Granska',
      sub:
        ruta49 > 0
          ? `${formatAmount(ruta49)} kr att betala`
          : ruta49 < 0
            ? `${formatAmount(Math.abs(ruta49))} kr att återfå`
            : 'ingen moms',
      done: false,
      warn: false,
    },
    {
      n: 3,
      label: 'Bokför',
      sub:
        bookingStatus === 'booked'
          ? 'bokförd'
          : bookingStatus === 'draft'
            ? 'utkast finns'
            : 'mot 2650',
      done: bookingStatus === 'booked',
      warn: false,
    },
    { n: 4, label: 'Lämna in', sub: 'till Skatteverket', done: false, warn: false },
  ]

  return (
    <div
      className="mx-auto flex w-full max-w-3xl items-center gap-3 overflow-x-auto px-1"
      role="tablist"
      aria-label="Momsdeklarationens steg"
    >
      {steps.map((step, i) => (
        <React.Fragment key={step.n}>
          {i > 0 && <span className="h-px min-w-4 flex-1 bg-border" aria-hidden="true" />}
          <button
            type="button"
            role="tab"
            aria-selected={active === step.n}
            onClick={() => onSelect(step.n)}
            className="group flex shrink-0 items-center gap-2 text-left"
          >
            <span
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums transition-colors duration-150',
                step.done
                  ? 'border-success/40 text-success'
                  : active === step.n
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground group-hover:border-foreground/30',
              )}
            >
              {step.done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : step.n}
            </span>
            <span className="leading-tight">
              <span
                className={cn(
                  'block text-[12.5px] transition-colors duration-150',
                  active === step.n
                    ? 'font-medium'
                    : 'text-muted-foreground group-hover:text-foreground',
                )}
              >
                {step.label}
              </span>
              {step.sub && (
                <span
                  className={cn(
                    'block text-[11px] tabular-nums',
                    step.warn ? 'text-attn' : 'text-muted-foreground',
                  )}
                >
                  {step.sub}
                </span>
              )}
            </span>
          </button>
        </React.Fragment>
      ))}
    </div>
  )
}

const MONTH_NAMES = [
  'Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
  'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December',
]
const QUARTER_SPANS = ['jan-mar', 'apr-jun', 'jul-sep', 'okt-dec']

// Inline momsperiod setup for the "registered but no period picked" state.
// Writes through the same PUT /api/settings validation as the tax settings
// form (SFL 26 kap coherence rules included), so this is a shortcut, not a
// second write path. Until a period exists the deadline engine generates NO
// VAT deadlines at all, silently, which is why this state answers inline
// instead of bouncing to settings.
function MomsPeriodInlineSetup({
  onSaved,
}: {
  onSaved: (value: 'monthly' | 'quarterly' | 'yearly') => Promise<void> | void
}) {
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const choose = async (value: 'monthly' | 'quarterly' | 'yearly') => {
    if (saving) return
    setSaving(value)
    setError(null)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moms_period: value }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        setError(getErrorMessage(json, { statusCode: res.status }))
        return
      }
      await onSaved(value)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSaving(null)
    }
  }

  const options: { value: 'monthly' | 'quarterly' | 'yearly'; label: string }[] = [
    { value: 'quarterly', label: 'Varje kvartal' },
    { value: 'monthly', label: 'Varje månad' },
    { value: 'yearly', label: 'Helår' },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap justify-center gap-2">
        {options.map((opt) => (
          <Button
            key={opt.value}
            variant="outline"
            size="sm"
            // The clicked button stays enabled (aria-busy) so keyboard focus
            // survives the save; the `if (saving) return` guard in choose()
            // prevents a double submit.
            disabled={saving !== null && saving !== opt.value}
            aria-busy={saving === opt.value}
            onClick={() => choose(opt.value)}
          >
            {saving === opt.value ? 'Sparar …' : opt.label}
          </Button>
        ))}
      </div>
      {error && (
        <p role="status" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

export function VatDeclarationView({ pageTitle }: { pageTitle?: string } = {}) {
  const currentYear = new Date().getFullYear()
  const currentMonth = new Date().getMonth() + 1
  const currentQuarter = Math.ceil(currentMonth / 3)

  // periodType stays null until the company's VAT settings have settled, so
  // the first (automatic) fetch runs against the configured momsperiod instead
  // of a guessed default.
  const [periodType, setPeriodType] = useState<VatPeriodType | null>(null)
  const [year, setYear] = useState(currentYear)
  const [period, setPeriod] = useState(currentQuarter)
  // Annual VAT (helårsmoms) is reported per räkenskapsår, not per calendar
  // year — picked inline in yearly mode. Monthly/quarterly are calendar
  // periods and need no fiscal year. The period's end date rides along so
  // the Skatteverket panel can target the FY-end month (broken fiscal years
  // do not end in December).
  const [fiscalPeriodId, setFiscalPeriodId] = useState('')
  const [fiscalPeriodEnd, setFiscalPeriodEnd] = useState<string | null>(null)
  // Latest fetch outcome, tagged with the fetch key it was requested under.
  // loading / error / data are all derived by comparing that tag with the
  // current key, so the fetch effect never sets state synchronously.
  const [result, setResult] = useState<{
    key: string
    declaration?: VatDeclaration
    error?: string
  } | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  // Stegen: which of the four pipeline steps is open. null = automatic
  // (errors land on Kontrollera, otherwise Granska). A period switch resets
  // to automatic so stale step choices never survive a context change.
  const [chosenStep, setChosenStep] = useState<number | null>(null)
  const [settlementRefreshKey, setSettlementRefreshKey] = useState(0)
  const [deadlineResult, setDeadlineResult] = useState<{ key: string; completed: boolean } | null>(null)
  // Per-verifikat RC-basis scan, fetched here (not only inside VatChecksCard)
  // because the filing gate lives here and the worklist unmounts as soon as
  // the user leaves steg 1. Tagged with the PERIOD it was requested for (see
  // gapScanPeriodKey), so a korrigering refetches without the gate falling
  // open in between; count === null means "not known" (scan failed), which is
  // deliberately NOT the same as zero.
  const [gapScan, setGapScan] = useState<{ key: string; count: number | null } | null>(null)

  // Company settings drive both the momsregistrerad gate and the default
  // periodicity (moms_period in Inställningar). Applied once per company the
  // first time its settings settle — as a render-phase adjustment, not an
  // effect. A later manual change to the picker is preserved for the session,
  // and a company switch re-applies the new company's setting. The cadence is
  // deliberately NOT persisted across visits: the redovisningsperiod is fixed
  // by the company's Skatteverket registration, so this mount-time re-seed is
  // the control that self-heals an in-session detour to the wrong period
  // type (see lib/vat/period-selection.ts). `useCompanySettings` only
  // refetches when the active company changes, so this never clobbers a
  // manual selection mid-session.
  const { settings, isLoading: settingsLoading, refetch: refetchSettings } = useCompanySettings()
  const [appliedCompany, setAppliedCompany] = useState<string | null>(null)
  const companyKey = settingsLoading ? null : (settings?.company_id ?? 'none')
  if (companyKey !== null && appliedCompany !== companyKey) {
    setAppliedCompany(companyKey)
    const initial = resolveInitialVatPeriodSelection({
      momsPeriod: settings?.moms_period ?? null,
      over40m: settings?.vat_taxable_base_over_40m === true,
    })
    setPeriodType(initial.periodType)
    setYear(initial.year)
    setPeriod(initial.period)
  }

  // Settings row present and the company answered "not VAT-registered" —
  // the declaration is meaningless, so the whole view is gated below.
  const notVatRegistered = !settingsLoading && settings !== null && !settings.vat_registered
  // No company_settings row at all (company created outside onboarding):
  // VAT registration AND periodicity are both unknown. This used to fall
  // through every gate and render a silently guessed quarterly declaration;
  // the wrong period type for an årsmoms company is a compliance hazard, so
  // it now gates like the other unknowns.
  const settingsRowMissing = !settingsLoading && settings === null
  // Registered but never picked a redovisningsperiod (rare — onboarding
  // requires it, but companies created outside that flow can miss it).
  const momsPeriodMissing = settings?.vat_registered === true && !settings.moms_period

  // Switching periodicity resets the period to the most recently ended one in
  // the new unit (same default as first load: the current period can never be
  // filed). Done in the change handler (not an effect) so the auto-fetch below
  // never sees an inconsistent periodType/period pair.
  const handlePeriodTypeChange = (value: VatPeriodType) => {
    setPeriodType(value)
    if (value === 'monthly' || value === 'quarterly') {
      const ended = mostRecentEndedVatPeriod(value, new Date(), {
        over40m: settings?.vat_taxable_base_over_40m === true,
      })
      setYear(ended.year)
      setPeriod(ended.period)
    } else {
      setPeriod(1)
    }
  }

  // Annual VAT (helårsmoms) is reported per räkenskapsår, not per calendar year.
  // For yearly we pass the selected fiscal period so the API uses its actual
  // bounds (handles extended/shortened years); monthly/quarterly stay calendar.
  const isYearly = periodType === 'yearly'
  const awaitingFiscalPeriod = isYearly && !fiscalPeriodId
  const vatQueryString = () => {
    const params = new URLSearchParams({
      periodType: periodType ?? 'quarterly',
      year: String(year),
      period: String(period),
    })
    if (isYearly && fiscalPeriodId) params.set('fiscal_period_id', fiscalPeriodId)
    return params.toString()
  }

  // The declaration loads as soon as the period is known — no manual "Hämta"
  // step. fetchKey is null while a prerequisite is missing (settings pending,
  // gated, or no redovisningsperiod configured); any change to it triggers a
  // refetch and stale responses are discarded.
  const fetchKey =
    periodType === null ||
    notVatRegistered ||
    settingsRowMissing ||
    momsPeriodMissing ||
    awaitingFiscalPeriod
      ? null
      : `${periodType}:${year}:${period}:${isYearly ? fiscalPeriodId : ''}:${retryKey}`

  // Period identity WITHOUT the retry counter, used to decide whether the gap
  // scan below still speaks for what is on screen. The scan re-runs on every
  // retryKey bump (each korrigering), but the last settled count stays in
  // force until the new one lands: falling back to `pending` mid-korrigering
  // would drop the gap finding out of `checks` for one round trip, and with
  // the aggregate check silent (the tolerance case this gate exists for) the
  // green "Inga fel hittades i underlaget för perioden" would render right
  // above the vouchers still left in the worklist, with Skicka enabled. That
  // is the exact regression being fixed, and steg 1 stays mounted across a
  // korrigering, so the user would be looking straight at it. Stale-but-closed
  // is the safe direction, and it matches the declaration itself, which stays
  // on screen (dimmed) while the next one loads.
  const gapScanPeriodKey =
    periodType === null
      ? null
      : `${periodType}:${year}:${period}:${isYearly ? fiscalPeriodId : ''}`

  const settlement = useVatSettlementProposal({
    periodType,
    year,
    period,
    fiscalPeriodId: isYearly ? fiscalPeriodId : undefined,
    enabled: fetchKey != null,
    refreshKey: settlementRefreshKey,
  })
  const bookingStatus = settlement.upToDate ? settlement.bookingStatus : null
  const taxPeriodKey = periodType ? vatDeadlineTaxPeriod(periodType, year, period) : null
  const deadlineCompleted =
    !!settlement.booked &&
    taxPeriodKey != null &&
    deadlineResult?.key === taxPeriodKey &&
    deadlineResult.completed

  useEffect(() => {
    setChosenStep(null)
  }, [periodType, year, period, fiscalPeriodId])

  useEffect(() => {
    if (!settlement.booked || !taxPeriodKey) return
    const key = taxPeriodKey
    let cancelled = false
    fetch('/api/deadlines?status=completed')
      .then(async (res) => {
        const json = await res.json().catch(() => null)
        if (cancelled) return
        const rows = Array.isArray(json?.data) ? json.data : []
        const match = rows.some(
          (d: { tax_period?: string | null; tax_deadline_type?: string | null }) =>
            d.tax_period === key &&
            (d.tax_deadline_type === 'moms_monthly' ||
              d.tax_deadline_type === 'moms_quarterly' ||
              d.tax_deadline_type === 'moms_yearly'),
        )
        setDeadlineResult({ key, completed: match })
      })
      .catch(() => {
        if (!cancelled) setDeadlineResult({ key, completed: false })
      })
    return () => {
      cancelled = true
    }
  }, [settlement.booked, taxPeriodKey])

  useEffect(() => {
    if (!fetchKey || periodType === null) return
    const params = new URLSearchParams({
      periodType,
      year: String(year),
      period: String(period),
    })
    if (periodType === 'yearly') params.set('fiscal_period_id', fiscalPeriodId)
    let cancelled = false
    fetch(`/api/reports/vat-declaration?${params.toString()}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null)
        if (cancelled) return
        if (!res.ok || json?.error) {
          setResult({
            key: fetchKey,
            error:
              typeof json?.error === 'string' ? json.error : 'Kunde inte hämta momsdeklaration',
          })
        } else {
          setResult({ key: fetchKey, declaration: json.data })
        }
      })
      .catch(() => {
        if (!cancelled) setResult({ key: fetchKey, error: 'Kunde inte hämta momsdeklaration' })
      })
    return () => {
      cancelled = true
    }
  }, [fetchKey, periodType, year, period, fiscalPeriodId])

  // The per-verifikat gap scan runs on the same key as the declaration, so a
  // korrigering (which bumps retryKey via onCorrected) re-verifies the gate
  // instead of leaving it stuck on the pre-correction count.
  useEffect(() => {
    if (!fetchKey || periodType === null || !gapScanPeriodKey) return
    const params = new URLSearchParams({
      periodType,
      year: String(year),
      period: String(period),
    })
    if (periodType === 'yearly') params.set('fiscal_period_id', fiscalPeriodId)
    let cancelled = false
    fetch(`/api/reports/vat-declaration/rc-basis-gaps?${params.toString()}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null)
        if (cancelled) return
        // count === null is a settled FAILURE, and unknown is not "inga
        // brister": it becomes a visible warning row (so the banner cannot
        // claim all-clear on a check that never ran) but does not block, or a
        // network hiccup would lock the user out of a statutory deadline.
        if (!res.ok || json?.error) setGapScan({ key: gapScanPeriodKey, count: null })
        else setGapScan({ key: gapScanPeriodKey, count: (json?.data?.gaps ?? []).length })
      })
      .catch(() => {
        if (!cancelled) setGapScan({ key: gapScanPeriodKey, count: null })
      })
    return () => {
      cancelled = true
    }
  }, [fetchKey, gapScanPeriodKey, periodType, year, period, fiscalPeriodId])

  // Derived fetch state: the previous declaration stays visible (dimmed)
  // while the next period loads.
  const upToDate = result !== null && result.key === fetchKey
  const data = result?.declaration ?? null
  const error = upToDate ? (result.error ?? null) : null
  const loading = fetchKey !== null && !upToDate

  // Local pre-flight checks on the calculated declaration. Computed here (not
  // in SkatteverketPanel) so every user sees them: they gate direct submission
  // but concern manual filers just as much.
  //
  // The per-verifikat gap scan is folded in BEFORE anything derives from the
  // list. The aggregate checks compare period totals with a tolerance that
  // scales with period size, so they can stay silent while individual
  // verifikat still miss their basbelopp: reading them alone let the green
  // "Inga fel hittades i underlaget för perioden" render directly above the
  // worklist of those verifikat, with Skicka enabled. Banner, stegen and the
  // send gate now all read this ONE array. The three scan states are kept
  // apart: only a settled count of zero is allowed to mean "inga brister".
  const gapScanSettled = gapScan !== null && gapScan.key === gapScanPeriodKey
  const rcBasisScan: RcBasisGapScan = !gapScanSettled
    ? { status: 'pending' }
    : gapScan.count === null
      ? { status: 'unavailable' }
      : { status: 'scanned', gapCount: gapScan.count }
  // The declaration carries the 2645/2647 totals (rcInputAccountTotals), so
  // RC_INPUT_VAT_MISMATCH compares rutor 30-32 against the reverse-charge INPUT
  // accounts instead of the ruta 48 aggregate. Without them, 50 000 kr of
  // fiktiv utgående moms with nothing on 2645 sits silently behind 60 000 kr of
  // ordinary 2641 and the user pays in moms they were entitled to deduct.
  // rcInputTotalsFromDeclaration returns undefined (not an empty map) when a
  // response predates the field, which keeps the fallback honest.
  // The gap-downgrade evidence (per-momssats 44xx/45xx balances) travels on
  // the declaration payload. Absent on responses from an older deploy: then
  // the gaps keep their blocking ERROR tier rather than guessing.
  const checks = data
    ? withRcBasisGapFindings(
        runVatDeclarationChecks(data.rutor, rcInputTotalsFromDeclaration(data)),
        rcBasisScan,
        data.rcBasisByRate
          ? { rutor: data.rutor, rcBasisByRate: data.rcBasisByRate }
          : undefined,
      )
    : []
  const checksBlocked = isFilingBlocked(checks)
  const errorCount = checks.filter((c) => c.status === 'ERROR').length
  const warningCount = checks.filter((c) => c.status === 'WARNING').length
  // Latch the automatic landing step once per period, as a render-phase
  // adjustment when the period's declaration first settles. Deriving it live
  // from checksBlocked navigated the user away mid-work: the refetch after a
  // korrigering can clear the aggregate error while the Kontrollera worklist
  // still holds broken vouchers, and the view would jump to Granska under
  // their feet. The period-change effect below resets chosenStep to null,
  // which re-arms this latch for the next period. It also waits for the gap
  // scan: latching on the aggregate alone landed the user on Granska while
  // steg 1 still held a blocking worklist.
  if (chosenStep === null && upToDate && data && !error && gapScanSettled) {
    setChosenStep(checksBlocked ? 1 : 2)
  }
  const activeStep = chosenStep ?? (checksBlocked ? 1 : 2)

  // Settings not settled yet — the picker defaults and the gate both depend
  // on them, so hold the whole view in a skeleton.
  // The standalone page renders its own PageHeader (FocusedReport passes the
  // title and skips its own), so the H1 must survive the gated/loading
  // states too: each early return carries the action-less header.
  const bareHeader = pageTitle ? <PageHeader title={pageTitle} /> : null

  if (settingsLoading || periodType === null) {
    return (
      <div className="space-y-8">
        {bareHeader}
        <Card>
          <CardContent className="p-6 space-y-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-64" />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (settingsRowMissing) {
    return (
      <div className="space-y-8">
        {bareHeader}
        <EmptyState
          icon={Percent}
          title="Skatteinställningar saknas"
          description="Momsdeklarationen bygger på företagets skatteinställningar, men inga är angivna ännu. Ange momsregistrering och redovisningsperiod (månad, kvartal eller helår) i inställningarna, så visas deklarationen för rätt period."
          actionLabel="Öppna skatteinställningar"
          actionHref="/settings/tax"
        />
      </div>
    )
  }

  if (notVatRegistered) {
    return (
      <div className="space-y-8">
        {bareHeader}
        <EmptyState
          icon={Percent}
          title="Företaget är inte momsregistrerat"
          description="Momsdeklarationen bygger på företagets skatteinställningar. Om företaget är momsregistrerat anger du momsregistrering och redovisningsperiod i inställningarna, så visas deklarationen här."
          actionLabel="Öppna skatteinställningar"
          actionHref="/settings/tax"
        />
      </div>
    )
  }

  // Registered but no redovisningsperiod picked: block instead of guessing.
  // A declaration rendered (and submittable via panelen) for the wrong
  // period type is a compliance hazard, not a convenience. But the answer is
  // collected HERE, inline: until it exists the deadline engine generates no
  // VAT deadlines at all (silently), so bouncing the user to settings left a
  // compliance hole open longer than it needed to be. When vat_number is ALSO
  // missing, the inline save would 400 on the vat_number coherence rule in
  // PUT /api/settings (momsregistrerad requires a registreringsnummer), so
  // that (rarer) state keeps the settings bounce, which has both fields.
  if (momsPeriodMissing) {
    if (!settings?.vat_number) {
      return (
        <div className="space-y-8">
          {bareHeader}
          <EmptyState
            icon={Percent}
            title="Redovisningsperiod för moms saknas"
            description="Företaget är momsregistrerat men momsregistreringsnummer och redovisningsperiod (månad, kvartal eller helår) saknas. Ange dem i skatteinställningarna så visas deklarationen för rätt period."
            actionLabel="Öppna skatteinställningar"
            actionHref="/settings/tax"
          />
        </div>
      )
    }
    return (
      <div className="space-y-8">
        {bareHeader}
        <EmptyState
          icon={Percent}
          title="Välj redovisningsperiod för moms"
          description="Företaget är momsregistrerat men ingen redovisningsperiod är vald, så deklarationen och momsdeadlines kan inte visas. Perioden står i registreringsbeslutet från Skatteverket."
        >
          <div className="space-y-3">
            <MomsPeriodInlineSetup
              onSaved={async (value) => {
                await refetchSettings()
                // The first-settle seeding above only runs once per company,
                // so re-apply the fresh periodicity (and its most-recent-
                // ended default period) by hand.
                handlePeriodTypeChange(value)
              }}
            />
            <p className="text-xs text-muted-foreground">
              Du kan alltid ändra den i{' '}
              <Link href="/settings/tax" className="underline underline-offset-2 hover:text-foreground">
                skatteinställningarna
              </Link>
              .
            </p>
          </div>
        </EmptyState>
      </div>
    )
  }

  // Year and concrete period fused into ONE chip: reverse-chronological
  // "Kvartal 2 2026", "Kvartal 1 2026", ... across the last five years, so
  // switching period never needs two pickers. Yearly keeps the FyPicker,
  // which is already a fused räkenskapsår chip.
  const fusedPeriodItems: { id: string; label: string; annotation?: string }[] = []
  if (!isYearly) {
    for (let y = currentYear; y > currentYear - 5; y--) {
      if (periodType === 'quarterly') {
        for (let q = 4; q >= 1; q--) {
          fusedPeriodItems.push({
            id: `${y}:${q}`,
            label: `Kvartal ${q} ${y}`,
            annotation: QUARTER_SPANS[q - 1],
          })
        }
      } else {
        for (let m = 12; m >= 1; m--) {
          fusedPeriodItems.push({ id: `${y}:${m}`, label: `${MONTH_NAMES[m - 1]} ${y}` })
        }
      }
    }
  }
  const fusedLabel =
    periodType === 'quarterly' ? `Kvartal ${period} ${year}` : `${MONTH_NAMES[period - 1]} ${year}`

  return (
    <VatDrillContext.Provider value={{ fiscalPeriodId: isYearly ? fiscalPeriodId : undefined }}>
    <div className="space-y-8">
      {/* Standalone page: the title row carries the primary action (locked
          convention 9), so Exportera sits beside the H1 and the period chips
          get their own row below. XML and PDF live in "Lämna in": they are
          filing artifacts, not report exports. */}
      {pageTitle && (
        <PageHeader
          title={pageTitle}
          action={
            <ReportExportMenu
              variant="default"
              items={[
                { format: 'xlsx', href: `/api/reports/vat-declaration/xlsx?${vatQueryString()}` },
              ]}
            />
          }
        />
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
              {/* Cadence lives behind a settings-style "Period" chip: the
                  concrete period chip next to it already shows the cadence
                  ("Kvartal 2" implies quarterly, "Räkenskapsår ..." yearly). */}
              <ContextPicker
                items={[
                  { id: 'monthly', label: 'Månadsvis' },
                  { id: 'quarterly', label: 'Kvartalsvis' },
                  { id: 'yearly', label: 'Årsvis' },
                ]}
                value={periodType}
                onChange={(value) => handlePeriodTypeChange(value as VatPeriodType)}
                triggerLabel="Period"
                ariaLabel="Periodicitet"
              />
            {isYearly ? (
              // Annual VAT covers a räkenskapsår: picked here, not a
              // calendar year.
              <FyPicker
                value={fiscalPeriodId || null}
                onChange={(id, fp) => {
                  setFiscalPeriodId(id || '')
                  setFiscalPeriodEnd(fp?.period_end ?? null)
                }}
                includeAllOption={false}
                hideFuturePeriods
                preferLatestEnded
              />
            ) : (
              <ContextPicker
                items={fusedPeriodItems}
                value={`${year}:${period}`}
                onChange={(id) => {
                  const [y, p] = id.split(':').map(Number)
                  setYear(y)
                  setPeriod(p)
                }}
                triggerLabel={fusedLabel}
                ariaLabel="Redovisningsperiod"
              />
            )}
            {!pageTitle && (
              <ReportExportMenu
                variant="default"
                items={[
                  { format: 'xlsx', href: `/api/reports/vat-declaration/xlsx?${vatQueryString()}` },
                ]}
              />
            )}
      </div>

      {error && (
        <Card>
          <CardContent className="flex flex-col items-center p-8 text-center">
            <AlertCircle className="mb-2 h-6 w-6 text-destructive" />
            <p className="mb-4 text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={() => setRetryKey((k) => k + 1)}>
              Försök igen
            </Button>
          </CardContent>
        </Card>
      )}

      {!error && (awaitingFiscalPeriod || (loading && !data)) && (
        <Card>
          <CardContent className="p-6 space-y-4">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-64" />
          </CardContent>
        </Card>
      )}

      {data && !awaitingFiscalPeriod && (
        <div
          className={`space-y-8 transition-opacity duration-150 ${loading ? 'opacity-60' : ''}`}
        >
          {settlement.booked && (
            <VatAlreadyBookedBanner
              entry={settlement.booked}
              deadlineCompleted={deadlineCompleted}
            />
          )}

          {/* Stegen (concept): the filing pipeline as a horizontal stepper —
              kontrollera, granska, bokför, lämna in — showing one step's
              content at a time. Errors land on step 1, otherwise Granska. */}
          <VatStepper
            active={activeStep}
            onSelect={setChosenStep}
            errorCount={errorCount}
            warningCount={warningCount}
            ruta49={data.rutor.ruta49}
            bookingStatus={bookingStatus}
          />

          {activeStep === 1 && (
            <section className="mx-auto max-w-3xl space-y-3">
              <VatChecksCard
              checks={checks}
              periodType={periodType}
              year={year}
              period={period}
              fiscalPeriodId={isYearly ? fiscalPeriodId : undefined}
              onCorrected={() => setRetryKey((k) => k + 1)}
            />
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setChosenStep(2)}>
                  Nästa: Granska deklarationen →
                </Button>
              </div>
            </section>
          )}

          {activeStep === 2 && (
            <section className="space-y-3">
              <div className="mx-auto max-w-2xl">
            <div className="flex flex-wrap items-baseline justify-between gap-3 px-1">
              <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Momsdeklaration · {data.period.start} till {data.period.end}
              </h3>
              <span className="text-[11.5px] tabular-nums text-muted-foreground">
                {data.invoiceCount} fakturor · {data.transactionCount} transaktioner
              </span>
            </div>
            <div className="mt-4 space-y-8">
              <div>
                {/* Utgående moms */}
                <div>
                  <h3 className="mb-3 font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Utgående moms (försäljning)
                  </h3>
                  <Table>
                    <TableBody>
                      {data.rutor.ruta05 > 0 && (
                        <VatRutaRow
                          ruta="05"
                          label="Momspliktig försäljning"
                          amount={data.rutor.ruta05}
                          baseAmount={0}
                          periodType={periodType}
                          year={year}
                          period={period}
                        />
                      )}
                      <VatRutaRow
                        ruta="10"
                        label="Utgående moms 25%"
                        amount={data.rutor.ruta10}
                        baseAmount={data.breakdown.invoices.base25}
                        periodType={periodType}
                        year={year}
                        period={period}
                      />
                      <VatRutaRow
                        ruta="11"
                        label="Utgående moms 12%"
                        amount={data.rutor.ruta11}
                        baseAmount={data.breakdown.invoices.base12}
                        periodType={periodType}
                        year={year}
                        period={period}
                      />
                      <VatRutaRow
                        ruta="12"
                        label="Utgående moms 6%"
                        amount={data.rutor.ruta12}
                        baseAmount={data.breakdown.invoices.base6}
                        periodType={periodType}
                        year={year}
                        period={period}
                      />
                      <VatRutaRow
                        ruta="39"
                        label="Tjänster EU (omvänd skattskyldighet)"
                        amount={0}
                        baseAmount={data.rutor.ruta39}
                        noVat
                        periodType={periodType}
                        year={year}
                        period={period}
                      />
                      <VatRutaRow
                        ruta="40"
                        label="Export utanför EU"
                        amount={0}
                        baseAmount={data.rutor.ruta40}
                        noVat
                        periodType={periodType}
                        year={year}
                        period={period}
                      />
                    </TableBody>
                    <tfoot>
                      <tr className="border-t font-medium">
                        <td className="py-2">Summa utgående moms</td>
                        <td className="py-2 text-right tabular-nums">
                          {formatAmount(
                            data.rutor.ruta10 + data.rutor.ruta11 + data.rutor.ruta12 +
                            data.rutor.ruta30 + data.rutor.ruta31 + data.rutor.ruta32 +
                            data.rutor.ruta60 + data.rutor.ruta61 + data.rutor.ruta62
                          )} kr
                        </td>
                      </tr>
                    </tfoot>
                  </Table>

                  {/* Omvänd skattskyldighet (inköp) */}
                  {(data.rutor.ruta20 > 0 || data.rutor.ruta21 > 0 || data.rutor.ruta22 > 0 || data.rutor.ruta23 > 0 || data.rutor.ruta24 > 0 ||
                    data.rutor.ruta30 > 0 || data.rutor.ruta31 > 0 || data.rutor.ruta32 > 0) && (
                    <>
                      <h3 className="mb-3 mt-6 font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Omvänd skattskyldighet (inköp)
                      </h3>
                      <Table>
                        <TableBody>
                          <VatRutaRow ruta="20" label="Inköp av varor från annat EU-land" amount={0} baseAmount={data.rutor.ruta20} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="21" label="Inköp av tjänster från annat EU-land" amount={0} baseAmount={data.rutor.ruta21} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="22" label="Inköp av tjänster utanför EU" amount={0} baseAmount={data.rutor.ruta22} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="23" label="Inköp av varor i Sverige" amount={0} baseAmount={data.rutor.ruta23} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="24" label="Övriga inköp av tjänster i Sverige" amount={0} baseAmount={data.rutor.ruta24} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="30" label="Utgående moms 25% (omvänd)" amount={data.rutor.ruta30} baseAmount={0} periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="31" label="Utgående moms 12% (omvänd)" amount={data.rutor.ruta31} baseAmount={0} periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="32" label="Utgående moms 6% (omvänd)" amount={data.rutor.ruta32} baseAmount={0} periodType={periodType} year={year} period={period} />
                        </TableBody>
                      </Table>
                    </>
                  )}

                  {/* Moms vid import */}
                  {(data.rutor.ruta50 > 0 || data.rutor.ruta60 > 0 || data.rutor.ruta61 > 0 || data.rutor.ruta62 > 0) && (
                    <>
                      <h3 className="mb-3 mt-6 font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Moms vid import
                      </h3>
                      <Table>
                        <TableBody>
                          <VatRutaRow ruta="50" label="Beskattningsunderlag vid import" amount={0} baseAmount={data.rutor.ruta50} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="60" label="Utgående moms 25% import" amount={data.rutor.ruta60} baseAmount={0} periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="61" label="Utgående moms 12% import" amount={data.rutor.ruta61} baseAmount={0} periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="62" label="Utgående moms 6% import" amount={data.rutor.ruta62} baseAmount={0} periodType={periodType} year={year} period={period} />
                        </TableBody>
                      </Table>
                    </>
                  )}
                </div>
              </div>
              <div>
                {/* Ingående moms */}
                <div>
                  <h3 className="mb-3 font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Ingående moms (avdragsgill)
                  </h3>
                  <Table>
                    <TableBody>
                      <VatRutaRow
                        ruta="48"
                        label="Ingående moms att dra av"
                        amount={data.rutor.ruta48}
                        baseAmount={0}
                        periodType={periodType}
                        year={year}
                        period={period}
                      />
                      {data.breakdown.transactions.ruta48 > 0 && (
                        <tr className="text-muted-foreground">
                          <td className="py-1 pl-6 text-xs">- från transaktioner</td>
                          <td className="py-1 text-right text-xs">
                            {formatAmount(data.breakdown.transactions.ruta48)} kr
                          </td>
                        </tr>
                      )}
                      {data.breakdown.receipts.ruta48 > 0 && (
                        <tr className="text-muted-foreground">
                          <td className="py-1 pl-6 text-xs">- från kvitton</td>
                          <td className="py-1 text-right text-xs">
                            {formatAmount(data.breakdown.receipts.ruta48)} kr
                          </td>
                        </tr>
                      )}
                    </TableBody>
                    <tfoot>
                      <tr className="border-t font-medium">
                        <td className="py-2">Summa ingående moms</td>
                        <td className="py-2 text-right tabular-nums">{formatAmount(data.rutor.ruta48)} kr</td>
                      </tr>
                    </tfoot>
                  </Table>
                </div>
              </div>
            </div>

            {/* Ruta 49 as the emphasized document foot (concept skv-foot). */}
            <div className="mt-8 flex items-baseline gap-3 border-t-2 border-foreground/80 pt-3">
              <span className="font-mono text-xs text-muted-foreground">49</span>
              <span className="flex-1 text-sm font-medium">
                {data.rutor.ruta49 >= 0 ? 'Moms att betala' : 'Moms att återfå'}
              </span>
              <span className="text-sm font-semibold tabular-nums">
                {formatAmount(Math.abs(data.rutor.ruta49))} kr
              </span>
            </div>
          </div>
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setChosenStep(3)}>
                  Nästa: Bokför momsen →
                </Button>
              </div>
            </section>
          )}

          {activeStep === 3 && (
            <section className="mx-auto max-w-3xl space-y-3">
              <VatBookingCard
              checksBlocked={checksBlocked}
              proposal={settlement.proposal}
              failed={settlement.failed}
              upToDate={settlement.upToDate}
              booked={settlement.booked}
              draft={settlement.draft}
              onRetry={() => setSettlementRefreshKey((k) => k + 1)}
            />
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setChosenStep(4)}>
                  Nästa: Lämna in →
                </Button>
              </div>
            </section>
          )}

          {activeStep === 4 && (
            <section className="mx-auto max-w-3xl space-y-8">
              <SkatteverketPanel
                periodType={periodType}
                year={year}
                period={period}
                fiscalPeriodId={isYearly ? fiscalPeriodId : undefined}
                fiscalYearEnd={
                  isYearly && fiscalPeriodEnd
                    ? {
                        year: Number(fiscalPeriodEnd.slice(0, 4)),
                        month: Number(fiscalPeriodEnd.slice(5, 7)),
                      }
                    : undefined
                }
                hasData={data !== null}
                localBlocked={checksBlocked}
              />
              <VatManualFilingCard
              xmlHref={`/api/reports/vat-declaration/eskd?${vatQueryString()}`}
              pdfHref={`/api/reports/vat-declaration/pdf?${vatQueryString()}`}
            />
            </section>
          )}
        </div>
      )}

      {/* Skatteverket integration panel for the no-data states (fetch error,
          empty period): with data it lives inside steg 4. Hidden while the
          räkenskapsår for helårsmoms is unresolved, so its actions can never
          target an unconfirmed period. */}
      {!awaitingFiscalPeriod && !data && (
        <SkatteverketPanel
          periodType={periodType}
          year={year}
          period={period}
          fiscalPeriodId={isYearly ? fiscalPeriodId : undefined}
          fiscalYearEnd={
            isYearly && fiscalPeriodEnd
              ? {
                  year: Number(fiscalPeriodEnd.slice(0, 4)),
                  month: Number(fiscalPeriodEnd.slice(5, 7)),
                }
              : undefined
          }
          hasData={data !== null}
          localBlocked={checksBlocked}
        />
      )}
    </div>
    </VatDrillContext.Provider>
  )
}

function makeVatFetcher(
  ruta: string,
  periodType: VatPeriodType,
  year: number,
  period: number,
  fiscalPeriodId?: string,
): ReportSourceFetcher {
  return async () => {
    const params = new URLSearchParams({
      periodType,
      year: String(year),
      period: String(period),
    })
    // Yearly drill-down resolves against the räkenskapsår, matching the report.
    if (periodType === 'yearly' && fiscalPeriodId) {
      params.set('fiscal_period_id', fiscalPeriodId)
    }
    const res = await fetch(
      `/api/reports/vat-declaration/ruta/${encodeURIComponent(ruta)}/sources?${params.toString()}`
    )
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || 'Kunde inte hämta verifikat')
    const lines: ReportSourceLine[] = json.data?.lines || []
    return { lines, next_cursor: json.data?.next_cursor ?? null }
  }
}

function VatRutaRow({
  ruta,
  label,
  amount,
  baseAmount,
  noVat,
  periodType,
  year,
  period,
}: {
  ruta: string
  label: string
  amount: number
  baseAmount: number
  noVat?: boolean
  periodType?: VatPeriodType
  year?: number
  period?: number
}) {
  const { fiscalPeriodId } = React.useContext(VatDrillContext)
  const canDrill = periodType !== undefined && year !== undefined && period !== undefined
  const fetcher = React.useMemo(
    () => (canDrill ? makeVatFetcher(ruta, periodType!, year!, period!, fiscalPeriodId) : null),
    [canDrill, ruta, periodType, year, period, fiscalPeriodId]
  )
  // Hooks must be called unconditionally: provide a noop fetcher when drill
  // is disabled. The early-return for zero rows lives below the hooks.
  const expansion = useReportRowExpansion(
    fetcher ?? (async () => ({ lines: [], next_cursor: null })),
    `vat-${ruta}`
  )

  // Don't show rows with zero values
  if (baseAmount === 0 && amount === 0) return null

  return (
    <>
      <tr className="border-b">
        <td className="py-2">
          {canDrill && (
            <span className="inline-block align-middle mr-1">
              <expansion.Toggle />
            </span>
          )}
          <span className="font-mono text-xs bg-muted px-1 rounded-sm mr-2">{ruta}</span>
          {label}
        </td>
        <td className="py-2 text-right tabular-nums">{noVat ? `${formatAmount(baseAmount)} kr` : `${formatAmount(amount)} kr`}</td>
      </tr>
      {!noVat && baseAmount > 0 && (
        <tr className="text-muted-foreground">
          <td className="py-1 pl-6 text-xs">Underlag</td>
          <td className="py-1 text-right text-xs tabular-nums">{formatAmount(baseAmount)} kr</td>
        </tr>
      )}
      {canDrill && <expansion.Panel colSpan={2} />}
    </>
  )
}

interface SupplierLedgerData {
  ledger: {
    entries: {
      supplier_id: string
      supplier_name: string
      current: number
      days_1_30: number
      days_31_60: number
      days_61_90: number
      days_90_plus: number
      total_outstanding: number
    }[]
    total_outstanding: number
    total_current: number
    total_overdue: number
    unpaid_count: number
    unconverted_fx_count: number
  }
  reconciliation: {
    supplier_ledger_total: number
    account_2440_balance: number
    difference: number
    is_reconciled: boolean
    unconverted_fx_count: number
  } | null
}

// Local calendar date (YYYY-MM-DD) for the reskontra "per datum" default:
// toISOString() is UTC and rolls the date over an hour early in Sweden.
function localIsoDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// Shared "Per datum" control + export menu header for the two reskontra views
// (#1020/#1021): pick an arbitrary as-of date and export PDF/Excel for it.
function ReskontraToolbar({
  asOfDate,
  onAsOfDateChange,
  inputId,
  exportBase,
}: {
  asOfDate: string
  onAsOfDateChange: (date: string) => void
  inputId: string
  exportBase: string
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <Label htmlFor={inputId} className="text-xs text-muted-foreground">
          Per datum
        </Label>
        <Input
          id={inputId}
          type="date"
          value={asOfDate}
          onChange={(e) => {
            if (e.target.value) onAsOfDateChange(e.target.value)
          }}
          className="w-40"
        />
      </div>
      <ReportExportMenu
        items={[
          { format: 'pdf', href: `${exportBase}/pdf?as_of_date=${asOfDate}` },
          { format: 'xlsx', href: `${exportBase}/xlsx?as_of_date=${asOfDate}` },
        ]}
      />
    </div>
  )
}

export function SupplierLedgerView({ periodId }: { periodId: string }) {
  const [data, setData] = useState<SupplierLedgerData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asOfDate, setAsOfDate] = useState(localIsoDate)

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/reports/supplier-ledger?period_id=${periodId}&as_of_date=${asOfDate}`)
      const result = await res.json()
      if (result.error) {
        // Envelope object, not a string: see the note on the other report
        // fetches. Rendering it bare blanks the page.
        setError(getErrorMessage(result))
      } else {
        setData(result.data)
      }
    } catch {
      setError('Kunde inte hämta leverantörsreskontra')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (periodId) fetchData()
  }, [periodId, asOfDate])

  if (loading) {
    return <ReportLoadingCard />
  }

  if (error) {
    return <ReportErrorCard message={error} />
  }

  if (!data || !data.ledger) {
    return (
      <ReportEmptyState
        title="Ingen leverantörsreskontra"
        description="Det finns inga leverantörsfakturor att visa för den valda perioden."
      />
    )
  }

  const { ledger, reconciliation } = data

  return (
    <div className="space-y-4">
      <ReskontraToolbar
        asOfDate={asOfDate}
        onAsOfDateChange={setAsOfDate}
        inputId="supplier-ledger-as-of"
        exportBase="/api/reports/supplier-ledger"
      />
      {/* Summary cards */}
      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Totalt utestående</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl tabular-nums">{formatAmount(ledger.total_outstanding)} kr</p>
            <p className="text-xs text-muted-foreground">{ledger.unpaid_count} fakturor</p>
            {ledger.unconverted_fx_count > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {ledger.unconverted_fx_count} faktura i utländsk valuta utan växelkurs är inte med i totalen.
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Ej förfallet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl tabular-nums text-success">{formatAmount(ledger.total_current)} kr</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Förfallet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl tabular-nums text-destructive">{formatAmount(ledger.total_overdue)} kr</p>
          </CardContent>
        </Card>
      </div>

      {/* Aging table */}
      {ledger.entries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Ålderfördelning per leverantör</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto -mx-2 px-2"><table className="w-full text-sm min-w-[500px]">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-2 w-8"></th>
                  <th className="py-2">Leverantör</th>
                  <th className="py-2 text-right">Ej förfallet</th>
                  <th className="py-2 text-right">1-30 dagar</th>
                  <th className="py-2 text-right">31-60 dagar</th>
                  <th className="py-2 text-right">61-90 dagar</th>
                  <th className="py-2 text-right">90+ dagar</th>
                  <th className="py-2 text-right font-semibold">Totalt</th>
                </tr>
              </thead>
              <tbody>
                {ledger.entries.map((entry) => (
                  <SupplierLedgerRow key={entry.supplier_id} entry={entry} />
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold border-t-2">
                  <td className="py-2"></td>
                  <td className="py-2">Summa</td>
                  <td className="py-2 text-right">{formatAmount(ledger.entries.reduce((s, e) => s + e.current, 0))}</td>
                  <td className="py-2 text-right">{formatAmount(ledger.entries.reduce((s, e) => s + e.days_1_30, 0))}</td>
                  <td className="py-2 text-right">{formatAmount(ledger.entries.reduce((s, e) => s + e.days_31_60, 0))}</td>
                  <td className="py-2 text-right">{formatAmount(ledger.entries.reduce((s, e) => s + e.days_61_90, 0))}</td>
                  <td className="py-2 text-right text-destructive">{formatAmount(ledger.entries.reduce((s, e) => s + e.days_90_plus, 0))}</td>
                  <td className="py-2 text-right">{formatAmount(ledger.total_outstanding)}</td>
                </tr>
              </tfoot>
            </table></div>
          </CardContent>
        </Card>
      )}

      {/* Reconciliation */}
      {reconciliation && (
        <Card>
          <CardHeader>
            <CardTitle>Avstämning mot <AccountNumber number="2440" /></CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Leverantörsreskontra (summa utestående)</span>
                <span className="tabular-nums">{formatAmount(reconciliation.supplier_ledger_total)} kr</span>
              </div>
              <div className="flex justify-between">
                <span><AccountNumber number="2440" /> saldo (huvudbok)</span>
                <span className="tabular-nums">{formatAmount(reconciliation.account_2440_balance)} kr</span>
              </div>
              <div className="flex justify-between pt-2 border-t font-semibold">
                <span>Differens</span>
                <span className={`tabular-nums ${reconciliation.is_reconciled ? 'text-success' : 'text-destructive'}`}>
                  {formatAmount(reconciliation.difference)} kr
                </span>
              </div>
              <div className="pt-2 space-y-2">
                {reconciliation.is_reconciled ? (
                  <span className="text-sm text-muted-foreground">Avstämd</span>
                ) : (
                  <Badge variant="destructive">Ej avstämd - kontrollera bokföring</Badge>
                )}
                {reconciliation.unconverted_fx_count > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {reconciliation.unconverted_fx_count} leverantörsfaktura i utländsk valuta saknar växelkurs: differensen kan bero på saknade kursuppgifter snarare än felbokning.
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function makeSupplierFetcher(supplierId: string): ReportSourceFetcher {
  return async () => {
    const res = await fetch(
      `/api/reports/supplier-ledger/supplier/${encodeURIComponent(supplierId)}/invoices`
    )
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || 'Kunde inte hämta leverantörsfakturor')
    const lines: ReportSourceLine[] = json.data?.lines || []
    return { lines, next_cursor: json.data?.next_cursor ?? null }
  }
}

function SupplierLedgerRow({
  entry,
}: {
  entry: {
    supplier_id: string
    supplier_name: string
    current: number
    days_1_30: number
    days_31_60: number
    days_61_90: number
    days_90_plus: number
    total_outstanding: number
  }
}) {
  const fetcher = React.useMemo(
    () => makeSupplierFetcher(entry.supplier_id),
    [entry.supplier_id]
  )
  const { Toggle, Panel } = useReportRowExpansion(fetcher, `sup-${entry.supplier_id}`)
  return (
    <>
      <tr className="border-b last:border-0 hover:bg-muted/30 transition-colors">
        <td className="py-2"><Toggle /></td>
        <td className="py-2">{entry.supplier_name}</td>
        <td className="py-2 text-right tabular-nums">{entry.current > 0 ? formatAmount(entry.current) : ''}</td>
        <td className="py-2 text-right tabular-nums">{entry.days_1_30 > 0 ? formatAmount(entry.days_1_30) : ''}</td>
        <td className="py-2 text-right tabular-nums">{entry.days_31_60 > 0 ? formatAmount(entry.days_31_60) : ''}</td>
        <td className="py-2 text-right tabular-nums">{entry.days_61_90 > 0 ? formatAmount(entry.days_61_90) : ''}</td>
        <td className="py-2 text-right tabular-nums text-destructive">{entry.days_90_plus > 0 ? formatAmount(entry.days_90_plus) : ''}</td>
        <td className="py-2 text-right tabular-nums font-semibold">{formatAmount(entry.total_outstanding)}</td>
      </tr>
      <Panel colSpan={8} />
    </>
  )
}

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

export function GeneralLedgerView({ periodId, initialAccountFilter, dimensionFilter = null, dateRange = EMPTY_DATE_RANGE }: { periodId: string; initialAccountFilter: string | null; dimensionFilter?: DimensionFilterValue | null; dateRange?: DateRangeValue }) {
  const [data, setData] = useState<GeneralLedgerData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [accountFrom, setAccountFrom] = useState('')
  const [accountTo, setAccountTo] = useState('')

  const fetchData = useCallback(async (fromOverride?: string, toOverride?: string) => {
    const from = fromOverride ?? accountFrom
    const to = toOverride ?? accountTo
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ period_id: periodId })
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
      if (result.error) {
        // Envelope object, not a string: see the note on the other report
        // fetches. Rendering it bare blanks the page.
        setError(getErrorMessage(result))
      } else {
        setData(result.data)
      }
    } catch {
      setError('Kunde inte hämta huvudbok')
    } finally {
      setLoading(false)
    }
  }, [periodId, accountFrom, accountTo, dimensionFilter, dateRange])

  // When initialAccountFilter changes (drill-down from another report), apply it
  useEffect(() => {
    if (initialAccountFilter) {
      setAccountFrom(initialAccountFilter)
      setAccountTo(initialAccountFilter)
      fetchData(initialAccountFilter, initialAccountFilter)
    } else {
      fetchData()
    }
  }, [periodId, initialAccountFilter, dimensionFilter, dateRange])

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
      {/* Account range filter: flat toolbar on the panel, no box */}
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label htmlFor="gl-account-from">Konto från</Label>
          <Input
            id="gl-account-from"
            type="text"
            value={accountFrom}
            onChange={(e) => setAccountFrom(e.target.value)}
            placeholder="t.ex. 1510"
            className="mt-1 w-32"
          />
        </div>
        <div>
          <Label htmlFor="gl-account-to">Konto till</Label>
          <Input
            id="gl-account-to"
            type="text"
            value={accountTo}
            onChange={(e) => setAccountTo(e.target.value)}
            placeholder="t.ex. 1519"
            className="mt-1 w-32"
          />
        </div>
        <Button onClick={() => fetchData()} variant="outline">
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

// --- Journal Register (Grundbok) ---

interface JournalRegisterData {
  entries: {
    voucher_series: string
    voucher_number: number
    date: string
    description: string
    source_type: string
    status: string
    lines: {
      account_number: string
      account_name: string
      debit: number
      credit: number
    }[]
    total_debit: number
    total_credit: number
  }[]
  total_entries: number
  total_debit: number
  total_credit: number
  period: { start: string; end: string }
}

export function JournalRegisterView({ periodId }: { periodId: string }) {
  const [data, setData] = useState<JournalRegisterData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedEntries, setExpandedEntries] = useState<Set<number>>(new Set())

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    setExpandedEntries(new Set())
    try {
      const res = await fetch(`/api/reports/journal-register?period_id=${periodId}`)
      const result = await res.json()
      if (result.error) {
        // Envelope object, not a string: see the note on the other report
        // fetches. Rendering it bare blanks the page.
        setError(getErrorMessage(result))
      } else {
        setData(result.data)
      }
    } catch {
      setError('Kunde inte hämta grundbok')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (periodId) fetchData()
  }, [periodId])

  const toggleEntry = (index: number) => {
    setExpandedEntries((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  if (loading) {
    return <ReportLoadingCard />
  }

  if (error) {
    return <ReportErrorCard message={error} />
  }

  if (!data || data.entries.length === 0) {
    return (
      <ReportEmptyState
        title="Inga verifikationer i perioden"
        description="Det finns inga bokförda verifikationer i den valda perioden."
      />
    )
  }

  return (
    <div className="space-y-4">
      <ReportExportMenu items={[{ format: 'xlsx', href: `/api/reports/journal-register/xlsx?period_id=${periodId}` }]} />
      {data.period.start && (
        <p className="text-sm text-muted-foreground tabular-nums">
          Period {data.period.start} till {data.period.end} · {data.total_entries} verifikationer
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Grundbok (registreringsordning)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto -mx-2 px-2"><table className="w-full text-sm min-w-[500px]">
            <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
              <tr className="border-b text-left">
                <th className="py-2 w-8"></th>
                <th className="py-2 w-16">Ver.nr</th>
                <th className="py-2 w-24">Datum</th>
                <th className="py-2">Beskrivning</th>
                <th className="py-2 w-24">Typ</th>
                <th className="py-2 w-24 text-right">Debet</th>
                <th className="py-2 w-24 text-right">Kredit</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry, index) => {
                const isExpanded = expandedEntries.has(index)
                const isReversed = entry.status === 'reversed'

                return (
                  <React.Fragment key={index}>
                    <tr
                      className={`border-b cursor-pointer hover:bg-muted/50 ${isReversed ? 'line-through opacity-60' : ''}`}
                      onClick={() => toggleEntry(index)}
                    >
                      <td className="py-2">
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </td>
                      <td className="py-2 font-mono text-xs">
                        {formatVoucher(entry)}
                      </td>
                      <td className="py-2">{formatDate(entry.date)}</td>
                      <td className="py-2">
                        {entry.description}
                        {isReversed && (
                          <Badge variant="outline" className="ml-2 text-xs">Makulerad</Badge>
                        )}
                      </td>
                      <td className="py-2 text-xs text-muted-foreground">{entry.source_type}</td>
                      <td className="py-2 text-right tabular-nums">{formatAmount(entry.total_debit)}</td>
                      <td className="py-2 text-right tabular-nums">{formatAmount(entry.total_credit)}</td>
                    </tr>
                    {isExpanded && entry.lines.map((line, lineIndex) => (
                      <tr key={`${index}-${lineIndex}`} className="bg-muted/30 border-b last:border-0">
                        <td></td>
                        <td></td>
                        <td className="py-1"><AccountNumber number={line.account_number} name={line.account_name} size="sm" /></td>
                        <td className="py-1 text-muted-foreground">{line.account_name}</td>
                        <td></td>
                        <td className="py-1 text-right">
                          {line.debit > 0 ? formatAmount(line.debit) : ''}
                        </td>
                        <td className="py-1 text-right">
                          {line.credit > 0 ? formatAmount(line.credit) : ''}
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="font-semibold border-t-2">
                <td colSpan={5} className="py-2">Summa</td>
                <td className="py-2 text-right">{formatAmount(data.total_debit)}</td>
                <td className="py-2 text-right">{formatAmount(data.total_credit)}</td>
              </tr>
            </tfoot>
          </table></div>
        </CardContent>
      </Card>
    </div>
  )
}

// --- AR Ledger (Kundreskontra) ---

interface ARLedgerData {
  ledger: {
    entries: {
      customer_id: string
      customer_name: string
      invoices: {
        invoice_id: string
        invoice_number: string
        invoice_date: string
        due_date: string
        total: number
        paid_amount: number
        outstanding: number
        outstanding_sek: number | null
        days_overdue: number
        currency: string
      }[]
      current: number
      days_1_30: number
      days_31_60: number
      days_61_90: number
      days_90_plus: number
      total_outstanding: number
    }[]
    total_outstanding: number
    total_current: number
    total_overdue: number
    unpaid_count: number
    unconverted_fx_count: number
    register_coverage?: {
      covers_from: string | null
      has_pre_register_invoices: boolean
    }
  }
  reconciliation: {
    ar_ledger_total: number
    account_1510_balance: number
    difference: number
    is_reconciled: boolean
    unconverted_fx_count: number
    pre_register_ar_in_period?: boolean
  } | null
}

// Inner expansion row component for AR ledger.
// Fetches per-customer invoices (with journal_entry_id) and renders each as a
// link to /bookkeeping/[id] when posted, /invoices/[id] when still draft.
function ARCustomerInvoiceRows({
  customerId,
  invoices,
}: {
  customerId: string
  invoices: {
    invoice_id: string
    invoice_number: string
    invoice_date: string
    due_date: string
    total: number
    paid_amount: number
    outstanding: number
    outstanding_sek: number | null
    days_overdue: number
    currency: string
  }[]
}) {
  // ARCustomerInvoiceRows is mounted lazily: only when a customer is
  // expanded, so initial state matches "still loading" and resets on
  // unmount. No synchronous setState in the effect is needed.
  const [enriched, setEnriched] = useState<Record<string, { journal_entry_id: string; voucher_series: string; voucher_number: number } | undefined>>({})
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/reports/ar-ledger/customer/${encodeURIComponent(customerId)}/invoices`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return
        const map: typeof enriched = {}
        for (const line of json.data?.lines || []) {
          if (line.invoice_id && line.journal_entry_id) {
            map[line.invoice_id] = {
              journal_entry_id: line.journal_entry_id,
              voucher_series: line.voucher_series,
              voucher_number: line.voucher_number,
            }
          }
        }
        setEnriched(map)
      })
      .catch(() => { /* fail silently; rows still render without verifikat link */ })
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [customerId])
  const loading = !loaded

  return (
    <>
      {invoices.map((inv) => {
        const entry = enriched[inv.invoice_id]
        const targetHref = entry?.journal_entry_id
          ? `/bookkeeping/${entry.journal_entry_id}`
          : `/invoices/${inv.invoice_id}`
        return (
          <tr key={inv.invoice_id} className="bg-muted/30 border-b last:border-0">
            <td></td>
            <td className="py-1 text-xs" colSpan={2}>
              <Link href={targetHref} className="font-mono hover:underline underline-offset-4">
                {inv.invoice_number || '(utkast)'}
              </Link>
              {entry && (
                <span className="ml-2 text-muted-foreground font-mono">
                  {formatVoucher(entry)}
                </span>
              )}
              <span className="text-muted-foreground ml-2 tabular-nums">{formatDate(inv.invoice_date)}</span>
              <span className="text-muted-foreground ml-2 tabular-nums">förfaller {formatDate(inv.due_date)}</span>
            </td>
            <td className="py-1 text-right text-xs text-muted-foreground" colSpan={2}>
              {inv.days_overdue > 0 ? `${inv.days_overdue} dagar förfallen` : 'Ej förfallen'}
            </td>
            <td className="py-1 text-right text-xs text-muted-foreground">
              {inv.paid_amount > 0 ? `Betalt: ${formatAmount(inv.paid_amount)} ${inv.currency}` : ''}
            </td>
            <td></td>
            <td className="py-1 text-right text-xs font-medium tabular-nums">
              {formatAmount(inv.outstanding)} {inv.currency}
            </td>
          </tr>
        )
      })}
      {loading && (
        <tr className="bg-muted/30">
          <td></td>
          <td colSpan={7} className="py-1 text-[10px] text-muted-foreground">Letar verifikat…</td>
        </tr>
      )}
    </>
  )
}

export function ARLedgerView({ periodId }: { periodId: string }) {
  const [data, setData] = useState<ARLedgerData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedCustomers, setExpandedCustomers] = useState<Set<string>>(new Set())
  const [asOfDate, setAsOfDate] = useState(localIsoDate)

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/reports/ar-ledger?period_id=${periodId}&as_of_date=${asOfDate}`)
      const result = await res.json()
      if (result.error) {
        // Envelope object, not a string: see the note on the other report
        // fetches. Rendering it bare blanks the page.
        setError(getErrorMessage(result))
      } else {
        setData(result.data)
      }
    } catch {
      setError('Kunde inte hämta kundreskontra')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (periodId) fetchData()
  }, [periodId, asOfDate])

  const toggleCustomer = (customerId: string) => {
    setExpandedCustomers((prev) => {
      const next = new Set(prev)
      if (next.has(customerId)) {
        next.delete(customerId)
      } else {
        next.add(customerId)
      }
      return next
    })
  }

  if (loading) {
    return <ReportLoadingCard />
  }

  if (error) {
    return <ReportErrorCard message={error} />
  }

  if (!data || !data.ledger) {
    return (
      <ReportEmptyState
        title="Ingen kundreskontra"
        description="Det finns inga kundfakturor att visa för den valda perioden."
      />
    )
  }

  const { ledger, reconciliation } = data

  return (
    <div className="space-y-4">
      <ReskontraToolbar
        asOfDate={asOfDate}
        onAsOfDateChange={setAsOfDate}
        inputId="ar-ledger-as-of"
        exportBase="/api/reports/ar-ledger"
      />
      {/* Summary cards */}
      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Totalt utestående</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl tabular-nums">{formatAmount(ledger.total_outstanding)} kr</p>
            <p className="text-xs text-muted-foreground">{ledger.unpaid_count} fakturor</p>
            {ledger.unconverted_fx_count > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {ledger.unconverted_fx_count} faktura i utländsk valuta utan växelkurs är inte med i totalen.
              </p>
            )}
            {ledger.register_coverage?.has_pre_register_invoices && ledger.register_coverage.covers_from && (
              <p className="mt-1 text-xs text-muted-foreground">
                Fakturor före {formatDate(ledger.register_coverage.covers_from)} kan ligga som bokförda verifikat och ingår inte i reskontran.
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Ej förfallet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl tabular-nums text-success">{formatAmount(ledger.total_current)} kr</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Förfallet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl tabular-nums text-destructive">{formatAmount(ledger.total_overdue)} kr</p>
          </CardContent>
        </Card>
      </div>

      {/* Aging table with expandable invoice details */}
      {ledger.entries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Ålderfördelning per kund</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto -mx-2 px-2"><table className="w-full text-sm min-w-[500px]">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-2 w-8"></th>
                  <th className="py-2">Kund</th>
                  <th className="py-2 text-right">Ej förfallet</th>
                  <th className="py-2 text-right">1-30 dagar</th>
                  <th className="py-2 text-right">31-60 dagar</th>
                  <th className="py-2 text-right">61-90 dagar</th>
                  <th className="py-2 text-right">90+ dagar</th>
                  <th className="py-2 text-right font-semibold">Totalt</th>
                </tr>
              </thead>
              <tbody>
                {ledger.entries.map((entry) => {
                  const isExpanded = expandedCustomers.has(entry.customer_id)
                  return (
                    <React.Fragment key={entry.customer_id}>
                      <tr
                        className="border-b cursor-pointer hover:bg-muted/50"
                        onClick={() => toggleCustomer(entry.customer_id)}
                      >
                        <td className="py-2">
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </td>
                        <td className="py-2">{entry.customer_name}</td>
                        <td className="py-2 text-right">{entry.current > 0 ? formatAmount(entry.current) : ''}</td>
                        <td className="py-2 text-right">{entry.days_1_30 > 0 ? formatAmount(entry.days_1_30) : ''}</td>
                        <td className="py-2 text-right">{entry.days_31_60 > 0 ? formatAmount(entry.days_31_60) : ''}</td>
                        <td className="py-2 text-right">{entry.days_61_90 > 0 ? formatAmount(entry.days_61_90) : ''}</td>
                        <td className="py-2 text-right text-destructive">{entry.days_90_plus > 0 ? formatAmount(entry.days_90_plus) : ''}</td>
                        <td className="py-2 text-right font-semibold">{formatAmount(entry.total_outstanding)}</td>
                      </tr>
                      {isExpanded && (
                        <ARCustomerInvoiceRows
                          customerId={entry.customer_id}
                          invoices={entry.invoices}
                        />
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="font-semibold border-t-2">
                  <td className="py-2"></td>
                  <td className="py-2">Summa</td>
                  <td className="py-2 text-right">{formatAmount(ledger.entries.reduce((s, e) => s + e.current, 0))}</td>
                  <td className="py-2 text-right">{formatAmount(ledger.entries.reduce((s, e) => s + e.days_1_30, 0))}</td>
                  <td className="py-2 text-right">{formatAmount(ledger.entries.reduce((s, e) => s + e.days_31_60, 0))}</td>
                  <td className="py-2 text-right">{formatAmount(ledger.entries.reduce((s, e) => s + e.days_61_90, 0))}</td>
                  <td className="py-2 text-right text-destructive">{formatAmount(ledger.entries.reduce((s, e) => s + e.days_90_plus, 0))}</td>
                  <td className="py-2 text-right">{formatAmount(ledger.total_outstanding)}</td>
                </tr>
              </tfoot>
            </table></div>
          </CardContent>
        </Card>
      )}

      {/* Reconciliation */}
      {reconciliation && (
        <Card>
          <CardHeader>
            <CardTitle>Avstämning mot <AccountNumber number="1510" /></CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Kundreskontra (summa utestående)</span>
                <span className="tabular-nums">{formatAmount(reconciliation.ar_ledger_total)} kr</span>
              </div>
              <div className="flex justify-between">
                <span>Kundfordringar (<AccountNumber number="1510" /> + <AccountNumber number="1513" />) saldo</span>
                <span className="tabular-nums">{formatAmount(reconciliation.account_1510_balance)} kr</span>
              </div>
              <div className="flex justify-between pt-2 border-t font-semibold">
                <span>Differens</span>
                <span className={`tabular-nums ${reconciliation.is_reconciled ? 'text-success' : 'text-destructive'}`}>
                  {formatAmount(reconciliation.difference)} kr
                </span>
              </div>
              <div className="pt-2 space-y-2">
                {reconciliation.is_reconciled ? (
                  <span className="text-sm text-muted-foreground">Avstämd</span>
                ) : (
                  <Badge variant="destructive">Ej avstämd - kontrollera bokföring</Badge>
                )}
                {reconciliation.unconverted_fx_count > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {reconciliation.unconverted_fx_count} kundfaktura i utländsk valuta saknar växelkurs: differensen kan bero på saknade kursuppgifter snarare än felbokning.
                  </p>
                )}
                {/* Only when pre-register AR debits exist IN the reconciled
                    period: prior-period migration history contributes nothing
                    to this period's balance, and offering it as an explanation
                    there would cushion a genuine felbokning. */}
                {!reconciliation.is_reconciled &&
                  reconciliation.pre_register_ar_in_period &&
                  ledger.register_coverage?.covers_from && (
                    <p className="text-xs text-muted-foreground">
                      Perioden innehåller verifikat med kundfordringar före {formatDate(ledger.register_coverage.covers_from)} som inte ligger i fakturaregistret (t.ex. efter en migrering): differensen kan bero på det. Kontrollera huvudboken på <AccountNumber number="1510" /> innan du letar felbokning.
                    </p>
                  )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// --- Resultat per projekt/kostnadsställe (dimension P&L matrix) ---

export function DimensionPnlView({ periodId, dateRange }: { periodId: string; dateRange: DateRangeValue }) {
  // Loading is DERIVED (result key ≠ current query string) instead of a
  // setState at effect start: keeps react-hooks/set-state-in-effect clean
  // and is race-safe when the pivot/date changes mid-flight.
  const [result, setResult] = useState<{
    qs: string
    data: DimensionPnlReport | null
    error: string | null
  } | null>(null)
  const [dimNo, setDimNo] = useState('6')
  const reportQs = `${reportQuery(periodId, dateRange)}&dim_no=${encodeURIComponent(dimNo)}`

  // Registered dimensions for the pivot picker, from the session cache
  // (lib/reference-data); best-effort, the report defaults to projekt while
  // the registry is unavailable.
  const { dimensions } = useDimensions()
  const dims = useMemo(
    () => dimensions.map((d) => ({ sie_dim_no: d.sie_dim_no, name: d.name })),
    [dimensions],
  )

  useEffect(() => {
    let cancelled = false
    fetch(`/api/reports/dimension-pnl?${reportQs}`)
      .then((res) => res.json())
      .then((payload) => {
        if (cancelled) return
        if (payload.error) {
          setResult({
            qs: reportQs,
            data: null,
            error: typeof payload.error === 'string' ? payload.error : 'Kunde inte hämta rapporten',
          })
        } else {
          setResult({ qs: reportQs, data: payload.data, error: null })
        }
      })
      .catch(() => {
        if (!cancelled) setResult({ qs: reportQs, data: null, error: 'Kunde inte hämta rapporten' })
      })
    return () => {
      cancelled = true
    }
  }, [reportQs])

  const loading = result?.qs !== reportQs
  const error = loading ? null : result?.error ?? null
  const data = loading ? null : result?.data ?? null

  const pivotPicker = dims.length > 1 && (
    <div className="flex flex-wrap items-center gap-1.5">
      {dims.map((d) => {
        const active = String(d.sie_dim_no) === dimNo
        return (
          <button
            key={d.sie_dim_no}
            type="button"
            onClick={() => setDimNo(String(d.sie_dim_no))}
            className={
              active
                ? 'px-3 py-1.5 text-xs rounded-full border transition-colors duration-150 bg-secondary border-border text-foreground'
                : 'px-3 py-1.5 text-xs rounded-full border transition-colors duration-150 bg-transparent border-border text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
            }
          >
            {d.name}
          </button>
        )
      })}
    </div>
  )

  if (loading) {
    return (
      <div className="space-y-4">
        {pivotPicker}
        <ReportLoadingCard />
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-4">
        {pivotPicker}
        <ReportErrorCard message={error} />
      </div>
    )
  }

  if (!data || data.groups.length === 0) {
    return (
      <div className="space-y-4">
        {pivotPicker}
        <ReportEmptyState
          title="Inga taggade poster"
          description="Inga intäkter eller kostnader är taggade med en dimension i den valda perioden."
        />
      </div>
    )
  }

  const columnLabel = (c: DimensionPnlReport['columns'][number]) =>
    c.code === null ? '(Utan dimension)' : c.code

  const colCount = 2 + data.columns.length + 1

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {pivotPicker || <span />}
        <ReportExportMenu items={[{ format: 'xlsx', href: `/api/reports/dimension-pnl/xlsx?${reportQs}` }]} />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-medium px-4 py-2 w-20">Konto</th>
                  <th className="text-left font-medium px-4 py-2">Kontonamn</th>
                  {data.columns.map((c, i) => (
                    /* data-ph-mask: the pivot column header is a user dimension
                       value. No title attribute: replay masking covers text
                       nodes, not attributes. */
                    <th key={i} data-ph-mask="" className="text-right font-medium px-4 py-2 w-32 tabular-nums">
                      {columnLabel(c)}
                    </th>
                  ))}
                  <th className="text-right font-medium px-4 py-2 w-32 tabular-nums">Totalt</th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((group) => (
                  <React.Fragment key={group.class}>
                    <tr className="bg-muted/30">
                      <td colSpan={colCount} className="px-4 py-2 text-[12px] font-semibold text-muted-foreground">
                        {group.class_label}
                      </td>
                    </tr>
                    {group.rows.map((row) => (
                      <tr key={row.account_number} className="border-b last:border-0">
                        <td className="px-4 py-1.5">
                          <AccountNumber number={row.account_number} name={row.account_name} />
                        </td>
                        <td className="px-4 py-1.5">{row.account_name}</td>
                        {row.values.map((v, i) => (
                          <td key={i} className="px-4 py-1.5 text-right tabular-nums">
                            {Math.abs(v) >= 0.005 ? formatAmount(v) : ''}
                          </td>
                        ))}
                        <td className="px-4 py-1.5 text-right tabular-nums font-medium">{formatAmount(row.total)}</td>
                      </tr>
                    ))}
                    <tr className="border-b font-medium">
                      <td colSpan={2} className="px-4 py-1.5 text-right text-muted-foreground">
                        Summa
                      </td>
                      {group.subtotals.map((v, i) => (
                        <td key={i} className="px-4 py-1.5 text-right tabular-nums">{formatAmount(v)}</td>
                      ))}
                      <td className="px-4 py-1.5 text-right tabular-nums">{formatAmount(group.subtotal_total)}</td>
                    </tr>
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                <tr>
                  <td className="px-4 text-sm font-medium">Beräknat resultat</td>
                  <td className="px-4" />
                  {data.net_per_column.map((v, i) => (
                    <td key={i} className={`px-4 text-right tabular-nums font-medium w-32 ${v >= 0 ? 'text-success' : 'text-destructive'}`}>
                      {formatAmount(v)}
                    </td>
                  ))}
                  <td className={`px-4 text-right font-display text-xl tabular-nums w-32 ${data.net_total >= 0 ? 'text-success' : 'text-destructive'}`}>
                    {formatAmount(data.net_total)} kr
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
