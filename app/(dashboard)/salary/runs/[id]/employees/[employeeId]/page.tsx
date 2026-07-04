'use client'

import { use, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Calculator, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { SalaryCalendar } from '@/components/salary/SalaryCalendar'
import { SalaryOverridePanel } from '@/components/salary/SalaryOverridePanel'
import { formatCurrency } from '@/lib/utils'
import type { SalaryRun, SalaryRunEmployee, SalaryLineItem, SalaryLineItemType, Employee } from '@/types'

const LINE_ITEM_TYPE_LABELS: Record<SalaryLineItemType, string> = {
  monthly_salary: 'Månadslön',
  hourly_salary: 'Timlön',
  overtime: 'Övertid',
  overtime_50: 'Övertid 50 %',
  overtime_100: 'Övertid 100 %',
  ob_weekday_evening: 'OB vardag kväll',
  ob_weekend: 'OB helg',
  ob_night: 'OB natt',
  ob_holiday: 'OB helgdag',
  bonus: 'Bonus',
  commission: 'Provision',
  gross_deduction_pension: 'Bruttoavdrag: pension',
  gross_deduction_other: 'Bruttoavdrag: övrigt',
  benefit_car: 'Bilförmån',
  benefit_housing: 'Bostadsförmån',
  benefit_meals: 'Kostförmån',
  benefit_wellness: 'Friskvård',
  benefit_bike: 'Cykelförmån',
  benefit_other: 'Övrig förmån',
  sick_karens: 'Karensavdrag',
  sick_day2_14: 'Sjuklön (dag 2-14, 80 %)',
  sick_day15_plus: 'Sjuklön (dag 15+, Försäkringskassan)',
  vab: 'VAB (vård av sjukt barn)',
  parental_leave: 'Föräldraledighet',
  unpaid_leave: 'Tjänstledighet utan lön',
  vacation: 'Semester',
  semesterersattning: 'Semesterersättning',
  traktamente_taxfree: 'Traktamente (skattefritt)',
  traktamente_taxable: 'Traktamente (skattepliktigt)',
  mileage_taxfree: 'Milersättning (skattefritt)',
  mileage_taxable: 'Milersättning (skattepliktigt)',
  net_deduction_advance: 'Nettoavdrag: förskott',
  net_deduction_union: 'Nettoavdrag: fackavgift',
  net_deduction_benefit_payment: 'Nettoavdrag: förmånsbetalning',
  net_deduction_other: 'Nettoavdrag: övrigt',
  correction: 'Korrigering',
  other: 'Övrigt',
}

interface DetailResponse {
  run: SalaryRun
  runEmployee: SalaryRunEmployee & { employee: Employee; line_items: SalaryLineItem[] }
}

export default function SalaryRunEmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string; employeeId: string }>
}) {
  const { id: runId, employeeId } = use(params)
  const [data, setData] = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [calculating, setCalculating] = useState(false)
  // Live counts pushed from the calendar: overrides the stale snapshot from
  // the last calculation so badges update immediately on absence save.
  const [liveCounts, setLiveCounts] = useState<{ sick: number; vab: number; parental: number } | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [runRes, sreRes] = await Promise.all([
        fetch(`/api/salary/runs/${runId}`),
        fetch(`/api/salary/runs/${runId}/employees/${employeeId}`),
      ])
      const runJson = await runRes.json()
      const sreJson = await sreRes.json()
      if (!runRes.ok) throw new Error(runJson.error || 'Kunde inte ladda lönekörning')
      if (!sreRes.ok) throw new Error(sreJson.error || 'Kunde inte ladda anställd')
      setData({ run: runJson.data, runEmployee: sreJson.data })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Okänt fel')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, employeeId])

  const handleCalculate = async () => {
    setCalculating(true)
    setError(null)
    try {
      const res = await fetch(`/api/salary/runs/${runId}/calculate`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(json.error || 'Beräkning misslyckades')
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Okänt fel')
    } finally {
      setCalculating(false)
    }
  }

  const periodStart = useMemo(() => {
    if (!data) return ''
    const y = data.run.period_year
    const m = data.run.period_month
    return `${y}-${String(m).padStart(2, '0')}-01`
  }, [data])

  const periodEnd = useMemo(() => {
    if (!data) return ''
    const y = data.run.period_year
    const m = data.run.period_month
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
    return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`
  }, [data])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Laddar...
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="space-y-3">
        <Link
          href={`/salary/runs/${runId}`}
          className="inline-flex items-center text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Tillbaka till lönekörning
        </Link>
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error ?? 'Kunde inte ladda anställd'}
        </div>
      </div>
    )
  }

  const { run, runEmployee } = data
  const employee = runEmployee.employee
  const lineItems = runEmployee.line_items ?? []
  const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  const readOnly = run.status !== 'draft' && run.status !== 'review'

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-3">
        <Link
          href={`/salary/runs/${runId}`}
          className="inline-flex items-center text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Tillbaka till lönekörning
        </Link>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h1 className="font-display text-2xl tracking-tight">
              {employee.first_name} {employee.last_name}
            </h1>
            <p className="text-sm text-muted-foreground tabular-nums">
              {employee.personnummer} · Lönespecifikation {periodLabel}
            </p>
          </div>
          {run.status === 'draft' && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCalculate}
              disabled={calculating}
            >
              {calculating ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Calculator className="mr-1.5 h-3.5 w-3.5" />
              )}
              Beräkna
            </Button>
          )}
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="Brutto" value={runEmployee.gross_salary} />
        <SummaryCard
          label="Skatt"
          value={runEmployee.tax_withheld_override ?? runEmployee.tax_withheld}
          overridden={runEmployee.tax_withheld_override !== null}
        />
        <SummaryCard
          label="Netto"
          value={runEmployee.net_salary + (runEmployee.tax_withheld - (runEmployee.tax_withheld_override ?? runEmployee.tax_withheld))}
          accent
          overridden={runEmployee.tax_withheld_override !== null}
        />
        <SummaryCard
          label="Avgifter"
          value={runEmployee.avgifter_amount_override ?? runEmployee.avgifter_amount}
          overridden={runEmployee.avgifter_amount_override !== null}
        />
      </div>

      {/* Advanced mode: per-employee override of tax / arbetsgivaravgift */}
      {run.status === 'review' && (
        <SalaryOverridePanel
          runId={runId}
          employeeId={employeeId}
          taxWithheld={runEmployee.tax_withheld}
          taxOverride={runEmployee.tax_withheld_override}
          avgifterAmount={runEmployee.avgifter_amount}
          avgifterOverride={runEmployee.avgifter_amount_override}
          avgifterBasis={runEmployee.avgifter_basis}
          avgifterBasisOverride={runEmployee.avgifter_basis_override}
          reason={runEmployee.override_reason}
          onSaved={load}
          disabled={readOnly}
        />
      )}

      {/* Unified calendar: worked time (for hourly) + absence on the same grid */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tid och frånvaro</CardTitle>
          <p className="text-xs text-muted-foreground">
            {employee.salary_type === 'hourly'
              ? 'Markera dagar och ange arbetade timmar eller frånvaro. Grundlönen räknas som timlön × summa arbetade timmar. Karensavdrag, sjuklön och AGI-rapportering härleds automatiskt.'
              : 'Markera sjukdom, VAB, föräldraledighet och annan frånvaro per dag. Karensavdrag, sjuklön och AGI-rapportering räknas ut automatiskt.'}
          </p>
        </CardHeader>
        <CardContent>
          <SalaryCalendar
            employeeId={employee.id}
            salaryType={employee.salary_type}
            periodStart={periodStart}
            periodEnd={periodEnd}
            salaryRunEmployeeId={runEmployee.id}
            readOnly={readOnly}
            onChange={load}
            onAbsenceCountsChange={setLiveCounts}
          />
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <AbsenceCount label="Sjukdagar" days={liveCounts?.sick ?? runEmployee.sick_days} />
            <AbsenceCount label="VAB-dagar" days={liveCounts?.vab ?? runEmployee.vab_days} />
            <AbsenceCount label="Föräldraledig" days={liveCounts?.parental ?? runEmployee.parental_days} />
          </div>
        </CardContent>
      </Card>

      {/* Line items */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lönerader ({lineItems.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {lineItems.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              Inga lönerader. Kör beräkning på lönekörningen för att skapa standardrader.
            </p>
          ) : (
            <table className="w-full">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="px-4 py-2">Typ</th>
                  <th className="px-4 py-2">Beskrivning</th>
                  <th className="px-4 py-2 text-right">Antal</th>
                  <th className="px-4 py-2 text-right">Belopp</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map(li => (
                  <tr key={li.id} className="border-b last:border-0">
                    <td className="px-4 py-2 text-xs text-muted-foreground">{LINE_ITEM_TYPE_LABELS[li.item_type] ?? li.item_type}</td>
                    <td className="px-4 py-2 text-sm">{li.description}</td>
                    <td className="px-4 py-2 text-sm text-right tabular-nums">{li.quantity ?? '-'}</td>
                    <td className="px-4 py-2 text-sm text-right tabular-nums">{formatCurrency(li.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function SummaryCard({ label, value, accent, overridden }: { label: string; value: number; accent?: boolean; overridden?: boolean }) {
  return (
    <div className={`rounded-md border bg-card p-3 ${accent ? 'ring-1 ring-primary/40' : ''} ${overridden ? 'ring-1 ring-warning/40' : ''}`}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {label}
        {overridden && <span className="text-[10px] uppercase tracking-wider text-warning">Justerat</span>}
      </div>
      <div className="mt-0.5 text-lg font-medium tabular-nums">{formatCurrency(value)}</div>
    </div>
  )
}

function AbsenceCount({ label, days }: { label: string; days: number }) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-medium tabular-nums">{days} dagar</div>
    </div>
  )
}
