'use client'

import { useTranslations } from 'next-intl'
import type { AgiFilingState } from '@/lib/salary/agi-submission-state'
import type { RunDetail } from './types'

type StepState = 'done' | 'active' | 'upcoming'

interface RunProgressBarProps {
  run: RunDetail
  isCalculated: boolean
  // Real filing state for the AGI step (deriveAgiFilingState): without it the
  // rail only knows generated/submitted and would mark the step done before
  // Skatteverket has the signed declaration.
  agiState: AgiFilingState
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
 * for the current stage live in the header (primary button + ⋯ menu), so the
 * rail shows the step labels only and adds a line just for an exception the
 * header does not say: failed payslips, or an AGI waiting on Skatteverket or
 * on a BankID signature.
 */
export function RunProgressBar(props: RunProgressBarProps) {
  const t = useTranslations('salary_run')
  const { run, isCalculated, agiState } = props
  const rank = STATUS_RANK[run.status] ?? 0
  const deliveries = run.payslip_deliveries_summary

  // Payslips are a parallel obligation from `approved` onwards: never gate
  // progression, so their "done" is simply having reached every employee.
  const payslipsAvailable = rank >= 2
  const payslipsDone =
    payslipsAvailable && !!deliveries && deliveries.sent > 0 && deliveries.failed === 0

  interface Step {
    key: string
    label: string
    state: StepState
  }

  // isCalculated means the calculation is current. Past review it is frozen;
  // before that a run whose calculation went stale is back on this step, in
  // review too (a run that reached review before the review step checked it).
  const calculationDone = rank > 1 || isCalculated

  const steps: Step[] = [
    {
      key: 'calculate',
      label: t('rail_calculate'),
      state: calculationDone ? 'done' : 'active',
    },
    {
      key: 'approve',
      label: t('rail_approve'),
      state: rank > 1 ? 'done' : run.status === 'review' && calculationDone ? 'active' : 'upcoming',
    },
    {
      key: 'pay',
      label: t('rail_pay'),
      state: rank > 2 ? 'done' : run.status === 'approved' ? 'active' : 'upcoming',
    },
    {
      key: 'payslips',
      label: t('rail_payslips'),
      state: payslipsDone ? 'done' : payslipsAvailable ? 'active' : 'upcoming',
    },
    {
      key: 'book',
      label: t('rail_book'),
      state: rank > 3 ? 'done' : run.status === 'paid' ? 'active' : 'upcoming',
    },
    {
      key: 'agi',
      label: t('rail_agi'),
      state: agiState === 'signed' ? 'done' : run.status === 'booked' ? 'active' : 'upcoming',
    },
  ]

  const doneCount = steps.filter(s => s.state === 'done').length
  const activeStep = steps.find(s => s.state === 'active')

  // The one exception line, if any. A payslip that failed to go out is the
  // employer's to resend; an AGI parked at Skatteverket waits on something
  // outside this page. Everything else is said by the header's button.
  const exception =
    payslipsAvailable && deliveries && deliveries.failed > 0
      ? t('rail_payslips_summary', {
          sent: deliveries.sent,
          failed: deliveries.failed,
          skipped: deliveries.skipped,
        })
      : run.status === 'booked' && agiState === 'awaiting_signing'
        ? t('rail_agi_awaiting_signature')
        : run.status === 'booked' && agiState === 'underlag_submitted'
          ? t('rail_agi_underlag_submitted')
          : null

  function segClass(state: StepState) {
    return state === 'done'
      ? 'bg-primary'
      : state === 'active'
        ? 'bg-primary/50'
        : 'bg-border'
  }

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
          <p className="text-xs text-muted-foreground tabular-nums">
            {t('rail_step_counter', { done: doneCount, total: steps.length })}
          </p>
        </div>
        {exception && <p className="text-xs text-muted-foreground">{exception}</p>}
      </div>

      {/* Desktop: segmented track with per-segment labels; a line beneath
          only for an exception. */}
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
        {exception && <p className="text-xs text-muted-foreground">{exception}</p>}
      </div>
    </div>
  )
}
