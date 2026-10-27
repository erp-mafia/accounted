'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { POPOVER_ENTER_UP_CLASS, POPOVER_SURFACE_CLASS } from '@/components/ui/popover-surface'
import { cn } from '@/lib/utils'
import { createVisiblePoller } from '@/lib/browser/visible-poller'

// Inlined at build time from next.config's `env` (the deploy's commit SHA on
// Vercel; empty in dev / self-hosted, which turns the check off).
const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID || ''
// Re-check on return to the tab only when the last answer is this old.
const VERSION_RECHECK_MS = 5 * 60 * 1000
// Backstop for a tab that stays visible without being left.
const VERSION_BACKSTOP_MS = 30 * 60 * 1000

/**
 * Detects when a newer deploy is live while this tab is still running an old JS
 * bundle, and offers a one-click reload. This is why a just-shipped change can
 * appear "missing" in a long-open tab until the whole app is reloaded.
 *
 * Compares the build id baked into this bundle against /api/version (the
 * running deployment's id), re-checking when the tab becomes visible again
 * (at most once per five minutes) plus a slow backstop while it stays
 * visible; a hidden tab does not poll. No-op when no build id is set.
 */
export function DeployReloadPrompt() {
  const t = useTranslations('common')
  const [stale, setStale] = useState(false)

  useEffect(() => {
    if (!BUILD_ID || stale) return

    const poller = createVisiblePoller({
      load: async (signal) => {
        const res = await fetch('/api/version', { cache: 'no-store', signal })
        if (!res.ok) throw new Error(`version answered ${res.status}`)
        const { id } = await res.json() as { id?: string }
        return id ?? ''
      },
      onResult: (id) => {
        if (id && id !== BUILD_ID) setStale(true)
      },
      intervalMs: () => VERSION_BACKSTOP_MS,
      staleAfterMs: () => VERSION_RECHECK_MS,
      retryMs: VERSION_BACKSTOP_MS,
      isVisible: () => document.visibilityState !== 'hidden',
    })
    document.addEventListener('visibilitychange', poller.nudge)
    poller.refresh()
    return () => {
      poller.stop()
      document.removeEventListener('visibilitychange', poller.nudge)
    }
  }, [stale])

  if (!stale) return null

  return (
    // The wrapper spans the full width at the same z-index as the docked
    // assistant panel and mounts after it, so without pointer-events-none it
    // swallowed every click and tap in the strip behind it: the panel's
    // composer sits exactly there, and "a new version is available" turned
    // into "I can't type any more". Only the card itself takes input.
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4">
      <div
        className={cn(
          'pointer-events-auto flex items-center gap-3 px-4 py-3 text-sm',
          POPOVER_SURFACE_CLASS,
          POPOVER_ENTER_UP_CLASS,
        )}
      >
        <span className="text-foreground">{t('update_available')}</span>
        <Button size="sm" onClick={() => window.location.reload()}>
          {t('reload')}
        </Button>
      </div>
    </div>
  )
}
