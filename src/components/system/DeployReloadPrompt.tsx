'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { onStaleDeploy } from '@/lib/browser/stale-deploy'
import {
  attemptedIn,
  installDeployNavigation,
  reloadCardDelayMs,
} from '@/lib/browser/deploy-navigation'
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
 * bundle. The tab then takes the new build by itself on the next page change
 * (lib/browser/deploy-navigation.ts: the link click becomes a full document
 * load), and the one-click reload card is the fallback for a tab that stays on
 * one page. It never reloads under the person: no timer, no reload on focus.
 *
 * Compares the build id baked into this bundle against /api/version (the
 * running deployment's id), re-checking when the tab becomes visible again
 * (at most once per five minutes) plus a slow backstop while it stays
 * visible; a hidden tab does not poll. No-op when no build id is set.
 */
export function DeployReloadPrompt() {
  const t = useTranslations('common')
  // null: not known to be behind. Otherwise the live build's id, or '' when
  // a failed Server Action is all we know.
  const [liveBuildId, setLiveBuildId] = useState<string | null>(null)
  const stale = liveBuildId !== null
  const [cardDue, setCardDue] = useState(false)
  // A full reload keeps this page on screen until the new document answers
  // (median 0.8 s, p90 1.7 s in production), so the click looked dead and
  // people clicked again; every extra reload() restarts that request. The
  // button shows it is working and ignores further clicks.
  const [reloading, setReloading] = useState(false)

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
        if (id && id !== BUILD_ID) setLiveBuildId(id)
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

  // A Server Action this build knows but the server no longer has: the tab
  // is behind a deploy whether or not /api/version has said so yet.
  useEffect(() => onStaleDeploy(window, () => {
    setLiveBuildId((known) => known ?? '')
    // The click just died: the way out is shown now, not after the wait.
    setCardDue(true)
  }), [])

  // While behind: hand the next in-app link click to the browser, and hold
  // the card back for a tab that can update that way (see reloadCardDelayMs
  // for the cases that show it at once, as before).
  useEffect(() => {
    if (liveBuildId === null) return
    const uninstall = BUILD_ID
      ? installDeployNavigation(window, { currentBuildId: BUILD_ID, liveBuildId })
      : () => {}
    const delay = reloadCardDelayMs({ currentBuildId: BUILD_ID, liveBuildId, attempted: attemptedIn(window) })
    const timer = window.setTimeout(() => setCardDue(true), delay)
    return () => {
      uninstall()
      window.clearTimeout(timer)
    }
  }, [liveBuildId])

  if (!stale || !cardDue) return null

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
        <Button
          loading={reloading}
          onClick={() => {
            if (reloading) return
            setReloading(true)
            window.location.reload()
          }}
        >
          {t('reload')}
        </Button>
      </div>
    </div>
  )
}
