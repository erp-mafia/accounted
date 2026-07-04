'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Lock } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'
import type { FiscalPeriod } from '@/types'

// Exported so other surfaces (e.g. JournalEntryList's filter dialog) can read
// and write the same persisted selection without duplicating the magic string.
export const STORAGE_KEY_PREFIX = 'Accounted:fiscal-year:'
export const ALL_YEARS_VALUE = '__all__'

interface Props {
  /**
   * Current selection. `null` means "all years": no filter applied.
   */
  value: string | null
  /**
   * Called with the selected period id (or null for "all years"). The second
   * arg is the matching FiscalPeriod object so callers can read period_start
   * / period_end without an extra fetch.
   */
  onChange: (periodId: string | null, period?: FiscalPeriod | null) => void
  /**
   * If true, include an "Alla räkenskapsår" option that clears the filter.
   * Pages that require a specific period (e.g. Reports) should pass false.
   */
  includeAllOption?: boolean
  /**
   * Optional label above the select. Pass null to render without a label.
   */
  label?: string | null
  /**
   * If true, only show periods whose start date is on or before today.
   * Matches the Reports-page filter.
   */
  hideFuturePeriods?: boolean
  /**
   * Called once after the initial period fetch completes. Useful for callers
   * that want to suppress a skeleton until the selector is ready.
   */
  onReady?: () => void
  className?: string
}

/**
 * Shared fiscal-year (räkenskapsår) selector.
 *
 * Loads periods for the active company, persists the last selection per
 * company in localStorage, and renders the same Select used elsewhere in the
 * app so the UX is consistent across Bookkeeping, Reports, etc.
 *
 * The component is controlled: the caller owns the selected period id and
 * threads it into whichever queries need scoping.
 */
export function FiscalYearSelector({
  value,
  onChange,
  includeAllOption = true,
  label,
  hideFuturePeriods = false,
  onReady,
  className,
}: Props) {
  const { company } = useCompany()
  const t = useTranslations('fiscal_year')
  const [periods, setPeriods] = useState<FiscalPeriod[]>([])
  const [loaded, setLoaded] = useState(false)
  const effectiveLabel = label === null ? null : (label ?? t('label'))

  useEffect(() => {
    if (!company?.id) {
      // Fire onReady so consumers don't stall in a loading state while the
      // company context hydrates. The effect re-runs once company.id arrives.
      onReady?.()
      return
    }
    let cancelled = false
    ;(async () => {
      const res = await fetch('/api/bookkeeping/fiscal-periods')
      if (!res.ok) {
        if (!cancelled) {
          setLoaded(true)
          onReady?.()
        }
        return
      }
      const { data } = await res.json()
      if (cancelled) return

      let fetched: FiscalPeriod[] = data || []
      if (hideFuturePeriods) {
        const today = new Date().toISOString().split('T')[0]
        fetched = fetched.filter((p) => p.period_start <= today)
      }
      // Newest first: most migrations list recent years at the top
      fetched.sort((a, b) => b.period_start.localeCompare(a.period_start))
      setPeriods(fetched)
      setLoaded(true)

      // Restore last selection (only if caller hasn't already set a value).
      // localStorage access is guarded because this is a 'use client' component
      // but still runs during SSR on first render for some setups.
      if (value === null && typeof window !== 'undefined') {
        const stored = window.localStorage.getItem(STORAGE_KEY_PREFIX + company.id)
        if (stored === ALL_YEARS_VALUE) {
          if (includeAllOption) onChange(null, null)
          else if (fetched.length > 0) onChange(fetched[0].id, fetched[0])
        } else if (stored && fetched.some((p) => p.id === stored)) {
          onChange(stored, fetched.find((p) => p.id === stored) ?? null)
        } else if (!includeAllOption && fetched.length > 0) {
          onChange(fetched[0].id, fetched[0])
        }
      }

      onReady?.()
    })()
    return () => {
      cancelled = true
    }
  // onReady is intentionally excluded from deps: it's a lifecycle callback that
  // should fire once per load, not re-trigger if the parent re-creates it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id, hideFuturePeriods, includeAllOption])

  const handleChange = (next: string) => {
    const nextPeriodId = next === ALL_YEARS_VALUE ? null : next
    if (company?.id && typeof window !== 'undefined') {
      window.localStorage.setItem(
        STORAGE_KEY_PREFIX + company.id,
        nextPeriodId ?? ALL_YEARS_VALUE,
      )
    }
    const nextPeriod = nextPeriodId ? periods.find((p) => p.id === nextPeriodId) ?? null : null
    onChange(nextPeriodId, nextPeriod)
  }

  const selectValue = value ?? (includeAllOption ? ALL_YEARS_VALUE : '')

  // Surface lock status for the currently-selected period. Browsing locked
  // years is read-only and allowed (BFL 7:1 requires access to historical
  // data), but the user should see clearly that they're looking at a
  // closed/locked year so the absence of write controls feels intentional.
  const selectedPeriod = value ? periods.find((p) => p.id === value) : null
  const lockState: 'locked' | 'closed' | null = selectedPeriod?.locked_at
    ? 'locked'
    : selectedPeriod?.is_closed
      ? 'closed'
      : null

  return (
    <div className={className}>
      {effectiveLabel && <Label>{effectiveLabel}</Label>}
      <div className={`flex items-center gap-2 ${effectiveLabel ? 'mt-1' : ''}`}>
        <Select
          value={selectValue}
          onValueChange={handleChange}
          disabled={!loaded || periods.length === 0}
        >
          <SelectTrigger className="w-full sm:w-[280px]">
            <SelectValue placeholder={loaded ? t('placeholder') : t('loading')} />
          </SelectTrigger>
          <SelectContent>
            {includeAllOption && (
              <SelectItem value={ALL_YEARS_VALUE}>{t('all_years')}</SelectItem>
            )}
            {periods.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name} ({p.period_start} till {p.period_end})
                {p.locked_at ? t('suffix_locked') : p.is_closed ? t('suffix_closed') : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {lockState && (
          <Badge
            variant="outline"
            className="gap-1 text-xs font-normal shrink-0"
            title={lockState === 'locked' ? t('tooltip_locked') : t('tooltip_closed')}
          >
            <Lock className="h-3 w-3" />
            {lockState === 'locked' ? t('badge_locked') : t('badge_closed')}
          </Badge>
        )}
      </div>
    </div>
  )
}
