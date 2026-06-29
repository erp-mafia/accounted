'use client'

import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  ArrowLeft, Calculator, Eye, Check, CreditCard, BookOpen,
  ArrowLeftCircle, Loader2, Download, FileDown, Trash2,
} from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { SalaryRun, SalaryRunEmployee, Employee, CreateJournalEntryLineInput } from '@/types'
import { AGIPanel } from '@/components/salary/AGIPanel'
import { PaymentFilePanel } from '@/components/salary/PaymentFilePanel'
import { TaxPaymentPanel } from '@/components/salary/TaxPaymentPanel'
import { TaxTableStatus } from '@/components/salary/TaxTableStatus'

type SalaryRunWithArbetsgivare = SalaryRun & { arbetsgivare?: string | null }

const STATUS_LABELS: Record<string, string> = {
  draft: 'Utkast',
  review: 'Granskning',
  approved: 'Godkänd',
  paid: 'Betald',
  booked: 'Bokförd',
  corrected: 'Korrigerad',
}

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  draft: 'secondary',
  review: 'warning',
  approved: 'default',
  paid: 'success',
  booked: 'success',
  corrected: 'secondary',
}

interface EntryPreview {
  description: string
  lines: CreateJournalEntryLineInput[]
}

interface PreviewData {
  salaryEntry: EntryPreview | null
  avgifterEntry: EntryPreview | null
  vacationEntry: EntryPreview | null
}

