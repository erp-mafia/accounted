'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { AlertTriangle, Download, Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { AGIPanel } from '@/components/salary/AGIPanel'
import { PaymentFilePanel } from '@/components/salary/PaymentFilePanel'
import { TaxPaymentPanel } from '@/components/salary/TaxPaymentPanel'
import { RunHeader } from '@/components/salary/run/RunHeader'
import { RunProgressBar } from '@/components/salary/run/RunProgressBar'
import { RunKpiCards } from '@/components/salary/run/RunKpiCards'
import { RunEmployeesTable } from '@/components/salary/run/RunEmployeesTable'
import { RunCalculationDetails } from '@/components/salary/run/RunCalculationDetails'
import { RunJournalPreview, type PreviewData } from '@/components/salary/run/RunJournalPreview'
import { periodLabelOf, type RunDetail } from '@/components/salary/run/types'
import type { Employee, SalaryRunEmployee } from '@/types'

export default function SalaryRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const t = useTranslations('salary_run')

  const [run, setRun] = useState<RunDetail | null>(null)
  const [availableEmployees, setAvailableEmployees] = useState<Employee[]>([])
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  // Non-null while the "Godkänn ändå?" dialog is open: holds the missing
  // bank-detail reasons returned by the approve route (overridable block).
  const [approveOverride, setApproveOverride] = useState<string[] | null>(null)
  const [preferredPaymentFormat, setPreferredPaymentFormat] = useState<'bg_lb' | 'pain001'>('pain001')
  const [defaultBank, setDefaultBank] = useState<string | null>(null)
  // Gates the default-dimensions chips on the employee rows: same
  // company_settings.dimensions_enabled UI gate as the voucher form.
  const [dimensionsEnabled, setDimensionsEnabled] = useState(false)
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
      // Employees and settings don't depend on the run - load all three in
      // parallel instead of serially.
      const [, empRes, settingsRes] = await Promise.all([
        loadRun(),
        fetch('/api/salary/employees'),
        fetch('/api/settings'),
      ])
      if (empRes.ok) {
        const { data } = await empRes.json()
        setAvailableEmployees(data || [])
      }
      if (settingsRes.ok) {
        const { data } = await settingsRes.json()
        if (data?.preferred_payment_format === 'pain001' || data?.preferred_payment_format === 'bg_lb') {
          setPreferredPaymentFormat(data.preferred_payment_format)
        }
        setDefaultBank(typeof data?.salary_default_bank === 'string' ? data.salary_default_bank : null)
        setDimensionsEnabled(data?.dimensions_enabled === true)
      }
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Refetch when the tab regains focus. AGI can be generated out-of-band (via
  // the MCP server, the public API, or another browser tab) and this page
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Auto-load the journal preview once the run is calculated, so the
  // "Bokföring (förhandsgranskning)" box renders beside Beräkningsdetaljer
  // without a manual Förhandsgranska click. Re-runs when the calculated totals
  // change (e.g. after Beräkna om) so the preview stays in sync; clears while
  // the run isn't calculated yet.
  const isCalculatedForPreview = run?.calculation_params != null
  useEffect(() => {
    if (!isCalculatedForPreview) {
      setPreview(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const res = await fetch(`/api/salary/runs/${id}/preview`)
      if (!res.ok) return
      const { data } = await res.json()
      if (!cancelled) setPreview(data)
    })()
    return () => {
      cancelled = true
    }
  }, [id, isCalculatedForPreview, run?.total_gross, run?.total_tax, run?.total_avgifter])

  async function handleAction(action: string, method: string = 'POST') {
    setActionLoading(action)
    const res = await fetch(`/api/salary/runs/${id}/${action}`, { method })
    if (res.ok) {
      // Optimistic: the status-transition endpoints return the updated run row.
      // Merge it in immediately so the screen flips without waiting for the
      // heavy detail refetch, then reconcile in the background. This is what
      // makes "Till granskning" / "Godkänn" feel instant.
      const payload = await res.json().catch(() => null)
      if (payload?.data) {
        setRun(prev => (prev ? { ...prev, ...payload.data } : prev))
      }
      setActionLoading(null)
      toast({ title: t('toast_status_updated') })
      loadRun() // background reconcile - not awaited
      return
    }
    const result = await res.json().catch(() => ({}))
    toast({
      title: t('toast_status_failed'),
      description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
      variant: 'destructive',
    })
    setActionLoading(null)
  }

  // Approval is an authorization step. Missing bank details are an *overridable*
  // block (SALARY_APPROVE_BANK_DETAILS_MISSING) - rather than dead-ending on a
  // 400 toast, we surface a confirm dialog and re-approve with ?force=true when
  // the user chooses "Godkänn ändå". The payment-file step still hard-blocks.
  async function doApprove(force: boolean) {
    setActionLoading('approve')
    const res = await fetch(`/api/salary/runs/${id}/approve${force ? '?force=true' : ''}`, {
      method: 'POST',
    })
    if (res.ok) {
      setApproveOverride(null)
      const payload = await res.json().catch(() => null)
      if (payload?.data) {
        setRun(prev => (prev ? { ...prev, ...payload.data } : prev))
      }
      setActionLoading(null)
      toast({ title: t('toast_status_updated') })
      loadRun() // background reconcile - not awaited
      return
    }
    const result = await res.json().catch(() => ({}))
    // Overridable → open the confirm dialog instead of toasting the error.
    if (
      !force &&
      result?.code === 'SALARY_APPROVE_BANK_DETAILS_MISSING' &&
      Array.isArray(result.details)
    ) {
      setApproveOverride(result.details as string[])
      setActionLoading(null)
      return
    }
    setApproveOverride(null)
    toast({
      title: t('toast_status_failed'),
      description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
      variant: 'destructive',
    })
    setActionLoading(null)
  }

  // Recall an approval (approved → review). Approval is only an internal
  // control point, but side effects may already exist — a payment file that
  // could be sitting at the bank, sent payslips, a generated AGI — so the
  // confirm spells out exactly the ones that apply to this run. The API
  // refuses outright once the AGI has been filed with Skatteverket.
  function handleUnapprove() {
    if (!run) return
    const lines = [t('confirm_unapprove_intro')]
    if (run.payment_file_generated_at) lines.push(t('confirm_unapprove_payment_file'))
    if ((run.payslip_deliveries_summary?.sent ?? 0) > 0) lines.push(t('confirm_unapprove_payslips'))
    if (run.agi_generated_at) lines.push(t('confirm_unapprove_agi'))
    if (!confirm(lines.join('\n\n'))) return
    handleAction('unapprove')
  }

  async function handleDelete() {
    if (!run) return
    const period = periodLabelOf(run)
    if (!confirm(t('confirm_delete', { period }))) return
    setActionLoading('delete')
    const res = await fetch(`/api/salary/runs/${id}`, { method: 'DELETE' })
    if (res.ok) {
      toast({ title: t('toast_draft_deleted') })
      router.push('/salary')
      return
    }
    const result = await res.json().catch(() => ({}))
    toast({
      title: t('toast_delete_failed'),
      description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
      variant: 'destructive',
    })
    setActionLoading(null)
  }

  // Storno-based correction (BFL 5 kap. 5 §) - the confirm dialog lives in
  // RunHeader; this fires only after the user has confirmed there.
  async function handleCorrect() {
    setActionLoading('correct')
    const res = await fetch(`/api/salary/runs/${id}/correct`, { method: 'POST' })
    if (res.ok) {
      const { data } = await res.json()
      toast({ title: t('toast_correction_created'), description: t('toast_correction_description') })
      router.push(`/salary/runs/${data.id}`)
      return
    }
    const result = await res.json().catch(() => ({}))
    toast({
      title: t('toast_correction_failed'),
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
      toast({ title: t('toast_employee_added') })
    } else {
      const result = await res.json().catch(() => ({}))
      toast({
        title: t('toast_add_employee_failed'),
        description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
        variant: 'destructive',
      })
    }
    setActionLoading(null)
  }

  // Remove an employee from a draft run. The DELETE endpoint is draft-only and
  // cascades to the employee's line items.
  async function handleRemoveEmployee(employeeId: string, name: string) {
    if (!confirm(t('confirm_remove_employee', { name }))) return
    setActionLoading(`remove-${employeeId}`)
    const res = await fetch(`/api/salary/runs/${id}/employees/${employeeId}`, {
      method: 'DELETE',
    })
    if (res.ok) {
      await loadRun()
      toast({ title: t('toast_employee_removed') })
    } else {
      const result = await res.json()
      toast({
        title: t('toast_remove_employee_failed'),
        description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
        variant: 'destructive',
      })
    }
    setActionLoading(null)
  }

  // Edit this month's monthly salary for one employee (draft only). The engine
  // reads this per-run value at calc time. Saved on blur; the user then clicks
  // Beräkna to refresh the outcome.
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
      toast({ title: t('toast_salary_updated'), description: t('toast_salary_updated_hint') })
    } else {
      const result = await res.json()
      toast({
        title: t('toast_salary_update_failed'),
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
        toast({ title: t('toast_calculation_done') })
      } else {
        for (const warning of warnings) {
          toast({ title: t('toast_calculation_warning'), description: warning })
        }
      }
    } else {
      const result = await res.json()
      toast({
        title: t('toast_calculation_failed'),
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

  async function handleSendPayslips() {
    setActionLoading('payslips-send')
    const res = await fetch(`/api/salary/runs/${id}/payslips/send`, { method: 'POST' })
    if (res.ok) {
      const { data } = await res.json()
      await loadRun()
      toast({
        title: t('toast_payslips_sent'),
        description: t('toast_payslips_sent_detail', {
          sent: data.sent,
          skipped: data.skipped,
        }),
      })
      if (data.errors?.length) {
        for (const err of data.errors as string[]) {
          toast({ title: t('toast_payslip_error'), description: err, variant: 'destructive' })
        }
      }
    } else {
      const result = await res.json()
      toast({
        title: t('toast_payslips_send_failed'),
        description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
        variant: 'destructive',
      })
    }
    setActionLoading(null)
  }

  async function handleBulkPayslipDownload() {
    if (!run) return
    setActionLoading('bulk_payslip')
    try {
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      const periodLabel = periodLabelOf(run)
      let added = 0
      for (const sre of employees) {
        const employee = (sre as SalaryRunEmployee & {
          employee?: { first_name: string; last_name: string }
        }).employee
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
        toast({ title: t('toast_payslips_download_empty'), variant: 'destructive' })
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
      toast({ title: t('toast_payslips_downloaded'), description: t('toast_payslips_downloaded_detail', { count: added }) })
    } catch (err) {
      toast({
        title: t('toast_zip_failed'),
        description: err instanceof Error ? err.message : t('unknown_error'),
        variant: 'destructive',
      })
    } finally {
      setActionLoading(null)
    }
  }

  async function handleDownloadAgi() {
    if (!run) return
    setActionLoading('agi-download')
    const res = await fetch(`/api/salary/runs/${id}/agi/xml`)
    if (!res.ok) {
      const result = await res.json().catch(() => ({ error: t('toast_agi_failed') }))
      toast({
        title: t('toast_agi_failed'),
        description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
        variant: 'destructive',
      })
      setActionLoading(null)
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const compactPeriod = `${run.period_year}${String(run.period_month).padStart(2, '0')}`
    const a = document.createElement('a')
    a.href = url
    a.download = `AGI_${compactPeriod}.xml`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    await loadRun()
    toast({ title: t('toast_agi_downloaded') })
    setActionLoading(null)
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-60" />
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_280px] gap-8 space-y-6 lg:space-y-0">
          <Skeleton className="rounded-lg h-48" />
          <Skeleton className="rounded-lg h-64 hidden lg:block" />
        </div>
      </div>
    )
  }

  if (!run) {
    return <p className="text-muted-foreground">{t('not_found')}</p>
  }

  const periodLabel = periodLabelOf(run)
  const employees = (run.employees || []) as SalaryRunEmployee[]

  // calculation_params is frozen only when the run has been calculated, so it
  // distinguishes "not yet calculated" from "calculated to 0" (a nollkörning).
  const isCalculated = run.calculation_params != null
  const isNollkorning = isCalculated && Math.round((run.total_gross ?? 0) * 100) === 0
  // A run that pays out nothing (a nollkörning, or one fully consumed by a
  // nettolöneavdrag) has no payment-file line and no payout to perform. The
  // pay step collapses to a plain "continue" and the payment-file panel is
  // hidden - mirrors the pain.001 / BG-LB generators, which emit no rows here.
  const noPayout = isCalculated && Math.round((run.total_net ?? 0) * 100) === 0

  // Advancing a draft to review. For a nollkörning confirm first: an empty
  // declaration is filed to Skatteverket, which should be deliberate.
  function handleToReview() {
    if (isNollkorning && !confirm(t('confirm_nollkorning'))) {
      return
    }
    handleAction('review')
  }

  // The one next step for the current status, mirrored as a prominent header
  // button - the rail alone buried it (nobody found Godkänn).
  const primaryAction = !canWrite
    ? null
    : run.status === 'draft'
      ? isCalculated
        ? { key: 'review', label: t('action_to_review'), onClick: handleToReview }
        : { key: 'calculate', label: t('action_calculate'), onClick: handleCalculate }
      : run.status === 'review'
        ? { key: 'approve', label: t('action_approve'), onClick: () => doApprove(false) }
        : run.status === 'approved'
          ? { key: 'paid', label: noPayout ? t('action_continue') : t('action_mark_paid'), onClick: () => handleAction('paid') }
          : run.status === 'paid'
            ? { key: 'book', label: t('action_book'), onClick: () => handleAction('book') }
            : null

  return (
    <div className="space-y-6">
      <RunHeader
        run={run}
        canWrite={canWrite}
        actionLoading={actionLoading}
        employeeCount={employees.length}
        onDelete={handleDelete}
        onCorrect={handleCorrect}
      />

      {/* Control zone: the wizard line and every action for the current stage,
          grouped in one place with a large primary target. */}
      <RunProgressBar
        run={run}
        isCalculated={isCalculated}
        noPayout={noPayout}
        canWrite={canWrite}
        actionLoading={actionLoading}
        primaryAction={primaryAction}
        onPreview={handlePreview}
        onRevert={() => handleAction('revert')}
        onUnapprove={handleUnapprove}
        onSendPayslips={handleSendPayslips}
        onDownloadPayslips={handleBulkPayslipDownload}
      />

      <RunKpiCards run={run} employees={employees} />

      {isNollkorning && (
        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-medium">{t('nollkorning_title')}</p>
            <p className="text-sm text-muted-foreground mt-1">
              {t('nollkorning_body', { period: periodLabel })}
            </p>
          </CardContent>
        </Card>
      )}

      <RunEmployeesTable
        run={run}
        runId={id}
        employees={employees}
        availableEmployees={availableEmployees}
        canWrite={canWrite}
        actionLoading={actionLoading}
        dimensionsEnabled={dimensionsEnabled}
        isCalculated={isCalculated}
        onAddEmployee={handleAddEmployee}
        onRemoveEmployee={handleRemoveEmployee}
        onSalaryEdit={handleSalaryEdit}
      />

      {/* Calculation detail and the journal preview read best side by side on
          the wide canvas; they stack on smaller viewports. */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-6 space-y-6 lg:space-y-0 items-start">
        <RunCalculationDetails periodYear={run.period_year} employees={employees} />
        {preview && (
          <RunJournalPreview
            preview={preview}
            onRecalculate={run.status === 'draft' && canWrite ? handleCalculate : undefined}
            recalculating={actionLoading === 'calculate'}
          />
        )}
      </div>

      {/* Payment file: available once the run is approved, but only when there
          is something to pay out. A zero-payout run generates no file rows. */}
      {['approved', 'paid', 'booked'].includes(run.status) && !noPayout && (
        <PaymentFilePanel
          salaryRunId={id}
          periodLabel={periodLabel}
          paymentFileFormat={run.payment_file_format}
          paymentFileGeneratedAt={run.payment_file_generated_at}
          defaultFormat={preferredPaymentFormat}
          defaultBank={defaultBank}
          readOnly={!canWrite}
          onDownloaded={loadRun}
        />
      )}

      {/* Tax payment (skatt + arbetsgivaravgifter): once AGI has been generated */}
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

      {/* AGI (Arbetsgivardeklaration): available once the run is booked */}
      {run.status === 'booked' && (
        <div className="space-y-3">
          <AGIPanel
            salaryRunId={id}
            arbetsgivare={run.arbetsgivare ?? ''}
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
                {t('action_download_agi')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Overridable approval guard: missing bank details don't dead-end -
          the user can approve now and complete details before the payment file. */}
      <Dialog open={approveOverride !== null} onOpenChange={(open) => { if (!open) setApproveOverride(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('approve_override_title')}</DialogTitle>
            <DialogDescription className="pt-2 text-left">
              {t('approve_override_body')}
            </DialogDescription>
          </DialogHeader>
          {approveOverride && approveOverride.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-border p-3 text-xs">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <ul className="space-y-1">
                {approveOverride.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveOverride(null)} disabled={actionLoading === 'approve'}>
              {t('approve_override_cancel')}
            </Button>
            <Button onClick={() => doApprove(true)} disabled={actionLoading === 'approve'}>
              {actionLoading === 'approve' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('approve_override_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
