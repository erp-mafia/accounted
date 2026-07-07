'use client'

import { useTranslations, useLocale } from 'next-intl'
import { Button } from '@/components/ui/button'
import { ArrowLeftCircle, Eye, FileDown, Loader2, Send } from 'lucide-react'
import { formatDateLong } from '@/lib/utils'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { RunDetail } from './types'

type StepState = 'done' | 'active' | 'upcoming'

interface RunProgressBarProps {
  run: RunDetail
  isCalculated: boolean
  // True when the run pays out nothing (nollkörning / fully net-deducted): the
  // pay step carries no "download the file" hint because there is no file.
  noPayout?: boolean
  canWrite: boolean
  actionLoading: string | null
  // The single "forward" step for the current status (Beräkna → Skicka till
  // granskning → Godkänn → Markera utbetald → Bokför). Rendered as the large
  // primary target in the control zone, right next to the secondary actions.
  primaryAction?: { key: string; label: string; onClick: () => void } | null
  // Secondary actions for the stage: preview, revert, and the parallel payslip
  // obligation. (Recalculate lives with the employee rows.)
  onPreview: () => void
  onRevert: () => void
  onUnapprove: () => void
  onSendPayslips: () => void
  onDownloadPayslips: () => void
}

const STATUS_RANK: Record<string, number> = {
  draft: 0,
  review: 1,
  approved: 2,
  paid: 3,
  booked: 4,
  corrected: 4,
}

