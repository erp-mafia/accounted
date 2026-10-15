'use client'

import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Stegen (concept scene 34): a numbered row of steps whose dots walk
 * check -> filled -> number. Shared by the bokslut guide and the
 * årsredovisning page so both flows read the same way.
 *
 * The caller decides each step's state and which steps can be selected:
 * the bokslut guide only lets the user go back, the årsredovisning page
 * scrolls to any step's section.
 */
export interface StepRailStep {
  key: string
  label: string
  state: 'done' | 'current' | 'upcoming'
  /** Short status under the label ("klart", "3 fel"). */
  sub?: string | null
  /** The sub reads as an attention line (ochre), e.g. a blocker count. */
  warn?: boolean
}

interface StepRailProps {
  steps: StepRailStep[]
  ariaLabel: string
  /** Steps without a handler, or for which `canSelect` is false, are inert. */
  onSelect?: (key: string) => void
  canSelect?: (step: StepRailStep, index: number) => boolean
  /** Tighter gaps for rails with many steps. */
  compact?: boolean
  className?: string
}

export function StepRail({
  steps,
  ariaLabel,
  onSelect,
  canSelect,
  compact = false,
  className,
}: StepRailProps) {
  return (
    <nav aria-label={ariaLabel} className={cn('w-full', className)}>
      <ol className={cn('flex w-full items-center overflow-x-auto px-1', compact ? 'gap-2' : 'gap-3')}>
        {steps.map((step, i) => {
          const selectable = Boolean(onSelect) && (canSelect ? canSelect(step, i) : true)
          return (
            <li
              key={step.key}
              className={cn(
                'flex items-center',
                i > 0 ? 'flex-1' : 'shrink-0',
                compact ? 'gap-2' : 'gap-3',
              )}
            >
              {i > 0 && (
                <span
                  className={cn('h-px flex-1 bg-border', compact ? 'min-w-3' : 'min-w-4')}
                  aria-hidden="true"
                />
              )}
              <button
                type="button"
                aria-current={step.state === 'current' ? 'step' : undefined}
                disabled={!selectable}
                onClick={() => {
                  if (selectable) onSelect?.(step.key)
                }}
                className={cn(
                  'group flex shrink-0 items-center gap-2 text-left',
                  !selectable && 'cursor-default',
                )}
              >
                <span
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums transition-colors duration-150',
                    step.state === 'done'
                      ? 'border-success/40 text-success'
                      : step.state === 'current'
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-border text-muted-foreground',
                  )}
                >
                  {step.state === 'done' ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : i + 1}
                </span>
                <span className="leading-tight">
                  <span
                    className={cn(
                      'block text-[12.5px] transition-colors duration-150',
                      step.state === 'current'
                        ? 'font-medium'
                        : cn('text-muted-foreground', selectable && 'group-hover:text-foreground'),
                    )}
                  >
                    {step.label}
                  </span>
                  {step.sub && (
                    <span
                      className={cn(
                        'block text-[11px] tabular-nums',
                        step.warn ? 'text-attn' : 'text-muted-foreground',
                      )}
                    >
                      {step.sub}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
