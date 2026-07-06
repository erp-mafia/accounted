'use client'

import { useCallback, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'

/**
 * Per-user toggle for the periodisering wizard's auto-detection step.
 *
 * Backed by localStorage (key: `periodisering_autodetect_enabled`) because
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

function readStored(): boolean {
  if (typeof window === 'undefined') return true
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
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
    if (e.key === STORAGE_KEY || e.key === null) callback()
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
  const enabled = useSyncExternalStore(
    subscribe,
    readStored,
    // Server snapshot: default to enabled. Matches the client default so
    // hydration is identical.
    () => true,
  )

  const handleChange = useCallback((value: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(value))
    } catch {
      // No-op; if storage is blocked the toggle simply won't persist.
    }
    notifyChange()
  }, [])

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        Periodisering
      </h2>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="periodisering-autodetect" className="text-sm">
            Aktivera automatisk periodiseringsdetektering
          </Label>
          <p className="text-xs text-muted-foreground max-w-md">
            Skannar fakturor i bokslutet efter datumintervall som sträcker sig
            in i nästa räkenskapsår och föreslår periodiseringar i bokslut-wizarden.
          </p>
        </div>
        <Switch
          id="periodisering-autodetect"
          checked={enabled}
          onCheckedChange={handleChange}
        />
      </div>
      <Link
        href="/bookkeeping/year-end/periodisering"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Öppna periodiserings-wizarden
      </Link>
    </section>
  )
}
