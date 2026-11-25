'use client'

import { use, useEffect, useRef, useState } from 'react'
import { useCompanySettings, useEmployees } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { usePathname, useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { StepBar } from '@/components/ui/step-bar'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { LoadError, NotFoundState } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ExclamationTriangleIcon } from '@/components/icons'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useAgiSubmission } from '@/lib/hooks/use-agi-submission'
import { usePaymentFileAccount } from '@/lib/hooks/use-payment-file-account'
import { deriveAgiFilingState } from '@/lib/salary/agi-submission-state'
import {
  buildPayslipZipReport,
  payslipEmployeeLabel,
  type PayslipZipAttempt,
} from '@/lib/salary/payslip-zip-report'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { downloadFile, saveBlobToDisk } from '@/lib/browser/download-file'
import { failureDescription } from '@/lib/browser/action-failure'
import { AGIPanel } from '@/components/salary/AGIPanel'
import { PaymentFilePanel } from '@/components/salary/PaymentFilePanel'
import {
  SalaryBankPaymentDialog,
  SalaryBankPaymentSection,
  useSalaryBankPayments,
} from '@/components/salary/SalaryBankPaymentSection'
import { TaxPaymentPanel } from '@/components/salary/TaxPaymentPanel'
import { RunHeader } from '@/components/salary/run/RunHeader'
import { RunProgressBar } from '@/components/salary/run/RunProgressBar'
import { RunKpiCards } from '@/components/salary/run/RunKpiCards'
import { RunEmployeesTable } from '@/components/salary/run/RunEmployeesTable'
import { RunCalculationDetails } from '@/components/salary/run/RunCalculationDetails'
import { RunJournalPreview, type PreviewData } from '@/components/salary/run/RunJournalPreview'
import { RunFoldSection } from '@/components/salary/run/RunFoldSection'
import { ForaReportDialog } from '@/components/salary/run/ForaReportDialog'
import { UsageLimitDialog } from '@/components/settings/UsageLimitDialog'
import { formatRunAmount, periodLabelOf, type RunDetail } from '@/components/salary/run/types'
import { isPaymentDateAhead, needsFuturePayoutConfirm } from '@/lib/salary/payout-date'
import { formatDate } from '@/lib/utils'
import {
  agiReportingPeriod,
  formatAgiPeriodCompact,
  formatAgiPeriodDashed,
} from '@/lib/salary/agi/reporting-period'
import { runCalculationState } from '@/lib/salary/calculation-state'
import { parseAmountInput, roundOre } from '@/lib/money'
import { fetchActiveSendingProviders } from '@/lib/digital-mailboxes/sending-status'
import {
  payslipChannelOptions,
  payslipSendRequest,
  type PayslipSendChannel,
} from '@/lib/salary/payslips/channel-options'
import type { SalaryRunEmployee } from '@/types'

/** Anchor of the AGI section, the target of a booked run's header action. */
const AGI_SECTION_ID = 'salary-run-agi'

/** The fields of GET /api/expense-claims?status=registered the run page reads. */
interface OpenClaimRow {
  id: string
  employee_id: string | null
  amount_sek: number | string
  /** Registered and on no payslip of any run: the server's answer (lib/salary/expense-claim-payout-state.ts). */
  awaits_payout: boolean
}

