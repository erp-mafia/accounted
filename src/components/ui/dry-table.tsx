'use client'

import { useEffect, useState, type ComponentPropsWithoutRef } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowDownIcon, ArrowUpIcon, ArrowsUpDownIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { LIST_BLEED_CLASS, TD_CLASS, TH_CLASS } from './dry-table-classes'

// Dry-table (Stil v3): a borderless table straight on the panel, 12px
// sentence-case heads over a hairline, 13px rows divided by hairlines, row
// controls that stay quiet until the row is hovered. Two row heights only:
// 44px for lists (TD_CLASS), 36px for ledger-style tables (VTD_CLASS:
// voucher lines, report rows, previews). List cells sit 8px in and the list
// bleeds 8px past the gutter (LIST_BLEED_CLASS on the table's wrapper), so
// the cell text sits on the 24px gutter while the hover tint and hairlines
// reach past it, and columns stay 16px apart (boards Kundfakturor-v3,
// Transaktioner-v3). Keep these
// in sync with .claude/rules/design.md; page-specific tweaks belong at the
// call site via cn(), not here.
export { LIST_BLEED_CLASS, TD_CLASS, TH_CLASS }
export const VTH_CLASS =
  'h-8 pr-4 text-left align-middle text-[12px] font-medium leading-4 text-muted-foreground border-b-hairline'
export const VTD_CLASS = 'h-9 py-2 pr-4 border-b-hairline align-top'
/** A Summa or total row's cells: the strong rule above, the value in the strong ink. */
export const TOTAL_TD_CLASS = 'h-9 py-2 pr-4 border-t-total font-medium text-strong tabular-nums'
export const QUIET_LINK_CLASS =
  'text-[12px] text-muted-foreground underline decoration-foreground/25 underline-offset-[3px] transition-colors duration-150 hover:text-foreground hover:decoration-foreground/60'

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

// Row SELECTION checkboxes (Stil v3 polish P2, founder-approved
// 2026-10-31): hidden at rest, shown on row hover, on keyboard focus, on
// coarse pointers, when checked, and on every row once any row is selected
// (pass revealed). The column keeps its width, so nothing shifts. The hit
// area stays the widened 32px (40px on touch) below, which is what the
// "sjukt pilligt" feedback was about: a near-miss beside the box. Action
// controls (chevrons, buttons) keep HOVER_REVEAL_CLASS above. Render row
// checkboxes with RowSelectCheckbox below, which applies this.
//
// A list that keeps the reveal on a WRAPPER must still put
// `border-foreground` (unconditionally) on the Checkbox itself: the
// primitive's border-input is ~1.4:1 against the page, which composited at
// opacity-50 lands ~1.2:1, under the WCAG 3:1 non-text minimum.
// border-foreground composites to >=3.4:1 at rest in every theme.
export const CHECKBOX_REVEAL_CLASS =
  'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100'

// The pointer target of a row selection checkbox: the box stays 16px, its
// ::after reaches 8px past each edge (32px), 12px on touch (40px, the design
// minimum). Rage clicks on list checkboxes were near-misses: a click a few px
// beside the box landed in a cell that swallows clicks (nothing happened) or
// on the row (the row opened instead), and the user clicked again. Exported
// for lists that keep the reveal opacity on a wrapper.
export const ROW_CHECKBOX_HIT_AREA_CLASS = 'relative after:absolute after:-inset-2 pointer-coarse:after:-inset-3'

// Compact rows (~28px) are shorter than the hit area, which would then reach
// into the next row's: there it stays 4px above and below the box.
const DENSE_HIT_AREA_CLASS = 'after:-inset-y-1 pointer-coarse:after:-inset-y-1'

type RowSelectCheckboxProps = Omit<ComponentPropsWithoutRef<typeof Checkbox>, 'checked'> & {
  checked: boolean
  /** Solid while unchecked too, e.g. once any row in the list is selected. */
  revealed?: boolean
  /** The list renders compact rows. */
  dense?: boolean
}

/**
 * The row selection checkbox the lists share: CHECKBOX_REVEAL_CLASS at rest,
 * solid when checked or revealed, border-foreground, and the widened hit
 * area. Keyboard and focus are the Checkbox's own. A call site that positions
 * the box (`absolute`) replaces `relative` through cn(); the ::after still
 * anchors to it.
 */
export function RowSelectCheckbox({ checked, revealed = false, dense = false, className, ...props }: RowSelectCheckboxProps) {
  return (
    <Checkbox
      checked={checked}
      className={cn(
        'border-foreground duration-150',
        ROW_CHECKBOX_HIT_AREA_CLASS,
        dense && DENSE_HIT_AREA_CLASS,
        checked || revealed ? 'opacity-100' : CHECKBOX_REVEAL_CLASS,
        className,
      )}
      {...props}
    />
  )
}

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
  /** The click: a list that stacks sort keys reads shiftKey from it. */
  onSort: (event: { shiftKey: boolean }) => void
  /** This column's place in a multi-column sort; shown when set. */
  rank?: number
  align?: 'left' | 'right'
  className?: string
}

/**
 * A sortable dry-table head: the TH_CLASS idiom with a button that states
 * the sort to assistive tech (aria-sort, "Sortera efter X"), has a keyboard
 * focus ring and a 32px target (40px on touch). The invoice and supplier invoice lists had this; the
 * customer, article and dimension lists had a bare button without any of it.
 */
export function SortableTh({ label, direction, onSort, rank, align = 'left', className }: SortableThProps) {
  const t = useTranslations('common')
  const SortIcon = direction === 'asc' ? ArrowUpIcon : direction === 'desc' ? ArrowDownIcon : ArrowsUpDownIcon
  return (
    <th
      className={cn(TH_CLASS, className)}
      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
    >
      <button
        type="button"
        className={cn(
          '-mx-2 inline-flex min-h-8 items-center gap-1 rounded-sm px-2 transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 pointer-coarse:min-h-10',
          align === 'right' && 'ml-auto justify-end',
        )}
        aria-label={t('sort_by', { column: label })}
        onClick={onSort}
      >
        <span>{label}</span>
        <SortIcon aria-hidden="true" className={cn('h-3.5 w-3.5 shrink-0', !direction && 'text-muted-foreground')} />
        {rank != null && (
          <span className="text-[12px] font-medium tabular-nums text-muted-foreground" aria-hidden="true">
            {rank}
          </span>
        )}
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
      <Button type="button" variant="ghost" onClick={onMore}>
        {t('load_more')}
      </Button>
    </div>
  )
}
