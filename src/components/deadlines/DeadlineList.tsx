'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Deadline, DeadlineType } from '@/types'
import { DeadlineRow, deadlineDateLabel } from './DeadlineRow'
import { DeadlineGroupCard, isSkattekontoDeadline } from './DeadlineGroupCard'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { isDeadlineOverdue } from '@/lib/calendar/utils'
import { todayIsoStockholm } from '@/lib/dates/iso'

type TypeSegment = 'all' | 'tax' | 'invoicing' | 'own'

const SEGMENT_TYPES: Record<Exclude<TypeSegment, 'all'>, ReadonlyArray<DeadlineType>> = {
  tax: ['tax'],
  invoicing: ['invoicing'],
  own: ['delivery', 'report', 'other'],
}

interface DeadlineListProps {
  deadlines: Deadline[]
  onDeadlineToggle: (deadline: Deadline) => Promise<void>
  onDeadlineEdit: (deadline: Deadline) => void
}

/**
 * Viktiga datum as the concept thread (scene 17): a type seg and borderless
 * rows under hairline section headers. Done deadlines wait behind one
 * "Visa klara" line. Marking done confirms up front via ConfirmDialog.
 */
export function DeadlineList({
  deadlines,
  onDeadlineToggle,
  onDeadlineEdit,
}: DeadlineListProps) {
  const t = useTranslations('deadlines')
  const [segment, setSegment] = useState<TypeSegment>('all')
  const [confirmTarget, setConfirmTarget] = useState<Deadline | null>(null)
  // Klara has no time window (every deadline ever marked done), so it stays
  // folded until asked for.
  const [showCompleted, setShowCompleted] = useState(false)

  const filteredDeadlines = useMemo(() => {
    if (segment === 'all') return deadlines
    const types = SEGMENT_TYPES[segment]
    return deadlines.filter((d) => types.includes(d.deadline_type))
  }, [deadlines, segment])

  const groupedDeadlines = useMemo(() => {
    const today = todayIsoStockholm()
    const overdue: Deadline[] = []
    const todayDeadlines: Deadline[] = []
    const upcoming: Deadline[] = []
    const completed: Deadline[] = []

    for (const d of filteredDeadlines) {
      if (d.is_completed) {
        completed.push(d)
      } else if (isDeadlineOverdue(d)) {
        overdue.push(d)
      } else if (d.due_date === today) {
        todayDeadlines.push(d)
      } else {
        upcoming.push(d)
      }
    }

    return { overdue, today: todayDeadlines, upcoming, completed }
  }, [filteredDeadlines])

  const handleRequestToggle = (deadline: Deadline) => {
    // Un-completing is a harmless revert: no confirmation (matches the undo
    // toast the page already offers).
    if (deadline.is_completed) {
      void onDeadlineToggle(deadline)
      return
    }
    setConfirmTarget(deadline)
  }

  const sections = [
    { key: 'overdue', label: t('section_overdue'), items: groupedDeadlines.overdue },
    { key: 'today', label: t('section_today'), items: groupedDeadlines.today },
    { key: 'upcoming', label: t('section_upcoming'), items: groupedDeadlines.upcoming },
  ].filter((s) => s.items.length > 0)
  const completed = groupedDeadlines.completed

  // Skattekonto obligations legally share the same due date (moms + AGI +
  // preliminärskatt all fall on "den 12:e"): collapse 2+ such rows into one
  // grouped row per date instead of near-identical rows. Other deadlines
  // render as before, in their original order.
  type ListEntry =
    | { kind: 'single'; deadline: Deadline }
    | { kind: 'group'; date: string; items: Deadline[] }

  const toEntries = (items: Deadline[]): ListEntry[] => {
    const byDate = new Map<string, Deadline[]>()
    for (const d of items) {
      if (!isSkattekontoDeadline(d)) continue
      const group = byDate.get(d.due_date) ?? []
      group.push(d)
      byDate.set(d.due_date, group)
    }
    const emittedDates = new Set<string>()
    const entries: ListEntry[] = []
    for (const d of items) {
      const group = byDate.get(d.due_date)
      if (isSkattekontoDeadline(d) && group && group.length >= 2) {
        if (!emittedDates.has(d.due_date)) {
          emittedDates.add(d.due_date)
          entries.push({ kind: 'group', date: d.due_date, items: group })
        }
        continue
      }
      entries.push({ kind: 'single', deadline: d })
    }
    return entries
  }

  const renderSection = ({ key, label, items }: { key: string; label: string; items: Deadline[] }) => (
    <section key={key}>
      <div className="mb-1 flex items-center gap-3 px-1">
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground">
          {label}
        </h2>
        <span className="text-xs tabular-nums text-muted-foreground/50">
          {items.length}
        </span>
        <div className="h-px flex-1 bg-border/60" />
      </div>
      <div>
        {toEntries(items).map((entry) =>
          entry.kind === 'group' ? (
            <DeadlineGroupCard
              key={`skattekonto-${entry.date}`}
              deadlines={entry.items}
              onEdit={onDeadlineEdit}
              onRequestToggle={handleRequestToggle}
            />
          ) : (
            <DeadlineRow
              key={entry.deadline.id}
              deadline={entry.deadline}
              onEdit={onDeadlineEdit}
              onRequestToggle={handleRequestToggle}
            />
          ),
        )}
      </div>
    </section>
  )

  return (
    <div className="space-y-6">
      {/* Toolbar: the type seg (concept: Alla / Skatt / Fakturering / Egna) */}
      <SegmentedControl
        value={segment}
        onChange={setSegment}
        options={[
          { value: 'all', label: t('seg_all') },
          { value: 'tax', label: t('seg_tax') },
          { value: 'invoicing', label: t('seg_invoicing') },
          { value: 'own', label: t('seg_own') },
        ]}
      />

      {/* The thread */}
      {filteredDeadlines.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {segment !== 'all' ? t('empty_filtered') : t('empty_title')}
        </p>
      ) : (
        <div className="stagger-enter space-y-8">
          {sections.map(renderSection)}
          {completed.length > 0 && (
            <button
              type="button"
              onClick={() => setShowCompleted((open) => !open)}
              aria-expanded={showCompleted}
              className="px-1 text-[12.5px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              {showCompleted ? t('hide_completed') : t('show_completed', { count: completed.length })}
            </button>
          )}
          {showCompleted &&
            completed.length > 0 &&
            renderSection({ key: 'completed', label: t('section_completed'), items: completed })}
        </div>
      )}

      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => !open && setConfirmTarget(null)}
        title={t('confirm_done_title')}
        description={
          confirmTarget
            ? `${deadlineDateLabel(confirmTarget.due_date)} · ${confirmTarget.title}`
            : undefined
        }
        confirmLabel={t('group_confirm')}
        onConfirm={async () => {
          if (confirmTarget) await onDeadlineToggle(confirmTarget)
        }}
      />
    </div>
  )
}