export function RunProgressBar(props: RunProgressBarProps) {
  const t = useTranslations('salary_run')
  const locale = useLocale()
  const { run, isCalculated, noPayout, canWrite, actionLoading, primaryAction } = props
  const rank = STATUS_RANK[run.status] ?? 0
  const busy = !!actionLoading
  const deliveries = run.payslip_deliveries_summary
  const hasEmailSend = useCapability(CAPABILITY.email_send)

  function spinnerOr(icon: React.ReactNode, key: string) {
    return actionLoading === key ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : icon
  }

  // Payslips are a parallel obligation from `approved` onwards — never gate
  // progression, so their "done" is simply having reached every employee.
  const payslipsAvailable = rank >= 2
  const payslipsDone =
    payslipsAvailable && !!deliveries && deliveries.sent > 0 && deliveries.failed === 0
  const payslipDetail = !payslipsAvailable
    ? undefined
    : deliveries && deliveries.sent + deliveries.failed + deliveries.skipped > 0
      ? t('rail_payslips_summary', {
          sent: deliveries.sent,
          failed: deliveries.failed,
          skipped: deliveries.skipped,
        })
      : t('rail_payslips_none')

  interface Step {
    key: string
    label: string
    state: StepState
    detail?: string
  }

  const steps: Step[] = [
    {
      key: 'calculate',
      label: t('rail_calculate'),
      state: rank > 0 || isCalculated ? 'done' : 'active',
      detail: rank === 0 && !isCalculated ? t('rail_calculate_hint') : undefined,
    },
    {
      key: 'approve',
      label: t('rail_approve'),
      state: rank > 1 ? 'done' : run.status === 'review' ? 'active' : 'upcoming',
      detail: run.approved_at ? formatDateLong(run.approved_at, locale) : undefined,
    },
    {
      key: 'pay',
      label: t('rail_pay'),
      state: rank > 2 ? 'done' : run.status === 'approved' ? 'active' : 'upcoming',
      detail:
        run.paid_at != null
          ? formatDateLong(run.paid_at, locale)
          : run.status === 'approved'
            ? noPayout
              ? t('rail_pay_nopayout_hint')
              : t('rail_pay_hint')
            : undefined,
    },
    {
      key: 'payslips',
      label: t('rail_payslips'),
      state: payslipsDone ? 'done' : payslipsAvailable ? 'active' : 'upcoming',
      detail: payslipDetail,
    },
    {
      key: 'book',
      label: t('rail_book'),
      state: rank > 3 ? 'done' : run.status === 'paid' ? 'active' : 'upcoming',
      detail: run.booked_at ? formatDateLong(run.booked_at, locale) : undefined,
    },
    {
      key: 'agi',
      label: t('rail_agi'),
      state: run.agi_submitted_at ? 'done' : run.status === 'booked' ? 'active' : 'upcoming',
      detail: run.agi_submitted_at
        ? t('rail_agi_submitted')
        : run.agi_generated_at
          ? t('rail_agi_generated')
          : run.status === 'booked'
            ? t('rail_agi_hint')
            : undefined,
    },
  ]

  const doneCount = steps.filter(s => s.state === 'done').length
  const activeStep = steps.find(s => s.state === 'active')

  // Payslip send/download — shared by the mobile summary and the desktop bar.
  // Email send is a paid capability (server 403s without it); the PDF
  // download alternative right next to it stays free.
  const payslipActions = payslipsAvailable && canWrite && (
    <>
      {/* The span carries the tooltip: browsers suppress `title` on
          disabled elements, and hover events don't fire on them. */}
      <span title={!hasEmailSend ? t('payslips_send_requires_subscription') : undefined}>
        <Button
          size="sm"
          variant={deliveries && deliveries.sent > 0 ? 'outline' : 'default'}
          onClick={props.onSendPayslips}
          disabled={busy || !hasEmailSend}
        >
          {spinnerOr(<Send className="mr-2 h-4 w-4" />, 'payslips-send')}
          {deliveries && deliveries.sent > 0
            ? t('action_send_payslips_again')
            : t('action_send_payslips')}
        </Button>
      </span>
      <Button variant="ghost" size="sm" onClick={props.onDownloadPayslips} disabled={busy}>
        {spinnerOr(<FileDown className="mr-2 h-4 w-4" />, 'bulk_payslip')}
        {t('action_download_payslips')}
      </Button>
    </>
  )

  // Secondary actions for the current status. The forward/primary action is
  // the header CTA, so this is deliberately the "everything else" set.
  let secondaryActions: React.ReactNode = null
  if (canWrite) {
    if (run.status === 'draft') {
      // Recalculate ("Beräkna om") lives with the employee rows it recalculates,
      // not here. This band keeps only the preview toggle.
      secondaryActions = (
        <Button
          variant="outline"
          size="sm"
          onClick={props.onPreview}
          disabled={busy || !isCalculated}
        >
          {spinnerOr(<Eye className="mr-2 h-4 w-4" />, 'preview')}
          {t('action_preview')}
        </Button>
      )
    } else if (run.status === 'review') {
      secondaryActions = (
        <>
          <Button variant="outline" size="sm" onClick={props.onPreview} disabled={busy}>
            {spinnerOr(<Eye className="mr-2 h-4 w-4" />, 'preview')}
            {t('action_preview')}
          </Button>
          <Button variant="ghost" size="sm" onClick={props.onRevert} disabled={busy}>
            <ArrowLeftCircle className="mr-2 h-4 w-4" />
            {t('action_revert')}
          </Button>
        </>
      )
    } else if (run.status === 'approved') {
      // Approval is an internal control point, not a legal event — the run can
      // be unlocked again as long as nothing has been paid, booked, or filed.
      // The API refuses once the AGI has reached Skatteverket.
      secondaryActions = (
        <>
          {payslipActions}
          <Button variant="ghost" size="sm" onClick={props.onUnapprove} disabled={busy}>
            <ArrowLeftCircle className="mr-2 h-4 w-4" />
            {t('action_unapprove')}
          </Button>
        </>
      )
    } else if (payslipsAvailable) {
      secondaryActions = payslipActions
    }
  }

  function segClass(state: StepState) {
    return state === 'done'
      ? 'bg-primary'
      : state === 'active'
        ? 'bg-primary/50'
        : 'bg-border'
  }

  // The stage line + its detail — a single sentence that sits under the track.
  const currentLine = activeStep?.detail ?? (activeStep ? activeStep.label : t('rail_all_done'))

  const primaryButton = primaryAction && (
    <Button size="sm" onClick={primaryAction.onClick} disabled={busy}>
      {actionLoading === primaryAction.key && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {primaryAction.label}
    </Button>
  )

  return (
    <div className="rounded-lg border border-border p-4">
      {/* Mobile: segmented track + current step + a full-width primary button. */}
      <div className="md:hidden space-y-3">
        <div className="flex gap-1">
          {steps.map(step => (
            <span key={step.key} className={`h-1 flex-1 rounded-full ${segClass(step.state)}`} />
          ))}
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">
            {activeStep ? activeStep.label : t('rail_all_done')}
          </p>
          <p className="text-[11px] text-muted-foreground tabular-nums">
            {t('rail_step_counter', { done: doneCount, total: steps.length })}
          </p>
        </div>
        {activeStep?.detail && (
          <p className="text-[11px] text-muted-foreground">{activeStep.detail}</p>
        )}
        {primaryAction && (
          <Button className="w-full" onClick={primaryAction.onClick} disabled={busy}>
            {actionLoading === primaryAction.key && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {primaryAction.label}
          </Button>
        )}
        {secondaryActions && <div className="flex flex-wrap gap-2">{secondaryActions}</div>}
      </div>

      {/* Desktop: segmented track with per-segment labels, then a single action
          row — the stage sentence on the left, secondary + primary on the right. */}
      <div className="hidden md:block space-y-4">
        <ol className="flex gap-2">
          {steps.map(step => (
            <li key={step.key} className="flex-1 min-w-0 space-y-2">
              <span className={`block h-1 rounded-full ${segClass(step.state)}`} aria-hidden />
              <p
                className={`text-[11px] truncate ${
                  step.state === 'active'
                    ? 'font-medium text-foreground'
                    : step.state === 'done'
                      ? 'text-foreground'
                      : 'text-muted-foreground'
                }`}
                title={step.label}
              >
                {step.label}
              </p>
            </li>
          ))}
        </ol>

        {(secondaryActions || primaryButton) && (
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground">{currentLine}</p>
            <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">
              {secondaryActions}
              {primaryButton}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