export default function SalaryRunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [run, setRun] = useState<SalaryRun | null>(null)
  const [availableEmployees, setAvailableEmployees] = useState<Employee[]>([])
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [addEmployeeKey, setAddEmployeeKey] = useState(0)
  const [preferredPaymentFormat, setPreferredPaymentFormat] = useState<'bg_lb' | 'pain001'>('bg_lb')
  const [taxPayment, setTaxPayment] = useState<{
    tax_payment_file_generated_at: string | null
    tax_paid_at: string | null
  } | null>(null)

  async function loadRun() {
    const res = await fetch(`/api/salary/runs/${id}`)
    if (res.ok) {
      const { data } = await res.json()
      setRun(data)
      if (data?.period_year && data?.period_month) {
        const period = `${data.period_year}-${String(data.period_month).padStart(2, '0')}`
        const txRes = await fetch(`/api/skatteverket/tax-payments/${period}`)
        if (txRes.ok) {
          const tx = await txRes.json()
          setTaxPayment(tx.data)
        }
      }
    }
  }

  useEffect(() => {
    async function load() {
      await loadRun()
      const empRes = await fetch('/api/salary/employees')
      if (empRes.ok) {
        const { data } = await empRes.json()
        setAvailableEmployees(data || [])
      }
      const settingsRes = await fetch('/api/settings')
      if (settingsRes.ok) {
        const { data } = await settingsRes.json()
        if (data?.preferred_payment_format === 'pain001' || data?.preferred_payment_format === 'bg_lb') {
          setPreferredPaymentFormat(data.preferred_payment_format)
        }
      }
      setLoading(false)
    }
    load()
  }, [id])

  // Refetch when the tab regains focus. AGI can be generated out-of-band — via
  // the MCP server, the public API, or another browser tab — and this page
  // would otherwise keep showing a stale "AGI-fil har inte genererats ännu"
  // (and a stale "AGI-XML saknas" error in the panel below) until a full
  // reload. Reconciling agi_generated_at on visibilitychange picks up that
  // generation without the user hard-refreshing.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') loadRun()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [id])

  async function handleAction(action: string, method: string = 'POST') {
    setActionLoading(action)
    const res = await fetch(`/api/salary/runs/${id}/${action}`, { method })
    if (res.ok) {
      await loadRun()
      toast({ title: 'Status uppdaterad' })
    } else {
      const result = await res.json()
      toast({
        title: 'Kunde inte uppdatera status',
        description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
        variant: 'destructive',
      })
    }
    setActionLoading(null)
  }

  async function handleDelete() {
    if (!run) return
    const period = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
    if (!confirm(`Radera utkastet för ${period}? Alla anställda och beräkningar i körningen tas bort. Detta kan inte ångras.`)) return
    setActionLoading('delete')
    const res = await fetch(`/api/salary/runs/${id}`, { method: 'DELETE' })
    if (res.ok) {
      toast({ title: 'Utkast raderat' })
      router.push('/salary')
      return
    }
    const result = await res.json()
    toast({
      title: 'Kunde inte radera utkast',
      description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
      variant: 'destructive',
    })
    setActionLoading(null)
  }

  async function handleAddEmployee(employeeId: string) {
    setActionLoading('add-employee')
    const res = await fetch(`/api/salary/runs/${id}/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: employeeId }),
    })
    if (res.ok) {
      await loadRun()
      toast({ title: 'Anställd tillagd' })
    } else {
      const result = await res.json()
      toast({
        title: 'Kunde inte lägga till anställd',
        description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
        variant: 'destructive',
      })
    }
    setActionLoading(null)
  }

  // Remove an employee from a draft run. The DELETE endpoint is draft-only and
  // cascades to the employee's line items; the button is only rendered while the
  // run is a draft, matching that guard.
  async function handleRemoveEmployee(employeeId: string, name: string) {
    if (!confirm(`Ta bort ${name} från lönekörningen?`)) return
    setActionLoading(`remove-${employeeId}`)
    const res = await fetch(`/api/salary/runs/${id}/employees/${employeeId}`, {
      method: 'DELETE',
    })
    if (res.ok) {
      await loadRun()
      toast({ title: 'Anställd borttagen' })
    } else {
      const result = await res.json()
      toast({
        title: 'Kunde inte ta bort anställd',
        description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
        variant: 'destructive',
      })
    }
    setActionLoading(null)
  }

  // Edit this month's monthly salary for one employee (draft only). The engine
  // reads this per-run value at calc time, so each month's gross can differ
  // without changing the employee's standard pay. Saved on blur; the user then
  // clicks Beräkna to refresh the outcome.
  async function handleSalaryEdit(employeeId: string, raw: string, previous: number) {
    const monthly = Number(raw.replace(/\s/g, '').replace(',', '.'))
    if (!Number.isFinite(monthly) || monthly < 0 || monthly === previous) return
    setActionLoading(`salary-${employeeId}`)
    const res = await fetch(`/api/salary/runs/${id}/employees/${employeeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthly_salary: monthly }),
    })
    if (res.ok) {
      await loadRun()
      toast({ title: 'Månadslön uppdaterad', description: 'Klicka Beräkna för att uppdatera utfallet.' })
    } else {
      const result = await res.json()
      toast({
        title: 'Kunde inte uppdatera månadslön',
        description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
        variant: 'destructive',
      })
    }
    setActionLoading(null)
  }

  async function handleCalculate() {
    setActionLoading('calculate')
    const res = await fetch(`/api/salary/runs/${id}/calculate`, { method: 'POST' })
    if (res.ok) {
      const payload = await res.json()
      await loadRun()
      const warnings = (payload.warnings as string[] | undefined) ?? []
      if (warnings.length === 0) {
        toast({ title: 'Beräkning klar' })
      } else {
        for (const warning of warnings) {
          toast({ title: 'Att kontrollera', description: warning })
        }
      }
    } else {
      const result = await res.json()
      toast({
        title: 'Beräkningsfel',
        description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
        variant: 'destructive',
      })
    }
    setActionLoading(null)
  }

  async function handlePreview() {
    setActionLoading('preview')
    const res = await fetch(`/api/salary/runs/${id}/preview`)
    if (res.ok) {
      const { data } = await res.json()
      setPreview(data)
    }
    setActionLoading(null)
  }

  async function handleBulkPayslipDownload() {
    setActionLoading('bulk_payslip')
    try {
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      const periodLabel = `${run!.period_year}-${String(run!.period_month).padStart(2, '0')}`
      let added = 0
      for (const sre of employees) {
        const employee = (sre as SalaryRunEmployee & { employee?: { first_name: string; last_name: string } }).employee
        const res = await fetch(`/api/salary/runs/${id}/payslips/${sre.employee_id}/pdf`)
        if (!res.ok) continue
        const blob = await res.blob()
        const name = employee
          ? `${employee.last_name}_${employee.first_name}`.replace(/[^A-Za-z0-9_-]/g, '_')
          : sre.employee_id.slice(0, 8)
        zip.file(`Lonespec_${periodLabel}_${name}.pdf`, blob)
        added++
      }
      if (added === 0) {
        toast({ title: 'Inga lönespecifikationer kunde laddas ner', variant: 'destructive' })
        return
      }
      const archive = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(archive)
      const a = document.createElement('a')
      a.href = url
      a.download = `Lonespec_${periodLabel}.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast({ title: 'Lönespecifikationer nedladdade', description: `${added} stycken i zip-arkiv.` })
    } catch (err) {
      toast({
        title: 'Kunde inte skapa zip-fil',
        description: err instanceof Error ? err.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setActionLoading(null)
    }
  }

  async function handleDownloadAgi() {
    setActionLoading('agi-download')
    const res = await fetch(`/api/salary/runs/${id}/agi/xml`)
    if (!res.ok) {
      const result = await res.json().catch(() => ({ error: 'Kunde inte generera AGI-fil' }))
      toast({
        title: 'AGI-fil kunde inte genereras',
        description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
        variant: 'destructive',
      })
      setActionLoading(null)
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const periodLabel = `${run!.period_year}${String(run!.period_month).padStart(2, '0')}`
    const a = document.createElement('a')
    a.href = url
    a.download = `AGI_${periodLabel}.xml`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    await loadRun()
    toast({ title: 'AGI-fil nedladdad' })
    setActionLoading(null)
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-60" />
        <Skeleton className="rounded-lg h-48" />
      </div>
    )
  }

  if (!run) {
    return <p className="text-muted-foreground">Lönekörning hittades inte</p>
  }

  const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  const employees = (run.employees || []) as SalaryRunEmployee[]
  const addedEmployeeIds = new Set(employees.map(e => e.employee_id))
  const notAdded = availableEmployees.filter(e => !addedEmployeeIds.has(e.id))
  // Employees can only be removed while the run is a draft (matches the DELETE
  // endpoint's guard); gate the row action column on the same condition.
  const canRemoveEmployee = run.status === 'draft' && canWrite

  // calculation_params is frozen only when the run has been calculated, so it
  // distinguishes "not yet calculated" from "calculated to 0" (a nollkörning).
  const isCalculated = run.calculation_params != null
  const isNollkorning = isCalculated && Math.round((run.total_gross ?? 0) * 100) === 0

  // Advancing a draft to review. For a nollkörning confirm first — an empty
  // declaration is filed to Skatteverket, which should be deliberate.
  function handleToReview() {
    if (
      isNollkorning &&
      !confirm(
        'Detta är en nollkörning — ingen lön rapporteras för perioden. ' +
          'En nolldeklaration (huvuduppgift utan individuppgifter) lämnas till Skatteverket. Vill du fortsätta?',
      )
    ) {
      return
    }
    handleAction('review')
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/salary" aria-label="Tillbaka till löner"><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <div>
            <h1 className="font-display text-2xl md:text-3xl tracking-tight">
              Lönekörning {periodLabel}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Utbetalning: {formatDate(run.payment_date)}
            </p>
          </div>
        </div>
        <Badge variant={STATUS_VARIANTS[run.status] || 'secondary'}>
          {STATUS_LABELS[run.status]}
        </Badge>
      </div>

      {/* Summary cards — recompute from per-employee rows so manual overrides
          (avancerat läge) are reflected immediately, without relying on
          run.total_* columns which are frozen at calculate-time. */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {(() => {
          const effTax = employees.reduce((s, e) => s + (e.tax_withheld_override ?? e.tax_withheld), 0)
          const effAvgifter = employees.reduce((s, e) => s + (e.avgifter_amount_override ?? e.avgifter_amount), 0)
          const effNet = employees.reduce(
            (s, e) => s + (e.net_salary + (e.tax_withheld - (e.tax_withheld_override ?? e.tax_withheld))),
            0,
          )
          const effEmployerCost = employees.reduce(
            (s, e) => s + e.gross_salary + (e.avgifter_amount_override ?? e.avgifter_amount) + e.vacation_accrual + e.vacation_accrual_avgifter,
            0,
          )
          return [
            { label: 'Brutto', value: run.total_gross },
            { label: 'Skatt', value: effTax },
            { label: 'Netto', value: effNet, accent: true },
            { label: 'Avgifter', value: effAvgifter },
            { label: 'Total kostnad', value: effEmployerCost },
          ]
        })().map(({ label, value, accent }) => (
          <Card key={label}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-2">{label}</p>
              <p className={`font-display text-xl tabular-nums leading-tight ${accent ? 'text-success' : ''}`}>
                {formatCurrency(value)}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {isNollkorning && (
        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-medium">Nollkörning</p>
            <p className="text-sm text-muted-foreground mt-1">
              Ingen lön rapporteras för {periodLabel}. En nolldeklaration (huvuduppgift utan
              individuppgifter) lämnas till Skatteverket — en registrerad arbetsgivare måste lämna
              arbetsgivardeklaration varje månad, även månader utan lön.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Employees */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Anställda ({employees.length})</CardTitle>
          <div className="flex items-center gap-2">
            {employees.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleBulkPayslipDownload}
                disabled={actionLoading === 'bulk_payslip'}
                className="h-8 text-sm"
              >
                {actionLoading === 'bulk_payslip' ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileDown className="mr-1.5 h-3.5 w-3.5" />
                )}
                Ladda ner alla
              </Button>
            )}
            {run.status === 'draft' && canWrite && notAdded.length > 0 && (
              <Select
                key={addEmployeeKey}
                onValueChange={(value) => {
                  handleAddEmployee(value)
                  setAddEmployeeKey(k => k + 1)
                }}
              >
                <SelectTrigger className="w-[200px] h-8 text-sm">
                  <SelectValue placeholder="Lägg till anställd..." />
                </SelectTrigger>
                <SelectContent>
                  {notAdded.map(emp => (
                    <SelectItem key={emp.id} value={emp.id}>{emp.first_name} {emp.last_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {employees.length === 0 ? (
            <p className="text-sm text-muted-foreground px-4 py-6 text-center">
              Inga anställda tillagda ännu
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Anställd</TableHead>
                  <TableHead className="hidden md:table-cell text-right">{run.status === 'draft' ? 'Månadslön' : 'Brutto'}</TableHead>
                  <TableHead className="hidden lg:table-cell text-right">Skatt</TableHead>
                  <TableHead className="text-right">Netto</TableHead>
                  <TableHead className="hidden lg:table-cell text-right">Avgifter</TableHead>
                  <TableHead className="hidden md:table-cell text-right">Semester</TableHead>
                  <TableHead className="text-right w-[80px]">Lönespec</TableHead>
                  {canRemoveEmployee && <TableHead className="w-[48px]"><span className="sr-only">Ta bort</span></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {employees.map(sre => {
                  const employee = (sre as SalaryRunEmployee & { employee?: { first_name: string; last_name: string; personnummer: string } }).employee
                  const name = employee
                    ? `${employee.first_name} ${employee.last_name}`
                    : `Anställd ${sre.employee_id.slice(0, 8)}...`
                  const taxValue = sre.tax_withheld_override ?? sre.tax_withheld
                  const avgifterValue = sre.avgifter_amount_override ?? sre.avgifter_amount
                  // Monthly salary is editable per run while the run is a draft.
                  const editableSalary = run.status === 'draft' && canWrite && sre.salary_type === 'monthly'
                  return (
                    <TableRow
                      key={sre.id}
                      className="cursor-pointer"
                      onClick={() => router.push(`/salary/runs/${id}/employees/${sre.employee_id}`)}
                    >
                      <TableCell className="font-medium">
                        <Link
                          href={`/salary/runs/${id}/employees/${sre.employee_id}`}
                          className="hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {name}
                        </Link>
                        <span className="md:hidden block text-xs text-muted-foreground font-normal mt-0.5 tabular-nums">
                          {run.status === 'draft'
                            ? `Månadslön ${formatCurrency(sre.monthly_salary)}`
                            : `Brutto ${formatCurrency(sre.gross_salary)}`}
                        </span>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-right tabular-nums">
                        {editableSalary ? (
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            defaultValue={sre.monthly_salary}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={(e) => handleSalaryEdit(sre.employee_id, e.target.value, sre.monthly_salary)}
                            disabled={actionLoading === `salary-${sre.employee_id}`}
                            aria-label={`Månadslön för ${name}`}
                            className="h-8 w-32 ml-auto text-right tabular-nums"
                          />
                        ) : (
                          formatCurrency(sre.gross_salary)
                        )}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-right tabular-nums">{formatCurrency(taxValue)}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{formatCurrency(sre.net_salary + (sre.tax_withheld - taxValue))}</TableCell>
                      <TableCell className="hidden lg:table-cell text-right tabular-nums">{formatCurrency(avgifterValue)}</TableCell>
                      <TableCell className="hidden md:table-cell text-right tabular-nums">{formatCurrency(sre.vacation_accrual)}</TableCell>
                      <TableCell className="text-right">
                        <a
                          href={`/api/salary/runs/${id}/payslips/${sre.employee_id}/pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                          title="Visa lönespecifikation"
                        >
                          <FileDown className="h-3.5 w-3.5" />
                          Visa PDF
                        </a>
                      </TableCell>
                      {canRemoveEmployee && (
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleRemoveEmployee(sre.employee_id, name)
                            }}
                            disabled={actionLoading === `remove-${sre.employee_id}`}
                            aria-label={`Ta bort ${name} från lönekörningen`}
                            title="Ta bort från lönekörningen"
                          >
                            {actionLoading === `remove-${sre.employee_id}` ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Calculation breakdown (if available) */}
      {employees.some(e => e.calculation_breakdown) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Beräkningsdetaljer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <TaxTableStatus year={run.period_year} compact />
            {employees.filter(e => e.calculation_breakdown).map(sre => {
              const breakdown = sre.calculation_breakdown as { steps?: Array<{ label: string; formula: string; output: number | null }> }
              return (
                <div key={sre.id} className="space-y-2">
                  <h4 className="text-sm font-medium">
                    {(sre as SalaryRunEmployee & { employee?: { first_name: string; last_name: string } }).employee
                      ? `${(sre as SalaryRunEmployee & { employee: { first_name: string; last_name: string } }).employee.first_name} ${(sre as SalaryRunEmployee & { employee: { first_name: string; last_name: string } }).employee.last_name}`
                      : sre.employee_id.slice(0, 8)}
                  </h4>
                  <div className="text-xs space-y-1 bg-muted/50 rounded-lg p-3">
                    {(breakdown?.steps || []).map((step, i) => (
                      <div key={i} className="flex justify-between gap-4">
                        <span className="text-muted-foreground">
                          {step.label}: <span className="font-mono">{step.formula}</span>
                        </span>
                        {step.output !== null && (
                          <span className="font-medium tabular-nums">{formatCurrency(step.output)}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      {/* Journal preview */}
      {preview && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Förhandsgranskning — verifikationer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {(() => {
              const entries = [
                preview.salaryEntry,
                preview.avgifterEntry,
                preview.vacationEntry,
                (preview as unknown as Record<string, EntryPreview | null>).pensionEntry,
              ].filter(Boolean) as EntryPreview[]
              if (entries.length === 0) {
                return (
                  <p className="text-sm text-muted-foreground">
                    Nollkörning — inga verifikat bokförs för den här körningen.
                    Kontrollera att övriga lönekörningar för perioden täcker
                    arbetsgivardeklarationen till Skatteverket.
                  </p>
                )
              }
              return entries.map((entry, idx) => (
                <div key={idx} className="space-y-2">
                  <h4 className="text-sm font-medium">{entry.description}</h4>
                  <table className="w-full text-xs">
                    <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                      <tr className="border-b">
                        <th className="text-left py-1">Konto</th>
                        <th className="text-left py-1">Beskrivning</th>
                        <th className="text-right py-1">Debet</th>
                        <th className="text-right py-1">Kredit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entry.lines.map((line, li) => (
                        <tr key={li} className="border-t border-border/30">
                          <td className="py-1.5 tabular-nums font-mono">{line.account_number}</td>
                          <td className="py-1.5 text-muted-foreground">{line.line_description}</td>
                          <td className="py-1.5 text-right tabular-nums">{line.debit_amount ? formatCurrency(line.debit_amount) : ''}</td>
                          <td className="py-1.5 text-right tabular-nums">{line.credit_amount ? formatCurrency(line.credit_amount) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))
            })()}
          </CardContent>
        </Card>
      )}

      {/* Payment file — available once the run is approved */}
      {['approved', 'paid', 'booked'].includes(run.status) && (
        <PaymentFilePanel
          salaryRunId={id}
          periodLabel={periodLabel}
          paymentFileFormat={run.payment_file_format}
          paymentFileGeneratedAt={run.payment_file_generated_at}
          defaultFormat={preferredPaymentFormat}
          readOnly={!canWrite}
          onDownloaded={loadRun}
        />
      )}

      {/* Tax payment (skatt + arbetsgivaravgifter) — once AGI has been generated */}
      {run.status === 'booked' && run.agi_generated_at && (
        <TaxPaymentPanel
          period={periodLabel}
          totalTax={run.total_tax}
          totalAvgifter={run.total_avgifter}
          paymentFileGeneratedAt={taxPayment?.tax_payment_file_generated_at ?? null}
          taxPaidAt={taxPayment?.tax_paid_at ?? null}
          readOnly={!canWrite}
          onChange={loadRun}
        />
      )}

      {/* AGI (Arbetsgivardeklaration) — available once the run is booked */}
      {run.status === 'booked' && (
        <div className="space-y-3">
          <AGIPanel
            salaryRunId={id}
            arbetsgivare={(run as SalaryRunWithArbetsgivare).arbetsgivare ?? ''}
            period={`${run.period_year}${String(run.period_month).padStart(2, '0')}`}
            agiGeneratedAt={run.agi_generated_at}
            agiSubmittedAt={run.agi_submitted_at}
            readOnly={!canWrite}
            onChange={loadRun}
          />
          {canWrite && (
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadAgi}
                disabled={!!actionLoading}
              >
                {actionLoading === 'agi-download' ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                Ladda ner AGI-fil (XML)
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      {canWrite && (
        <div className="flex flex-wrap gap-3 justify-end">
          {run.status === 'draft' && (
            <>
              <Button variant="outline" onClick={handleDelete} disabled={!!actionLoading} className="text-destructive hover:text-destructive mr-auto">
                {actionLoading === 'delete' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                Radera utkast
              </Button>
              <Button variant="outline" onClick={handleCalculate} disabled={!!actionLoading}>
                {actionLoading === 'calculate' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Calculator className="mr-2 h-4 w-4" />}
                Beräkna
              </Button>
              <Button variant="outline" onClick={handlePreview} disabled={!!actionLoading || run.total_gross === 0}>
                {actionLoading === 'preview' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
                Förhandsgranska
              </Button>
              <Button onClick={handleToReview} disabled={!!actionLoading || !isCalculated}>
                Till granskning
              </Button>
            </>
          )}
          {run.status === 'review' && (
            <>
              <Button variant="outline" onClick={() => handleAction('revert')} disabled={!!actionLoading}>
                <ArrowLeftCircle className="mr-2 h-4 w-4" />
                Tillbaka till utkast
              </Button>
              <Button variant="outline" onClick={handlePreview} disabled={!!actionLoading}>
                <Eye className="mr-2 h-4 w-4" />
                Förhandsgranska
              </Button>
              <Button onClick={() => handleAction('approve')} disabled={!!actionLoading}>
                <Check className="mr-2 h-4 w-4" />
                Godkänn
              </Button>
            </>
          )}
          {run.status === 'approved' && (
            <Button onClick={() => handleAction('paid')} disabled={!!actionLoading}>
              <CreditCard className="mr-2 h-4 w-4" />
              Markera som betald
            </Button>
          )}
          {run.status === 'paid' && (
            <Button onClick={() => handleAction('book')} disabled={!!actionLoading}>
              {actionLoading === 'book' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <BookOpen className="mr-2 h-4 w-4" />}
              Bokför
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
