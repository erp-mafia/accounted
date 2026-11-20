'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'
import { CountTile } from '@/components/ui/count-tile'

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
 * The toolbar segmented control (view/mode switcher), Stil v3: a wash track
 * (8px radius, 2px inset) holding 28px segments (6px radius, concentric),
 * the selected one on the raised control surface. One fixed height (h-8)
 * shared with ToolbarSearch and the pickers so a toolbar row reads as one
 * line. Counts sit in CountTile.
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
          'inline-flex h-8 shrink-0 items-center gap-0.5 rounded-lg bg-secondary/80 p-0.5',
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
                'group/seg inline-flex h-full items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-[background-color,box-shadow,color] duration-150',
                value === opt.value
                  ? 'bg-control text-strong shadow-raised'
                  : disabled
                    ? 'cursor-not-allowed text-muted-foreground/60'
                    : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {opt.label}
              {typeof opt.count === 'number' && opt.count > 0 && <CountTile value={opt.count} />}
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
