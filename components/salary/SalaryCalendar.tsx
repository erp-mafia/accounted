'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addDays,
  eachDayOfInterval,
  endOfMonth,
  format,
  isSameDay,
  parseISO,
  startOfMonth,
  startOfWeek,
} from 'date-fns'
import { enUS, sv } from 'date-fns/locale'
import {
  Activity,
  Baby,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Clock,
  Heart,
  HeartPulse,
  Loader2,
  MinusCircle,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { SalaryType } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

// ─── Types ─────────────────────────────────────────────────────────

type AbsenceType =
  | 'sick'
  | 'vab'
  | 'parental'
  | 'pregnancy'
  | 'care_relative'
  | 'study'
  | 'unpaid_leave'
  | 'other_leave'

interface AbsenceDay {
  id: string
  absence_date: string
  absence_type: AbsenceType
  hours: number
  notes: string | null
}

interface WorkedDay {
  id: string
  work_date: string
  hours: number
  notes: string | null
}

interface AbsenceTypeMeta {
  /** Translation keys in the `salary_calendar` namespace. */
  labelKey: string
  shortLabelKey: string
  icon: LucideIcon
  pillClass: string
}

// Absence tone comes from the semantic scale, never the raw Tailwind palette.
// Every value is alpha-over-token, which is why none of these need a `dark:`
// variant: the same class reads correctly on both grounds (the approach
// components/ui/badge.tsx already takes). The eight types share four tones, so
// fill carries a second axis: filled vs outlined separates the two types
// inside a tone whose Lucide icon is identical (Heart is parental, pregnancy
// and care_relative; Activity is study and other_leave).
//
//   terracotta = sick (karens, employer cost)
//   ochre      = caring for someone else (vab, närstående)
//   sage       = parental and pregnancy leave
//   neutral    = the rest (study, unpaid, other)
const TYPE_META: Record<AbsenceType, AbsenceTypeMeta> = {
  sick:          { labelKey: 'type_sick',          shortLabelKey: 'type_sick_short',          icon: HeartPulse,   pillClass: 'bg-destructive/10 text-destructive' },
  vab:           { labelKey: 'type_vab',           shortLabelKey: 'type_vab_short',           icon: Baby,         pillClass: 'bg-muted text-attn' },
  care_relative: { labelKey: 'type_care_relative', shortLabelKey: 'type_care_relative_short', icon: Heart,        pillClass: 'border border-border text-attn' },
  parental:      { labelKey: 'type_parental',      shortLabelKey: 'type_parental_short',      icon: Heart,        pillClass: 'bg-success/10 text-success' },
  pregnancy:     { labelKey: 'type_pregnancy',     shortLabelKey: 'type_pregnancy_short',     icon: Heart,        pillClass: 'border border-success/40 text-success' },
  study:         { labelKey: 'type_study',         shortLabelKey: 'type_study_short',         icon: Activity,     pillClass: 'bg-secondary text-secondary-foreground' },
  unpaid_leave:  { labelKey: 'type_unpaid_leave',  shortLabelKey: 'type_unpaid_leave_short',  icon: MinusCircle,  pillClass: 'bg-muted text-muted-foreground' },
  other_leave:   { labelKey: 'type_other_leave',   shortLabelKey: 'type_other_leave_short',   icon: Activity,     pillClass: 'border border-border text-muted-foreground' },
}

const TYPE_ORDER: AbsenceType[] = ['sick', 'vab', 'parental', 'pregnancy', 'care_relative', 'study', 'unpaid_leave', 'other_leave']

// ─── Component ─────────────────────────────────────────────────────

export interface SalaryCalendarProps {
  employeeId: string
  /** Hourly employees get the worked-hours overlay + actions; monthly only see absence. */
  salaryType: SalaryType
  /** Pay period start (YYYY-MM-DD). The calendar opens on this month. */
  periodStart: string
  /** Pay period end (YYYY-MM-DD). */
  periodEnd: string
  /** Optional: link new rows to a specific salary run. */
  salaryRunEmployeeId?: string
  /** Read-only mode (e.g. for booked runs). */
  readOnly?: boolean
  /** Called after a successful create/delete so the parent can refresh totals. */
  onChange?: () => void
  /** Live absence counts within the pay period, emitted whenever the calendar
   *  reloads. Used so the parent can show day badges that update instantly
   *  on save (without waiting for a recalculation snapshot). */
  onAbsenceCountsChange?: (counts: { sick: number; vab: number; parental: number }) => void
}

export function SalaryCalendar({
  employeeId,
  salaryType,
  periodStart,
  periodEnd,
  salaryRunEmployeeId,
  readOnly = false,
  onChange,
  onAbsenceCountsChange,
}: SalaryCalendarProps) {
  const t = useTranslations('salary_calendar')
  const locale = useLocale()
  const { dialogProps, confirm: confirmAction } = useDestructiveConfirm()
  const dateLocale = locale === 'en' ? enUS : sv
  const isHourly = salaryType === 'hourly'
  const periodStartDate = useMemo(() => parseISO(periodStart), [periodStart])
  const periodEndDate = useMemo(() => parseISO(periodEnd), [periodEnd])

  const [visibleMonth, setVisibleMonth] = useState<Date>(() => startOfMonth(periodStartDate))
  const [absences, setAbsences] = useState<AbsenceDay[]>([])
  const [worked, setWorked] = useState<WorkedDay[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const anchorRef = useRef<string | null>(null)
  const [bulkMode, setBulkMode] = useState<'worked' | 'absence' | null>(null)
  const [inspecting, setInspecting] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const gridStart = startOfWeek(startOfMonth(visibleMonth), { weekStartsOn: 1 })

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const from = format(periodStartDate < gridStart ? periodStartDate : gridStart, 'yyyy-MM-dd')
      const gridEnd = addDays(gridStart, 41)
      const to = format(periodEndDate > gridEnd ? periodEndDate : gridEnd, 'yyyy-MM-dd')
      const requests: Promise<Response>[] = [
        fetch(`/api/salary/employees/${employeeId}/absence?from=${from}&to=${to}`),
      ]
      if (isHourly) {
        requests.push(fetch(`/api/salary/employees/${employeeId}/worked-hours?from=${from}&to=${to}`))
      }
      const responses = await Promise.all(requests)
      // Map the parsed body plus the status, never `new Error(json.error)`:
      // the routes answer thrown errors with the canonical envelope
      // `{ error: { code, message } }`, and the Error constructor would
      // stringify that object to "[object Object]", discarding the route's
      // own Swedish reason.
      const absJson = await responses[0]!.json().catch(() => null)
      if (!responses[0]!.ok) {
        setError(getUserErrorMessage(absJson, { statusCode: responses[0]!.status }))
        return
      }
      setAbsences(absJson?.data ?? [])
      if (isHourly && responses[1]) {
        const wJson = await responses[1].json().catch(() => null)
        if (!responses[1].ok) {
          setError(getUserErrorMessage(wJson, { statusCode: responses[1].status }))
          return
        }
        setWorked(wJson?.data ?? [])
      }
    } catch (e) {
      setError(e instanceof Error ? getUserErrorMessage(e) : t('unknown_error'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, salaryType, visibleMonth.getFullYear(), visibleMonth.getMonth()])

  const absenceMap = useMemo(() => {
    const m = new Map<string, AbsenceDay[]>()
    for (const a of absences) {
      const list = m.get(a.absence_date) ?? []
      list.push(a)
      m.set(a.absence_date, list)
    }
    return m
  }, [absences])

  // Live counts within the pay period: unique dates per category. Emit so
  // the parent can render day badges without waiting for a recalculation.
  // Parental groups parental + pregnancy + care_relative to match how the
  // existing snapshot column lumps them.
  useEffect(() => {
    if (!onAbsenceCountsChange) return
    const sickDates = new Set<string>()
    const vabDates = new Set<string>()
    const parentalDates = new Set<string>()
    for (const a of absences) {
      if (a.absence_date < periodStart || a.absence_date > periodEnd) continue
      if (a.absence_type === 'sick') sickDates.add(a.absence_date)
      else if (a.absence_type === 'vab') vabDates.add(a.absence_date)
      else if (a.absence_type === 'parental' || a.absence_type === 'pregnancy' || a.absence_type === 'care_relative') {
        parentalDates.add(a.absence_date)
      }
    }
    onAbsenceCountsChange({
      sick: sickDates.size,
      vab: vabDates.size,
      parental: parentalDates.size,
    })
  }, [absences, periodStart, periodEnd, onAbsenceCountsChange])

  const workedMap = useMemo(() => {
    const m = new Map<string, WorkedDay>()
    for (const w of worked) m.set(w.work_date, w)
    return m
  }, [worked])

  const cells = useMemo(() => {
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  }, [gridStart])

  const periodTotalHours = useMemo(() => {
    return worked
      .filter(w => w.work_date >= periodStart && w.work_date <= periodEnd)
      .reduce((sum, w) => Math.round((sum + Number(w.hours)) * 100) / 100, 0)
  }, [worked, periodStart, periodEnd])

  const handleCellClick = (date: Date, e: React.MouseEvent) => {
    if (readOnly) return
    const key = format(date, 'yyyy-MM-dd')
    if (e.shiftKey && anchorRef.current) {
      const a = parseISO(anchorRef.current)
      const [from, to] = a <= date ? [a, date] : [date, a]
      const range = eachDayOfInterval({ start: from, end: to }).map(d => format(d, 'yyyy-MM-dd'))
      setSelected(prev => {
        const next = new Set(prev)
        for (const k of range) next.add(k)
        return next
      })
      return
    }
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    anchorRef.current = key
  }

  const handleCellDblClick = (date: Date) => {
    if (readOnly) return
    const key = format(date, 'yyyy-MM-dd')
    // Only open the inspector if there's something to inspect: otherwise
    // it would just be an empty dialog.
    if (workedMap.has(key) || (absenceMap.get(key)?.length ?? 0) > 0) {
      setInspecting(key)
    }
  }

  const clearSelection = () => {
    setSelected(new Set())
    anchorRef.current = null
  }

  const handleFillWeekdays = () => {
    if (readOnly || !isHourly) return
    const weekdays = eachDayOfInterval({ start: periodStartDate, end: periodEndDate })
      .filter(d => {
        const dow = d.getDay()
        if (dow === 0 || dow === 6) return false
        return !workedMap.has(format(d, 'yyyy-MM-dd'))
      })
      .map(d => format(d, 'yyyy-MM-dd'))
    setSelected(new Set(weekdays))
  }

  const handleBulkDelete = async () => {
    if (selected.size === 0 || readOnly) return
    const ok = await confirmAction({
      title: t('confirm_bulk_delete_title'),
      description: t('confirm_bulk_delete', { count: selected.size }),
      confirmLabel: t('delete'),
      variant: 'destructive',
    })
    if (!ok) return
    setDeleting(true)
    setError(null)
    try {
      // Sequential per-date so a failure on one date doesn't leave a partial
      // batch on the others. Selection sizes are bounded by the pay period.
      for (const date of selected) {
        if (isHourly) {
          const wRes = await fetch(
            `/api/salary/employees/${employeeId}/worked-hours?date=${date}`,
            { method: 'DELETE' },
          )
          if (!wRes.ok) {
            const j = await wRes.json().catch(() => null)
            setError(getUserErrorMessage(j, { statusCode: wRes.status }))
            return
          }
        }
        const aRes = await fetch(
          `/api/salary/employees/${employeeId}/absence?from=${date}&to=${date}`,
          { method: 'DELETE' },
        )
        if (!aRes.ok) {
          const j = await aRes.json().catch(() => null)
          setError(getUserErrorMessage(j, { statusCode: aRes.status }))
          return
        }
      }
      clearSelection()
      await load()
      onChange?.()
    } catch (e) {
      setError(e instanceof Error ? getUserErrorMessage(e) : t('unknown_error'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="rounded-lg border bg-card">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setVisibleMonth(prev => addDays(startOfMonth(prev), -1))}
            aria-label={t('prev_month')}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium tabular-nums">
            {format(visibleMonth, 'MMMM yyyy', { locale: dateLocale })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setVisibleMonth(prev => addDays(endOfMonth(prev), 1))}
            aria-label={t('next_month')}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        {isHourly && !readOnly && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleFillWeekdays}
            className="text-xs"
            title={t('fill_weekdays_title')}
          >
            <CalendarPlus className="mr-1 h-3.5 w-3.5" />
            {t('fill_weekdays')}
          </Button>
        )}
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b bg-muted/40 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {(['wd_mon', 'wd_tue', 'wd_wed', 'wd_thu', 'wd_fri', 'wd_sat', 'wd_sun'] as const).map(d => (
          <div key={d} className="px-2 py-1.5 text-center">{t(d)}</div>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-7">
        {cells.map((date, i) => {
          const key = format(date, 'yyyy-MM-dd')
          const inMonth = date.getMonth() === visibleMonth.getMonth()
          const inPeriod = date >= periodStartDate && date <= periodEndDate
          const today = isSameDay(date, new Date())
          const w = workedMap.get(key)
          const dayAbsences = absenceMap.get(key) ?? []
          const isSelected = selected.has(key)
          const isWeekend = date.getDay() === 0 || date.getDay() === 6
          const hasContent = !!w || dayAbsences.length > 0

          return (
            <button
              type="button"
              key={i}
              onClick={(e) => handleCellClick(date, e)}
              onDoubleClick={() => handleCellDblClick(date)}
              disabled={readOnly}
              className={cn(
                'relative flex min-h-[5.5rem] flex-col items-start gap-0.5 border-b border-r p-1.5 text-left text-xs transition-colors',
                !readOnly && 'hover:bg-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                readOnly && 'cursor-default',
                !inMonth && 'bg-muted/30 text-muted-foreground/60',
                !inPeriod && inMonth && 'bg-muted/10',
                isWeekend && inMonth && !hasContent && 'bg-muted/20',
                today && 'ring-1 ring-inset ring-primary/40',
                isSelected && 'ring-2 ring-inset ring-primary bg-primary/5',
              )}
              title={hasContent ? t('cell_details_title') : undefined}
            >
              <span className={cn('tabular-nums', today && 'font-semibold')}>
                {format(date, 'd')}
              </span>
              <div className="mt-auto flex flex-col items-start gap-0.5">
                {w && (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-secondary px-1.5 py-px text-[10px] font-medium text-secondary-foreground">
                    <Clock className="h-2.5 w-2.5" aria-hidden />
                    <span className="tabular-nums">{w.hours}h</span>
                  </span>
                )}
                {dayAbsences.length > 0 && (
                  <div className="flex flex-wrap gap-0.5">
                    {dayAbsences.map(a => {
                      const meta = TYPE_META[a.absence_type]
                      const Icon = meta.icon
                      return (
                        <span
                          key={a.id}
                          className={cn(
                            'inline-flex items-center gap-0.5 rounded-full px-1 py-px text-[10px] font-medium',
                            meta.pillClass,
                          )}
                          title={t('pill_title', { label: t(meta.labelKey), hours: String(a.hours) })}
                        >
                          <Icon className="h-2.5 w-2.5" aria-hidden />
                          <span>{t(meta.shortLabelKey)}</span>
                        </span>
                      )
                    })}
                  </div>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {/* Summary + hint */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-[11px] text-muted-foreground">
        <span>
          {isHourly && (
            <>
              {t('worked_hours_in_period')}{' '}
              <span className="tabular-nums font-medium text-foreground">{periodTotalHours} h</span>
              {' · '}
            </>
          )}
          {t('hint_click')}
        </span>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t px-3 py-2 text-[11px] text-muted-foreground">
        {isHourly && (
          <span className="inline-flex items-center gap-1">
            <span className="inline-flex h-3 w-3 items-center justify-center rounded-full bg-secondary">
              <Clock className="h-2 w-2 text-secondary-foreground" aria-hidden />
            </span>
            <span>{t('worked_time')}</span>
          </span>
        )}
        {TYPE_ORDER.map(type => {
          const meta = TYPE_META[type]
          const Icon = meta.icon
          return (
            <span key={type} className="inline-flex items-center gap-1">
              <span className={cn('inline-flex h-3 w-3 items-center justify-center rounded-full', meta.pillClass)}>
                <Icon className="h-2 w-2" aria-hidden />
              </span>
              <span>{t(meta.labelKey)}</span>
            </span>
          )
        })}
      </div>

      {error && (
        <div className="border-t bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Floating action bar */}
      {selected.size > 0 && !readOnly && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/40 px-3 py-2">
          <div className="text-xs">
            <span className="font-medium tabular-nums">{selected.size}</span>{' '}
            {t('days_selected', { count: selected.size })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={clearSelection} disabled={deleting}>
              <X className="mr-1 h-3.5 w-3.5" />
              {t('clear_selection')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleBulkDelete}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-3.5 w-3.5" />
              )}
              {t('delete')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setBulkMode('absence')} disabled={deleting}>
              {t('absence_action')}
            </Button>
            {isHourly && (
              <Button size="sm" onClick={() => setBulkMode('worked')} disabled={deleting}>
                {t('worked_hours_action')}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Bulk dialogs */}
      {bulkMode === 'worked' && (
        <BulkWorkedDialog
          employeeId={employeeId}
          dates={Array.from(selected).sort()}
          salaryRunEmployeeId={salaryRunEmployeeId}
          onClose={() => setBulkMode(null)}
          onSaved={(conflicts) => {
            setBulkMode(null)
            if (conflicts.length === 0) clearSelection()
            else setSelected(new Set(conflicts.map(c => c.date)))
            load()
            onChange?.()
          }}
        />
      )}
      {bulkMode === 'absence' && (
        <BulkAbsenceDialog
          employeeId={employeeId}
          dates={Array.from(selected).sort()}
          salaryRunEmployeeId={salaryRunEmployeeId}
          onClose={() => setBulkMode(null)}
          onSaved={(conflicts) => {
            setBulkMode(null)
            if (conflicts.length === 0) clearSelection()
            else setSelected(new Set(conflicts.map(c => c.date)))
            load()
            onChange?.()
          }}
        />
      )}

      {/* Day inspector (double-click) */}
      {inspecting && (
        <DayInspectorDialog
          employeeId={employeeId}
          date={inspecting}
          worked={workedMap.get(inspecting)}
          absences={absenceMap.get(inspecting) ?? []}
          isHourly={isHourly}
          onClose={() => setInspecting(null)}
          onChanged={() => {
            load()
            onChange?.()
          }}
        />
      )}

      <DestructiveConfirmDialog {...dialogProps} />
    </div>
  )
}

// ─── Bulk worked-hours dialog ───────────────────────────────────────

interface BulkConflict { date: string; reason: string }

interface BulkWorkedDialogProps {
  employeeId: string
  dates: string[]
  salaryRunEmployeeId?: string
  onClose: () => void
  onSaved: (conflicts: BulkConflict[]) => void
}

function BulkWorkedDialog({
  employeeId,
  dates,
  salaryRunEmployeeId,
  onClose,
  onSaved,
}: BulkWorkedDialogProps) {
  const t = useTranslations('salary_calendar')
  const [hours, setHours] = useState<string>('8')
  const [notes, setNotes] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<BulkConflict[]>([])

  const hoursNum = parseFloat(hours)
  const isClear = isFinite(hoursNum) && hoursNum === 0

  const handleSave = async () => {
    setSubmitting(true)
    setError(null)
    setConflicts([])
    try {
      if (!isFinite(hoursNum) || hoursNum < 0 || hoursNum > 24) {
        throw new Error(t('error_hours_range'))
      }
      // 0 hours = "no worked time on these days" → delete any existing rows.
      // Avoids tripping the DB CHECK (hours > 0) and matches user intent.
      if (isClear) {
        for (const date of dates) {
          const res = await fetch(
            `/api/salary/employees/${employeeId}/worked-hours?date=${date}`,
            { method: 'DELETE' },
          )
          if (!res.ok) {
            const j = await res.json().catch(() => null)
            setError(getUserErrorMessage(j, { statusCode: res.status }))
            return
          }
        }
        onSaved([])
        return
      }
      const res = await fetch(`/api/salary/employees/${employeeId}/worked-hours/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dates,
          hours: hoursNum,
          notes: notes.trim() || undefined,
          salary_run_employee_id: salaryRunEmployeeId,
        }),
      })
      const json = await res.json()
      if (res.status === 207) {
        setConflicts(json.data?.conflicts ?? [])
        return
      }
      if (!res.ok) {
        setError(getUserErrorMessage(json, { statusCode: res.status }))
        return
      }
      onSaved([])
    } catch (e) {
      setError(e instanceof Error ? getUserErrorMessage(e) : t('unknown_error'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('bulk_worked_title')}</DialogTitle>
          <DialogDescription>
            {isClear
              ? t('bulk_worked_clear_desc', { count: dates.length })
              : t('bulk_worked_desc', { count: dates.length })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="bulk-w-hours">{t('hours_per_day')}</label>
            <Input
              id="bulk-w-hours"
              type="number"
              min={0}
              max={24}
              step={0.5}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              autoFocus
              className="tabular-nums"
            />
            <p className="text-[11px] text-muted-foreground">
              {t('hours_zero_hint')}
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="bulk-w-notes">{t('notes_label')}</label>
            <Textarea
              id="bulk-w-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              className="min-h-0"
            />
          </div>

          {conflicts.length > 0 && (
            <div className="space-y-1 rounded-lg border border-border bg-muted/30 p-2 text-xs">
              <div className="font-medium text-attn">
                {t('conflicts_worked', { count: conflicts.length })}
              </div>
              <ul className="list-disc space-y-0.5 pl-4 text-attn tabular-nums">
                {conflicts.map(c => <li key={c.date}>{c.date}</li>)}
              </ul>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">{error}</div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>{t('close')}</Button>
          {conflicts.length > 0 ? (
            <Button size="sm" onClick={() => onSaved(conflicts)}>{t('ok')}</Button>
          ) : (
            <Button size="sm" onClick={handleSave} disabled={submitting}>
              {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {isClear ? t('delete') : t('save')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Bulk absence dialog ────────────────────────────────────────────

interface BulkAbsenceDialogProps {
  employeeId: string
  dates: string[]
  salaryRunEmployeeId?: string
  onClose: () => void
  onSaved: (conflicts: BulkConflict[]) => void
}

function BulkAbsenceDialog({
  employeeId,
  dates,
  salaryRunEmployeeId,
  onClose,
  onSaved,
}: BulkAbsenceDialogProps) {
  const t = useTranslations('salary_calendar')
  const [absenceType, setAbsenceType] = useState<AbsenceType>('sick')
  const [hours, setHours] = useState<string>('8')
  const [notes, setNotes] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<BulkConflict[]>([])

  const handleSave = async () => {
    setSubmitting(true)
    setError(null)
    setConflicts([])
    try {
      const hoursNum = parseFloat(hours)
      if (!isFinite(hoursNum) || hoursNum <= 0 || hoursNum > 24) {
        throw new Error(t('error_hours_range'))
      }
      // No batch endpoint for absence: call POST per date so we can isolate
      // 24h-cap conflicts. Pay-period sized loops are fine.
      const localConflicts: BulkConflict[] = []
      for (const date of dates) {
        const res = await fetch(`/api/salary/employees/${employeeId}/absence`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            absence_date: date,
            absence_type: absenceType,
            hours: hoursNum,
            notes: notes.trim() || undefined,
            salary_run_employee_id: salaryRunEmployeeId,
          }),
        })
        if (res.status === 409) {
          const j = await res.json().catch(() => ({}))
          localConflicts.push({ date, reason: j.error || '24h-tak' })
          continue
        }
        if (!res.ok) {
          const j = await res.json().catch(() => null)
          setError(getUserErrorMessage(j, { statusCode: res.status }))
          return
        }
      }
      if (localConflicts.length > 0) {
        setConflicts(localConflicts)
        return
      }
      onSaved([])
    } catch (e) {
      setError(e instanceof Error ? getUserErrorMessage(e) : t('unknown_error'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('bulk_absence_title')}</DialogTitle>
          <DialogDescription>
            {t('bulk_absence_desc', { count: dates.length })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">{t('type_label')}</label>
            <Select value={absenceType} onValueChange={v => setAbsenceType(v as AbsenceType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TYPE_ORDER.map(type => (
                  <SelectItem key={type} value={type}>{t(TYPE_META[type].labelKey)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="bulk-a-hours">{t('hours_per_day')}</label>
            <Input
              id="bulk-a-hours"
              type="number"
              min={0.5}
              max={24}
              step={0.5}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className="tabular-nums"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="bulk-a-notes">{t('notes_label')}</label>
            <Textarea
              id="bulk-a-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              className="min-h-0"
            />
          </div>

          {conflicts.length > 0 && (
            <div className="space-y-1 rounded-lg border border-border bg-muted/30 p-2 text-xs">
              <div className="font-medium text-attn">
                {t('conflicts_absence', { count: conflicts.length })}
              </div>
              <ul className="list-disc space-y-0.5 pl-4 text-attn tabular-nums">
                {conflicts.map(c => <li key={c.date}>{c.date}</li>)}
              </ul>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">{error}</div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>{t('close')}</Button>
          {conflicts.length > 0 ? (
            <Button size="sm" onClick={() => onSaved(conflicts)}>{t('ok')}</Button>
          ) : (
            <Button size="sm" onClick={handleSave} disabled={submitting}>
              {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {t('save')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Day inspector (double-click) ───────────────────────────────────

interface DayInspectorDialogProps {
  employeeId: string
  date: string
  worked?: WorkedDay
  absences: AbsenceDay[]
  isHourly: boolean
  onClose: () => void
  onChanged: () => void
}

function DayInspectorDialog({
  employeeId,
  date,
  worked,
  absences,
  isHourly,
  onClose,
  onChanged,
}: DayInspectorDialogProps) {
  const t = useTranslations('salary_calendar')
  const locale = useLocale()
  const dateLocale = locale === 'en' ? enUS : sv
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const handleDeleteWorked = async () => {
    if (!worked) return
    setBusy('worked')
    setError(null)
    try {
      const res = await fetch(`/api/salary/employees/${employeeId}/worked-hours?date=${date}`, { method: 'DELETE' })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        setError(getUserErrorMessage(j, { statusCode: res.status }))
        return
      }
      onChanged()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? getUserErrorMessage(e) : t('unknown_error'))
    } finally {
      setBusy(null)
    }
  }

  const handleDeleteAbsence = async (a: AbsenceDay) => {
    setBusy(a.id)
    setError(null)
    try {
      const res = await fetch(
        `/api/salary/employees/${employeeId}/absence?date=${date}&type=${a.absence_type}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        setError(getUserErrorMessage(j, { statusCode: res.status }))
        return
      }
      onChanged()
      // Stay open if there's other content; close if this was the last entry.
      if (absences.length === 1 && !worked) onClose()
    } catch (e) {
      setError(e instanceof Error ? getUserErrorMessage(e) : t('unknown_error'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {format(parseISO(date), 'd MMMM yyyy', { locale: dateLocale })}
          </DialogTitle>
          <DialogDescription>
            {t('inspector_desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {isHourly && worked && (
            <div className="flex items-center justify-between rounded-lg border bg-secondary/50 px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <div>
                  <div className="font-medium">{t('worked_time')}</div>
                  <div className="text-xs text-muted-foreground tabular-nums">{t('hours_count', { hours: String(worked.hours) })}</div>
                  {worked.notes && <div className="text-xs text-muted-foreground italic">{worked.notes}</div>}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDeleteWorked}
                disabled={busy !== null}
                aria-label={t('delete_worked_aria')}
              >
                {busy === 'worked' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
            </div>
          )}

          {absences.length > 0 && absences.map(a => {
            const meta = TYPE_META[a.absence_type]
            const Icon = meta.icon
            return (
              <div key={a.id} className={cn('flex items-center justify-between rounded-lg border px-3 py-2', meta.pillClass)}>
                <div className="flex items-center gap-2 text-sm">
                  <Icon className="h-4 w-4" />
                  <div>
                    <div className="font-medium">{t(meta.labelKey)}</div>
                    <div className="text-xs opacity-80 tabular-nums">{t('hours_count', { hours: String(a.hours) })}</div>
                    {a.notes && <div className="text-xs opacity-70 italic">{a.notes}</div>}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDeleteAbsence(a)}
                  disabled={busy !== null}
                  aria-label={t('delete_absence_aria')}
                >
                  {busy === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </Button>
              </div>
            )
          })}

          {!worked && absences.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t('no_entries')}
            </p>
          )}

          {error && (
            <div className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>{t('close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
