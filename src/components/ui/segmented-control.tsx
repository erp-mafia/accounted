'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface SegmentedControlOption<T extends string> {
  value: T
  /** Segment label. Pass a fragment for custom trailing content (e.g. a muted count). */
  label: React.ReactNode
  /** Renders the standard count chip after the label when > 0. */
  count?: number
  /**
   * Why the segment cannot be chosen right now. The segment stays in the
   * tablist (focusable, aria-disabled) with the reason as its tooltip and
   * its accessible description.
   */
  disabledReason?: string
}

interface SegmentedControlProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: SegmentedControlOption<T>[]
  'aria-label'?: string
  className?: string
}

/**
 * The toolbar segmented control (view/mode switcher). Pill-in-pill per the
 * radius ladder: interactive toolbar controls are pills, and pill nesting is
 * concentric by construction. One fixed height (h-8) shared with
 * ToolbarSearch and ContextPicker so a toolbar row reads as one line.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  className,
  ...aria
}: SegmentedControlProps<T>) {
  const idPrefix = React.useId()
  const reasonId = (index: number) => `${idPrefix}-reason-${index}`
  return (
    <>
      <div
        className={cn(
          'inline-flex h-8 shrink-0 items-center gap-0.5 rounded-full bg-muted/70 p-[3px]',
          className,
        )}
        role="tablist"
        aria-label={aria['aria-label']}
      >
        {options.map((opt, index) => {
          const disabled = Boolean(opt.disabledReason)
          return (
            // data-ph-unmask: segment labels are static i18n chrome in session
            // replays; the count chip inside is data and carries data-ph-mask
            // (nearest tag wins), matching the nav count bubbles.
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={value === opt.value}
              aria-disabled={disabled || undefined}
              aria-describedby={disabled ? reasonId(index) : undefined}
              title={opt.disabledReason}
              onClick={() => {
                if (!disabled) onChange(opt.value)
              }}
              data-ph-unmask=""
              className={cn(
                'inline-flex h-full items-center gap-1.5 rounded-full px-3.5 text-[12.5px] transition-colors duration-150',
                value === opt.value
                  ? 'border border-border bg-card font-medium text-foreground'
                  : disabled
                    ? 'cursor-not-allowed text-muted-foreground/60'
                    : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {opt.label}
              {typeof opt.count === 'number' && opt.count > 0 && (
                <span data-ph-mask="" className="rounded-full bg-secondary px-1.5 text-[11px] font-medium tabular-nums">
                  {opt.count}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {/* Outside the tablist, which may only own tabs. */}
      {options.map((opt, index) =>
        opt.disabledReason ? (
          <span key={opt.value} id={reasonId(index)} className="sr-only">
            {opt.disabledReason}
          </span>
        ) : null,
      )}
    </>
  )
}
