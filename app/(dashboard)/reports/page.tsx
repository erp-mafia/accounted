'use client'

import React, { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Download, FileSpreadsheet, AlertCircle, ChevronDown, ChevronRight, ArrowRight } from 'lucide-react'
import AgentSparkleButton from '@/components/agent/AgentSparkleButton'
import { formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { AccountNumber } from '@/components/ui/account-number'
import { useCompany } from '@/contexts/CompanyContext'
import { FiscalYearSelector } from '@/components/common/FiscalYearSelector'
import { ReportDateRange, type DateRangeValue } from '@/components/common/ReportDateRange'
import { ReportsNav } from '@/components/reports/ReportsNav'
import { NEDeclarationView } from '@/components/reports/NEDeclarationView'
import { PeriodiskSammanstallningView } from '@/components/reports/PeriodiskSammanstallningView'
import { INK2DeclarationView } from '@/components/reports/INK2DeclarationView'
import { BankReconciliationView } from '@/components/reports/BankReconciliationView'
import { TrialBalanceChart } from '@/components/reports/TrialBalanceChart'
import { VatCompositionChart } from '@/components/reports/VatCompositionChart'
import { SkatteverketPanel } from '@/components/reports/SkatteverketPanel'
import { IncomeExpenseChart } from '@/components/reports/IncomeExpenseChart'
import { useReportRowExpansion } from '@/components/reports/ReportRowExpansion'
import type {
  ReportSourceLine,
  ReportSourceFetcher,
} from '@/lib/reports/source-lines'
import type { MonthlyDataPoint } from '@/components/reports/IncomeExpenseChart'
import type {
  TrialBalanceRow,
  IncomeStatementReport,
  BalanceSheetReport,
  ResultatrapportReport,
  BalansrapportReport,
  VatDeclaration,
  VatPeriodType,
} from '@/types'

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Build a report API query string with the period and optional date range.
 * Omitting from/to lets the API fall back to full-period behaviour, which
 * keeps URLs (and the matching caches) identical for the "Hela året" preset.
 */
function reportQuery(periodId: string, range?: DateRangeValue): string {
  const params = new URLSearchParams({ period_id: periodId })
  if (range?.fromDate) params.set('from_date', range.fromDate)
  if (range?.toDate) params.set('to_date', range.toDate)
  return params.toString()
}

// Breadcrumb trail for drill-down navigation
interface DrillDownStep {
  tab: string
  label: string
  accountNumber?: string
}

const TAB_LABEL_KEYS: Record<string, string> = {
  'resultatrapport': 'name_resultatrapport',
  'balansrapport': 'name_balansrapport',
  'trial-balance': 'name_trial_balance',
  'income-statement': 'name_income_statement',
  'balance-sheet': 'name_balance_sheet',
  'huvudbok': 'name_huvudbok',
}

const DATE_RANGE_TABS = new Set([
  'resultatrapport',
  'balansrapport',
  'income-statement',
  'balance-sheet',
])

export default function ReportsPage() {
  const router = useRouter()
  const [selectedPeriod, setSelectedPeriod] = useState('')
  const [selectedPeriodBounds, setSelectedPeriodBounds] = useState<{ start: string; end: string } | null>(null)
  const [dateRange, setDateRange] = useState<DateRangeValue>({})
  const [activeTab, setActiveTab] = useState('resultatrapport')
  const [isLoadingInit, setIsLoadingInit] = useState(true)
  const { company } = useCompany()
  const t = useTranslations('reports')

  // Drill-down state: when navigating from a report to the GL for a specific account
  const [glAccountFilter, setGlAccountFilter] = useState<string | null>(null)
  const [drillDownTrail, setDrillDownTrail] = useState<DrillDownStep[]>([])

  const navigateToAccount = useCallback((accountNumber: string) => {
    setDrillDownTrail((prev) => [
      ...prev,
      { tab: activeTab, label: TAB_LABEL_KEYS[activeTab] ? t(TAB_LABEL_KEYS[activeTab]) : activeTab },
    ])
    setGlAccountFilter(accountNumber)
    setActiveTab('huvudbok')
  }, [activeTab, t])

  const handleTabChange = useCallback((tab: string) => {
    // Kassaflödesanalys lives on its own route; route there instead of swapping tabs.
    if (tab === 'kassaflodesanalys') {
      router.push('/reports/kassaflodesanalys')
      return
    }
    // Årsredovisning is an editable document (narrative + signatures) and lives
    // on its own route under the year-end flow. Forward the active period so
    // the page opens directly on the right fiscal year.
    if (tab === 'arsredovisning') {
      router.push(
        selectedPeriod
          ? `/bookkeeping/year-end/arsredovisning?period=${selectedPeriod}`
          : '/bookkeeping/year-end/arsredovisning',
      )
      return
    }
    // Manual tab change clears drill-down state
    setActiveTab(tab)
    setGlAccountFilter(null)
    setDrillDownTrail([])
  }, [router, selectedPeriod])

  const navigateBack = useCallback((stepIndex: number) => {
    const step = drillDownTrail[stepIndex]
    setActiveTab(step.tab)
    setGlAccountFilter(null)
    setDrillDownTrail(drillDownTrail.slice(0, stepIndex))
  }, [drillDownTrail])

  // Period list is loaded by FiscalYearSelector; isLoadingInit flips to false
  // via its onReady callback once the initial fetch completes.

  const isEnskildFirma = company?.entity_type === 'enskild_firma'
  const isAktiebolag = company?.entity_type === 'aktiebolag'

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">{t('title')}</h1>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-end gap-6">
        <FiscalYearSelector
          value={selectedPeriod || null}
          onChange={(id, period) => {
            setSelectedPeriod(id || '')
            setSelectedPeriodBounds(
              period ? { start: period.period_start, end: period.period_end } : null,
            )
            // Reset the range so the new period's stored preset re-resolves
            // against the new bounds (avoids stale dates from the prior year).
            setDateRange({})
          }}
          includeAllOption={false}
          hideFuturePeriods
          onReady={() => setIsLoadingInit(false)}
        />
        {DATE_RANGE_TABS.has(activeTab) && selectedPeriodBounds && (
          <ReportDateRange
            periodStart={selectedPeriodBounds.start}
            periodEnd={selectedPeriodBounds.end}
            value={dateRange}
            onChange={setDateRange}
          />
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {t('sie_moved_hint')}{' '}
        <Link href="/import?view=export#sie-export" className="text-foreground underline underline-offset-4 decoration-muted-foreground/40 hover:decoration-foreground">
          {t('sie_moved_link')}
        </Link>
        .
      </p>

      {isLoadingInit ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3 w-16" />
                <div className="rounded-lg border p-1 space-y-1">
                  <Skeleton className="h-8" />
                  <Skeleton className="h-8" />
                  <Skeleton className="h-8" />
                </div>
              </div>
            ))}
          </div>
          <Card>
            <CardContent className="p-6 space-y-4">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-64" />
            </CardContent>
          </Card>
        </div>
      ) : (
      <>

      {selectedPeriod ? (
        <>
        {/* Drill-down breadcrumb */}
        {drillDownTrail.length > 0 && (
          <nav className="flex items-center gap-1.5 text-sm">
            {drillDownTrail.map((step, i) => (
              <React.Fragment key={i}>
                <button
                  onClick={() => navigateBack(i)}
                  className="text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4 decoration-muted-foreground/40"
                >
                  {step.label}
                </button>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
              </React.Fragment>
            ))}
            <span className="font-medium">
              {t('name_huvudbok')} {glAccountFilter && `— ${glAccountFilter}`}
            </span>
          </nav>
        )}

        <div className="flex flex-col sm:flex-row gap-6 sm:gap-8">
          <ReportsNav
            active={activeTab}
            onChange={handleTabChange}
            entityType={company?.entity_type}
          />
          <div className="flex-1 min-w-0">
            {activeTab === 'resultatrapport' && (
              <ResultatrapportView periodId={selectedPeriod} dateRange={dateRange} onNavigateToAccount={navigateToAccount} />
            )}
            {activeTab === 'balansrapport' && (
              <BalansrapportView periodId={selectedPeriod} dateRange={dateRange} onNavigateToAccount={navigateToAccount} />
            )}
            {activeTab === 'trial-balance' && (
              <TrialBalanceView periodId={selectedPeriod} onNavigateToAccount={navigateToAccount} />
            )}
            {activeTab === 'income-statement' && (
              <IncomeStatementView periodId={selectedPeriod} dateRange={dateRange} onNavigateToAccount={navigateToAccount} />
            )}
            {activeTab === 'balance-sheet' && (
              <BalanceSheetView periodId={selectedPeriod} dateRange={dateRange} onNavigateToAccount={navigateToAccount} />
            )}
            {activeTab === 'vat-declaration' && <VatDeclarationView />}
            {activeTab === 'periodisk-sammanstallning' && <PeriodiskSammanstallningView />}
            {isEnskildFirma && activeTab === 'ne-declaration' && (
              <NEDeclarationView periodId={selectedPeriod} />
            )}
            {isAktiebolag && activeTab === 'ink2-declaration' && (
              <INK2DeclarationView periodId={selectedPeriod} />
            )}
            {activeTab === 'huvudbok' && (
              <GeneralLedgerView periodId={selectedPeriod} initialAccountFilter={glAccountFilter} />
            )}
            {activeTab === 'grundbok' && <JournalRegisterView periodId={selectedPeriod} />}
            {activeTab === 'kundreskontra' && <ARLedgerView periodId={selectedPeriod} />}
            {activeTab === 'supplier-ledger' && <SupplierLedgerView periodId={selectedPeriod} />}
            {activeTab === 'bank-reconciliation' && <BankReconciliationView />}
          </div>
        </div>
        </>
      ) : (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Inget räkenskapsår valt. Skapa ett räkenskapsår under Inställningar.
          </CardContent>
        </Card>
      )}
      </>
      )}
    </div>
  )
}

