'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { ContextPicker } from '@/components/common/ContextPicker'
import {
  STORAGE_KEY_PREFIX,
  ALL_YEARS_VALUE,
} from '@/components/common/FiscalYearSelector'
import type { FiscalPeriod } from '@/types'

interface FyPickerProps {
  /** Current selection. `null` means "all years": no filter applied. */
  value: string | null
  /**
   * Called with the selected period id (or null for "all years") and the
   * matching FiscalPeriod so callers avoid an extra fetch.
   */
  onChange: (periodId: string | null, period?: FiscalPeriod | null) => void
  /** Include an "Alla räkenskapsår" option that clears the filter. */
  includeAllOption?: boolean
  /** Only show periods that have started (Reports-style filter). */
  hideFuturePeriods?: boolean
  /**
   * Auto-select the most recently ENDED period on load instead of restoring
   * the shared per-company scope or falling back to the newest started one.
   * For filing surfaces (helårsmoms): only an ended räkenskapsår can be
   * declared, so the newest started period is the one default that is always
   * wrong there. Manual picks still work and are still persisted.
   */
  preferLatestEnded?: boolean
  /** Fires once after the initial period load completes. */
  onReady?: () => void
  /** Server-loaded periods for the first render, scoped to initialCompanyId. */
  initialPeriods?: FiscalPeriod[]
  initialCompanyId?: string | null
  className?: string
}

function preparePeriods(periods: FiscalPeriod[], hideFuturePeriods: boolean): FiscalPeriod[] {
  const today = new Date().toISOString().split('T')[0]
  return periods
    .filter((p) => !hideFuturePeriods || p.period_start <= today)
    .sort((a, b) => b.period_start.localeCompare(a.period_start))
}

/**
 * Fiscal-year context picker (UI-migration plan PR 3): the chip-dropdown
 * "Räkenskapsår 2026" with a check on the active choice and closed/locked
 * years annotated. Same controlled API and per-company localStorage
 * persistence as FiscalYearSelector, which it replaces page by page from
 * PR 4 on.
 */
export function FyPicker({
  value,
  onChange,
  includeAllOption = true,
  hideFuturePeriods = false,
  preferLatestEnded = false,
  onReady,
  initialPeriods,
  initialCompanyId,
  className,
}: FyPickerProps) {
  const { company } = useCompany()
  const t = useTranslations('fiscal_year')
  const canUseInitial = initialCompanyId === company?.id && initialPeriods !== undefined
  const [periods, setPeriods] = useState<FiscalPeriod[]>(() =>
    canUseInitial ? preparePeriods(initialPeriods, hideFuturePeriods) : [],
  )
  const [loaded, setLoaded] = useState(canUseInitial)

  useEffect(() => {
    if (!company?.id) {
      onReady?.()
      return
    }
    let cancelled = false
    ;(async () => {
      let fetched: FiscalPeriod[]
      if (initialCompanyId === company.id && initialPeriods !== undefined) {
        fetched = preparePeriods(initialPeriods, hideFuturePeriods)
      } else {
        const res = await fetch('/api/bookkeeping/fiscal-periods')
        if (!res.ok) {
          if (!cancelled) {
            setLoaded(true)
            onReady?.()
          }
          return
        }
        const { data } = await res.json()
        fetched = preparePeriods(data || [], hideFuturePeriods)
      }
      if (cancelled) return

      setPeriods(fetched)
      setLoaded(true)

      // Restore last selection (same key as FiscalYearSelector so pages keep
      // their scope when the picker swaps in).
      if (value === null && typeof window !== 'undefined') {
        if (preferLatestEnded) {
          // Filing surfaces: ignore the shared scope memory and open on the
          // most recently ended period (fetched is sorted newest-first).
          const today = new Date().toISOString().split('T')[0]
          const pick = fetched.find((p) => p.period_end < today) ?? fetched[0]
          if (pick) onChange(pick.id, pick)
        } else {
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
      }

      onReady?.()
    })()
    return () => {
      cancelled = true
    }
  // onReady is a lifecycle callback: fire once per load, not on parent
  // re-renders that re-create it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id, hideFuturePeriods, includeAllOption, preferLatestEnded, initialCompanyId, initialPeriods])

  const handleChange = (id: string) => {
    const nextId = id === ALL_YEARS_VALUE ? null : id
    if (company?.id && typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY_PREFIX + company.id, nextId ?? ALL_YEARS_VALUE)
    }
    onChange(nextId, nextId ? periods.find((p) => p.id === nextId) ?? null : null)
  }

  const annotationFor = (p: FiscalPeriod) =>
    p.locked_at ? t('badge_locked').toLowerCase() : p.is_closed ? t('badge_closed').toLowerCase() : undefined

  const selected = value ? periods.find((p) => p.id === value) : null
  // Real period names often already read "Räkenskapsår 2026"; only prefix
  // the label when the name is a bare year/name so the chip never doubles up.
  const chipLabel = (p: FiscalPeriod) =>
    p.name.toLowerCase().includes(t('label').toLowerCase())
      ? p.name
      : `${t('label')} ${p.name}`
  const triggerLabel = selected
    ? chipLabel(selected)
    : includeAllOption
      ? t('all_years')
      : loaded
        ? t('placeholder')
        : t('loading')

  const items = [
    ...(includeAllOption ? [{ id: ALL_YEARS_VALUE, label: t('all_years') }] : []),
    ...periods.map((p) => ({
      id: p.id,
      label: p.name,
      annotation: annotationFor(p),
    })),
  ]

  return (
    <ContextPicker
      items={items}
      value={value ?? (includeAllOption ? ALL_YEARS_VALUE : null)}
      onChange={handleChange}
      triggerLabel={triggerLabel}
      disabled={!loaded || periods.length === 0}
      ariaLabel={t('label')}
      className={className}
    />
  )
}
