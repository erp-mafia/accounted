'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'

// Inlined at build time from next.config's `env` (the deploy's commit SHA on
// Vercel; empty in dev / self-hosted, which turns the check off).
const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID || ''

/**
 * Detects when a newer deploy is live while this tab is still running an old JS
 * bundle, and offers a one-click reload. This is why a just-shipped change can
 * appear "missing" in a long-open tab until the whole app is reloaded.
 *
 * Compares the build id baked into this bundle against /api/version (the
 * running deployment's id), re-checking when the tab regains focus plus a slow
 * interval backstop. No-op when no build id is set.
 */
export function DeployReloadPrompt() {
  const t = useTranslations('common')
  const [stale, setStale] = useState(false)

  useEffect(() => {
    if (!BUILD_ID || stale) return

    let cancelled = false
    async function check() {
      try {
        const res = await fetch('/api/version', { cache: 'no-store' })
        if (!res.ok) return
        const { id } = await res.json()
        if (!cancelled && id && id !== BUILD_ID) setStale(true)
      } catch {
        // Transient network error: ignore, the next trigger retries.
      }
    }

    function onVisible() {
      if (document.visibilityState === 'visible') check()
    }

    check()
    document.addEventListener('visibilitychange', onVisible)
    const interval = setInterval(check, 30 * 60 * 1000) // 30 min backstop
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(interval)
    }
  }, [stale])

  if (!stale) return null

  return (
    <div className="fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 text-sm shadow-md">
        <span className="text-foreground">{t('update_available')}</span>
        <Button size="sm" onClick={() => window.location.reload()}>
          {t('reload')}
        </Button>
      </div>
    </div>
  )
}