function TrialBalanceView({ periodId, onNavigateToAccount }: { periodId: string; onNavigateToAccount: (account: string) => void }) {
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
          setError(result.error)
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
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Laddar saldobalans...
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-destructive">
          <AlertCircle className="h-6 w-6 mx-auto mb-2" />
          {error}
        </CardContent>
      </Card>
    )
  }

  if (!data || data.rows.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Inga bokförda verifikationer i denna period.
        </CardContent>
      </Card>
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
    return Math.round((creditNormal ? credit - debit : debit - credit) * 100) / 100
  }

  function formatSigned(amount: number): string {
    if (amount === 0) return ''
    return amount < 0
      ? `−${formatAmount(Math.abs(amount))}`
      : formatAmount(amount)
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(`/api/reports/trial-balance/xlsx?period_id=${periodId}`, '_blank')}
        >
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Ladda ner Excel
        </Button>
      </div>
      <TrialBalanceChart rows={data.rows} />
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Saldobalans</CardTitle>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-0.5 rounded-md border p-0.5">
                <button
                  onClick={() => setViewMode('simplified')}
                  className={`px-3 py-1 text-xs rounded-sm transition-colors ${
                    viewMode === 'simplified'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Förenklad
                </button>
                <button
                  onClick={() => setViewMode('detailed')}
                  className={`px-3 py-1 text-xs rounded-sm transition-colors ${
                    viewMode === 'detailed'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Detaljerad
                </button>
              </div>
              {data.isBalanced ? (
                <Badge className="bg-success/10 text-success">Balanserad</Badge>
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
function IncomeStatementView({ periodId, dateRange, onNavigateToAccount }: { periodId: string; dateRange: DateRangeValue; onNavigateToAccount: (account: string) => void }) {
  const t = useTranslations('reports')
  const [data, setData] = useState<IncomeStatementReport | null>(null)
  const [monthlyData, setMonthlyData] = useState<MonthlyDataPoint[]>([])
  const [monthlyLoading, setMonthlyLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const reportQs = reportQuery(periodId, dateRange)

  useEffect(() => {
    setLoading(true)
    setError(null)
    setMonthlyLoading(true)

    fetch(`/api/reports/income-statement?${reportQs}`)
      .then((res) => res.json())
      .then((result) => {
        if (result.error) {
          setError(result.error)
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
    fetch(`/api/reports/monthly-breakdown?period_id=${periodId}`)
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
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Laddar resultaträkning...
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-destructive">
          <AlertCircle className="h-6 w-6 mx-auto mb-2" />
          {error}
        </CardContent>
      </Card>
    )
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Ingen data för denna period.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(`/api/reports/income-statement/pdf?${reportQs}`, '_blank')}
        >
          <Download className="h-4 w-4 mr-2" />
          {t('download_pdf')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(`/api/reports/income-statement/xlsx?${reportQs}`, '_blank')}
        >
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Ladda ner Excel
        </Button>
      </div>

      {!monthlyLoading && monthlyData.length > 0 && (
        <IncomeExpenseChart months={monthlyData} />
      )}

      {/* Revenue */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Rörelseintäkter</CardTitle>
        </CardHeader>
        <CardContent>
          <ReportSectionTable sections={data.revenue_sections} onNavigateToAccount={onNavigateToAccount} />
          <div className="flex justify-between font-semibold pt-2 border-t mt-2">
            <span>Summa rörelseintäkter</span>
            <span>{formatAmount(data.total_revenue)} kr</span>
          </div>
        </CardContent>
      </Card>

      {/* Expenses */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Rörelsekostnader</CardTitle>
        </CardHeader>
        <CardContent>
          <ReportSectionTable sections={data.expense_sections} negate onNavigateToAccount={onNavigateToAccount} />
          <div className="flex justify-between font-semibold pt-2 border-t mt-2">
            <span>Summa rörelsekostnader</span>
            <span>-{formatAmount(data.total_expenses)} kr</span>
          </div>
        </CardContent>
      </Card>

      {/* Operating result */}
      <Card>
        <CardContent className="py-4">
          <div className="flex justify-between font-bold text-lg">
            <span>Rörelseresultat</span>
            <span className={data.total_revenue - data.total_expenses >= 0 ? 'text-success' : 'text-destructive'}>
              {formatAmount(data.total_revenue - data.total_expenses)} kr
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Financial items */}
      {data.financial_sections.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Finansiella poster</CardTitle>
          </CardHeader>
          <CardContent>
            <ReportSectionTable sections={data.financial_sections} onNavigateToAccount={onNavigateToAccount} />
            <div className="flex justify-between font-semibold pt-2 border-t mt-2">
              <span>Summa finansiella poster</span>
              <span>{formatAmount(data.total_financial)} kr</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Net result */}
      <Card className="border-2">
        <CardContent className="py-4">
          <div className="flex justify-between font-bold text-xl">
            <span>Årets resultat</span>
            <span className={data.net_result >= 0 ? 'text-success' : 'text-destructive'}>
              {formatAmount(data.net_result)} kr
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function BalanceSheetView({ periodId, dateRange, onNavigateToAccount }: { periodId: string; dateRange: DateRangeValue; onNavigateToAccount: (account: string) => void }) {
  const t = useTranslations('reports')
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
          setError(result.error)
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
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Laddar balansräkning...
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-destructive">
          <AlertCircle className="h-6 w-6 mx-auto mb-2" />
          {error}
        </CardContent>
      </Card>
    )
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Ingen data för denna period.
        </CardContent>
      </Card>
    )
  }

  const isBalanced = Math.abs(data.total_assets - data.total_equity_liabilities) < 0.01

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(`/api/reports/balance-sheet/pdf?${reportQs}`, '_blank')}
        >
          <Download className="h-4 w-4 mr-2" />
          {t('download_pdf')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(`/api/reports/balance-sheet/xlsx?${reportQs}`, '_blank')}
        >
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Ladda ner Excel
        </Button>
      </div>

      {/* Assets */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Tillgångar</CardTitle>
        </CardHeader>
        <CardContent>
          <ReportSectionTable sections={data.asset_sections} onNavigateToAccount={onNavigateToAccount} />
          <div className="flex justify-between font-semibold pt-2 border-t mt-2">
            <span>Summa tillgångar</span>
            <span>{formatAmount(data.total_assets)} kr</span>
          </div>
        </CardContent>
      </Card>

      {/* Equity and liabilities */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Eget kapital och skulder</CardTitle>
        </CardHeader>
        <CardContent>
          <ReportSectionTable sections={data.equity_liability_sections} onNavigateToAccount={onNavigateToAccount} />
          <div className="flex justify-between font-semibold pt-2 border-t mt-2">
            <span>Summa eget kapital och skulder</span>
            <span>{formatAmount(data.total_equity_liabilities)} kr</span>
          </div>
        </CardContent>
      </Card>

      {/* Balance check */}
      <Card className="border-2">
        <CardContent className="py-4">
          <div className="flex justify-between items-center">
            <span className="font-bold text-lg">Balanscheck</span>
            {isBalanced ? (
              <Badge className="bg-success/10 text-success text-base px-3 py-1">
                Balanserar
              </Badge>
            ) : (
              <div className="text-right">
                <Badge variant="destructive" className="text-base px-3 py-1">
                  Balanserar ej
                </Badge>
                <p className="text-sm text-destructive mt-1">
                  Differens: {formatAmount(Math.abs(data.total_assets - data.total_equity_liabilities))} kr
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function ResultatrapportView({ periodId, dateRange, onNavigateToAccount }: { periodId: string; dateRange: DateRangeValue; onNavigateToAccount: (account: string) => void }) {
  const t = useTranslations('reports')
  const [data, setData] = useState<ResultatrapportReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const reportQs = reportQuery(periodId, dateRange)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/reports/resultatrapport?${reportQs}`)
      .then((res) => res.json())
      .then((result) => {
        if (result.error) {
          setError(result.error)
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
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Laddar resultatrapport...
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-destructive">
          <AlertCircle className="h-6 w-6 mx-auto mb-2" />
          {error}
        </CardContent>
      </Card>
    )
  }

  if (!data || data.groups.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Inga bokförda intäkter eller kostnader i denna period.
        </CardContent>
      </Card>
    )
  }

  const hasPrior = data.prior_period !== null
  const colCount = 4

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(`/api/reports/resultatrapport/pdf?${reportQs}`, '_blank')}
        >
          <Download className="h-4 w-4 mr-2" />
          {t('download_pdf')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(`/api/reports/resultatrapport/xlsx?${reportQs}`, '_blank')}
        >
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Ladda ner Excel
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-medium px-4 py-2 w-20">Konto</th>
                  <th className="text-left font-medium px-4 py-2">Kontonamn</th>
                  <th className="text-right font-medium px-4 py-2 w-32 tabular-nums">Innevarande</th>
                  <th className="text-right font-medium px-4 py-2 w-32 tabular-nums">Föregående</th>
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
                          {hasPrior ? formatAmount(row.prior_period) : '—'}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-b font-medium">
                      <td colSpan={2} className="px-4 py-1.5 text-right text-muted-foreground">
                        Summa
                      </td>
                      <td className="px-4 py-1.5 text-right tabular-nums">{formatAmount(group.subtotal_current)}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">
                        {hasPrior ? formatAmount(group.subtotal_prior) : '—'}
                      </td>
                    </tr>
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card className="border-2">
        <CardContent className="py-4">
          <div className="grid gap-x-6 items-baseline grid-cols-[1fr_auto_auto]">
            <span className="font-bold text-lg">Beräknat resultat</span>
            <span className={`tabular-nums font-bold text-lg w-32 text-right ${data.net_result_current >= 0 ? 'text-success' : 'text-destructive'}`}>
              {formatAmount(data.net_result_current)} kr
            </span>
            <span className="tabular-nums text-base text-muted-foreground w-32 text-right">
              {hasPrior ? `${formatAmount(data.net_result_prior)} kr` : '—'}
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function BalansrapportView({ periodId, dateRange, onNavigateToAccount }: { periodId: string; dateRange: DateRangeValue; onNavigateToAccount: (account: string) => void }) {
  const t = useTranslations('reports')
  const [data, setData] = useState<BalansrapportReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const reportQs = reportQuery(periodId, dateRange)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/reports/balansrapport?${reportQs}`)
      .then((res) => res.json())
      .then((result) => {
        if (result.error) {
          setError(result.error)
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
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Laddar balansrapport...
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-destructive">
          <AlertCircle className="h-6 w-6 mx-auto mb-2" />
          {error}
        </CardContent>
      </Card>
    )
  }

  if (!data || data.groups.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Inga balansposter i denna period.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(`/api/reports/balansrapport/pdf?${reportQs}`, '_blank')}
        >
          <Download className="h-4 w-4 mr-2" />
          {t('download_pdf')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(`/api/reports/balansrapport/xlsx?${reportQs}`, '_blank')}
        >
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Ladda ner Excel
        </Button>
      </div>

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

      <Card className="border-2">
        <CardContent className="py-4 space-y-2">
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
            <span className="font-bold text-lg">Balanscheck</span>
            {data.is_balanced ? (
              <Badge className="bg-success/10 text-success text-base px-3 py-1">
                Balanserar
              </Badge>
            ) : (
              <Badge variant="destructive" className="text-base px-3 py-1">
                Balanserar ej
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function ReportSectionTable({
  sections,
  negate,
  onNavigateToAccount,
}: {
  sections: { title: string; rows: { account_number: string; account_name: string; amount: number }[]; subtotal: number }[]
  negate?: boolean
  onNavigateToAccount?: (account: string) => void
}) {
  if (sections.length === 0) {
    return <p className="text-sm text-muted-foreground">Inga poster.</p>
  }

  return (
    <div className="space-y-3">
      {sections.map((section) => (
        <div key={section.title}>
          <h4 className="text-sm font-semibold text-muted-foreground mb-1">{section.title}</h4>
          <div className="overflow-x-auto -mx-2 px-2"><table className="w-full text-sm min-w-[400px]">
            <tbody>
              {section.rows.map((row) => (
                <tr
                  key={row.account_number}
                  className={`border-b last:border-0 ${onNavigateToAccount ? 'cursor-pointer hover:bg-muted/50 transition-colors' : ''}`}
                  onClick={onNavigateToAccount ? () => onNavigateToAccount(row.account_number) : undefined}
                >
                  <td className="py-1 w-16"><AccountNumber number={row.account_number} name={row.account_name} /></td>
                  <td className="py-1">{row.account_name}</td>
                  <td className="py-1 text-right w-28">
                    {negate ? `-${formatAmount(row.amount)}` : formatAmount(row.amount)} kr
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <div className="flex justify-between text-sm font-medium border-t pt-1 mt-1">
            <span>{section.title}</span>
            <span>
              {negate ? `-${formatAmount(section.subtotal)}` : formatAmount(section.subtotal)} kr
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function VatDeclarationView() {
  const currentYear = new Date().getFullYear()
  const currentMonth = new Date().getMonth() + 1
  const currentQuarter = Math.ceil(currentMonth / 3)

  const [periodType, setPeriodType] = useState<VatPeriodType>('quarterly')
  const [year, setYear] = useState(currentYear)
  const [period, setPeriod] = useState(currentQuarter)
  const [data, setData] = useState<VatDeclaration | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Generate year options (last 5 years)
  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - i)

  // Generate period options based on type
  const getPeriodOptions = () => {
    switch (periodType) {
      case 'monthly':
        return [
          { value: 1, label: 'Januari' },
          { value: 2, label: 'Februari' },
          { value: 3, label: 'Mars' },
          { value: 4, label: 'April' },
          { value: 5, label: 'Maj' },
          { value: 6, label: 'Juni' },
          { value: 7, label: 'Juli' },
          { value: 8, label: 'Augusti' },
          { value: 9, label: 'September' },
          { value: 10, label: 'Oktober' },
          { value: 11, label: 'November' },
          { value: 12, label: 'December' },
        ]
      case 'quarterly':
        return [
          { value: 1, label: 'Kvartal 1 (jan-mar)' },
          { value: 2, label: 'Kvartal 2 (apr-jun)' },
          { value: 3, label: 'Kvartal 3 (jul-sep)' },
          { value: 4, label: 'Kvartal 4 (okt-dec)' },
        ]
      case 'yearly':
        return [{ value: 1, label: 'Helår' }]
      default:
        return []
    }
  }

  // Reset period when type changes
  useEffect(() => {
    if (periodType === 'monthly') {
      setPeriod(currentMonth)
    } else if (periodType === 'quarterly') {
      setPeriod(currentQuarter)
    } else {
      setPeriod(1)
    }
  }, [periodType, currentMonth, currentQuarter])

  const fetchDeclaration = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/reports/vat-declaration?periodType=${periodType}&year=${year}&period=${period}`
      )
      const result = await res.json()
      if (result.error) {
        setError(result.error)
      } else {
        setData(result.data)
      }
    } catch {
      setError('Kunde inte hämta momsdeklaration')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(`/api/reports/vat-declaration/xlsx?periodType=${periodType}&year=${year}&period=${period}`, '_blank')}
        >
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Ladda ner Excel
        </Button>
        <AgentSparkleButton
          intentId="vat.review"
          intentArgs={{ period_type: periodType, year, period }}
          contextRef={`vat:${year}-${periodType}-${period}`}
        />
      </div>
      {/* Period selection */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Välj period</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <Label>Periodicitet</Label>
              <select
                value={periodType}
                onChange={(e) => setPeriodType(e.target.value as VatPeriodType)}
                className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="monthly">Månadsvis</option>
                <option value="quarterly">Kvartalsvis</option>
                <option value="yearly">Årsvis</option>
              </select>
            </div>
            <div>
              <Label>År</Label>
              <select
                value={year}
                onChange={(e) => setYear(parseInt(e.target.value))}
                className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {yearOptions.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Period</Label>
              <select
                value={period}
                onChange={(e) => setPeriod(parseInt(e.target.value))}
                className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {getPeriodOptions().map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <Button onClick={fetchDeclaration} disabled={loading}>
              {loading ? 'Laddar...' : 'Hämta'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-8 text-center text-destructive">
            <AlertCircle className="h-6 w-6 mx-auto mb-2" />
            {error}
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          <VatCompositionChart rutor={data.rutor} />

          {/* Summary */}
          <Card className="border-2">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Momsdeklaration - {data.period.start} till {data.period.end}</CardTitle>
                <Badge
                  variant={
                    data.rutor.ruta49 > 0
                      ? 'warning'
                      : data.rutor.ruta49 < 0
                      ? 'success'
                      : 'secondary'
                  }
                >
                  {data.rutor.ruta49 > 0
                    ? `Att betala: ${formatAmount(data.rutor.ruta49)} kr`
                    : data.rutor.ruta49 < 0
                    ? `Att återfå: ${formatAmount(Math.abs(data.rutor.ruta49))} kr`
                    : 'Ingen moms'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-sm text-muted-foreground mb-4">
                Baserat på {data.invoiceCount} fakturor och {data.transactionCount} transaktioner
              </div>

              <div className="grid md:grid-cols-2 gap-6">
                {/* Utgående moms */}
                <div>
                  <h4 className="font-semibold mb-3">Utgående moms (försäljning)</h4>
                  <div><table className="w-full text-sm">
                    <tbody>
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
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 font-semibold">
                        <td className="py-2">Summa utgående</td>
                        <td className="py-2 text-right">
                          {formatAmount(
                            data.rutor.ruta10 + data.rutor.ruta11 + data.rutor.ruta12 +
                            data.rutor.ruta30 + data.rutor.ruta31 + data.rutor.ruta32
                          )} kr
                        </td>
                      </tr>
                    </tfoot>
                  </table></div>

                  {/* Omvänd skattskyldighet (inköp) */}
                  {(data.rutor.ruta20 > 0 || data.rutor.ruta21 > 0 || data.rutor.ruta22 > 0 || data.rutor.ruta23 > 0 || data.rutor.ruta24 > 0 ||
                    data.rutor.ruta30 > 0 || data.rutor.ruta31 > 0 || data.rutor.ruta32 > 0) && (
                    <>
                      <h4 className="font-semibold mb-3 mt-6">Omvänd skattskyldighet (inköp)</h4>
                      <div><table className="w-full text-sm">
                        <tbody>
                          <VatRutaRow ruta="20" label="Inköp av varor från annat EU-land" amount={0} baseAmount={data.rutor.ruta20} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="21" label="Inköp av tjänster från annat EU-land" amount={0} baseAmount={data.rutor.ruta21} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="22" label="Inköp av tjänster utanför EU" amount={0} baseAmount={data.rutor.ruta22} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="23" label="Inköp av varor i Sverige" amount={0} baseAmount={data.rutor.ruta23} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="24" label="Övriga inköp av tjänster i Sverige" amount={0} baseAmount={data.rutor.ruta24} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="30" label="Utgående moms 25% (omvänd)" amount={data.rutor.ruta30} baseAmount={0} periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="31" label="Utgående moms 12% (omvänd)" amount={data.rutor.ruta31} baseAmount={0} periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="32" label="Utgående moms 6% (omvänd)" amount={data.rutor.ruta32} baseAmount={0} periodType={periodType} year={year} period={period} />
                        </tbody>
                      </table></div>
                    </>
                  )}
                </div>

                {/* Ingående moms */}
                <div>
                  <h4 className="font-semibold mb-3">Ingående moms (avdragsgill)</h4>
                  <div><table className="w-full text-sm">
                    <tbody>
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
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 font-semibold">
                        <td className="py-2">Summa ingående</td>
                        <td className="py-2 text-right">{formatAmount(data.rutor.ruta48)} kr</td>
                      </tr>
                    </tfoot>
                  </table></div>
                </div>
              </div>

              {/* Net result */}
              <div className="mt-6 pt-4 border-t-2">
                <div className="flex justify-between items-center">
                  <div>
                    <span className="font-mono text-xs bg-muted px-1 rounded mr-2">49</span>
                    <span className="font-bold text-lg">
                      {data.rutor.ruta49 >= 0 ? 'Moms att betala' : 'Moms att återfå'}
                    </span>
                  </div>
                  <span
                    className={`text-xl font-bold ${
                      data.rutor.ruta49 > 0
                        ? 'text-orange-600'
                        : data.rutor.ruta49 < 0
                        ? 'text-success'
                        : ''
                    }`}
                  >
                    {formatAmount(Math.abs(data.rutor.ruta49))} kr
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Skatteverket integration panel */}
      <SkatteverketPanel
        periodType={periodType}
        year={year}
        period={period}
        hasData={data !== null}
        rutor={data?.rutor ?? null}
      />

      {!data && !loading && !error && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Välj period och klicka &quot;Hämta&quot; för att se momsdeklaration.
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function makeVatFetcher(ruta: string, periodType: VatPeriodType, year: number, period: number): ReportSourceFetcher {
  return async () => {
    const res = await fetch(
      `/api/reports/vat-declaration/ruta/${encodeURIComponent(ruta)}/sources?periodType=${periodType}&year=${year}&period=${period}`
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
  const canDrill = periodType !== undefined && year !== undefined && period !== undefined
  const fetcher = React.useMemo(
    () => (canDrill ? makeVatFetcher(ruta, periodType!, year!, period!) : null),
    [canDrill, ruta, periodType, year, period]
  )
  // Hooks must be called unconditionally — provide a noop fetcher when drill
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
          <span className="font-mono text-xs bg-muted px-1 rounded mr-2">{ruta}</span>
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

function SupplierLedgerView({ periodId }: { periodId: string }) {
  const [data, setData] = useState<SupplierLedgerData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/reports/supplier-ledger?period_id=${periodId}`)
      const result = await res.json()
      if (result.error) {
        setError(result.error)
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
  }, [periodId])

  if (loading) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Laddar leverantörsreskontra...
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-destructive">
          <AlertCircle className="h-6 w-6 mx-auto mb-2" />
          {error}
        </CardContent>
      </Card>
    )
  }

  if (!data || !data.ledger) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Ingen data tillgänglig.
        </CardContent>
      </Card>
    )
  }

  const { ledger, reconciliation } = data

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(`/api/reports/supplier-ledger/xlsx?period_id=${periodId}`, '_blank')}
        >
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Ladda ner Excel
        </Button>
      </div>
      {/* Summary cards */}
      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Totalt utestående</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl font-medium tabular-nums">{formatAmount(ledger.total_outstanding)} kr</p>
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
            <p className="font-display text-2xl font-medium tabular-nums text-success">{formatAmount(ledger.total_current)} kr</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Förfallet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl font-medium tabular-nums text-destructive">{formatAmount(ledger.total_overdue)} kr</p>
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
        <Card className="border-2">
          <CardHeader>
            <CardTitle>Avstämning mot <AccountNumber number="2440" /></CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Leverantörsreskontra (summa utestående)</span>
                <span className="font-mono">{formatAmount(reconciliation.supplier_ledger_total)} kr</span>
              </div>
              <div className="flex justify-between">
                <span><AccountNumber number="2440" /> saldo (huvudbok)</span>
                <span className="font-mono">{formatAmount(reconciliation.account_2440_balance)} kr</span>
              </div>
              <div className="flex justify-between pt-2 border-t font-semibold">
                <span>Differens</span>
                <span className={reconciliation.is_reconciled ? 'text-success' : 'text-destructive'}>
                  {formatAmount(reconciliation.difference)} kr
                </span>
              </div>
              <div className="pt-2 space-y-2">
                {reconciliation.is_reconciled ? (
                  <Badge className="bg-success/10 text-success">Avstämd</Badge>
                ) : (
                  <Badge variant="destructive">Ej avstämd - kontrollera bokföring</Badge>
                )}
                {reconciliation.unconverted_fx_count > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {reconciliation.unconverted_fx_count} leverantörsfaktura i utländsk valuta saknar växelkurs — differensen kan bero på saknade kursuppgifter snarare än felbokning.
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
    }[]
    closing_balance: number
    total_debit: number
    total_credit: number
  }[]
  period: { start: string; end: string }
}

function GeneralLedgerView({ periodId, initialAccountFilter }: { periodId: string; initialAccountFilter: string | null }) {
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
      const res = await fetch(`/api/reports/general-ledger?${params}`)
      const result = await res.json()
      if (result.error) {
        setError(result.error)
      } else {
        setData(result.data)
      }
    } catch {
      setError('Kunde inte hämta huvudbok')
    } finally {
      setLoading(false)
    }
  }, [periodId, accountFrom, accountTo])

  // When initialAccountFilter changes (drill-down from another report), apply it
  useEffect(() => {
    if (initialAccountFilter) {
      setAccountFrom(initialAccountFilter)
      setAccountTo(initialAccountFilter)
      fetchData(initialAccountFilter, initialAccountFilter)
    } else {
      fetchData()
    }
  }, [periodId, initialAccountFilter])

  if (loading) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Laddar huvudbok...
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-destructive">
          <AlertCircle className="h-6 w-6 mx-auto mb-2" />
          {error}
        </CardContent>
      </Card>
    )
  }

  if (!data || data.accounts.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Inga bokförda verifikationer i denna period.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(`/api/reports/general-ledger/xlsx?period_id=${periodId}`, '_blank')}
        >
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Ladda ner Excel
        </Button>
      </div>
      {/* Account range filter */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <Label>Konto från</Label>
              <input
                type="text"
                value={accountFrom}
                onChange={(e) => setAccountFrom(e.target.value)}
                placeholder="t.ex. 1510"
                className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <Label>Konto till</Label>
              <input
                type="text"
                value={accountTo}
                onChange={(e) => setAccountTo(e.target.value)}
                placeholder="t.ex. 1519"
                className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <Button onClick={() => fetchData()} variant="outline">
              Filtrera
            </Button>
          </div>
        </CardContent>
      </Card>

      {data.period.start && (
        <p className="text-sm text-muted-foreground">
          Period: {data.period.start} — {data.period.end} | {data.accounts.length} konton
        </p>
      )}

      {data.accounts.map((account) => (
        <Card key={account.account_number}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
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
                    <td className="py-1.5">{line.date}</td>
                    <td className="py-1.5 truncate max-w-[200px]">{line.description}</td>
                    <td className="py-1.5 text-right">
                      {line.debit > 0 ? formatAmount(line.debit) : ''}
                    </td>
                    <td className="py-1.5 text-right">
                      {line.credit > 0 ? formatAmount(line.credit) : ''}
                    </td>
                    <td className="py-1.5 text-right font-mono">{formatAmount(line.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold border-t-2">
                  <td colSpan={3} className="py-2">Summa / Utgående balans</td>
                  <td className="py-2 text-right">{formatAmount(account.total_debit)}</td>
                  <td className="py-2 text-right">{formatAmount(account.total_credit)}</td>
                  <td className="py-2 text-right font-mono">{formatAmount(account.closing_balance)}</td>
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

function JournalRegisterView({ periodId }: { periodId: string }) {
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
        setError(result.error)
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
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Laddar grundbok...
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-destructive">
          <AlertCircle className="h-6 w-6 mx-auto mb-2" />
          {error}
        </CardContent>
      </Card>
    )
  }

  if (!data || data.entries.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Inga bokförda verifikationer i denna period.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(`/api/reports/journal-register/xlsx?period_id=${periodId}`, '_blank')}
        >
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Ladda ner Excel
        </Button>
      </div>
      {data.period.start && (
        <p className="text-sm text-muted-foreground">
          Period: {data.period.start} — {data.period.end} | {data.total_entries} verifikationer
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
                      <td className="py-2">{entry.date}</td>
                      <td className="py-2">
                        {entry.description}
                        {isReversed && (
                          <Badge variant="outline" className="ml-2 text-xs">Makulerad</Badge>
                        )}
                      </td>
                      <td className="py-2 text-xs text-muted-foreground">{entry.source_type}</td>
                      <td className="py-2 text-right">{formatAmount(entry.total_debit)}</td>
                      <td className="py-2 text-right">{formatAmount(entry.total_credit)}</td>
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
  }
  reconciliation: {
    ar_ledger_total: number
    account_1510_balance: number
    difference: number
    is_reconciled: boolean
    unconverted_fx_count: number
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
  // ARCustomerInvoiceRows is mounted lazily — only when a customer is
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
              {inv.paid_amount > 0 ? `Betalt: ${formatAmount(inv.paid_amount)}` : ''}
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

function ARLedgerView({ periodId }: { periodId: string }) {
  const [data, setData] = useState<ARLedgerData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedCustomers, setExpandedCustomers] = useState<Set<string>>(new Set())

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/reports/ar-ledger?period_id=${periodId}`)
      const result = await res.json()
      if (result.error) {
        setError(result.error)
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
  }, [periodId])

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
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Laddar kundreskontra...
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-destructive">
          <AlertCircle className="h-6 w-6 mx-auto mb-2" />
          {error}
        </CardContent>
      </Card>
    )
  }

  if (!data || !data.ledger) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Ingen data tillgänglig.
        </CardContent>
      </Card>
    )
  }

  const { ledger, reconciliation } = data

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(`/api/reports/ar-ledger/xlsx?period_id=${periodId}`, '_blank')}
        >
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Ladda ner Excel
        </Button>
      </div>
      {/* Summary cards */}
      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Totalt utestående</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl font-medium tabular-nums">{formatAmount(ledger.total_outstanding)} kr</p>
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
            <p className="font-display text-2xl font-medium tabular-nums text-success">{formatAmount(ledger.total_current)} kr</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Förfallet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl font-medium tabular-nums text-destructive">{formatAmount(ledger.total_overdue)} kr</p>
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
        <Card className="border-2">
          <CardHeader>
            <CardTitle>Avstämning mot <AccountNumber number="1510" /></CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Kundreskontra (summa utestående)</span>
                <span className="font-mono">{formatAmount(reconciliation.ar_ledger_total)} kr</span>
              </div>
              <div className="flex justify-between">
                <span>Kundfordringar (<AccountNumber number="1510" /> + <AccountNumber number="1513" />) saldo</span>
                <span className="font-mono">{formatAmount(reconciliation.account_1510_balance)} kr</span>
              </div>
              <div className="flex justify-between pt-2 border-t font-semibold">
                <span>Differens</span>
                <span className={reconciliation.is_reconciled ? 'text-success' : 'text-destructive'}>
                  {formatAmount(reconciliation.difference)} kr
                </span>
              </div>
              <div className="pt-2 space-y-2">
                {reconciliation.is_reconciled ? (
                  <Badge className="bg-success/10 text-success">Avstämd</Badge>
                ) : (
                  <Badge variant="destructive">Ej avstämd - kontrollera bokföring</Badge>
                )}
                {reconciliation.unconverted_fx_count > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {reconciliation.unconverted_fx_count} kundfaktura i utländsk valuta saknar växelkurs — differensen kan bero på saknade kursuppgifter snarare än felbokning.
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
