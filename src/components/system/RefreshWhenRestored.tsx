'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { renderTracker } from '@/lib/navigation/restored-render'

/**
 * Re-renders the current route from the server when the client router showed
 * it from its cache (back/forward, or a link click within staleTimes.dynamic).
 * The cached render paints at once and the fresh one replaces it, so a live
 * page never sits on numbers from an earlier visit. A fresh render costs
 * nothing extra. See lib/navigation/restored-render.ts.
 */
export function RefreshWhenRestored({ renderId }: { renderId: string }) {
  const router = useRouter()
  // Identity of this mount, stable across StrictMode's effect re-run.
  const [mount] = useState(() => ({}))
  useEffect(() => {
    if (renderTracker.isRestored(renderId, mount)) router.refresh()
  }, [renderId, mount, router])
  return null
}
