'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { ContextPicker } from '@/components/common/ContextPicker'
import { STORAGE_KEY_PREFIX, ALL_YEARS_VALUE } from '@/components/common/fiscal-year-storage'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import { prepareFiscalPeriods, resolveInitialFiscalScope } from '@/lib/reference-data/fiscal-scope'
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
  /**
   * Never auto-select on load, from ANY source: not the newest-period
   * fallback, and not a selection persisted by an earlier session. The picker
   * stays empty until the user chooses, every session.
   *
   * The default behaviour (restore or pick the newest) is right for a filter,
   * where a sensible default beats an empty page. It is wrong where the year
   * is an ASSERTION the user is making rather than a view they are narrowing:
   * the underlag import resolves voucher references inside the chosen year and
   * writes irreversible links. A pre-filled newest year would let a 2023 batch
   * land in 2026, and a restored LAST-USED year is aimed even worse: in a
   * multi-year migration the user is by definition moving to a year other than
   * last time. Within one sitting the caller carries the choice in its own
   * state (the wizard's reset() keeps it), which covers multi-batch runs
   * without any cross-session hazard.
   */
  requireExplicitChoice?: boolean
  /**
   * Skip ONLY the on-load restore of a persisted selection (and its
   * newest-period fallback) while keeping manual picks persisted as usual.
   * For deep-link visits that arrive with a deliberate transient scope (e.g.
   * /bookkeeping?missingUnderlag=true opens as "Alla räkenskapsår" to match
   * the all-years dashboard count): without this, the restore fires on
   * `value === null` and snaps the scope back to the stored year right after
   * load. Unlike requireExplicitChoice this does not change labels or
   * persistence semantics.
   */
  suppressAutoRestore?: boolean
  /** Fires once after the initial period load completes. */
  onReady?: () => void
  /** Server-loaded periods for the first render, scoped to initialCompanyId. */
  initialPeriods?: FiscalPeriod[]
  initialCompanyId?: string | null
  /**
   * localStorage prefix for the persisted selection (companyId is appended).
   * Defaults to the report-wide shared scope; pass a page-specific prefix
   * when the page's scope must not follow (or steer) the shared one, e.g.
   * the transactions inbox, where a narrowed scope hides pending rows.
   */
  storageKeyPrefix?: string
  className?: string
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
  requireExplicitChoice = false,
  suppressAutoRestore = false,
  onReady,
  initialPeriods,
  initialCompanyId,
  storageKeyPrefix = STORAGE_KEY_PREFIX,
  className,
}: FyPickerProps) {
  const { company } = useCompany()
  const t = useTranslations('fiscal_year')
  // Session-cached and seeded by the dashboard layout, so on a normal visit
  // the list is already here on the first render: the restore below runs in
  // the first effect tick and onReady fires without a network round trip.
  // initialPeriods remains an explicit override for server-rendered pages.
  const { periods: cachedPeriods, isLoading } = useFiscalPeriods()
  const canUseInitial = initialCompanyId === company?.id && initialPeriods !== undefined
  const periods = useMemo(
    () => prepareFiscalPeriods(canUseInitial ? initialPeriods : cachedPeriods, hideFuturePeriods),
    [canUseInitial, initialPeriods, cachedPeriods, hideFuturePeriods],
  )
  const loaded = canUseInitial || !isLoading
  // Restore once per company load, not on every background revalidation of
  // the cached list (which would re-fire onChange/onReady mid-session).
  const restoredForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!company?.id) {
      onReady?.()
      return
    }
    if (!loaded || restoredForRef.current === company.id) return
    restoredForRef.current = company.id

    // Restore last selection (same key as FiscalYearSelector so pages keep
    // their scope when the picker swaps in).
    //
    // requireExplicitChoice gates this WHOLE block, not individual branches:
    // every path in here ends in an unprompted onChange (restore, the
    // ALL_YEARS-stored fallback, newest-period, preferLatestEnded), and a
    // per-branch gate already missed one of them once. Nothing auto-fires;
    // the picker stays empty until a human picks.
    if (value === null && !requireExplicitChoice && !suppressAutoRestore && typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(storageKeyPrefix + company.id)
      const pick = resolveInitialFiscalScope(periods, stored, { includeAllOption, preferLatestEnded })
      if (pick) onChange(pick.periodId, pick.period)
    }

    onReady?.()
  // onReady/onChange are lifecycle callbacks: fire once per load, not on
  // parent re-renders that re-create them. `value` is read once at restore.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id, loaded, periods])

  const handleChange = (id: string) => {
    const nextId = id === ALL_YEARS_VALUE ? null : id
    // A per-batch assertion is never restored, so persisting it would be a
    // write nothing reads. Worse than useless: this write happens BEFORE
    // onChange, so a pick the caller rejects (e.g. mid-preview) would still
    // be recorded as if it had taken effect.
    if (!requireExplicitChoice && company?.id && typeof window !== 'undefined') {
      window.localStorage.setItem(storageKeyPrefix + company.id, nextId ?? ALL_YEARS_VALUE)
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
