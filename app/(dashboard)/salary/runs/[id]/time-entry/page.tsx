'use client'

import { use, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { BulkTimeEntryTable, type RunEmployeeOption, type ExistingTimeEntry } from '@/components/salary/BulkTimeEntryTable'
import type { SalaryRun, SalaryRunEmployee, Employee } from '@/types'

export default function SalaryRunTimeEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const [run, setRun] = useState<SalaryRun | null>(null)
  const [entries, setEntries] = useState<ExistingTimeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/salary/runs/${id}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Kunde inte ladda lönekörningen')
      const runData = json.data as SalaryRun
      setRun(runData)

      // Pull every worked-day + absence-day already saved for the period so the
      // table can show (and edit) them. One pair of requests per employee, run
      // in parallel.
      const y = runData.period_year
      const m = runData.period_month
      const from = `${y}-${String(m).padStart(2, '0')}-01`
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
      const to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

      const list = (runData.employees ?? []) as SalaryRunEmployee[]
      const order = new Map(list.map((s, i) => [s.employee_id, i]))
      const collected: ExistingTimeEntry[] = []

      await Promise.all(list.map(async (sre) => {
        const empId = sre.employee_id
        const [wRes, aRes] = await Promise.all([
          fetch(`/api/salary/employees/${empId}/worked-hours?from=${from}&to=${to}`),
          fetch(`/api/salary/employees/${empId}/absence?from=${from}&to=${to}`),
        ])
        if (wRes.ok) {
          const wj = await wRes.json()
          for (const d of (wj.data ?? [])) {
            collected.push({ employeeId: empId, kind: 'worked', date: d.work_date, hours: Number(d.hours), notes: d.notes ?? null })
          }
        }
        if (aRes.ok) {
          const aj = await aRes.json()
          for (const d of (aj.data ?? [])) {
            collected.push({ employeeId: empId, kind: d.absence_type, date: d.absence_date, hours: Number(d.hours), notes: d.notes ?? null })
          }
        }
      }))

      collected.sort((a, b) =>
        (order.get(a.employeeId)! - order.get(b.employeeId)!) || a.date.localeCompare(b.date))
      setEntries(collected)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Okänt fel')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  const periodStart = useMemo(() => {
    if (!run) return ''
    return `${run.period_year}-${String(run.period_month).padStart(2, '0')}-01`
  }, [run])

  const periodEnd = useMemo(() => {
    if (!run) return ''
    const last = new Date(Date.UTC(run.period_year, run.period_month, 0)).getUTCDate()
    return `${run.period_year}-${String(run.period_month).padStart(2, '0')}-${String(last).padStart(2, '0')}`
  }, [run])

  const employees = useMemo<RunEmployeeOption[]>(() => {
    const list = (run?.employees ?? []) as SalaryRunEmployee[]
    return list.map(sre => {
      const emp = sre.employee as (Employee & { personnummer_last4?: string | null }) | undefined
      const name = emp ? `${emp.first_name} ${emp.last_name}` : `Anställd ${sre.employee_id.slice(0, 8)}…`
      return {
        sreId: sre.id,
        employeeId: sre.employee_id,
        name,
        salaryType: sre.salary_type,
        personnummer: emp?.personnummer ?? null,
        personnummerLast4: emp?.personnummer_last4 ?? null,
      }
    })
  }, [run])

  // Time can only be registered while the run is editable. After approval the
  // rows are locked (same rule as the per-employee calendar view).
  const readOnly = !canWrite || (run != null && run.status !== 'draft' && run.status !== 'review')

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Laddar…
      </div>
    )
  }

  if (error || !run) {
    return (
      <div className="space-y-3">
        <Link href={`/salary/runs/${id}`} className="inline-flex items-center text-sm text-muted-foreground hover:underline">
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Tillbaka till lönekörning
        </Link>
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error ?? 'Kunde inte ladda lönekörningen'}
        </div>
      </div>
    )
  }

  const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`

  return (
    <div className="space-y-6">
      <Link href={`/salary/runs/${id}`} className="inline-flex items-center text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Tillbaka till lönekörning
      </Link>
      <PageHeader
        title="Registrera tid"
        description={`Lägg till arbetade timmar och frånvaro för perioden ${periodLabel} i en tabell — ett alternativ till kalendern per anställd. Varje rad sparas mot vald anställd i den här lönekörningen.`}
      />

      {readOnly && (
        <div className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning-foreground">
          {canWrite
            ? 'Lönekörningen är inte längre ett utkast — tid kan inte registreras.'
            : 'Du har skrivskyddad åtkomst till det här företaget.'}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tidrader</CardTitle>
          <p className="text-xs text-muted-foreground">
            Redan registrerad tid för perioden visas nedan och kan ändras eller tas bort. Arbetad tid
            gäller endast timavlönade; frånvaro (sjukdom, VAB, föräldraledighet m.m.) gäller alla.
            Befintlig tid för samma anställd och dag skrivs över; kombinationen får inte överstiga
            24 timmar per dag.
          </p>
        </CardHeader>
        <CardContent>
          <BulkTimeEntryTable
            periodStart={periodStart}
            periodEnd={periodEnd}
            employees={employees}
            initialEntries={entries}
            readOnly={readOnly}
            onChanged={() => {
              toast({ title: 'Tid uppdaterad', description: 'Räkna om lönekörningen för att uppdatera beloppen.' })
            }}
          />
        </CardContent>
      </Card>
    </div>
  )
}
