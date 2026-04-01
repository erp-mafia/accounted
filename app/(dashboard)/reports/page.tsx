'use client'

import React, { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Download, AlertCircle, ChevronDown, ChevronRight, ArrowRight } from 'lucide-react'
import { AccountNumber } from '@/components/ui/account-number'
import { NEDeclarationView } from '@/components/reports/NEDeclarationView'
import { INK2DeclarationView } from '@/components/reports/INK2DeclarationView'
import { BankReconciliationView } from '@/components/reports/BankReconciliationView'
import { TrialBalanceChart } from '@/components/reports/TrialBalanceChart'
import { VatCompositionChart } from '@/components/reports/VatCompositionChart'
import { SkatteverketPanel } from '@/components/reports/SkatteverketPanel'
import { IncomeExpenseChart } from '@/components/reports/IncomeExpenseChart'
import type { MonthlyDataPoint } from '@/components/reports/IncomeExpenseChart'
import type {
  FiscalPeriod,
  TrialBalanceRow,
  IncomeStatementReport,
  BalanceSheetReport,
  VatDeclaration,
  VatPeriodType,
} from '@/types'

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Breadcrumb trail for drill-down navigation
interface DrillDownStep {
  tab: string
  label: string
  accountNumber?: string
}

const TAB_LABELS: Record<string, string> = {
  'trial-balance': 'Saldobalans',
  'income-statement': 'Resultaträkning',
  'balance-sheet': 'Balansräkning',
  'huvudbok': 'Huvudbok',
}

