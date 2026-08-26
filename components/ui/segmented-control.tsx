'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface SegmentedControlOption<T extends string> {
  value: T
  /** Segment label. Pass a fragment for custom trailing content (e.g. a muted count). */
  label: React.ReactNode
  /** Renders the standard count chip after the label when > 0. */
  count?: number
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
  return (
    <div
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-0.5 rounded-full bg-muted/70 p-[3px]',
        className,
      )}
      role="tablist"
      aria-label={aria['aria-label']}
    >
      {options.map((opt) => (
        // data-ph-unmask: segment labels are static i18n chrome in session
        // replays; the count chip inside is data and carries data-ph-mask
        // (nearest tag wins), matching the nav count bubbles.
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          onClick={() => onChange(opt.value)}
          data-ph-unmask=""
          className={cn(
            'inline-flex h-full items-center gap-1.5 rounded-full px-3.5 text-[12.5px] transition-colors duration-150',
            value === opt.value
              ? 'border border-border bg-card font-medium text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.label}
          {typeof opt.count === 'number' && opt.count > 0 && (
            <span data-ph-mask="" className="rounded-full bg-secondary px-1.5 text-[10px] font-medium tabular-nums">
              {opt.count}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
