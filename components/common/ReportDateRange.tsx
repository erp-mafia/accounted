'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Check, ChevronDown } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn, formatDate } from '@/lib/utils'

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
  /**
   * Preset to open on when this company has no stored choice yet. Defaults to
   * YTD, which matches Fortnox/Visma for the resultat-/balansrapport family.
   * Bank reconciliation passes 'full_year': a reconciliation is carried out
   * over a whole räkenskapsår, and a part-year window makes its difference
   * describe a period the user did not ask about.
   */
  defaultPreset?: Preset
  /**
   * localStorage prefix for the remembered preset (companyId is appended).
   * Defaults to the range shared by the report family. Pass a page-specific
   * prefix where inheriting another report's preset would be wrong rather than
   * merely surprising: bank reconciliation opened on a "Denna månad" carried
   * over from Resultatrapport would show an alarming difference for a window
   * nobody chose.
   */
  storageKeyPrefix?: string
  className?: string
}

const STORAGE_KEY_PREFIX = 'Accounted:report-range-preset:'
const PRESETS: Preset[] = ['full_year', 'ytd', 'this_month', 'last_month', 'this_quarter', 'custom']
const MENU_PRESETS: Exclude<Preset, 'custom'>[] = ['full_year', 'ytd', 'this_month', 'last_month', 'this_quarter']

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
export function resolvePreset(
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
 * Period picker for the resultat-/balansrapport family and the reconciliation
 * workspace: one pill that names the range in force and opens a menu with the
 * presets and a custom from/to. Nothing renders inline in the toolbar when a
 * choice is made, so the row keeps one control per axis (Jakob, 2026-09-09:
 * "dropdowns that are overlays instead of inline").
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
  defaultPreset = 'ytd',
  storageKeyPrefix = STORAGE_KEY_PREFIX,
  className,
}: Props) {
  const t = useTranslations('reports')
  const { company } = useCompany()
  const [preset, setPreset] = useState<Preset>(defaultPreset)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<{ from: string; to: string }>({ from: periodStart, to: periodEnd })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  // Restore last-used preset per company, then resolve it against the
  // current fiscal period. The period selector lives upstream: when it
  // changes, we re-resolve so the dates always sit inside the visible year.
  useEffect(() => {
    if (!company?.id || typeof window === 'undefined') return
    const stored = window.localStorage.getItem(storageKeyPrefix + company.id) as Preset | null
    const initial: Preset = stored && PRESETS.includes(stored) ? stored : defaultPreset
    setPreset(initial)
    if (initial !== 'custom') {
      onChange(resolvePreset(initial, periodStart, periodEnd, todayIso()))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id, periodStart, periodEnd, storageKeyPrefix, defaultPreset])

  const remember = useCallback(
    (next: Preset) => {
      if (company?.id && typeof window !== 'undefined') {
        window.localStorage.setItem(storageKeyPrefix + company.id, next)
      }
    },
    [company?.id, storageKeyPrefix],
  )

  const choosePreset = useCallback(
    (next: Exclude<Preset, 'custom'>) => {
      setPreset(next)
      remember(next)
      onChange(resolvePreset(next, periodStart, periodEnd, todayIso()))
      setOpen(false)
    },
    [onChange, periodEnd, periodStart, remember],
  )

  const applyCustom = useCallback(() => {
    const from = draft.from ? clampToPeriod(draft.from, periodStart, periodEnd) : periodStart
    const to = draft.to ? clampToPeriod(draft.to, periodStart, periodEnd) : periodEnd
    const ordered = from <= to ? { fromDate: from, toDate: to } : { fromDate: to, toDate: from }
    setPreset('custom')
    remember('custom')
    onChange(ordered)
    setOpen(false)
  }, [draft.from, draft.to, onChange, periodEnd, periodStart, remember])

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || !panelRef.current) return
    const tr = triggerRef.current.getBoundingClientRect()
    const p = panelRef.current.getBoundingClientRect()
    const margin = 8
    // Right-aligned under the pill (it sits far right in the toolbar), clamped to the viewport.
    const left = Math.max(margin, Math.min(tr.right - p.width, window.innerWidth - p.width - margin))
    const top = Math.min(tr.bottom + 4, window.innerHeight - p.height - margin)
    setPos({ top, left })
  }, [])

  useEffect(() => {
    if (!open) return
    setDraft({ from: value.fromDate ?? periodStart, to: value.toDate ?? clampToPeriod(todayIso(), periodStart, periodEnd) })
    const raf = requestAnimationFrame(() => updatePosition())
    return () => cancelAnimationFrame(raf)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.isConnected) return
      if (
        (!triggerRef.current || !triggerRef.current.contains(target)) &&
        (!panelRef.current || !panelRef.current.contains(target))
      ) {
        setOpen(false)
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

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

  const summary =
    preset === 'custom' && (value.fromDate || value.toDate)
      ? t('date_range_custom_summary', { from: formatDate(value.fromDate ?? periodStart), to: formatDate(value.toDate ?? periodEnd) })
      : presetLabels[preset]

  return (
    <div className={cn('inline-flex', className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('date_range_label')}
        className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-background px-3 text-[13px] text-foreground transition-colors duration-150 hover:bg-secondary/60"
      >
        <span className="max-w-[260px] truncate tabular-nums">{summary}</span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t('date_range_label')}
            data-dialog-companion=""
            className="pointer-events-auto fixed z-[60] w-[320px] rounded-lg border border-border bg-popover p-1 shadow-lg"
            style={{ top: pos.top, left: pos.left }}
          >
            <div role="listbox" aria-label={t('date_range_label')}>
              {MENU_PRESETS.map((p) => {
                const active = preset === p
                return (
                  <button
                    key={p}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => choosePreset(p)}
                    className={cn(
                      'flex w-full items-center justify-between rounded-sm px-3 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-secondary/60',
                      active ? 'text-foreground' : 'text-foreground/90',
                    )}
                  >
                    <span>{presetLabels[p]}</span>
                    {active ? <Check className="h-3.5 w-3.5 text-muted-foreground" /> : null}
                  </button>
                )
              })}
            </div>
            <div className="my-1 h-px bg-border" />
            <div className="space-y-2 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{presetLabels.custom}</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{t('date_range_from')}</Label>
                  <Input
                    type="date"
                    min={periodStart}
                    max={periodEnd}
                    value={draft.from}
                    onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
                    className="h-8 tabular-nums"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{t('date_range_to')}</Label>
                  <Input
                    type="date"
                    min={periodStart}
                    max={periodEnd}
                    value={draft.to}
                    onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                    className="h-8 tabular-nums"
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button size="sm" onClick={applyCustom}>
                  {t('date_range_apply')}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
