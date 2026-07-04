'use client'

import { useEffect } from 'react'
import { useCompany } from '@/contexts/CompanyContext'

/**
 * CompanyTabSync: cross-tab active company enforcement.
 *
 * Mounted once inside the dashboard layout (via CompanyProvider), this
 * component guarantees that every open tab of the same user always shows
 * the same active company. It has three layers:
 *
 *   1. BroadcastChannel('gnubok-company-switch')
 *      When the user switches company in one tab, every other live tab
 *      receives the message and hard-reloads if its current company differs
 *      from the broadcasted one.
 *
 *   2. visibilitychange
 *      Catches tabs that were hidden/minimized during a switch. On focus,
 *      the tab checks /api/company/current and reloads on mismatch, before
 *      any pixel of stale data is painted to the user.
 *
 *   3. pageshow with event.persisted === true
 *      Catches tabs restored from the browser's bfcache (back/forward
 *      navigation). bfcache literally freezes the DOM and JS state, so
 *      neither BroadcastChannel nor visibilitychange fires. pageshow is the
 *      only reliable signal and is guaranteed to fire on bfcache restore.
 *
 * All three layers converge on the same action: window.location.assign('/'),
 * a hard navigation that wipes React state, the router cache, in-flight
 * requests, blob URLs, and every other in-tab leak vector.
 *
 * No-op when the user has no active company (renders nothing, attaches no
 * listeners).
 */
export default function CompanyTabSync() {
  const { company } = useCompany()
  const currentCompanyId = company?.id ?? null

  useEffect(() => {
    const hardReload = () => {
      window.location.assign('/')
    }

    // Layer 1: BroadcastChannel: live cross-tab sync
    let channel: BroadcastChannel | null = null
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('gnubok-company-switch')
      channel.onmessage = (event: MessageEvent<{ companyId: string | null }>) => {
        const incomingId = event.data?.companyId ?? null
        if (incomingId !== currentCompanyId) {
          hardReload()
        }
      }
    }

    // Layer 2: visibilitychange: on focus, verify against server
    const checkServer = async () => {
      try {
        const res = await fetch('/api/company/current', {
          cache: 'no-store',
          credentials: 'same-origin',
        })
        if (!res.ok) return
        const data = (await res.json()) as { companyId: string | null }
        if (data.companyId !== currentCompanyId) {
          hardReload()
        }
      } catch {
        // Network error / offline: do nothing (don't accidentally reload-loop)
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkServer()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    // Layer 3: pageshow (persisted === true): bfcache restore
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        void checkServer()
      }
    }
    window.addEventListener('pageshow', handlePageShow)

    return () => {
      channel?.close()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pageshow', handlePageShow)
    }
  }, [currentCompanyId])

  return null
}