export default function SalaryRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const pathname = usePathname()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const t = useTranslations('salary_run')
  const tBank = useTranslations('salary_bank_payment')
  const tCommon = useTranslations('common')
  const errorLocale = useLocale() as ErrorLocale
  const { dialogProps, confirm: confirmAction } = useDestructiveConfirm()

  const [run, setRun] = useState<RunDetail | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  // The active roster from the session cache (lib/reference-data), for the
  // "add employee to the run" picker.
  const { employees: availableEmployees } = useEmployees()
  // Registered utlägg (#2331): fetched only while the run is a draft, the
  // one status in which they can be put on a payslip.
  const [openClaims, setOpenClaims] = useState<OpenClaimRow[]>([])
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [foraOpen, setForaOpen] = useState(false)
  // Non-null while the "Godkänn ändå?" dialog is open: holds the missing
  // bank-detail reasons returned by the approve route (overridable block).
  const [approveOverride, setApproveOverride] = useState<string[] | null>(null)
  const [preferredPaymentFormat, setPreferredPaymentFormat] = useState<'bg_lb' | 'pain001'>('pain001')
  // undefined = settings not loaded yet, null = confirmed missing. The panel
  // only warns on null, so a failed settings fetch never shows a false alarm.
  const [senderBankgiro, setSenderBankgiro] = useState<string | null | undefined>(undefined)
  // Gates the default-dimensions chips on the employee rows: same
  // company_settings.dimensions_enabled UI gate as the voucher form.
  const [dimensionsEnabled, setDimensionsEnabled] = useState(false)
  const [taxPayment, setTaxPayment] = useState<{
    total_tax: number
    total_avgifter: number
    tax_payment_file_format: string | null
    tax_payment_file_generated_at: string | null
    tax_paid_at: string | null
    payment_due_date?: string | null
    period_conflict?: { code: string; message: string; message_en?: string } | null
    bank_payment?: { status: string; amount: number; requested_execution_date: string; signed: boolean; pays_declaration: boolean } | null
  } | null>(null)
  const [taxPaymentLoading, setTaxPaymentLoading] = useState(false)
  // The run's bank payments and whether the company can make them: they pick
  // the header's button (Betala via banken before any payment) and, while one
  // is live, keep the payment file away (it would pay the month twice).
  const bankPayments = useSalaryBankPayments(id, !!run && ['approved', 'paid', 'booked'].includes(run.status))
  const inBankPayment = bankPayments.live.length > 0
  const [payDialogOpen, setPayDialogOpen] = useState(false)
  // How the payslips can go out: the email link, plus each digital mailbox
  // (Billo, Kivra) the company sends through, read once. A failed read
  // leaves the email link alone, as before the mailboxes.
  const [payslipChannels, setPayslipChannels] = useState<PayslipSendChannel[]>(['email'])
  // A mailbox send stopped at what the month includes: the service to ask for more of.
  const [payslipCharge, setPayslipCharge] = useState<{ channel: Exclude<PayslipSendChannel, 'email'>; included: number; unitPriceOre: number } | null>(null)
  useEffect(() => {
    let cancelled = false
    void fetchActiveSendingProviders().then((providers) => {
      if (!cancelled) setPayslipChannels(payslipChannelOptions(providers))
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Skatteverket's per-period AGI submission record: drives the AGI step on
  // the progress rail and the panel's state machine (underlag submitted /
  // awaiting BankID signature / signed). Only booked runs can file AGI, so
  // the fetch is skipped (null period) for everything else.
  // The period is the PAYOUT month (kontantprincipen), which for lön i
  // efterskott is the month after run.period_*; every AGI and tax-payment
  // surface below keys on it.
  const { submission: agiSubmission, refresh: refreshAgiSubmission } = useAgiSubmission(
    run && run.status === 'booked' ? formatAgiPeriodCompact(agiReportingPeriod(run)) : null,
  )

  // The account the payment files pay from (crm#1483). The salary file pays
  // from the account the run's verifikat credits (the primary until it is
  // booked); the tax file from the primary. Read only while a panel shows.
  const showsPaymentFile = Boolean(run && ['approved', 'paid', 'booked'].includes(run.status))
  const { account: runFileAccount, refresh: refreshRunFileAccount } = usePaymentFileAccount(id, {
    enabled: showsPaymentFile,
    runStatus: run?.status ?? null,
  })
  const { account: taxFileAccount, refresh: refreshTaxFileAccount } = usePaymentFileAccount(null, {
    enabled: Boolean(run && run.status === 'booked' && run.agi_generated_at),
  })

  async function loadRun() {
    const res = await fetch(`/api/salary/runs/${id}`).catch(() => null) // unreachable: the !res branch below
    if (!res) {
      // The request never reached the server: not "not found" either.
      setRunError(tCommon('load_error_hint'))
      return
    }
    if (res.ok) {
      setRunError(null)
      const { data } = await res.json()
      setRun(data)
      if (data?.status === 'draft') {
        void fetch('/api/expense-claims?status=registered')
          .then(async (claimsRes) => (claimsRes.ok ? claimsRes.json() : null))
          .then((json) =>
            setOpenClaims(((json?.data as OpenClaimRow[] | undefined) ?? []).filter((claim) => claim.awaits_payout)),
          )
          .catch(() => setOpenClaims([]))
      } else {
        setOpenClaims([])
      }
      if (data?.period_year && data?.period_month) {
        const period = formatAgiPeriodDashed(agiReportingPeriod(data))
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
    } else if (res.status !== 404) {
      // Any other failure is not "not found": show what the server said, so
      // a timeout or a refused read does not read as a missing run.
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      setRunError(getErrorMessage(body, { locale: errorLocale, fallback: tCommon('load_error_hint') }))
    } else {
      setRunError(null)
    }
  }

  // Company settings from the session cache (lib/reference-data): applied
  // whenever the cached row (re)loads, no request of its own.
  const { settings: companySettings } = useCompanySettings()
  useEffect(() => {
    const data = companySettings as unknown as Record<string, unknown> | null
    if (!data) return
    const format = data.preferred_payment_format
    if (format === 'pain001' || format === 'bg_lb') setPreferredPaymentFormat(format)
    setSenderBankgiro(
      typeof data.bankgiro === 'string' && data.bankgiro.trim() ? data.bankgiro : null,
    )
    setDimensionsEnabled(data.dimensions_enabled === true)
  }, [companySettings])

  useEffect(() => {
    async function load() {
      await loadRun()
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // The payment-file warning links to settings, which opens as an intercepting
  // modal over this still-mounted page. When the URL returns here after that
  // detour, refetch settings and the paying account so a bankgiro, IBAN or
  // new primary saved there clears the warning instead of leaving it
  // asserting a stale "file cannot be created".
  const pathnameSeen = useRef(false)
  useEffect(() => {
    if (!pathnameSeen.current) {
      pathnameSeen.current = true
      return
    }
    if (pathname === `/salary/runs/${id}`) {
      void invalidateReferenceData('company_settings')
      refreshRunFileAccount()
      refreshTaxFileAccount()
    }
  }, [pathname, id, refreshRunFileAccount, refreshTaxFileAccount])

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

  // One rule for "calculated", shared with the review and approve steps
  // (lib/salary/calculation-state.ts). The run-level calculation_params alone
  // survives a payment date change that cleared every employee's calculation,
  // so reading only it kept stale figures on screen next to a Godkänn that
  // the server then refused (crm#1001).
  const calculationState = run
    ? runCalculationState(run, (run.employees ?? []) as SalaryRunEmployee[])
    : 'not_calculated'

  // Auto-load the journal view once the run is calculated, so the voucher box
  // renders beside Beräkningsdetaljer without a manual Förhandsgranska click.
  // Re-runs when the calculated totals change (e.g. after Beräkna om) so the
  // preview stays in sync; clears while the calculation isn't current (not yet
  // made, or stale after a change). For booked/corrected runs the route
  // returns the ACTUAL posted verifikat (voucher numbers included) instead of
  // a recomputed projection, which could contradict vouchers booked under
  // earlier rules.
  const isCalculatedForPreview = calculationState === 'current'
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
  async function handleAction(action: string, method: string = 'POST', body?: Record<string, unknown>) {
    setActionLoading(action)
    try {
      const res = await fetch(
        `/api/salary/runs/${id}/${action}`,
        body
          ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : { method },
      )
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

  // Draft-only payment-date edit from the header meta line, via the same
  // internal PATCH the run has always supported. Returns success so the
  // header can snap its input back to the server value on failure.
  async function handleUpdatePaymentDate(date: string): Promise<boolean> {
    setActionLoading('payment_date')
    try {
      const res = await fetch(`/api/salary/runs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_date: date }),
      })
      if (res.ok) {
        // Optimistic: the PATCH returns the updated run row, and it cleared
        // every employee's calculation (skatteavdrag follows the payment
        // date). Mirror that clear at once, so the page turns stale and
        // offers Beräkna om instead of Till granskning until the reconcile.
        const payload = await res.json().catch(() => null)
        if (payload?.data) {
          setRun(prev =>
            prev
              ? {
                  ...prev,
                  ...payload.data,
                  employees: prev.employees?.map(sre => ({ ...sre, calculation_breakdown: null })),
                }
              : prev,
          )
        }
        toast({
          title: t('toast_payment_date_updated'),
          description:
            run?.calculation_params != null ? t('toast_payment_date_updated_hint') : undefined,
        })
        loadRun() // background reconcile - not awaited
        return true
      }
      const result = await res.json().catch(() => ({}))
      toast({
        title: t('toast_status_failed'),
        description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
        variant: 'destructive',
      })
      return false
    } catch (err) {
      toast({
        title: t('toast_status_failed'),
        description: err instanceof Error ? getErrorMessage(err) : t('unknown_error'),
        variant: 'destructive',
      })
      return false
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
  // control point, but side effects may already exist - a payment file that
  // could be sitting at the bank, sent payslips, a generated AGI - so the
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

  // "Lägg till utlägg" (#2331): the server pulls the employee's registered
  // claims onto the payslip as tax-free lines; the user then clicks Beräkna.
  async function handleAddExpenseClaims(employeeId: string) {
    setActionLoading(`expense-claims-${employeeId}`)
    try {
      const res = await fetch(`/api/salary/runs/${id}/employees/${employeeId}/expense-claims`, {
        method: 'POST',
      })
      const result = await res.json().catch(() => ({}))
      if (res.ok) {
        await loadRun()
        const added = result?.data as { claim_count?: number; total_sek?: number } | undefined
        toast({
          title: t('toast_expense_claims_added'),
          description: t('toast_expense_claims_added_detail', {
            count: added?.claim_count ?? 0,
            amount: formatRunAmount(added?.total_sek ?? 0),
          }),
        })
      } else {
        toast({
          title: t('toast_expense_claims_failed'),
          description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
          variant: 'destructive',
        })
      }
    } catch (err) {
      toast({
        title: t('toast_expense_claims_failed'),
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
    const monthly = parseAmountInput(raw)
    if (monthly === null || monthly < 0 || monthly === previous) return
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

  // Beräkna / Beräkna om. fromReview: a run in review whose calculation is not
  // current (it reached review before the review step checked) goes back to
  // draft first, the only status the calculation runs in.
  async function handleCalculate(options: { fromReview?: boolean } = {}) {
    setActionLoading('calculate')
    try {
      if (options.fromReview) {
        const revertRes = await fetch(`/api/salary/runs/${id}/revert`, { method: 'POST' })
        if (!revertRes.ok) {
          const result = await revertRes.json().catch(() => ({}))
          toast({
            title: t('toast_calculation_failed'),
            description: getErrorMessage(result, { context: 'salary', statusCode: revertRes.status }),
            variant: 'destructive',
          })
          return
        }
      }
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
        // Reverted but not calculated: show the draft it now is.
        if (options.fromReview) await loadRun()
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

  async function handleSendPayslips(channel: PayslipSendChannel) {
    setActionLoading('payslips-send')
    try {
      // A mailbox channel sends each payslip to the employee's Billo or
      // Kivra where it reaches them, and the email link to the rest.
      const res = await fetch(`/api/salary/runs/${id}/payslips/send`, payslipSendRequest(channel))
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
        const refused = (result as { error?: { code?: string; details?: { included?: number; unit_price_ore?: number } } }).error
        if (refused?.code === 'USAGE_LIMIT_REACHED' && channel !== 'email') {
          setPayslipCharge({ channel, included: refused.details?.included ?? 0, unitPriceOre: refused.details?.unit_price_ore ?? 0 })
          return
        }
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
          // The archive is what the employer hands out: the employee copy,
          // which follows the company's payslip section switches.
          const res = await fetch(`/api/salary/runs/${id}/payslips/${sre.employee_id}/pdf?audience=employee`)
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
      saveBlobToDisk(archive, `Lonespec_${periodLabel}.zip`)

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
      const compactPeriod = formatAgiPeriodCompact(agiReportingPeriod(run))
      const result = await downloadFile({
        url: `/api/salary/runs/${id}/agi/xml`,
        filename: `AGI_${compactPeriod}.xml`,
        locale: errorLocale,
        errorContext: 'salary',
      })
      if (!result.ok) {
        toast({
          title: t('toast_agi_failed'),
          description: failureDescription(result, {
            timeout: tCommon('download_timeout'),
            network: tCommon('download_network'),
          }),
          variant: 'destructive',
        })
        return
      }
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
      <LateReveal className="space-y-6">
        <Skeleton className="h-9 w-60" />
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_280px] gap-8 space-y-6 lg:space-y-0">
          <Skeleton className="rounded-lg h-48" />
          <Skeleton className="rounded-lg h-64 hidden lg:block" />
        </div>
      </LateReveal>
    )
  }

  if (!run && runError) {
    return (
      <LoadError
        title={t('load_failed_title')}
        description={runError}
        onRetry={() => {
          setLoading(true)
          void loadRun().finally(() => setLoading(false))
        }}
      />
    )
  }

  if (!run) {
    return <NotFoundState title={t('not_found')} backHref="/salary" backLabel={tCommon('back_to_list')} />
  }

  const periodLabel = periodLabelOf(run)
  const employees = (run.employees || []) as SalaryRunEmployee[]
  // The company reports to Fora when someone on the run has a Fora code.
  const reportsToFora = employees.some((sre) => !!sre.employee?.fora_fok_id)
  const paymentPeriod = agiReportingPeriod(run)

  // Open utlägg per employee: the claims that wait for a payout, less the
  // ones put on a payslip line of this run since they were read (#2331).
  const scheduledClaimIds = new Set(
    employees.flatMap((sre) =>
      (sre.line_items ?? [])
        .map((li) => li.source_expense_claim_id)
        .filter((claimId): claimId is string => Boolean(claimId)),
    ),
  )
  const openExpenseClaims: Record<string, { count: number; total_sek: number }> = {}
  for (const claim of openClaims) {
    if (!claim.employee_id || scheduledClaimIds.has(claim.id)) continue
    const bucket = openExpenseClaims[claim.employee_id] ?? { count: 0, total_sek: 0 }
    bucket.count += 1
    bucket.total_sek = roundOre(bucket.total_sek + (Number(claim.amount_sek) || 0))
    openExpenseClaims[claim.employee_id] = bucket
  }

  // Calculated means current (calculationState above): only then are the
  // figures on this page the ones approval and booking accept. A stale run
  // shows no calculated figures, says why, and offers Beräkna om. "Not yet
  // calculated" still differs from "calculated to 0" (a nollkörning).
  const isCalculated = calculationState === 'current'
  const isStale = calculationState === 'stale'
  // A förmånsvärde alone is still reported (its individuppgift, avgifter on
  // it), so a run with one is no nollkörning even at gross 0 (crm#1596).
  const isNollkorning =
    isCalculated &&
    Math.round((run.total_gross ?? 0) * 100) === 0 &&
    employees.every((sre) => Math.round((sre.benefit_values ?? 0) * 100) === 0)
  // A run that pays out nothing (a nollkörning, or one fully consumed by a
  // nettolöneavdrag) has no payment-file line and no payout to perform. The
  // pay step collapses to a plain "continue" and the payment-file panel is
  // hidden - mirrors the pain.001 / BG-LB generators, which emit no rows here.
  const noPayout = isCalculated && Math.round((run.total_net ?? 0) * 100) === 0

  // Real AGI filing state: run-row timestamps + the extension's submission
  // record. Falls back gracefully when the extension is unavailable.
  const agiState = deriveAgiFilingState(run, agiSubmission)

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

  // Markera som betald records that the net pay has left the bank; it posts
  // nothing, but Bokför then books the payout on the payment date. With that
  // date still ahead it is rarely true yet, so ask first (crm#1216). The
  // server refuses such a run without the answer (paymentDateAheadRefusal);
  // a confirmed one goes through, since some companies pay early on purpose.
  async function handleMarkPaid() {
    if (!run) return
    if (needsFuturePayoutConfirm(run.payment_date, noPayout)) {
      const ok = await confirmAction({
        title: t('confirm_mark_paid_ahead_title'),
        description: t('confirm_mark_paid_ahead', { date: formatDate(run.payment_date) }),
        confirmLabel: t('action_mark_paid'),
        variant: 'warning',
      })
      if (!ok) return
      handleAction('paid', 'POST', { confirm_payment_date_ahead: true })
      return
    }
    handleAction('paid')
  }

  // Bokför posts the run's vouchers at once, dated on the payment date (frozen
  // when the run left draft), the net pay out of the bank account. Confirm up
  // front with that outcome, and say plainly when
  // the date has not come yet: nothing else on the page told the user the
  // vouchers would be dated ahead of the payout (crm#1216).
  async function handleBook() {
    if (!run) return
    const date = formatDate(run.payment_date)
    const ahead = isPaymentDateAhead(run.payment_date)
    const lines = [t('confirm_book_intro', { period: periodLabel, date })]
    if (!noPayout) lines.push(t('confirm_book_bank'))
    if (ahead) lines.push(t('confirm_book_ahead', { date }))
    lines.push(t('confirm_book_correction'))
    const ok = await confirmAction({
      title: t('confirm_book_title'),
      description: lines.join('\n\n'),
      confirmLabel: t('action_book'),
      variant: 'warning',
    })
    if (!ok) return
    // The dialog named the early date: that is the confirmation the server
    // asks for before it posts a payout ahead of its day.
    handleAction('book', 'POST', ahead ? { confirm_payment_date_ahead: true } : undefined)
  }

  // A booked run's next step is the AGI, filed in the section further down:
  // the header button takes the user there instead of the rail describing it.
  function scrollToAgi() {
    const section = document.getElementById(AGI_SECTION_ID)
    if (!section) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    section.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
  }

  // Betala via banken is the way to pay an approved run where bank payments
  // are on and none is live yet: the header's button, the payment file folded
  // under the section as the other way. Markera som betald moves to the menu.
  const canPayViaBank = canWrite && bankPayments.available === true && run.status === 'approved' && !noPayout
  // Until both answers are in, the way to pay is unknown: no pay button and no
  // payment panels yet, rather than the file first and then folded away.
  const bankPaymentsKnown = bankPayments.available !== null && bankPayments.orders !== null
  const payViaBankFirst = canPayViaBank && bankPaymentsKnown && !inBankPayment

  // The one next step for the current status, mirrored as a prominent header
  // button - the rail alone buried it (nobody found Godkänn).
  const primaryAction = !canWrite
    ? null
    : run.status === 'draft'
      ? isCalculated
        ? { key: 'review', label: t('action_to_review'), onClick: handleToReview }
        : {
            key: 'calculate',
            label: isStale ? t('action_recalculate') : t('action_calculate'),
            onClick: () => handleCalculate(),
          }
      : run.status === 'review'
        ? isCalculated
          ? { key: 'approve', label: t('action_approve'), onClick: () => doApprove(false) }
          : // Godkänn would be refused: offer the step that makes it possible.
            {
              key: 'calculate',
              label: t('action_recalculate'),
              onClick: () => handleCalculate({ fromReview: true }),
            }
        : run.status === 'approved'
          ? noPayout
            ? { key: 'paid', label: t('action_continue'), onClick: handleMarkPaid }
            : payViaBankFirst
              ? { key: 'pay_bank', label: tBank('pay_button'), onClick: () => setPayDialogOpen(true) }
              : // A bank payment is under way: the run moves to paid by itself
                // once the bank has executed every payment.
                inBankPayment || !bankPaymentsKnown
                ? null
                : { key: 'paid', label: t('action_mark_paid'), onClick: handleMarkPaid }
          : run.status === 'paid'
            ? { key: 'book', label: t('action_book'), onClick: handleBook }
            : run.status === 'booked' && agiState !== 'signed'
              ? { key: 'agi', label: t('action_submit_agi'), onClick: scrollToAgi }
              : null

  // Calculation detail and the journal preview read best side by side on the
  // wide canvas; they stack on smaller viewports.
  const calculationAndVouchers = (
    <div className="grid gap-x-12 gap-y-8 lg:grid-cols-2 items-start">
      <RunCalculationDetails
        periodYear={run.period_year}
        employees={employees}
        calculationParams={run.calculation_params}
      />
      {preview && (
        <RunJournalPreview
          preview={preview}
          onRecalculate={run.status === 'draft' && canWrite ? () => handleCalculate() : undefined}
          recalculating={actionLoading === 'calculate'}
          underlagHref={
            preview.booked ? `/api/salary/runs/${id}/underlag/pdf` : undefined
          }
          benefitValues={roundOre(employees.reduce((sum, sre) => sum + (sre.benefit_values ?? 0), 0))}
        />
      )}
    </div>
  )

  // The payment file of the run, while no bank payment is live (it would pay
  // the month twice). Where Betala via banken comes first it folds under it.
  const paymentFile = !inBankPayment && (
    <PaymentFilePanel
      salaryRunId={id}
      periodLabel={periodLabel}
      paymentFileFormat={run.payment_file_format}
      paymentFileGeneratedAt={run.payment_file_generated_at}
      paymentFileVersion={run.payment_file_version ?? 1}
      defaultFormat={preferredPaymentFormat}
      senderBankgiro={senderBankgiro}
      fileAccount={runFileAccount}
      readOnly={!canWrite}
      settled={run.status === 'paid' || run.status === 'booked'}
      folded={payViaBankFirst}
      onDownloaded={loadRun}
    />
  )

  // Paying: available once the run is approved, but only when there is
  // something to pay out (a zero-payout run generates no file rows).
  const payPanels = ['approved', 'paid', 'booked'].includes(run.status) && !noPayout && bankPaymentsKnown && (
    <>
      <SalaryBankPaymentSection payments={bankPayments} canPay={canPayViaBank} onPay={() => setPayDialogOpen(true)}>
        {payViaBankFirst && paymentFile}
      </SalaryBankPaymentSection>
      {!payViaBankFirst && paymentFile}
    </>
  )
  const payIsCurrent = run.status === 'approved'

  // Filing: the AGI once the run is booked (the header's Lämna in AGI), then
  // the tax payment (skatt + arbetsgivaravgifter) once the AGI is generated.
  const filingPanels = run.status === 'booked' && (
    <>
      {/* AGI (Arbetsgivardeklaration). The XML download for manual filing
          lives in the header's ⋯ menu. The anchor of the header's "Lämna in
          AGI"; scroll-mt clears the sticky top bar. */}
      <div id={AGI_SECTION_ID} className="scroll-mt-24">
        <AGIPanel
          salaryRunId={id}
          arbetsgivare={run.arbetsgivare ?? ''}
          period={formatAgiPeriodCompact(agiReportingPeriod(run))}
          agiGeneratedAt={run.agi_generated_at}
          agiSubmittedAt={run.agi_submitted_at}
          submission={agiSubmission}
          onRefreshSubmission={refreshAgiSubmission}
          readOnly={!canWrite}
          onChange={loadRun}
        />
      </div>
      {run.agi_generated_at && (
        taxPaymentLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <TaxPaymentPanel
            // The AGI period (payout month), the key the declaration was
            // fetched with above: the earned month named the previous AGI for
            // lön i efterskott, so the file and mark-paid hit the wrong period.
            period={formatAgiPeriodDashed(agiReportingPeriod(run))}
            // Prefer the AGI declaration's stored totals (whole kronor, and
            // they honor review overrides/corrections); the run totals are
            // the pre-AGI fallback and get truncated inside the panel.
            totalTax={taxPayment?.total_tax ?? run.total_tax}
            totalAvgifter={taxPayment?.total_avgifter ?? run.total_avgifter}
            paymentFileFormat={taxPayment?.tax_payment_file_format ?? null}
            paymentFileGeneratedAt={taxPayment?.tax_payment_file_generated_at ?? null}
            taxPaidAt={taxPayment?.tax_paid_at ?? null}
            paymentDueDate={taxPayment?.payment_due_date ?? null}
            agiPeriod={taxPayment ? formatAgiPeriodDashed(agiReportingPeriod(run)) : null}
            periodConflict={taxPayment?.period_conflict ?? null}
            bankPayment={taxPayment?.bank_payment ?? null}
            defaultFormat={preferredPaymentFormat}
            senderBankgiro={senderBankgiro}
            fileAccount={taxFileAccount}
            readOnly={!canWrite}
            onChange={loadRun}
          />
        )
      )}
    </>
  )
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
        // The run is a guided sequence: its one next step sits in the fixed
        // bar at the bottom of the page (V7 long processes), not in the top bar.
        primaryAction={null}
        onMarkPaid={run.status === 'approved' && !noPayout && primaryAction?.key !== 'paid' ? handleMarkPaid : null}
        onPreview={handlePreview}
        onRevert={() => handleAction('revert')}
        onUnapprove={handleUnapprove}
        payslipChannels={payslipChannels}
        onSendPayslips={(channel) => void handleSendPayslips(channel)}
        onDownloadPayslips={handleBulkPayslipDownload}
        onDownloadAgi={handleDownloadAgi}
        onOpenForaReport={reportsToFora ? () => setForaOpen(true) : null}
        onDelete={handleDelete}
        onCorrect={handleCorrect}
        onUpdatePaymentDate={handleUpdatePaymentDate}
      />

      {/* The one attention sentence on the page (the two never coincide: a
          nollkörning is a current calculation). A stale calculation: say why
          the figures are gone and Godkänn is not offered; Beräkna om is the
          step bar's primary action. An empty declaration will be filed for the
          period, which should be deliberate. */}
      {isStale && <AttnLine>{t('calculation_stale')}</AttnLine>}
      {isNollkorning && (
        <AttnLine>
          {t('nollkorning_title')}: {t('nollkorning_body', { period: periodLabel })}
        </AttnLine>
      )}

      {/* The month's steps as a flat rail: where the run stands and what the
          stage means. Actions live in the header. */}
      <RunProgressBar run={run} isCalculated={isCalculated} agiState={agiState} />

      {/* The step the run is in comes first, right under the rail: paying an
          approved run, the AGI and the tax payment of a booked one. Paid, the
          payment keeps its place further down as the run's record. */}
      {payIsCurrent && payPanels}
      {filingPanels}

      {/* Totals of a stale calculation are not the run's figures any more. */}
      {!isStale && <RunKpiCards run={run} employees={employees} />}

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
        openExpenseClaims={openExpenseClaims}
        onAddExpenseClaims={handleAddExpenseClaims}
      />

      {/* What is reviewed before approval; reference after it, folded. */}
      {run.status === 'draft' || run.status === 'review' ? (
        calculationAndVouchers
      ) : (
        <RunFoldSection kicker={t('underlag_fold_title')}>{calculationAndVouchers}</RunFoldSection>
      )}

      {!payIsCurrent && payPanels}

      {/* The step's bar: the one next step for the run's status (Beräkna,
          Till granskning, Godkänn, Betala, Bokför, Lämna in AGI), fixed to
          the bottom. Everything else stays in the top bar's menu. */}
      {primaryAction && (
        <StepBar>
          <Button
            onClick={primaryAction.onClick}
            disabled={!!actionLoading}
            loading={actionLoading === primaryAction.key}
          >
            {primaryAction.label}
          </Button>
        </StepBar>
      )}

      <SalaryBankPaymentDialog
        salaryRunId={id}
        fileAccount={runFileAccount}
        open={payDialogOpen}
        onClose={() => setPayDialogOpen(false)}
        onDone={() => {
          bankPayments.reload()
          loadRun()
        }}
      />

      <Dialog open={approveOverride !== null} onOpenChange={(open) => { if (!open) setApproveOverride(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('approve_override_title')}</DialogTitle>
            <DialogDescription className="pt-2 text-left">
              {t('approve_override_body')}
            </DialogDescription>
          </DialogHeader>
          {approveOverride && approveOverride.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg p-3 text-xs bg-control shadow-raised">
              <ExclamationTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
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
            <Button onClick={() => doApprove(true)} loading={actionLoading === 'approve'}>
              {t('approve_override_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DestructiveConfirmDialog {...dialogProps} />

      {payslipCharge && (
        <UsageLimitDialog
          kind={`${payslipCharge.channel}_send`}
          included={payslipCharge.included}
          unitPriceOre={payslipCharge.unitPriceOre}
          open
          onOpenChange={(open) => {
            if (!open) setPayslipCharge(null)
          }}
        />
      )}

      {/* Fora's month is the payment month, like the AGI's. */}
      {foraOpen && (
        <ForaReportDialog
          open={foraOpen}
          onOpenChange={setForaOpen}
          year={paymentPeriod.periodYear}
          month={paymentPeriod.periodMonth}
        />
      )}
    </div>
  )
}
