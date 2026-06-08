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
import { sv } from 'date-fns/locale'
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
import { Button } from '@/components/ui/button'
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
  label: string
  shortLabel: string
  icon: LucideIcon
  pillClass: string
}

const TYPE_META: Record<AbsenceType, AbsenceTypeMeta> = {
  sick:          { label: 'Sjukfrånvaro',     shortLabel: 'Sjuk',   icon: HeartPulse,   pillClass: 'bg-red-100 text-red-800' },
  vab:           { label: 'VAB',              shortLabel: 'VAB',    icon: Baby,         pillClass: 'bg-amber-100 text-amber-800' },
  parental:      { label: 'Föräldraledighet', shortLabel: 'Förä.',  icon: Heart,        pillClass: 'bg-emerald-100 text-emerald-800' },
  pregnancy:     { label: 'Graviditetspenning', shortLabel: 'Grav.', icon: Heart,       pillClass: 'bg-pink-100 text-pink-800' },
  care_relative: { label: 'Närståendepenning', shortLabel: 'Närst.', icon: Heart,       pillClass: 'bg-blue-100 text-blue-800' },
  study:         { label: 'Studieledig',      shortLabel: 'Studie', icon: Activity,     pillClass: 'bg-indigo-100 text-indigo-800' },
  unpaid_leave:  { label: 'Tjänstledig utan lön', shortLabel: 'Tjänstl.', icon: MinusCircle, pillClass: 'bg-slate-100 text-slate-800' },
  other_leave:   { label: 'Övrig ledighet',   shortLabel: 'Övrigt', icon: Activity,     pillClass: 'bg-zinc-100 text-zinc-800' },
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
      const absJson = await responses[0]!.json()
      if (!responses[0]!.ok) throw new Error(absJson.error || 'Kunde inte ladda frånvaro')
      setAbsences(absJson.data ?? [])
      if (isHourly && responses[1]) {
        const wJson = await responses[1].json()
        if (!responses[1].ok) throw new Error(wJson.error || 'Kunde inte ladda arbetade timmar')
        setWorked(wJson.data ?? [])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Okänt fel')
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

  // Live counts within the pay period — unique dates per category. Emit so
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
    // Only open the inspector if there's something to inspect — otherwise
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
    if (!confirm(
      `Ta bort allt (arbetad tid och frånvaro) på ${selected.size} ${selected.size === 1 ? 'dag' : 'dagar'}?`,
    )) return
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
            const j = await wRes.json().catch(() => ({}))
            throw new Error(j.error || `Kunde inte ta bort arbetad tid på ${date}`)
          }
        }
        const aRes = await fetch(
          `/api/salary/employees/${employeeId}/absence?from=${date}&to=${date}`,
          { method: 'DELETE' },
        )
        if (!aRes.ok) {
          const j = await aRes.json().catch(() => ({}))
          throw new Error(j.error || `Kunde inte ta bort frånvaro på ${date}`)
        }
      }
      clearSelection()
      await load()
      onChange?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Okänt fel')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="rounded-md border bg-card">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setVisibleMonth(prev => addDays(startOfMonth(prev), -1))}
            aria-label="Föregående månad"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium tabular-nums">
            {format(visibleMonth, 'MMMM yyyy', { locale: sv })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setVisibleMonth(prev => addDays(endOfMonth(prev), 1))}
            aria-label="Nästa månad"
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
            title="Markera alla vardagar i perioden som inte redan har arbetad tid"
          >
            <CalendarPlus className="mr-1 h-3.5 w-3.5" />
            Fyll vardagar
          </Button>
        )}
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b bg-muted/40 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'].map(d => (
          <div key={d} className="px-2 py-1.5 text-center">{d}</div>
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
              title={hasContent ? 'Dubbelklicka för detaljer' : undefined}
            >
              <span className={cn('tabular-nums', today && 'font-semibold')}>
                {format(date, 'd')}
              </span>
              <div className="mt-auto flex flex-col items-start gap-0.5">
                {w && (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-px text-[10px] font-medium text-emerald-800">
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
                          title={`${meta.label} (${a.hours}h)`}
                        >
                          <Icon className="h-2.5 w-2.5" aria-hidden />
                          <span>{meta.shortLabel}</span>
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
              Arbetade timmar i perioden:{' '}
              <span className="tabular-nums font-medium text-foreground">{periodTotalHours} h</span>
              {' · '}
            </>
          )}
          Klicka för att markera, shift-klicka för intervall, dubbelklicka för detaljer.
        </span>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t px-3 py-2 text-[11px] text-muted-foreground">
        {isHourly && (
          <span className="inline-flex items-center gap-1">
            <span className="inline-flex h-3 w-3 items-center justify-center rounded-full bg-emerald-100">
              <Clock className="h-2 w-2 text-emerald-800" aria-hidden />
            </span>
            <span>Arbetad tid</span>
          </span>
        )}
        {TYPE_ORDER.map(t => {
          const meta = TYPE_META[t]
          const Icon = meta.icon
          return (
            <span key={t} className="inline-flex items-center gap-1">
              <span className={cn('inline-flex h-3 w-3 items-center justify-center rounded-full', meta.pillClass)}>
                <Icon className="h-2 w-2" aria-hidden />
              </span>
              <span>{meta.label}</span>
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
            {selected.size === 1 ? 'dag' : 'dagar'} valda
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={clearSelection} disabled={deleting}>
              <X className="mr-1 h-3.5 w-3.5" />
              Rensa val
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
              Ta bort
            </Button>
            <Button variant="outline" size="sm" onClick={() => setBulkMode('absence')} disabled={deleting}>
              Frånvaro…
            </Button>
            {isHourly && (
              <Button size="sm" onClick={() => setBulkMode('worked')} disabled={deleting}>
                Arbetade timmar…
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
        throw new Error('Timmar måste vara mellan 0 och 24')
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
            const j = await res.json().catch(() => ({}))
            throw new Error(j.error || `Kunde inte ta bort ${date}`)
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
      if (!res.ok) throw new Error(json.error || 'Kunde inte spara timmar')
      onSaved([])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Okänt fel')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Arbetade timmar</DialogTitle>
          <DialogDescription>
            {isClear
              ? `Arbetad tid tas bort för ${dates.length} ${dates.length === 1 ? 'dag' : 'dagar'}.`
              : `${dates.length} ${dates.length === 1 ? 'dag' : 'dagar'} markeras som arbetade. Befintliga timmar för dessa datum skrivs över.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="bulk-w-hours">Timmar per dag</label>
            <input
              id="bulk-w-hours"
              type="number"
              min={0}
              max={24}
              step={0.5}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              autoFocus
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm tabular-nums shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <p className="text-[11px] text-muted-foreground">
              Sätt till 0 för att ta bort arbetad tid på de valda dagarna.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="bulk-w-notes">Anteckning (valfri)</label>
            <textarea
              id="bulk-w-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              className="flex w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          {conflicts.length > 0 && (
            <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs">
              <div className="font-medium text-amber-900">
                {conflicts.length} {conflicts.length === 1 ? 'dag utelämnades' : 'dagar utelämnades'} — kombinationen med befintlig frånvaro hade överstigit 24 timmar.
              </div>
              <ul className="list-disc space-y-0.5 pl-4 text-amber-800 tabular-nums">
                {conflicts.map(c => <li key={c.date}>{c.date}</li>)}
              </ul>
            </div>
          )}

          {error && (
            <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">{error}</div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>Stäng</Button>
          {conflicts.length > 0 ? (
            <Button size="sm" onClick={() => onSaved(conflicts)}>OK</Button>
          ) : (
            <Button size="sm" onClick={handleSave} disabled={submitting}>
              {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {isClear ? 'Ta bort' : 'Spara'}
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
        throw new Error('Timmar måste vara mellan 0 och 24')
      }
      // No batch endpoint for absence — call POST per date so we can isolate
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
          const j = await res.json().catch(() => ({}))
          throw new Error(j.error || `Kunde inte spara frånvaro på ${date}`)
        }
      }
      if (localConflicts.length > 0) {
        setConflicts(localConflicts)
        return
      }
      onSaved([])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Okänt fel')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Frånvaro</DialogTitle>
          <DialogDescription>
            {dates.length} {dates.length === 1 ? 'dag' : 'dagar'} markeras som frånvaro.
            Sjuklöneberäkning, karensavdrag och AGI-rapportering härleds automatiskt.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Typ</label>
            <Select value={absenceType} onValueChange={v => setAbsenceType(v as AbsenceType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TYPE_ORDER.map(t => (
                  <SelectItem key={t} value={t}>{TYPE_META[t].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="bulk-a-hours">Timmar per dag</label>
            <input
              id="bulk-a-hours"
              type="number"
              min={0.5}
              max={24}
              step={0.5}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm tabular-nums shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="bulk-a-notes">Anteckning (valfri)</label>
            <textarea
              id="bulk-a-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              className="flex w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          {conflicts.length > 0 && (
            <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs">
              <div className="font-medium text-amber-900">
                {conflicts.length} {conflicts.length === 1 ? 'dag utelämnades' : 'dagar utelämnades'} — kombinationen med befintlig arbetad tid hade överstigit 24 timmar.
              </div>
              <ul className="list-disc space-y-0.5 pl-4 text-amber-800 tabular-nums">
                {conflicts.map(c => <li key={c.date}>{c.date}</li>)}
              </ul>
            </div>
          )}

          {error && (
            <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">{error}</div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>Stäng</Button>
          {conflicts.length > 0 ? (
            <Button size="sm" onClick={() => onSaved(conflicts)}>OK</Button>
          ) : (
            <Button size="sm" onClick={handleSave} disabled={submitting}>
              {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Spara
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
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const handleDeleteWorked = async () => {
    if (!worked) return
    setBusy('worked')
    setError(null)
    try {
      const res = await fetch(`/api/salary/employees/${employeeId}/worked-hours?date=${date}`, { method: 'DELETE' })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || 'Kunde inte ta bort arbetad tid')
      }
      onChanged()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Okänt fel')
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
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || 'Kunde inte ta bort frånvaro')
      }
      onChanged()
      // Stay open if there's other content; close if this was the last entry.
      if (absences.length === 1 && !worked) onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Okänt fel')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {format(parseISO(date), 'd MMMM yyyy', { locale: sv })}
          </DialogTitle>
          <DialogDescription>
            Översikt av arbetad tid och frånvaro på den här dagen.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {isHourly && worked && (
            <div className="flex items-center justify-between rounded-md border bg-emerald-50 px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4 text-emerald-700" />
                <div>
                  <div className="font-medium">Arbetad tid</div>
                  <div className="text-xs text-muted-foreground tabular-nums">{worked.hours} timmar</div>
                  {worked.notes && <div className="text-xs text-muted-foreground italic">{worked.notes}</div>}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDeleteWorked}
                disabled={busy !== null}
                aria-label="Ta bort arbetad tid"
              >
                {busy === 'worked' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
            </div>
          )}

          {absences.length > 0 && absences.map(a => {
            const meta = TYPE_META[a.absence_type]
            const Icon = meta.icon
            return (
              <div key={a.id} className={cn('flex items-center justify-between rounded-md border px-3 py-2', meta.pillClass)}>
                <div className="flex items-center gap-2 text-sm">
                  <Icon className="h-4 w-4" />
                  <div>
                    <div className="font-medium">{meta.label}</div>
                    <div className="text-xs opacity-80 tabular-nums">{a.hours} timmar</div>
                    {a.notes && <div className="text-xs opacity-70 italic">{a.notes}</div>}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDeleteAbsence(a)}
                  disabled={busy !== null}
                  aria-label="Ta bort frånvaro"
                >
                  {busy === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </Button>
              </div>
            )
          })}

          {!worked && absences.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Inga registreringar på den här dagen.
            </p>
          )}

          {error && (
            <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Stäng</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
