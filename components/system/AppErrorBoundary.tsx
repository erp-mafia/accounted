'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SupportLink } from '@/components/ui/support-link'

/**
 * App-wide error boundary (rendered from app/error.tsx). It catches any render
 * error below the root layout that has no closer boundary, which includes the
 * auth and onboarding segments AND their layouts (an error.tsx never catches
 * its own sibling layout, only a parent boundary does).
 *
 * Those segments fire several Supabase auth/DB queries at the exact moment a
 * session is established (BankID login -> /auth/callback -> the /select-company
 * picker). A transient failure there, most often a Supabase refresh-token
 * rotation race in the first request after the cookies are set, or a stale JS
 * chunk right after a deploy, used to escape every boundary and hit
 * app/global-error.tsx, which blanks the whole document with a bare "Nagot gick
 * fel" screen for a second before the next request repainted and logged the
 * user in normally.
 *
 * Recovery is a single hard reload, NOT React's reset(). A reload re-runs
 * middleware (picking up the freshly rotated auth cookie) and fetches a fresh
 * bundle (recovering a ChunkLoadError after a deploy): the same
 * browser-navigation heal these transients already relied on. A soft reset()
 * re-renders against the same stale server payload / bundle and just re-throws.
 *
 * A per-path, per-tab-session sessionStorage flag makes the auto-reload fire at
 * most once per path, so a genuinely persistent error settles on the manual
 * fallback instead of looping. This is a monotonic one-shot, not a time window:
 * a time window can still loop if each failing render takes longer than the
 * window (slow SSR that eventually throws), whereas the flag caps auto-reloads
 * regardless of timing. sessionStorage is per-tab and cleared on tab close, so
 * a fresh visit gets a fresh auto-recovery; a different path keeps its own flag.
 */
const RELOAD_FLAG_PREFIX = 'accounted:app-error-reloaded:'

function reloadKey(): string {
  return (
    RELOAD_FLAG_PREFIX +
    (typeof window !== 'undefined' ? window.location.pathname : '')
  )
}

// Decided once at mount via a lazy state initializer, never in an effect, so
// the auto-reload stays off React's setState-in-effect path. 'reloading'
// renders nothing while the single hard reload is issued; 'fallback' shows the
// manual UI. On the server (root layout threw during SSR) there is no window,
// so it starts in 'reloading' -> renders nothing and defers to the client,
// avoiding both a server crash and a flash in the common recover-invisibly case.
function decideInitialPhase(): 'reloading' | 'fallback' {
  if (typeof window === 'undefined') return 'reloading'
  try {
    // Already auto-reloaded this path in this tab session: don't loop, show the
    // manual fallback.
    if (window.sessionStorage.getItem(reloadKey())) return 'fallback'
    // Claim the one-shot and reload only if the flag actually persisted:
    // writing here (not in the effect) keeps "mark reloaded" and "decide to
    // reload" atomic, so a failed write (quota full / blocked) falls through to
    // 'fallback' instead of reloading forever without ever recording it.
    window.sessionStorage.setItem(reloadKey(), '1')
    return 'reloading'
  } catch {
    // sessionStorage blocked or full: don't risk a reload loop, show the
    // fallback so the user always has an explicit way forward.
    return 'fallback'
  }
}

export function AppErrorBoundary({
  error,
  scope,
}: {
  error: Error & { digest?: string }
  scope: string
}) {
  const [phase] = useState<'reloading' | 'fallback'>(decideInitialPhase)

  useEffect(() => {
    console.error(
      `[${scope}] Unhandled error${error.digest ? ` (digest ${error.digest})` : ''}:`,
      error,
    )
    // The one-shot flag is already claimed in decideInitialPhase, so reaching
    // 'reloading' guarantees it persisted: reload exactly once.
    if (phase === 'reloading') window.location.reload()
  }, [phase, error, scope])

  // During the single automatic reload, render nothing so a transient error
  // never flashes any UI at all.
  if (phase === 'reloading') return null

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <h2 className="text-xl font-semibold">Något gick fel</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Ett oväntat fel uppstod. Försök igen eller{' '}
        <SupportLink variant="inline" subject="Oväntat fel">
          kontakta support
        </SupportLink>{' '}
        om problemet kvarstår.
      </p>
      <Button onClick={() => window.location.reload()}>Försök igen</Button>
    </div>
  )
}
