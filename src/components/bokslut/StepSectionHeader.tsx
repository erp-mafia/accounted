import type { ReactNode } from 'react'
import {
  ANNUAL_REPORT_STEP_KEYS,
  type AnnualReportStepKey,
} from '@/lib/bokslut/arsredovisning/workflow-steps'

/** The anchor a rail step scrolls to. */
export function annualReportStepAnchor(step: AnnualReportStepKey): string {
  return `ar-step-${step}`
}

/**
 * The divider heading of one årsredovisning step, numbered like the step
 * rail at the top of the page so a section and its step read as one.
 * `help` is the section's "?" (a HelpPopover): its intro and § references,
 * so the section body carries no instructional copy (convention 7).
 */
export function StepSectionHeader({
  step,
  title,
  help,
}: {
  step: AnnualReportStepKey
  title: string
  help?: ReactNode
}) {
  return (
    <div className="mb-1 flex items-center gap-2 px-1">
      <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <span className="tabular-nums">{ANNUAL_REPORT_STEP_KEYS.indexOf(step) + 1}.</span> {title}
      </h3>
      {help}
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}
