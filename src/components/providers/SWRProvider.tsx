'use client'

import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'

/**
 * Global SWR defaults: one shared client-side cache so repeated mounts of the
 * same data (company settings, nav badges, reference data) dedupe in-flight
 * requests and render instantly from cache on back-navigation, revalidating
 * in the background instead of re-showing skeletons on every visit.
 *
 * String keys are fetched as JSON from our own API routes; hooks that read
 * Supabase directly pass an array key with their own fetcher.
 */
export function SWRProvider({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        fetcher: async (key: string) => {
          const res = await fetch(key)
          if (!res.ok) throw new Error(`HTTP ${res.status} for ${key}`)
          return res.json()
        },
      }}
    >
      {children}
    </SWRConfig>
  )
}
