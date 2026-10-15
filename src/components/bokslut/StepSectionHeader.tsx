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
 */
export function StepSectionHeader({ step, title }: { step: AnnualReportStepKey; title: string }) {
  return (
    <div className="mb-1 flex items-center gap-2 px-1">
      <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <span className="tabular-nums">{ANNUAL_REPORT_STEP_KEYS.indexOf(step) + 1}.</span> {title}
      </h3>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}
