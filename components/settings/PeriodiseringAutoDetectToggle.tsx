'use client'

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import {
  SettingsRow,
  SettingsRowEnd,
} from '@/components/settings/SettingsRows'

/**
 * Per-company toggle for the periodisering wizard's auto-detection step.
 *
 * Backed by localStorage (key: `periodisering_autodetect_enabled:<companyId>`,
 * with the old unscoped key as a read fallback so existing choices survive:
 * the unscoped key silently applied one company's choice to every company in
 * the browser) because
 * the company_settings table does not yet have a dedicated column for this
 * preference, and the task description explicitly allows the persistence to
 * be UI-local. A future migration can promote this to a real
 * `company_settings.periodisering_autodetect_enabled boolean` column and
 * the wizard's auto-detect step will read either source.
 *
 * Default: enabled. The wizard's auto-detect step renders regardless: the
 * toggle merely controls whether the GET response includes `autoDetected`
 * on subsequent fetches. (Today the API always returns it; the wizard step
 * can early-out based on this setting locally.)
 */
const STORAGE_KEY = 'periodisering_autodetect_enabled'

function storageKeyFor(companyId: string | null): string {
  return companyId ? `${STORAGE_KEY}:${companyId}` : STORAGE_KEY
}

function readStored(companyId: string | null): boolean {
  if (typeof window === 'undefined') return true
  try {
    const stored =
      window.localStorage.getItem(storageKeyFor(companyId)) ??
      window.localStorage.getItem(STORAGE_KEY)
    return stored === null ? true : stored !== 'false'
  } catch {
    return true
  }
}

/** Subscribe to localStorage changes from OTHER tabs. Same-tab updates are
 *  picked up via the explicit re-render after `setItem`: see
 *  `notifyChange` below. */
function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = (e: StorageEvent) => {
    if (e.key === null || e.key === STORAGE_KEY || e.key.startsWith(`${STORAGE_KEY}:`)) callback()
  }
  const customHandler = () => callback()
  window.addEventListener('storage', handler)
  window.addEventListener('gnubok-periodisering-toggle', customHandler)
  return () => {
    window.removeEventListener('storage', handler)
    window.removeEventListener('gnubok-periodisering-toggle', customHandler)
  }
}

/** Fire a same-tab notification so useSyncExternalStore re-subscribers
 *  see the change without a manual setState. */
function notifyChange() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event('gnubok-periodisering-toggle'))
}

export function PeriodiseringAutoDetectToggle() {
  const companyId = useCompanyOptional()?.company?.id ?? null
  const getSnapshot = useMemo(() => () => readStored(companyId), [companyId])
  const enabled = useSyncExternalStore(
    subscribe,
    getSnapshot,
    // Server snapshot: default to enabled. Matches the client default so
    // hydration is identical.
    () => true,
  )

  const handleChange = useCallback((value: boolean) => {
    try {
      window.localStorage.setItem(storageKeyFor(companyId), String(value))
    } catch {
      // No-op; if storage is blocked the toggle simply won't persist.
    }
    notifyChange()
  }, [companyId])

  return (
    <SettingsRow
      label="Periodisering"
      help="Skannar fakturor i bokslutet efter datumintervall som sträcker sig in i nästa räkenskapsår och föreslår periodiseringar i bokslut-wizarden."
    >
      <Switch
        id="periodisering-autodetect"
        checked={enabled}
        onCheckedChange={handleChange}
      />
      <label htmlFor="periodisering-autodetect" className="cursor-pointer text-sm">
        Aktivera automatisk periodiseringsdetektering
      </label>
      <SettingsRowEnd>
        <Link
          href="/bookkeeping/year-end/periodisering"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Öppna periodiserings-wizarden
        </Link>
      </SettingsRowEnd>
    </SettingsRow>
  )
}
