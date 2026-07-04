'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export type DateRangeValue = {
  /** Inclusive lower bound. ISO YYYY-MM-DD. `undefined` = period start. */
  fromDate?: string
  /** Inclusive upper bound. ISO YYYY-MM-DD. `undefined` = period end. */
  toDate?: string
}

type Preset = 'full_year' | 'ytd' | 'this_month' | 'last_month' | 'this_quarter' | 'custom'

interface Props {
  /** Selected fiscal period: bounds the range. */
  periodStart: string
  periodEnd: string
  value: DateRangeValue
  onChange: (next: DateRangeValue) => void
  className?: string
}

const STORAGE_KEY_PREFIX = 'Accounted:report-range-preset:'

const PRESETS: Preset[] = ['full_year', 'ytd', 'this_month', 'last_month', 'this_quarter', 'custom']

function todayIso(): string {
  // Local calendar date: using toISOString() returns UTC, which falls a day
  // behind for Swedish users between midnight and 01:00/02:00 local time and
  // would silently truncate "today" from YTD / this-month / this-quarter.
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function clampToPeriod(date: string, periodStart: string, periodEnd: string): string {
  if (date < periodStart) return periodStart
  if (date > periodEnd) return periodEnd
  return date
}

/**
 * Resolve a preset to a concrete range inside the fiscal period.
 *
 * Endpoints are always clamped to the period: e.g. "this month" outside the
 * period collapses to a zero-width range at whichever boundary you're nearest.
 * `full_year` returns `{}` so the API call omits the params entirely and the
 * report falls back to its full-period default (preserves cache parity with
 * the pre-feature behaviour).
 */
function resolvePreset(
  preset: Preset,
  periodStart: string,
  periodEnd: string,
  reference: string,
): DateRangeValue {
  if (preset === 'full_year') return {}
  if (preset === 'custom') return {}

  if (preset === 'ytd') {
    const to = clampToPeriod(reference, periodStart, periodEnd)
    return { fromDate: periodStart, toDate: to }
  }

  const ref = new Date(reference)
  // Same UTC pitfall as todayIso(): Date.toISOString() returns UTC, so a
  // local Date constructed via `new Date(y, m, d)` round-trips to the wrong
  // calendar day in any timezone west of UTC. Use the local components.
  const toLocalIso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (preset === 'this_month') {
    const y = ref.getFullYear()
    const m = ref.getMonth()
    const start = `${y}-${String(m + 1).padStart(2, '0')}-01`
    const end = toLocalIso(new Date(y, m + 1, 0))
    return {
      fromDate: clampToPeriod(start, periodStart, periodEnd),
      toDate: clampToPeriod(end, periodStart, periodEnd),
    }
  }
  if (preset === 'last_month') {
    const y = ref.getFullYear()
    const m = ref.getMonth() - 1
    const start = toLocalIso(new Date(y, m, 1))
    const end = toLocalIso(new Date(y, m + 1, 0))
    return {
      fromDate: clampToPeriod(start, periodStart, periodEnd),
      toDate: clampToPeriod(end, periodStart, periodEnd),
    }
  }
  if (preset === 'this_quarter') {
    const y = ref.getFullYear()
    const q = Math.floor(ref.getMonth() / 3)
    const start = `${y}-${String(q * 3 + 1).padStart(2, '0')}-01`
    const end = toLocalIso(new Date(y, q * 3 + 3, 0))
    return {
      fromDate: clampToPeriod(start, periodStart, periodEnd),
      toDate: clampToPeriod(end, periodStart, periodEnd),
    }
  }
  return {}
}

/**
 * Date-range picker for the resultat-/balansrapport family.
 *
 * Default = "Hittills i år" (YTD) which matches Fortnox/Visma. A "Hela året"
 * preset clears the range entirely so the API falls back to full-period
 * behaviour. Custom range is clamped to the fiscal period: cross-year
 * ranges are out of scope.
 */
export function ReportDateRange({
  periodStart,
  periodEnd,
  value,
  onChange,
  className,
}: Props) {
  const t = useTranslations('reports')
  const { company } = useCompany()
  const [preset, setPreset] = useState<Preset>('ytd')

  // Restore last-used preset per company, then resolve it against the
  // current fiscal period. The period selector lives upstream: when it
  // changes, we re-resolve so the dates always sit inside the visible year.
  useEffect(() => {
    if (!company?.id || typeof window === 'undefined') return
    const stored = window.localStorage.getItem(STORAGE_KEY_PREFIX + company.id) as Preset | null
    const initial: Preset = stored && PRESETS.includes(stored) ? stored : 'ytd'
    setPreset(initial)
    if (initial !== 'custom') {
      onChange(resolvePreset(initial, periodStart, periodEnd, todayIso()))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id, periodStart, periodEnd])

  const handlePreset = useCallback(
    (next: Preset) => {
      setPreset(next)
      if (company?.id && typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY_PREFIX + company.id, next)
      }
      if (next === 'custom') {
        // Seed the custom inputs with whatever is currently active so the
        // user can nudge them rather than start from scratch.
        if (!value.fromDate && !value.toDate) {
          onChange({ fromDate: periodStart, toDate: clampToPeriod(todayIso(), periodStart, periodEnd) })
        }
        return
      }
      onChange(resolvePreset(next, periodStart, periodEnd, todayIso()))
    },
    [company?.id, onChange, periodEnd, periodStart, value.fromDate, value.toDate],
  )

  const handleFromChange = (raw: string) => {
    const next = raw ? clampToPeriod(raw, periodStart, periodEnd) : undefined
    onChange({ fromDate: next, toDate: value.toDate })
  }
  const handleToChange = (raw: string) => {
    const next = raw ? clampToPeriod(raw, periodStart, periodEnd) : undefined
    onChange({ fromDate: value.fromDate, toDate: next })
  }

  const presetLabels: Record<Preset, string> = useMemo(
    () => ({
      full_year: t('date_range_preset_full_year'),
      ytd: t('date_range_preset_ytd'),
      this_month: t('date_range_preset_this_month'),
      last_month: t('date_range_preset_last_month'),
      this_quarter: t('date_range_preset_this_quarter'),
      custom: t('date_range_preset_custom'),
    }),
    [t],
  )

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {t('date_range_label')}
      </Label>
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => {
          const active = preset === p
          return (
            <button
              key={p}
              type="button"
              onClick={() => handlePreset(p)}
              className={cn(
                'px-3 py-1.5 text-xs rounded-md border transition-colors duration-150',
                active
                  ? 'bg-secondary border-border text-foreground'
                  : 'bg-transparent border-border text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
              )}
            >
              {presetLabels[p]}
            </button>
          )
        })}
      </div>
      {preset === 'custom' && (
        <div className="flex flex-wrap items-end gap-3 mt-1">
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">{t('date_range_from')}</Label>
            <Input
              type="date"
              min={periodStart}
              max={periodEnd}
              value={value.fromDate ?? ''}
              onChange={(e) => handleFromChange(e.target.value)}
              className="w-[160px] tabular-nums"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">{t('date_range_to')}</Label>
            <Input
              type="date"
              min={periodStart}
              max={periodEnd}
              value={value.toDate ?? ''}
              onChange={(e) => handleToChange(e.target.value)}
              className="w-[160px] tabular-nums"
            />
          </div>
        </div>
      )}
    </div>
  )
}
