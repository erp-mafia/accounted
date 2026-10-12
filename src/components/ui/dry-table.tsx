'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Concept dry-table (scenes 9/10): borderless table straight on the panel,
// uppercase hairline heads, 13px rows, hover-revealed row controls. Shared by
// the verifikat list and the transaction inbox so the two read as the same
// instrument. Keep these in sync with .claude/rules/design.md; page-specific
// tweaks belong at the call site via cn(), not here.
export const TH_CLASS =
  'px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground border-b border-border whitespace-nowrap'
export const TD_CLASS = 'px-4 py-[11px] border-b border-border align-top'
export const VTH_CLASS =
  'py-2 pr-4 text-left text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground border-b border-border'
export const VTD_CLASS = 'py-[7px] pr-4 border-b border-border align-top'
export const QUIET_LINK_CLASS =
  'text-[12.5px] text-muted-foreground underline decoration-border underline-offset-4 transition-colors duration-150 hover:text-foreground'

// Row controls that stay out of the way until the row is hovered. Coarse
// pointers never fire hover, so without pointer-coarse: the control would be
// permanently invisible and the action unreachable on touch. Always use this
// constant instead of hand-rolling `opacity-0 group-hover:opacity-100`.
//
// focus-within is what makes this safe on a WRAPPER: focus-visible only matches
// the element itself, so a non-focusable <span> holding the buttons would stay
// transparent while a keyboard user tabbed through the controls inside it.
export const HOVER_REVEAL_CLASS =
  'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100'

// Row SELECTION checkboxes are not hover-reveal controls: bulk-select is a
// primary workflow on list pages, and an invisible 16px target forces a
// precise hover-then-aim per row (user feedback: "sjukt pilligt"). They rest
// always-visible at muted opacity and go solid on hover/focus/coarse
// pointers; call sites force opacity-100 when checked. Action controls
// (chevrons, buttons) keep HOVER_REVEAL_CLASS above.
//
// Call sites must also put `border-foreground` (unconditionally) on the
// Checkbox itself: the primitive's border-input is ~1.4:1 against the page,
// which composited at opacity-50 lands ~1.2:1, under the WCAG 3:1 non-text
// minimum. border-foreground composites to >=3.4:1 at rest in every theme.
// It lives at the call site, not in this constant, because the constant is
// sometimes applied to a borderless WRAPPER around the checkbox.
export const CHECKBOX_REVEAL_CLASS =
  'opacity-50 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100'

// Animated row expansion (concept vwrap/vinner): grid-rows 0fr -> 1fr on
// mount; the global reduced-motion rule collapses the transition.
export function RowFoldout({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div
      className="grid transition-[grid-template-rows] duration-300 ease-out"
      style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

/** Rows a client-side list shows at first and adds per "Ladda fler". */
export const SHOW_MORE_STEP = 100

interface SortableThProps {
  label: string
  /** The column's sort, or null when the list is sorted on another column. */
  direction: 'asc' | 'desc' | null
  onSort: () => void
  align?: 'left' | 'right'
  className?: string
}

/**
 * A sortable dry-table head: the TH_CLASS idiom with a button that keeps the
 * uppercase (Preflight resets text-transform on buttons), states the sort to
 * assistive tech (aria-sort, "Sortera efter X"), has a keyboard focus ring
 * and a 40px target. The invoice and supplier invoice lists had this; the
 * customer, article and dimension lists had a bare button without any of it.
 */
export function SortableTh({ label, direction, onSort, align = 'left', className }: SortableThProps) {
  const t = useTranslations('common')
  const SortIcon = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ArrowUpDown
  return (
    <th
      className={cn(TH_CLASS, className)}
      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
    >
      <button
        type="button"
        className={cn(
          '-mx-2 inline-flex min-h-10 items-center gap-1 rounded-sm px-2 uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          align === 'right' && 'ml-auto justify-end',
        )}
        aria-label={t('sort_by', { column: label })}
        onClick={onSort}
      >
        <span>{label}</span>
        <SortIcon aria-hidden="true" className={cn('h-3.5 w-3.5 shrink-0', !direction && 'text-muted-foreground/60')} />
      </button>
    </th>
  )
}

/** "Ladda fler" under a client-side list cut at `shown` of `total` rows; renders nothing when all are shown. */
export function ShowMoreFooter({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  const t = useTranslations('common')
  if (shown >= total) return null
  return (
    <div className="flex justify-center">
      <Button type="button" variant="outline" onClick={onMore}>
        {t('load_more')}
      </Button>
    </div>
  )
}
