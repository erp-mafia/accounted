'use client'

import { ChevronLeft } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { StepRail } from '@/components/bokslut/StepRail'

interface ImportWizardRailProps<S extends string> {
  /** The wizard's steps in order. Empty for a state without steps (a running SIE job). */
  steps: readonly S[]
  current: S | null
  label: (step: S) => string
  /** Back to the import choices: the rail's first crumb. */
  onBack?: () => void
}

/**
 * The import wizards' chrome: one compact row with "Tillbaka till val" as the
 * first crumb and the steps as the rail the bokslut and årsredovisning pages
 * use. It replaces the ghost back button, the bordered progress card with its
 * bar, and the step-card titles that restated the current step.
 */
export function ImportWizardRail<S extends string>({
  steps,
  current,
  label,
  onBack,
}: ImportWizardRailProps<S>) {
  const t = useTranslations('import')
  const currentIndex = current === null ? -1 : steps.indexOf(current)

  if (!onBack && steps.length === 0) return null

  return (
    <div className="flex min-w-0 items-center gap-3">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="inline-flex shrink-0 items-center gap-1 text-[12.5px] text-muted-foreground transition-colors duration-150 hover:text-foreground pointer-coarse:min-h-10"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t('back_to_choices')}
        </button>
      )}
      {onBack && steps.length > 0 && <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />}
      {steps.length > 0 && (
        <StepRail
          compact
          className="min-w-0 flex-1"
          ariaLabel={t('wizard_steps_label')}
          steps={steps.map((step, i) => ({
            key: step,
            label: label(step),
            state: i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'upcoming',
          }))}
        />
      )}
    </div>
  )
}
