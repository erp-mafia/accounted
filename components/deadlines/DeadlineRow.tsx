'use client'

import { useTranslations } from 'next-intl'
import { Deadline } from '@/types'
import { cn } from '@/lib/utils'
import { isDeadlineOverdue, parseDate, startOfDay } from '@/lib/calendar/utils'
import { HOVER_REVEAL_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
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

// Statutory deadlines carry the receiving authority's mark: Bolagsverket for
// the company-law dates, Skatteverket for everything tax-shaped. Non-system
// deadlines keep the neutral type icons.
const BOLAGSVERKET_TYPES = new Set(['arsredovisning', 'arsstamma'])

export function deadlineAuthorityLogo(deadline: Deadline): { src: string; alt: string } | null {
  if (deadline.tax_deadline_type) {
    return BOLAGSVERKET_TYPES.has(deadline.tax_deadline_type)
      ? { src: '/logos/bolagsverket.jpg', alt: 'Bolagsverket' }
      : { src: '/logos/skatteverket_color.svg', alt: 'Skatteverket' }
  }
  // Manual deadlines (including user-created tax-category ones) keep the
  // neutral type icons: the authority crest is reserved for statutory dates
  // the system generated from the tax settings.
  return null
}

/** The shared 28px round mark: authority logo on white, or a muted type icon. */
export function DeadlineMark({
  deadline,
  completed = false,
}: {
  deadline: Deadline
  completed?: boolean
}) {
  const logo = deadlineAuthorityLogo(deadline)
  if (completed) {
    return (
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground/60">
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    )
  }
  if (logo) {
    // Deliberately white in both themes: the authority marks are badges, not
    // chrome, and their brand colors need a white ground.
    return (
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-white">
        <img src={logo.src} alt={logo.alt} className="h-4 w-4 object-contain" />
      </span>
    )
  }
  const Icon = TYPE_ICONS[deadline.deadline_type] ?? CalendarClock
  return (
    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground">
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </span>
  )
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
        'group flex items-start gap-3 rounded-sm py-3 -mx-2 px-2 transition-colors duration-150',
        onEdit && 'cursor-pointer hover:bg-secondary/35',
        completed && 'opacity-60',
      )}
    >
      <DeadlineMark deadline={deadline} completed={completed} />

      <div className="min-w-0 flex-1">
        <p className={cn('text-sm leading-6', completed && 'line-through text-muted-foreground')}>
          <span className="tabular-nums text-muted-foreground">
            {deadlineDateLabel(deadline.due_date)}
          </span>
          <span className="text-muted-foreground/50"> · </span>
          <span>{deadline.title}</span>
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
            className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS)}
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
            className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS)}
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
