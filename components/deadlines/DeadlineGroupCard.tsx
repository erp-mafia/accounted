'use client'

import { useTranslations } from 'next-intl'
import { Deadline } from '@/types'
import { cn } from '@/lib/utils'
import { isDeadlineOverdue } from '@/lib/calendar/utils'
import { HOVER_REVEAL_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { deadlineDateLabel } from './DeadlineRow'
import { Pencil } from 'lucide-react'

/**
 * System tax deadlines that legally share the skattekonto date ("den 12:e"):
 * for a small monthly-moms employer, moms + AGI (+ debiterad preliminärskatt)
 * all fall due the same day. Rendering them as one grouped row instead of
 * 2-3 identical-date rows keeps the list scannable.
 */
export const SKATTEKONTO_GROUP_TYPES = new Set([
  'moms_monthly',
  'moms_quarterly',
  'moms_yearly',
  'f_skatt',
  'arbetsgivardeklaration',
  'skatteinbetalning',
])

export function isSkattekontoDeadline(d: Deadline): boolean {
  return (
    !d.is_completed &&
    d.source === 'system' &&
    d.tax_deadline_type !== null &&
    SKATTEKONTO_GROUP_TYPES.has(d.tax_deadline_type)
  )
}

interface DeadlineGroupRowProps {
  /** Two or more skattekonto deadlines sharing the same due_date. */
  deadlines: Deadline[]
  onEdit?: (deadline: Deadline) => void
  /** "Markera klar": the list confirms before toggling. */
  onRequestToggle: (deadline: Deadline) => void
}

/**
 * One thread row for all skattekonto obligations on a shared due date
 * (concept scene 17 row language): the date renders once, each obligation is
 * a sub-row with its own quiet "Markera klar".
 */
export function DeadlineGroupCard({ deadlines, onEdit, onRequestToggle }: DeadlineGroupRowProps) {
  const t = useTranslations('deadlines')
  const first = deadlines[0]
  const overdue = deadlines.some(isDeadlineOverdue)

  return (
    <div className="flex items-start gap-3 py-3 -mx-2 px-2">
      {/* Shared skattekonto date: always Skatteverket's mark (white ground,
          badge not chrome). */}
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-white">
        <img src="/logos/skatteverket_color.svg" alt="Skatteverket" className="h-4 w-4 object-contain" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-sm leading-6">
          <span className="tabular-nums text-muted-foreground">
            {deadlineDateLabel(first.due_date)}
          </span>
          <span className="text-muted-foreground/50"> · </span>
          <span>{t('group_skattekonto_title')}</span>
        </p>
        <p
          className={cn(
            'text-xs leading-5',
            overdue ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {t('group_same_day', { count: deadlines.length })}
        </p>

        <div className="mt-1">
          {deadlines.map((deadline) => (
            <div
              key={deadline.id}
              onClick={() => onEdit?.(deadline)}
              className={cn(
                'group flex items-center gap-3 rounded-sm py-1.5 -mx-2 px-2 transition-colors duration-150',
                onEdit && 'cursor-pointer hover:bg-secondary/35',
              )}
            >
              <p className="min-w-0 flex-1 truncate text-sm">{deadline.title}</p>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onRequestToggle(deadline)
                }}
                className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS, 'shrink-0')}
              >
                {t('group_mark_done')}
              </button>
              {onEdit && (
                <Pencil
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/50"
                  aria-hidden="true"
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
