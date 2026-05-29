'use client'

import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  ArrowLeft, Calculator, Eye, Check, CreditCard, BookOpen,
  ArrowLeftCircle, Loader2, Download, Clock, ChevronDown,
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
  salaryEntry: EntryPreview
  avgifterEntry: EntryPreview
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
  const [showBreakdown, setShowBreakdown] = useState(false)

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

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/salary" aria-label="Tillbaka till löner"><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <div>
            <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">
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

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: 'Brutto', value: run.total_gross },
          { label: 'Skatt', value: run.total_tax },
          { label: 'Netto', value: run.total_net, accent: true },
          { label: 'Avgifter', value: run.total_avgifter },
          { label: 'Total kostnad', value: run.total_employer_cost },
        ].map(({ label, value, accent }) => (
          <Card key={label}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-2">{label}</p>
              <p className={`font-display text-xl font-medium tabular-nums leading-tight ${accent ? 'text-success' : ''}`}>
                {formatCurrency(value)}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Employees */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Anställda ({employees.length})</CardTitle>
          <div className="flex items-center gap-2">
            {employees.length > 0 && canWrite && (run.status === 'draft' || run.status === 'review') && (
              <Button asChild variant="outline" size="sm" className="h-8">
                <Link href={`/salary/runs/${id}/time-entry`}>
                  <Clock className="mr-1 h-3.5 w-3.5" /> Registrera tid
                </Link>
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
                  <TableHead className="hidden md:table-cell text-right">Brutto</TableHead>
                  <TableHead className="hidden lg:table-cell text-right">Skatt</TableHead>
                  <TableHead className="text-right">Netto</TableHead>
                  <TableHead className="hidden lg:table-cell text-right">Avgifter</TableHead>
                  <TableHead className="hidden md:table-cell text-right">Semester</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {employees.map(sre => {
                  const employee = (sre as SalaryRunEmployee & { employee?: { first_name: string; last_name: string; personnummer: string } }).employee
                  const name = employee
                    ? `${employee.first_name} ${employee.last_name}`
                    : `Anställd ${sre.employee_id.slice(0, 8)}...`
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
                          Brutto {formatCurrency(sre.gross_salary)}
                        </span>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-right tabular-nums">{formatCurrency(sre.gross_salary)}</TableCell>
                      <TableCell className="hidden lg:table-cell text-right tabular-nums">{formatCurrency(sre.tax_withheld)}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{formatCurrency(sre.net_salary)}</TableCell>
                      <TableCell className="hidden lg:table-cell text-right tabular-nums">{formatCurrency(sre.avgifter_amount)}</TableCell>
                      <TableCell className="hidden md:table-cell text-right tabular-nums">{formatCurrency(sre.vacation_accrual)}</TableCell>
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
            <button
              type="button"
              onClick={() => setShowBreakdown(v => !v)}
              aria-expanded={showBreakdown}
              className="flex w-full items-center justify-between text-left"
            >
              <CardTitle className="text-base">Beräkningsdetaljer</CardTitle>
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform ${showBreakdown ? 'rotate-180' : ''}`}
              />
            </button>
          </CardHeader>
          {showBreakdown && (
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
          )}
        </Card>
      )}

      {/* Journal preview */}
      {preview && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Förhandsgranskning — verifikationer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {[preview.salaryEntry, preview.avgifterEntry, preview.vacationEntry, (preview as unknown as Record<string, EntryPreview | null>).pensionEntry].filter(Boolean).map((entry, idx) => (
              <div key={idx} className="space-y-2">
                <h4 className="text-sm font-medium">{entry!.description}</h4>
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
                    {entry!.lines.map((line, li) => (
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
            ))}
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
              <Button variant="outline" onClick={handleCalculate} disabled={!!actionLoading || employees.length === 0}>
                {actionLoading === 'calculate' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Calculator className="mr-2 h-4 w-4" />}
                Beräkna
              </Button>
              <Button variant="outline" onClick={handlePreview} disabled={!!actionLoading || run.total_gross === 0}>
                {actionLoading === 'preview' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
                Förhandsgranska
              </Button>
              <Button onClick={() => handleAction('review')} disabled={!!actionLoading || run.total_gross === 0}>
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
