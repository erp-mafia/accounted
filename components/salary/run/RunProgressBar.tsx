'use client'

import { useTranslations, useLocale } from 'next-intl'
import { formatDateLong } from '@/lib/utils'
import type { AgiFilingState } from '@/lib/salary/agi-submission-state'
import type { RunDetail } from './types'

type StepState = 'done' | 'active' | 'upcoming'

interface RunProgressBarProps {
  run: RunDetail
  isCalculated: boolean
  // True when the run pays out nothing (nollkörning / fully net-deducted): the
  // pay step carries no "download the file" hint because there is no file.
  noPayout?: boolean
  // Real filing state for the AGI step (deriveAgiFilingState): without it the
  // rail only knows generated/submitted and mislabels "waiting for BankID
  // signature" as "lämna in till Skatteverket".
  agiState: AgiFilingState
  // Shown on the AGI step once signed: the kvittens is the filing receipt.
  agiKvittensnummer?: string | null
}

const STATUS_RANK: Record<string, number> = {
  draft: 0,
  review: 1,
  approved: 2,
  paid: 3,
  booked: 4,
  corrected: 4,
}

/**
 * The month's steps as a flat segmented rail: no box, no buttons. The actions
 * for the current stage live in the header (primary button + ⋯ menu); the
 * rail only says where the run stands and what the stage means.
 */
export function RunProgressBar(props: RunProgressBarProps) {
  const t = useTranslations('salary_run')
  const locale = useLocale()
  const { run, isCalculated, noPayout, agiState, agiKvittensnummer } = props
  const rank = STATUS_RANK[run.status] ?? 0
  const deliveries = run.payslip_deliveries_summary

  // Payslips are a parallel obligation from `approved` onwards: never gate
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
      state: agiState === 'signed' ? 'done' : run.status === 'booked' ? 'active' : 'upcoming',
      detail:
        agiState === 'signed'
          ? agiKvittensnummer
            ? t('rail_agi_submitted_kvittens', { kvittens: agiKvittensnummer })
            : t('rail_agi_submitted')
          : agiState === 'awaiting_signing'
            ? t('rail_agi_awaiting_signature')
            : agiState === 'underlag_submitted'
              ? t('rail_agi_underlag_submitted')
              : agiState === 'generated'
                ? t('rail_agi_generated')
                : run.status === 'booked'
                  ? t('rail_agi_hint')
                  : undefined,
    },
  ]

  const doneCount = steps.filter(s => s.state === 'done').length
  const activeStep = steps.find(s => s.state === 'active')

  function segClass(state: StepState) {
    return state === 'done'
      ? 'bg-primary'
      : state === 'active'
        ? 'bg-primary/50'
        : 'bg-border'
  }

  // The stage line + its detail: a single sentence that sits under the track.
  const currentLine = activeStep?.detail ?? (activeStep ? activeStep.label : t('rail_all_done'))

  return (
    <div>
      {/* Mobile: segmented track + current step + counter. */}
      <div className="md:hidden space-y-3">
        <div className="flex gap-1">
          {steps.map(step => (
            <span key={step.key} className={`h-1 flex-1 rounded-full transition-colors duration-150 ${segClass(step.state)}`} />
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
      </div>

      {/* Desktop: segmented track with per-segment labels, then the stage
          sentence. */}
      <div className="hidden md:block space-y-3">
        <ol className="flex gap-2">
          {steps.map(step => (
            <li key={step.key} className="flex-1 min-w-0 space-y-2">
              <span className={`block h-1 rounded-full transition-colors duration-150 ${segClass(step.state)}`} aria-hidden />
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
        <p className="text-xs text-muted-foreground">{currentLine}</p>
      </div>
    </div>
  )
}
