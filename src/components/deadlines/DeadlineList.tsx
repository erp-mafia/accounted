'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Deadline, DeadlineType } from '@/types'
import { DeadlineRow, deadlineDateLabel } from './DeadlineRow'
import { DeadlineGroupCard, isSkattekontoDeadline } from './DeadlineGroupCard'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { isDeadlineOverdue, parseDate, startOfDay } from '@/lib/calendar/utils'

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
 * Viktiga datum as the concept thread (scene 17): a type seg, borderless
 * rows under hairline section headers, and a "Närmast" countdown pane on the
 * right. Marking done confirms up front via ConfirmDialog.
 */
export function DeadlineList({
  deadlines,
  onDeadlineToggle,
  onDeadlineEdit,
}: DeadlineListProps) {
  const t = useTranslations('deadlines')
  const [segment, setSegment] = useState<TypeSegment>('all')
  const [confirmTarget, setConfirmTarget] = useState<Deadline | null>(null)

  const filteredDeadlines = useMemo(() => {
    if (segment === 'all') return deadlines
    const types = SEGMENT_TYPES[segment]
    return deadlines.filter((d) => types.includes(d.deadline_type))
  }, [deadlines, segment])

  const groupedDeadlines = useMemo(() => {
    const today = new Date().toISOString().split('T')[0]
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

  // "Närmast" pane: days to the nearest pending deadline (across the
  // unfiltered list: the countdown is page context, not a filter readout).
  const nearest = useMemo(() => {
    const pending = deadlines
      .filter((d) => !d.is_completed && !isDeadlineOverdue(d))
      .sort((a, b) => a.due_date.localeCompare(b.due_date))
    const first = pending[0]
    if (!first) return null
    const today = startOfDay(new Date())
    const days = Math.round(
      (parseDate(first.due_date).getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
    )
    return { deadline: first, days: Math.max(0, days) }
  }, [deadlines])

  const overdueCount = useMemo(
    () => deadlines.filter((d) => !d.is_completed && isDeadlineOverdue(d)).length,
    [deadlines],
  )

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
    { key: 'completed', label: t('section_completed'), items: groupedDeadlines.completed },
  ].filter((s) => s.items.length > 0)

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

      <div className="gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_240px] lg:items-start">
        {/* The thread */}
        {filteredDeadlines.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {segment !== 'all' ? t('empty_filtered') : t('empty_title')}
          </p>
        ) : (
          <div className="stagger-enter space-y-8">
            {sections.map(({ key, label, items }) => (
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
            ))}
          </div>
        )}

        {/* "Närmast" pane (concept aside) */}
        <aside className="mt-8 lg:mt-0">
          <div className="rounded-lg border border-border">
            <div className="border-b border-border px-4 py-2.5">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {t('nearest_title')}
              </p>
            </div>
            <div className="px-4 py-6 text-center">
              {nearest ? (
                <>
                  <p className="font-display text-4xl leading-none tracking-tight tabular-nums">
                    {nearest.days === 0 ? t('rel_today') : nearest.days}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {nearest.days === 0
                      ? nearest.deadline.title
                      : t('nearest_days_to', { title: nearest.deadline.title })}
                  </p>
                  <p className="mt-1 text-xs tabular-nums text-muted-foreground/60">
                    {deadlineDateLabel(nearest.deadline.due_date)}
                  </p>
                </>
              ) : (
                <p className="py-4 text-xs text-muted-foreground">{t('nearest_empty')}</p>
              )}
              {overdueCount > 0 && (
                <p className="mt-3 text-xs font-medium text-destructive">
                  {t('nearest_overdue', { count: overdueCount })}
                </p>
              )}
            </div>
          </div>
        </aside>
      </div>

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