export default function ReportsPage() {
  const [periods, setPeriods] = useState<FiscalPeriod[]>([])
  const [selectedPeriod, setSelectedPeriod] = useState('')
  const [activeTab, setActiveTab] = useState('trial-balance')
  const [entityType, setEntityType] = useState<string | null>(null)
  const [isLoadingInit, setIsLoadingInit] = useState(true)

  // Drill-down state: when navigating from a report to the GL for a specific account
  const [glAccountFilter, setGlAccountFilter] = useState<string | null>(null)
  const [drillDownTrail, setDrillDownTrail] = useState<DrillDownStep[]>([])

  const navigateToAccount = useCallback((accountNumber: string) => {
    setDrillDownTrail((prev) => [
      ...prev,
      { tab: activeTab, label: TAB_LABELS[activeTab] || activeTab },
    ])
    setGlAccountFilter(accountNumber)
    setActiveTab('huvudbok')
  }, [activeTab])

  const handleTabChange = useCallback((tab: string) => {
    // Manual tab change clears drill-down state
    setActiveTab(tab)
    setGlAccountFilter(null)
    setDrillDownTrail([])
  }, [])

  const navigateBack = useCallback((stepIndex: number) => {
    const step = drillDownTrail[stepIndex]
    setActiveTab(step.tab)
    setGlAccountFilter(null)
    setDrillDownTrail(drillDownTrail.slice(0, stepIndex))
  }, [drillDownTrail])

  async function fetchPeriods() {
    const res = await fetch('/api/bookkeeping/fiscal-periods')
    const { data } = await res.json()
    const today = new Date().toISOString().split('T')[0]
    const activePeriods = (data || []).filter((p: FiscalPeriod) => p.period_start <= today)
    setPeriods(activePeriods)
    if (activePeriods.length > 0) {
      setSelectedPeriod(activePeriods[0].id)
    }
  }

  async function fetchEntityType() {
    try {
      const res = await fetch('/api/settings')
      const { data } = await res.json()
      if (data?.entity_type) {
        setEntityType(data.entity_type)
      }
    } catch {
      // Ignore - entity type is optional for tab visibility
    }
  }

  useEffect(() => {
    Promise.all([fetchPeriods(), fetchEntityType()]).finally(() => {
      setIsLoadingInit(false)
    })
  }, [])

  const isEnskildFirma = entityType === 'enskild_firma'
  const isAktiebolag = entityType === 'aktiebolag'

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">Rapporter</h1>
          <p className="text-muted-foreground">
            Generera skattedeklarationer, resultaträkningar och exportera till Skatteverket
          </p>
        </div>
      </div>

      {isLoadingInit ? (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-end gap-4">
            <div>
              <div className="h-4 bg-muted rounded w-24 animate-pulse mb-1" />
              <div className="h-10 bg-muted rounded w-64 animate-pulse" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="space-y-2">
                <div className="h-3 bg-muted rounded w-16 animate-pulse" />
                <div className="rounded-lg border p-1 space-y-1">
                  <div className="h-8 bg-muted rounded animate-pulse" />
                  <div className="h-8 bg-muted rounded animate-pulse" />
                  <div className="h-8 bg-muted rounded animate-pulse" />
                </div>
              </div>
            ))}
          </div>
          <Card>
            <CardContent className="p-6 space-y-4">
              <div className="h-5 bg-muted rounded w-32 animate-pulse" />
              <div className="h-64 bg-muted rounded animate-pulse" />
            </CardContent>
          </Card>
        </div>
      ) : (
      <>
      <div className="flex flex-col sm:flex-row sm:items-end gap-4">
        <div>
          <Label>Räkenskapsår</Label>
          <select
            value={selectedPeriod}
            onChange={(e) => setSelectedPeriod(e.target.value)}
            className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.period_start} — {p.period_end})
              </option>
            ))}
          </select>
        </div>
        {selectedPeriod && (
          <Button
            variant="outline"
            onClick={() => {
              window.open(`/api/reports/sie-export?period_id=${selectedPeriod}`, '_blank')
            }}
          >
            <Download className="h-4 w-4 mr-2" />
            Ladda ner SIE-fil
          </Button>
        )}
      </div>

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
              Huvudbok {glAccountFilter && `— ${glAccountFilter}`}
            </span>
          </nav>
        )}

        <Tabs value={activeTab} onValueChange={handleTabChange}>
          {/* Mobile: compact select dropdown */}
          <div className="sm:hidden mb-2">
            <select
              value={activeTab}
              onChange={(e) => handleTabChange(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <optgroup label="Bokslut">
                <option value="trial-balance">Saldobalans</option>
                <option value="income-statement">Resultaträkning</option>
                <option value="balance-sheet">Balansräkning</option>
              </optgroup>
              <optgroup label="Skatt & moms">
                <option value="vat-declaration">Momsdeklaration</option>
                {isEnskildFirma && <option value="ne-declaration">NE-bilaga</option>}
                {isAktiebolag && <option value="ink2-declaration">INK2</option>}
              </optgroup>
              <optgroup label="Huvudböcker">
                <option value="huvudbok">Huvudbok</option>
                <option value="grundbok">Grundbok</option>
                <option value="kundreskontra">Kundreskontra</option>
                <option value="supplier-ledger">Leverantörsreskontra</option>
              </optgroup>
              <optgroup label="Avstämning">
                <option value="bank-reconciliation">Bankavstämning</option>
              </optgroup>
            </select>
          </div>

          {/* Desktop: grid tab navigation */}
          <div className="hidden sm:grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-2">
            {/* Bokslut (Financial Statements) */}
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-[0.08em] px-1">
                Bokslut
              </p>
              <TabsList className="flex flex-col h-auto w-full gap-0.5 p-1">
                <TabsTrigger value="trial-balance" className="w-full justify-start">
                  Saldobalans
                </TabsTrigger>
                <TabsTrigger value="income-statement" className="w-full justify-start">
                  Resultaträkning
                </TabsTrigger>
                <TabsTrigger value="balance-sheet" className="w-full justify-start">
                  Balansräkning
                </TabsTrigger>
              </TabsList>
            </div>

            {/* Skatt & moms (Tax & VAT) */}
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-[0.08em] px-1">
                Skatt & moms
              </p>
              <TabsList className="flex flex-col h-auto w-full gap-0.5 p-1">
                <TabsTrigger value="vat-declaration" className="w-full justify-start">
                  Momsdeklaration
                </TabsTrigger>
                {isEnskildFirma && (
                  <TabsTrigger value="ne-declaration" className="w-full justify-start">
                    NE-bilaga
                  </TabsTrigger>
                )}
                {isAktiebolag && (
                  <TabsTrigger value="ink2-declaration" className="w-full justify-start">
                    INK2
                  </TabsTrigger>
                )}
              </TabsList>
            </div>

            {/* Huvudböcker (Ledgers) */}
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-[0.08em] px-1">
                Huvudböcker
              </p>
              <TabsList className="flex flex-col h-auto w-full gap-0.5 p-1">
                <TabsTrigger value="huvudbok" className="w-full justify-start">
                  Huvudbok
                </TabsTrigger>
                <TabsTrigger value="grundbok" className="w-full justify-start">
                  Grundbok
                </TabsTrigger>
                <TabsTrigger value="kundreskontra" className="w-full justify-start">
                  Kundreskontra
                </TabsTrigger>
                <TabsTrigger value="supplier-ledger" className="w-full justify-start">
                  Leverantörsreskontra
                </TabsTrigger>
              </TabsList>
            </div>

            {/* Avstämning (Reconciliation) */}
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-[0.08em] px-1">
                Avstämning
              </p>
              <TabsList className="flex flex-col h-auto w-full gap-0.5 p-1">
                <TabsTrigger value="bank-reconciliation" className="w-full justify-start">
                  Bankavstämning
                </TabsTrigger>
              </TabsList>
            </div>
          </div>

          <TabsContent value="trial-balance">
            <TrialBalanceView periodId={selectedPeriod} onNavigateToAccount={navigateToAccount} />
          </TabsContent>
          <TabsContent value="income-statement">
            <IncomeStatementView periodId={selectedPeriod} onNavigateToAccount={navigateToAccount} />
          </TabsContent>
          <TabsContent value="balance-sheet">
            <BalanceSheetView periodId={selectedPeriod} onNavigateToAccount={navigateToAccount} />
          </TabsContent>
          <TabsContent value="vat-declaration">
            <VatDeclarationView />
          </TabsContent>
          {isEnskildFirma && (
            <TabsContent value="ne-declaration">
              <NEDeclarationView periodId={selectedPeriod} />
            </TabsContent>
          )}
          {isAktiebolag && (
            <TabsContent value="ink2-declaration">
              <INK2DeclarationView periodId={selectedPeriod} />
            </TabsContent>
          )}
          <TabsContent value="huvudbok">
            <GeneralLedgerView periodId={selectedPeriod} initialAccountFilter={glAccountFilter} />
          </TabsContent>
          <TabsContent value="grundbok">
            <JournalRegisterView periodId={selectedPeriod} />
          </TabsContent>
          <TabsContent value="kundreskontra">
            <ARLedgerView periodId={selectedPeriod} />
          </TabsContent>
          <TabsContent value="supplier-ledger">
            <SupplierLedgerView periodId={selectedPeriod} />
          </TabsContent>
          <TabsContent value="bank-reconciliation">
            <BankReconciliationView />
          </TabsContent>
        </Tabs>
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
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 w-20">Konto</th>
                    <th className="py-2">Namn</th>
                    <th className="py-2 w-32 text-right">Ingående saldo</th>
                    <th className="py-2 w-32 text-right">Förändring</th>
                    <th className="py-2 w-32 text-right">Utgående saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => {
                    const ob = getNetBalance(row, 'opening')
                    const ch = getNetBalance(row, 'period')
                    const cb = getNetBalance(row, 'closing')
                    return (
                      <tr
                        key={row.account_number}
                        className="border-b last:border-0 cursor-pointer hover:bg-muted/50 transition-colors"
                        onClick={() => onNavigateToAccount(row.account_number)}
                      >
                        <td className="py-2">
                          <AccountNumber number={row.account_number} name={row.account_name} />
                        </td>
                        <td className="py-2">{row.account_name}</td>
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
                    )
                  })}
                </tbody>
              </table>
            ) : (
              <table className="w-full text-sm min-w-[600px]">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
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
                    <tr
                      key={row.account_number}
                      className="border-b last:border-0 cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => onNavigateToAccount(row.account_number)}
                    >
                      <td className="py-2">
                        <AccountNumber number={row.account_number} name={row.account_name} />
                      </td>
                      <td className="py-2">{row.account_name}</td>
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
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold border-t-2">
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
function IncomeStatementView({ periodId, onNavigateToAccount }: { periodId: string; onNavigateToAccount: (account: string) => void }) {
  const [data, setData] = useState<IncomeStatementReport | null>(null)
  const [monthlyData, setMonthlyData] = useState<MonthlyDataPoint[]>([])
  const [monthlyLoading, setMonthlyLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    setMonthlyLoading(true)

    fetch(`/api/reports/income-statement?period_id=${periodId}`)
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
  }, [periodId])

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

function BalanceSheetView({ periodId, onNavigateToAccount }: { periodId: string; onNavigateToAccount: (account: string) => void }) {
  const [data, setData] = useState<BalanceSheetReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/reports/balance-sheet?period_id=${periodId}`)
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
  }, [periodId])

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
                  className={
                    data.rutor.ruta49 > 0
                      ? 'bg-orange-100 text-orange-800'
                      : data.rutor.ruta49 < 0
                      ? 'bg-success/10 text-success'
                      : 'bg-gray-100 text-gray-800'
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
                  <div className="overflow-x-auto -mx-2 px-2"><table className="w-full text-sm min-w-[400px]">
                    <tbody>
                      {data.rutor.ruta05 > 0 && (
                        <tr className="border-b">
                          <td className="py-2">
                            <span className="font-mono text-xs bg-muted px-1 rounded mr-2">05</span>
                            Momspliktig försäljning
                          </td>
                          <td className="py-2 text-right">{formatAmount(data.rutor.ruta05)} kr</td>
                        </tr>
                      )}
                      <VatRutaRow
                        ruta="10"
                        label="Utgående moms 25%"
                        amount={data.rutor.ruta10}
                        baseAmount={data.breakdown.invoices.base25}
                      />
                      <VatRutaRow
                        ruta="11"
                        label="Utgående moms 12%"
                        amount={data.rutor.ruta11}
                        baseAmount={data.breakdown.invoices.base12}
                      />
                      <VatRutaRow
                        ruta="12"
                        label="Utgående moms 6%"
                        amount={data.rutor.ruta12}
                        baseAmount={data.breakdown.invoices.base6}
                      />
                      <VatRutaRow
                        ruta="39"
                        label="Tjänster EU (omvänd skattskyldighet)"
                        amount={0}
                        baseAmount={data.rutor.ruta39}
                        noVat
                      />
                      <VatRutaRow
                        ruta="40"
                        label="Export utanför EU"
                        amount={0}
                        baseAmount={data.rutor.ruta40}
                        noVat
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
                      <div className="overflow-x-auto -mx-2 px-2"><table className="w-full text-sm min-w-[400px]">
                        <tbody>
                          <VatRutaRow ruta="20" label="Inköp av varor från annat EU-land" amount={0} baseAmount={data.rutor.ruta20} noVat />
                          <VatRutaRow ruta="21" label="Inköp av tjänster från annat EU-land" amount={0} baseAmount={data.rutor.ruta21} noVat />
                          <VatRutaRow ruta="22" label="Inköp av tjänster utanför EU" amount={0} baseAmount={data.rutor.ruta22} noVat />
                          <VatRutaRow ruta="23" label="Inköp av varor i Sverige" amount={0} baseAmount={data.rutor.ruta23} noVat />
                          <VatRutaRow ruta="24" label="Övriga inköp av tjänster i Sverige" amount={0} baseAmount={data.rutor.ruta24} noVat />
                          <VatRutaRow ruta="30" label="Utgående moms 25% (omvänd)" amount={data.rutor.ruta30} baseAmount={0} />
                          <VatRutaRow ruta="31" label="Utgående moms 12% (omvänd)" amount={data.rutor.ruta31} baseAmount={0} />
                          <VatRutaRow ruta="32" label="Utgående moms 6% (omvänd)" amount={data.rutor.ruta32} baseAmount={0} />
                        </tbody>
                      </table></div>
                    </>
                  )}
                </div>

                {/* Ingående moms */}
                <div>
                  <h4 className="font-semibold mb-3">Ingående moms (avdragsgill)</h4>
                  <div className="overflow-x-auto -mx-2 px-2"><table className="w-full text-sm min-w-[400px]">
                    <tbody>
                      <tr className="border-b">
                        <td className="py-2">
                          <span className="font-mono text-xs bg-muted px-1 rounded mr-2">48</span>
                          Ingående moms att dra av
                        </td>
                        <td className="py-2 text-right">{formatAmount(data.rutor.ruta48)} kr</td>
                      </tr>
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

function VatRutaRow({
  ruta,
  label,
  amount,
  baseAmount,
  noVat,
}: {
  ruta: string
  label: string
  amount: number
  baseAmount: number
  noVat?: boolean
}) {
  // Don't show rows with zero values
  if (baseAmount === 0 && amount === 0) return null

  return (
    <>
      <tr className="border-b">
        <td className="py-2">
          <span className="font-mono text-xs bg-muted px-1 rounded mr-2">{ruta}</span>
          {label}
        </td>
        <td className="py-2 text-right">{noVat ? `${formatAmount(baseAmount)} kr` : `${formatAmount(amount)} kr`}</td>
      </tr>
      {!noVat && baseAmount > 0 && (
        <tr className="text-muted-foreground">
          <td className="py-1 pl-6 text-xs">Underlag</td>
          <td className="py-1 text-right text-xs">{formatAmount(baseAmount)} kr</td>
        </tr>
      )}
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
  }
  reconciliation: {
    supplier_ledger_total: number
    account_2440_balance: number
    difference: number
    is_reconciled: boolean
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
      {/* Summary cards */}
      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Totalt utestående</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl font-medium tabular-nums">{formatAmount(ledger.total_outstanding)} kr</p>
            <p className="text-xs text-muted-foreground">{ledger.unpaid_count} fakturor</p>
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
              <thead>
                <tr className="border-b text-left text-muted-foreground">
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
                  <tr key={entry.supplier_id} className="border-b last:border-0">
                    <td className="py-2">{entry.supplier_name}</td>
                    <td className="py-2 text-right">{entry.current > 0 ? formatAmount(entry.current) : ''}</td>
                    <td className="py-2 text-right">{entry.days_1_30 > 0 ? formatAmount(entry.days_1_30) : ''}</td>
                    <td className="py-2 text-right">{entry.days_31_60 > 0 ? formatAmount(entry.days_31_60) : ''}</td>
                    <td className="py-2 text-right">{entry.days_61_90 > 0 ? formatAmount(entry.days_61_90) : ''}</td>
                    <td className="py-2 text-right text-destructive">{entry.days_90_plus > 0 ? formatAmount(entry.days_90_plus) : ''}</td>
                    <td className="py-2 text-right font-semibold">{formatAmount(entry.total_outstanding)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold border-t-2">
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
              <div className="pt-2">
                {reconciliation.is_reconciled ? (
                  <Badge className="bg-success/10 text-success">Avstämd</Badge>
                ) : (
                  <Badge variant="destructive">Ej avstämd - kontrollera bokföring</Badge>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
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
              <thead>
                <tr className="border-b text-left text-muted-foreground">
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
                        {line.voucher_series}{line.voucher_number}
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
            <thead>
              <tr className="border-b text-left text-muted-foreground">
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
                        {entry.voucher_series}{entry.voucher_number}
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
  }
  reconciliation: {
    ar_ledger_total: number
    account_1510_balance: number
    difference: number
    is_reconciled: boolean
  } | null
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
      {/* Summary cards */}
      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Totalt utestående</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl font-medium tabular-nums">{formatAmount(ledger.total_outstanding)} kr</p>
            <p className="text-xs text-muted-foreground">{ledger.unpaid_count} fakturor</p>
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
              <thead>
                <tr className="border-b text-left text-muted-foreground">
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
                      {isExpanded && entry.invoices.map((inv) => (
                        <tr key={inv.invoice_id} className="bg-muted/30 border-b last:border-0">
                          <td></td>
                          <td className="py-1 text-xs" colSpan={2}>
                            <span className="font-mono">{inv.invoice_number}</span>
                            <span className="text-muted-foreground ml-2">{inv.invoice_date}</span>
                            <span className="text-muted-foreground ml-2">förfaller {inv.due_date}</span>
                          </td>
                          <td className="py-1 text-right text-xs text-muted-foreground" colSpan={2}>
                            {inv.days_overdue > 0 ? `${inv.days_overdue} dagar förfallen` : 'Ej förfallen'}
                          </td>
                          <td className="py-1 text-right text-xs text-muted-foreground">
                            {inv.paid_amount > 0 ? `Betalt: ${formatAmount(inv.paid_amount)}` : ''}
                          </td>
                          <td></td>
                          <td className="py-1 text-right text-xs font-medium">
                            {formatAmount(inv.outstanding)} {inv.currency}
                          </td>
                        </tr>
                      ))}
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
                <span><AccountNumber number="1510" /> saldo (huvudbok)</span>
                <span className="font-mono">{formatAmount(reconciliation.account_1510_balance)} kr</span>
              </div>
              <div className="flex justify-between pt-2 border-t font-semibold">
                <span>Differens</span>
                <span className={reconciliation.is_reconciled ? 'text-success' : 'text-destructive'}>
                  {formatAmount(reconciliation.difference)} kr
                </span>
              </div>
              <div className="pt-2">
                {reconciliation.is_reconciled ? (
                  <Badge className="bg-success/10 text-success">Avstämd</Badge>
                ) : (
                  <Badge variant="destructive">Ej avstämd - kontrollera bokföring</Badge>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
