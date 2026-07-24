'use client'

import { useTranslations } from 'next-intl'
import { Deadline } from '@/types'
import { cn } from '@/lib/utils'
import { isDeadlineOverdue, parseDate, startOfDay } from '@/lib/calendar/utils'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import {
  CalendarClock,
  Check,
  FileText,
  Landmark,
  Pencil,
  ReceiptText,
  Truck,
} from 'lucide-react'

interface DeadlineRowProps {
  deadline: Deadline
  /** Row click: open the edit dialog. */
  onEdit?: (deadline: Deadline) => void
  /** "Markera klar" (or un-done): the list confirms before toggling. */
  onRequestToggle: (deadline: Deadline) => void
}

function daysFromToday(dateStr: string): number {
  const today = startOfDay(new Date())
  const target = parseDate(dateStr)
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

const TYPE_ICONS: Record<Deadline['deadline_type'], typeof CalendarClock> = {
  tax: Landmark,
  invoicing: ReceiptText,
  delivery: Truck,
  report: FileText,
  other: CalendarClock,
}

const SWEDISH_MONTHS_SHORT = [
  'jan', 'feb', 'mar', 'apr', 'maj', 'jun',
  'jul', 'aug', 'sep', 'okt', 'nov', 'dec',
]

export function deadlineDateLabel(dateStr: string): string {
  const date = parseDate(dateStr)
  return `${date.getDate()} ${SWEDISH_MONTHS_SHORT[date.getMonth()]}`
}

/**
 * One deadline as a concept thread row (scene 17): icon circle, "12 aug ·
 * Title" line, muted status sentence below, quiet hover actions. Rows are
 * borderless; the section headers carry the structure.
 */
export function DeadlineRow({ deadline, onEdit, onRequestToggle }: DeadlineRowProps) {
  const t = useTranslations('deadlines')
  const overdue = isDeadlineOverdue(deadline)
  const completed = deadline.is_completed
  const diff = daysFromToday(deadline.due_date)
  const Icon = TYPE_ICONS[deadline.deadline_type] ?? CalendarClock

  const relative = completed
    ? null
    : diff === 0
      ? t('rel_today')
      : diff === 1
        ? t('rel_tomorrow')
        : diff < 0
          ? t('rel_days_ago', { count: Math.abs(diff) })
          : diff <= 14
            ? t('rel_in_days', { count: diff })
            : null

  const subParts = [
    relative,
    deadline.due_time ? `kl ${deadline.due_time.slice(0, 5)}` : null,
    deadline.customer?.name ?? null,
  ].filter(Boolean) as string[]

  return (
    <div
      onClick={() => onEdit?.(deadline)}
      className={cn(
        'group flex items-start gap-3 rounded-md py-3 -mx-2 px-2 transition-colors duration-150',
        onEdit && 'cursor-pointer hover:bg-secondary/35',
        completed && 'opacity-60',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border',
          completed ? 'text-muted-foreground/60' : 'text-muted-foreground',
        )}
      >
        {completed ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className={cn('text-sm leading-6', completed && 'line-through text-muted-foreground')}>
          <span className="tabular-nums">{deadlineDateLabel(deadline.due_date)}</span>
          <span className="text-muted-foreground/50"> · </span>
          <span className="font-medium">{deadline.title}</span>
        </p>
        {subParts.length > 0 && (
          <p
            className={cn(
              'text-xs leading-5',
              overdue && !completed ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {subParts.join(' · ')}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3 pt-1">
        {completed ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRequestToggle(deadline)
            }}
            className={cn(QUIET_LINK_CLASS, 'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100')}
          >
            {t('mark_not_done')}
          </button>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRequestToggle(deadline)
            }}
            className={cn(QUIET_LINK_CLASS, 'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100')}
          >
            {t('group_mark_done')}
          </button>
        )}
        {onEdit && (
          <Pencil
            className="h-3.5 w-3.5 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/50"
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  )
}
