'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { ensureBasLoaded, isBasLoaded, subscribeBasLoaded } from './bas-lazy'

const serverSnapshot = () => false

/**
 * Kick off the lazy BAS chart load on mount and re-render once it lands.
 * Returns true when getBasLoaded() / getAccountDescription()'s BAS fallback
 * can answer. False on the server and during hydration, so SSR and the
 * first client render agree.
 */
export function useBasReference(): boolean {
  const ready = useSyncExternalStore(subscribeBasLoaded, isBasLoaded, serverSnapshot)
  useEffect(() => {
    void ensureBasLoaded().catch(() => {
      // Descriptions degrade to the hardcoded set; nothing to surface.
    })
  }, [])
  return ready
}
