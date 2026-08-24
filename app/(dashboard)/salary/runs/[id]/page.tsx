'use client'

import { use, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { AlertTriangle, Loader2 } from 'lucide-react'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useAgiSubmission } from '@/lib/hooks/use-agi-submission'
import {
  deriveAgiFilingState,
  resolveRunAgiKvittensnummer,
} from '@/lib/salary/agi-submission-state'
import {
  buildPayslipZipReport,
  payslipEmployeeLabel,
  type PayslipZipAttempt,
} from '@/lib/salary/payslip-zip-report'
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
import type { EmployeeMasked, SalaryRunEmployee } from '@/types'

export default function SalaryRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const pathname = usePathname()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const t = useTranslations('salary_run')
  const { dialogProps, confirm: confirmAction } = useDestructiveConfirm()

  const [run, setRun] = useState<RunDetail | null>(null)
  const [availableEmployees, setAvailableEmployees] = useState<EmployeeMasked[]>([])
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  // Non-null while the "Godkänn ändå?" dialog is open: holds the missing
  // bank-detail reasons returned by the approve route (overridable block).
  const [approveOverride, setApproveOverride] = useState<string[] | null>(null)
  const [preferredPaymentFormat, setPreferredPaymentFormat] = useState<'bg_lb' | 'pain001'>('pain001')
  const [defaultBank, setDefaultBank] = useState<string | null>(null)
  // undefined = settings not loaded yet, null = confirmed missing. The panel
  // only warns on null, so a failed settings fetch never shows a false alarm.
  const [senderBankgiro, setSenderBankgiro] = useState<string | null | undefined>(undefined)
  const [senderIban, setSenderIban] = useState<string | null | undefined>(undefined)
  // Gates the default-dimensions chips on the employee rows: same
  // company_settings.dimensions_enabled UI gate as the voucher form.
  const [dimensionsEnabled, setDimensionsEnabled] = useState(false)
  const [taxPayment, setTaxPayment] = useState<{
    total_tax: number
    total_avgifter: number
    tax_payment_file_format: string | null
    tax_payment_file_generated_at: string | null
    tax_paid_at: string | null
  } | null>(null)
  const [taxPaymentLoading, setTaxPaymentLoading] = useState(false)

  // Skatteverket's per-period AGI submission record: drives the AGI step on
  // the progress rail and the panel's state machine (underlag submitted /
  // awaiting BankID signature / signed). Only booked runs can file AGI, so
  // the fetch is skipped (null period) for everything else.
  const { submission: agiSubmission, refresh: refreshAgiSubmission } = useAgiSubmission(
    run && run.status === 'booked'
      ? `${run.period_year}${String(run.period_month).padStart(2, '0')}`
      : null,
  )

  async function loadRun() {
    const res = await fetch(`/api/salary/runs/${id}`)
    if (res.ok) {
      const { data } = await res.json()
      setRun(data)
      if (data?.period_year && data?.period_month) {
        const period = `${data.period_year}-${String(data.period_month).padStart(2, '0')}`
        setTaxPaymentLoading(true)
        void fetch(`/api/skatteverket/tax-payments/${period}`)
          .then(async (txRes) => (txRes.ok ? txRes.json() : null))
          .then((tx) => {
            // Clear on failure too: a stale record from a prior period must
            // not keep feeding the panel outdated declared totals.
            setTaxPayment(tx?.data ?? null)
          })
          .catch(() => setTaxPayment(null))
          .finally(() => setTaxPaymentLoading(false))
      }
    }
  }

  async function loadSettings() {
    const settingsRes = await fetch('/api/settings')
    if (!settingsRes.ok) return
    const { data } = await settingsRes.json()
    if (data?.preferred_payment_format === 'pain001' || data?.preferred_payment_format === 'bg_lb') {
      setPreferredPaymentFormat(data.preferred_payment_format)
    }
    setDefaultBank(typeof data?.salary_default_bank === 'string' ? data.salary_default_bank : null)
    setSenderBankgiro(
      typeof data?.bankgiro === 'string' && data.bankgiro.trim() ? data.bankgiro : null,
    )
    setSenderIban(typeof data?.iban === 'string' && data.iban.trim() ? data.iban : null)
    setDimensionsEnabled(data?.dimensions_enabled === true)
  }

  useEffect(() => {
    async function load() {
      // Employees and settings don't depend on the run - load all three in
      // parallel instead of serially.
      const [, empRes] = await Promise.all([
        loadRun(),
        fetch('/api/salary/employees'),
        loadSettings(),
      ])
      if (empRes.ok) {
        const { data } = await empRes.json()
        setAvailableEmployees(data || [])
      }
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // The payment-file warning links to settings, which opens as an intercepting
  // modal over this still-mounted page. When the URL returns here after that
  // detour, refetch settings so a bankgiro/IBAN saved in the modal clears the
  // warning instead of leaving it asserting a stale "file cannot be created".
  const pathnameSeen = useRef(false)
  useEffect(() => {
    if (!pathnameSeen.current) {
      pathnameSeen.current = true
      return
    }
    if (pathname === `/salary/runs/${id}`) loadSettings()
  }, [pathname, id])

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

  // Auto-load the journal view once the run is calculated, so the voucher box
  // renders beside Beräkningsdetaljer without a manual Förhandsgranska click.
  // Re-runs when the calculated totals change (e.g. after Beräkna om) so the
  // preview stays in sync; clears while the run isn't calculated yet. For
  // booked/corrected runs the route returns the ACTUAL posted verifikat
  // (voucher numbers included) instead of a recomputed projection, which
  // could contradict vouchers booked under earlier rules.
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
    // run?.status: after Bokför, the box must swap the projection for the
    // posted verifikat (voucher numbers included) without a manual reload.
  }, [id, isCalculatedForPreview, run?.status, run?.total_gross, run?.total_tax, run?.total_avgifter])

  // Every handler below releases actionLoading in a finally: the flag gates the
  // header button, the progress rail and the employee table, so a rejected
  // fetch that skipped the release froze the whole page until a reload.
  async function handleAction(action: string, method: string = 'POST') {
    setActionLoading(action)
    try {
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
    } catch (err) {
      toast({
        title: t('toast_status_failed'),
        description: err instanceof Error ? getErrorMessage(err) : t('unknown_error'),
        variant: 'destructive',
      })
    } finally {
      setActionLoading(null)
    }
  }

  // Approval is an authorization step. Missing bank details are an *overridable*
  // block (SALARY_APPROVE_BANK_DETAILS_MISSING) - rather than dead-ending on a
  // 400 toast, we surface a confirm dialog and re-approve with ?force=true when
  // the user chooses "Godkänn ändå". The payment-file step still hard-blocks.
  async function doApprove(force: boolean) {
    setActionLoading('approve')
    try {
      const res = await fetch(`/api/salary/runs/${id}/approve${force ? '?force=true' : ''}`, {
        method: 'POST',
      })
      if (res.ok) {
        setApproveOverride(null)
        const payload = await res.json().catch(() => null)
        if (payload?.data) {
          setRun(prev => (prev ? { ...prev, ...payload.data } : prev))
        }
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
        return
      }
      setApproveOverride(null)
      toast({
        title: t('toast_status_failed'),
        description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
        variant: 'destructive',
      })
    } catch (err) {
      setApproveOverride(null)
      toast({
        title: t('toast_status_failed'),
        description: err instanceof Error ? getErrorMessage(err) : t('unknown_error'),
        variant: 'destructive',
      })
    } finally {
      setActionLoading(null)
    }
  }

  // Recall an approval (approved → review). Approval is only an internal
  // control point, but side effects may already exist — a payment file that
  // could be sitting at the bank, sent payslips, a generated AGI — so the
  // confirm spells out exactly the ones that apply to this run. The API
  // refuses outright once the AGI has been filed with Skatteverket.
  async function handleUnapprove() {
    if (!run) return
    const lines = [t('confirm_unapprove_intro')]
    if (run.payment_file_generated_at) lines.push(t('confirm_unapprove_payment_file'))
    if ((run.payslip_deliveries_summary?.sent ?? 0) > 0) lines.push(t('confirm_unapprove_payslips'))
    if (run.agi_generated_at) lines.push(t('confirm_unapprove_agi'))
    const ok = await confirmAction({
      title: t('confirm_unapprove_title'),
      description: lines.join('\n\n'),
      confirmLabel: t('action_unapprove'),
      variant: 'warning',
    })
    if (!ok) return
    handleAction('unapprove')
  }

  async function handleDelete() {
    if (!run) return
    const period = periodLabelOf(run)
    const ok = await confirmAction({
      title: t('confirm_delete_title'),
      description: t('confirm_delete', { period }),
      confirmLabel: t('action_delete_draft'),
      variant: 'destructive',
    })
    if (!ok) return
    setActionLoading('delete')
    // No finally here: the success path navigates away and deliberately leaves
    // the buttons disabled for the duration of the route change. Every path
    // that stays on the page releases the flag.
    try {
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
    } catch (err) {
      toast({
        title: t('toast_delete_failed'),
        description: err instanceof Error ? getErrorMessage(err) : t('unknown_error'),
        variant: 'destructive',
      })
    }
    setActionLoading(null)
  }

  // Storno-based correction (BFL 5 kap. 5 §) - the confirm dialog lives in
  // RunHeader; this fires only after the user has confirmed there.
  async function handleCorrect() {
    setActionLoading('correct')
    // As in handleDelete: the success path navigates to the new run and keeps
    // the buttons disabled meanwhile; every path that stays here releases.
    try {
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
    } catch (err) {
      toast({
        title: t('toast_correction_failed'),
        description: err instanceof Error ? getErrorMessage(err) : t('unknown_error'),
        variant: 'destructive',
      })
    }
    setActionLoading(null)
  }

  async function handleAddEmployee(employeeId: string) {
    setActionLoading('add-employee')
    try {
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
    } catch (err) {
      toast({
        title: t('toast_add_employee_failed'),
        description: err instanceof Error ? getErrorMessage(err) : t('unknown_error'),
        variant: 'destructive',
      })
    } finally {
      setActionLoading(null)
    }
  }

  // Remove an employee from a draft run. The DELETE endpoint is draft-only and
  // cascades to the employee's line items.
  async function handleRemoveEmployee(employeeId: string, name: string) {
    const ok = await confirmAction({
      title: t('confirm_remove_employee_title'),
      description: t('confirm_remove_employee', { name }),
      confirmLabel: t('remove_sr'),
      variant: 'destructive',
    })
    if (!ok) return
    setActionLoading(`remove-${employeeId}`)
    try {
      const res = await fetch(`/api/salary/runs/${id}/employees/${employeeId}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        await loadRun()
        toast({ title: t('toast_employee_removed') })
      } else {
        const result = await res.json().catch(() => ({}))
        toast({
          title: t('toast_remove_employee_failed'),
          description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
          variant: 'destructive',
        })
      }
    } catch (err) {
      toast({
        title: t('toast_remove_employee_failed'),
        description: err instanceof Error ? getErrorMessage(err) : t('unknown_error'),
        variant: 'destructive',
      })
    } finally {
      setActionLoading(null)
    }
  }

  // Edit this month's monthly salary for one employee (draft only). The engine
  // reads this per-run value at calc time. Saved on blur; the user then clicks
  // Beräkna to refresh the outcome.
  async function handleSalaryEdit(employeeId: string, raw: string, previous: number) {
    const monthly = Number(raw.replace(/\s/g, '').replace(',', '.'))
    if (!Number.isFinite(monthly) || monthly < 0 || monthly === previous) return
    setActionLoading(`salary-${employeeId}`)
    try {
      const res = await fetch(`/api/salary/runs/${id}/employees/${employeeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthly_salary: monthly }),
      })
      if (res.ok) {
        await loadRun()
        toast({ title: t('toast_salary_updated'), description: t('toast_salary_updated_hint') })
      } else {
        const result = await res.json().catch(() => ({}))
        toast({
          title: t('toast_salary_update_failed'),
          description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
          variant: 'destructive',
        })
      }
    } catch (err) {
      toast({
        title: t('toast_salary_update_failed'),
        description: err instanceof Error ? getErrorMessage(err) : t('unknown_error'),
        variant: 'destructive',
      })
    } finally {
      setActionLoading(null)
    }
  }

  async function handleCalculate() {
    setActionLoading('calculate')
    try {
      const res = await fetch(`/api/salary/runs/${id}/calculate`, { method: 'POST' })
      if (res.ok) {
        const payload = await res.json().catch(() => ({}))
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
        const result = await res.json().catch(() => ({}))
        toast({
          title: t('toast_calculation_failed'),
          description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
          variant: 'destructive',
        })
      }
    } catch (err) {
      toast({
        title: t('toast_calculation_failed'),
        description: err instanceof Error ? getErrorMessage(err) : t('unknown_error'),
        variant: 'destructive',
      })
    } finally {
      setActionLoading(null)
    }
  }

  async function handlePreview() {
    setActionLoading('preview')
    try {
      const res = await fetch(`/api/salary/runs/${id}/preview`)
      if (res.ok) {
        const { data } = await res.json()
        setPreview(data)
      }
    } catch {
      // The preview is a read-only convenience; the auto-load effect retries on
      // the next calculation. Nothing to report, but the flag must be released.
    } finally {
      setActionLoading(null)
    }
  }

  async function handleSendPayslips() {
    setActionLoading('payslips-send')
    try {
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
        const result = await res.json().catch(() => ({}))
        toast({
          title: t('toast_payslips_send_failed'),
          description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
          variant: 'destructive',
        })
      }
    } catch (err) {
      toast({
        title: t('toast_payslips_send_failed'),
        description: err instanceof Error ? getErrorMessage(err) : t('unknown_error'),
        variant: 'destructive',
      })
    } finally {
      setActionLoading(null)
    }
  }

  // Bulk payslip archive. One PDF request per employee, so a single failure
  // must not take the batch down - but it must not vanish either: the employer
  // hands out what the ZIP contains and has no other signal that someone is
  // missing from it. Every outcome is recorded per employee and reported by
  // name; a short archive is never presented as a complete one.
  async function handleBulkPayslipDownload() {
    if (!run) return
    setActionLoading('bulk_payslip')
    try {
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      const periodLabel = periodLabelOf(run)
      const attempts: PayslipZipAttempt[] = []
      for (const sre of employees) {
        const employee = (sre as SalaryRunEmployee & {
          employee?: { first_name: string; last_name: string }
        }).employee
        let ok = false
        try {
          const res = await fetch(`/api/salary/runs/${id}/payslips/${sre.employee_id}/pdf`)
          if (res.ok) {
            const blob = await res.blob()
            const fileName = employee
              ? `${employee.last_name}_${employee.first_name}`.replace(/[^A-Za-z0-9_-]/g, '_')
              : sre.employee_id.slice(0, 8)
            zip.file(`Lonespec_${periodLabel}_${fileName}.pdf`, blob)
            ok = true
          }
        } catch {
          // A network-level failure for this one employee counts exactly like a
          // non-ok response: missing from the archive, named in the report.
        }
        attempts.push({ name: payslipEmployeeLabel(sre.employee_id, employee), ok })
      }

      const report = buildPayslipZipReport(attempts)

      // Nothing to archive: no file is produced, so say so and stop.
      if (report.outcome === 'empty') {
        toast({ title: t('toast_payslips_download_empty'), variant: 'destructive' })
        return
      }
      if (report.outcome === 'none') {
        toast({
          title: t('toast_payslips_download_empty'),
          description: t('toast_payslips_download_none_detail', { total: report.total }),
          variant: 'destructive',
        })
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

      // The toaster holds one toast at a time: a warning emitted next to a
      // success toast is evicted and never rendered. So a partial archive gets
      // a single destructive toast naming who is missing, not success + warning.
      if (report.outcome === 'partial') {
        const shown = report.missingShown.join(', ')
        const names =
          report.missingOverflow > 0
            ? t('toast_payslips_download_more', { names: shown, count: report.missingOverflow })
            : shown
        toast({
          title: t('toast_payslips_download_partial'),
          description: t('toast_payslips_download_partial_detail', {
            added: report.added,
            total: report.total,
            names,
          }),
          variant: 'destructive',
        })
        return
      }

      toast({
        title: t('toast_payslips_downloaded'),
        description: t('toast_payslips_downloaded_detail', { count: report.added }),
      })
    } catch (err) {
      toast({
        title: t('toast_zip_failed'),
        description: err instanceof Error ? getErrorMessage(err) : t('unknown_error'),
        variant: 'destructive',
      })
    } finally {
      setActionLoading(null)
    }
  }

  // actionLoading gates this button, the progress rail and the employee table,
  // so it has to be released on every path. A rejected fetch (or a blob/read
  // failure) used to leave it set and freeze the page until a full reload.
  async function handleDownloadAgi() {
    if (!run) return
    setActionLoading('agi-download')
    try {
      const res = await fetch(`/api/salary/runs/${id}/agi/xml`)
      if (!res.ok) {
        const result = await res.json().catch(() => ({ error: t('toast_agi_failed') }))
        toast({
          title: t('toast_agi_failed'),
          description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
          variant: 'destructive',
        })
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
    } catch (err) {
      toast({
        title: t('toast_agi_failed'),
        description: err instanceof Error ? getErrorMessage(err) : t('unknown_error'),
        variant: 'destructive',
      })
    } finally {
      setActionLoading(null)
    }
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

  // Real AGI filing state: run-row timestamps + the extension's submission
  // record. Falls back gracefully when the extension is unavailable.
  const agiState = deriveAgiFilingState(run, agiSubmission)
  // The submission record is cached per PERIOD, but a corrected month holds two
  // runs and each files its own complete replacement declaration, so each gets
  // its own kvittens from Skatteverket. Resolving the record against this run
  // keeps the rail from labelling one run's step with the sibling's receipt.
  const agiKvittensnummer = resolveRunAgiKvittensnummer(run, agiSubmission)

  // Advancing a draft to review. For a nollkörning confirm first: an empty
  // declaration is filed to Skatteverket, which should be deliberate.
  async function handleToReview() {
    if (isNollkorning) {
      const ok = await confirmAction({
        title: t('nollkorning_title'),
        description: t('confirm_nollkorning'),
        confirmLabel: t('action_to_review'),
        variant: 'warning',
      })
      if (!ok) return
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
    <div className="space-y-8 stagger-enter">
      {/* Back row + header: serif title with one status chip, the quiet meta
          line, the next step as the one default button and everything else
          behind the ⋯ menu. */}
      <RunHeader
        run={run}
        canWrite={canWrite}
        actionLoading={actionLoading}
        employeeCount={employees.length}
        isCalculated={isCalculated}
        primaryAction={primaryAction}
        onPreview={handlePreview}
        onRevert={() => handleAction('revert')}
        onUnapprove={handleUnapprove}
        onSendPayslips={handleSendPayslips}
        onDownloadPayslips={handleBulkPayslipDownload}
        onDownloadAgi={handleDownloadAgi}
        onDelete={handleDelete}
        onCorrect={handleCorrect}
      />

      {/* The one attention sentence on the page: an empty declaration will be
          filed for the period, which should be deliberate. */}
      {isNollkorning && (
        <AttnLine>
          {t('nollkorning_title')}: {t('nollkorning_body', { period: periodLabel })}
        </AttnLine>
      )}

      {/* The month's steps as a flat rail: where the run stands and what the
          stage means. Actions live in the header. */}
      <RunProgressBar
        run={run}
        isCalculated={isCalculated}
        noPayout={noPayout}
        agiState={agiState}
        agiKvittensnummer={agiKvittensnummer}
      />

      <RunKpiCards run={run} employees={employees} />

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
      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-2 items-start">
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
          senderBankgiro={senderBankgiro}
          senderIban={senderIban}
          readOnly={!canWrite}
          onDownloaded={loadRun}
        />
      )}

      {/* Tax payment (skatt + arbetsgivaravgifter): once AGI has been generated */}
      {run.status === 'booked' && run.agi_generated_at && (
        taxPaymentLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <TaxPaymentPanel
            period={periodLabel}
            // Prefer the AGI declaration's stored totals (whole kronor, and
            // they honor review overrides/corrections); the run totals are
            // the pre-AGI fallback and get truncated inside the panel.
            totalTax={taxPayment?.total_tax ?? run.total_tax}
            totalAvgifter={taxPayment?.total_avgifter ?? run.total_avgifter}
            paymentFileFormat={taxPayment?.tax_payment_file_format ?? null}
            paymentFileGeneratedAt={taxPayment?.tax_payment_file_generated_at ?? null}
            taxPaidAt={taxPayment?.tax_paid_at ?? null}
            defaultFormat={preferredPaymentFormat}
            senderBankgiro={senderBankgiro}
            senderIban={senderIban}
            readOnly={!canWrite}
            onChange={loadRun}
          />
        )
      )}

      {/* AGI (Arbetsgivardeklaration): available once the run is booked. The
          XML download for manual filing lives in the header's ⋯ menu. */}
      {run.status === 'booked' && (
        <AGIPanel
          salaryRunId={id}
          arbetsgivare={run.arbetsgivare ?? ''}
          period={`${run.period_year}${String(run.period_month).padStart(2, '0')}`}
          agiGeneratedAt={run.agi_generated_at}
          agiSubmittedAt={run.agi_submitted_at}
          submission={agiSubmission}
          onRefreshSubmission={refreshAgiSubmission}
          readOnly={!canWrite}
          onChange={loadRun}
        />
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
            <div className="flex items-start gap-2 rounded-lg border border-border p-3 text-xs">
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

      <DestructiveConfirmDialog {...dialogProps} />
    </div>
  )
}
