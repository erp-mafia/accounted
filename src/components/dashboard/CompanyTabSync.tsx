'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { useCompany } from '@/contexts/CompanyContext'
import {
  TAB_SYNC_CHANNEL,
  TAB_SYNC_STORAGE_KEY,
  ACTIVE_COMPANY_HEADER,
  ACTIVE_COMPANY_VERIFY_DELAY_MS,
  COMPANY_CURRENT_PATH,
  companyObservedFromResponse,
  decodeStorageValue,
  isSameOriginApiUrl,
  guardStore,
  isTabMismatch,
  requestHasNextActionHeader,
  shouldBlockMutation,
  withTabCompanyHeader,
} from '@/lib/company/tab-guard'

/**
 * CompanyTabSync: the cross-tab active-company TAB GUARD (WL-09).
 *
 * The active company is one user_preferences row per user shared across
 * every tab, so a switch in one tab silently re-anchors every other tab's
 * writes to the new company. Each tab remembers the company it is rendering
 * (server-rendered active company at mount). Three detection layers:
 *
 *   1. BroadcastChannel('gnubok-company-switch'): live cross-tab signal;
 *      the switch action (lib/company/switch-client) broadcasts.
 *   2. `storage` events on the gnubok-active-company key: fallback where
 *      BroadcastChannel is unavailable; the switch action writes the key.
 *   3. visibilitychange + pageshow(persisted): tabs hidden/bfcache-frozen
 *      during the switch verify against /api/company/current on focus.
 *   4. Every /api answer names the company the server acted on
 *      (ACTIVE_COMPANY_HEADER): a tab that stayed visible while the company
 *      was switched somewhere it cannot hear (another device, profile or
 *      session) verifies against /api/company/current after a short wait.
 *
 * On mismatch the tab BLOCKS with a dialog whose only exits are switching
 * back to this tab's company or reloading as the new one. Deliberately no
 * continue-anyway: continuing would post into the wrong company's books
 * (WL-09 resolution; this is not the soft-guard pattern).
 *
 * Mutations are guarded too: window.fetch is wrapped while mounted, and a
 * mutating same-origin request from a tab that KNOWS the active company
 * changed is refused with a synthetic 409 before it leaves the tab (covers
 * autosaves and other background writes racing the dialog). Two shapes:
 *
 *   - /api requests get the canonical JSON error envelope. The sanctioned
 *     company switch (POST /api/company/switch while
 *     guardStore.companySwitchInFlight) passes through: it is both dialog
 *     exits.
 *   - server-action POSTs (identified by the `next-action` header; verified
 *     to pass through the patched window.fetch on next@16.2.12) get a
 *     text/plain 409, which the flight client surfaces as the thrown action
 *     error.
 *
 * Browser-direct Supabase calls go to the Supabase origin and stay outside
 * this seam; their write sites call guardBrowserWrite() (lib/company/
 * tab-guard.ts), which consults the same guardStore.
 *
 * No-op when the user has no active company.
 */

// Guard state is the shared guardStore in lib/company/tab-guard.ts so
// browser-direct write sites can consult the same belief. Single dashboard
// shell = single writer (this component).

/** The blocking dialog, loaded when it is first raised: no page renders it with its first view. */
const CompanyTabDialog = dynamic(() => import('./CompanyTabDialog'), { ssr: false })

let originalFetch: typeof window.fetch | null = null

function installFetchGuard(): void {
  if (typeof window === 'undefined' || originalFetch) return
  originalFetch = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const method =
      init?.method ?? (input instanceof Request ? input.method : undefined)
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const isServerAction = requestHasNextActionHeader(input, init)
    if (
      shouldBlockMutation({
        method,
        url,
        pageOrigin: window.location.origin,
        tabCompanyId: guardStore.tabCompanyId,
        observedCompanyId: guardStore.observedCompanyId,
        isServerAction,
        companySwitchInFlight: guardStore.companySwitchInFlight,
      })
    ) {
      guardStore.notifyBlocked?.()
      if (isServerAction) {
        // The flight client treats a non-RSC response as a failed action and
        // surfaces a text/plain >=400 body as the thrown error's message.
        return Promise.resolve(
          new Response('Aktivt företag har bytts i en annan flik.', {
            status: 409,
            headers: { 'Content-Type': 'text/plain' },
          }),
        )
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: 'ACTIVE_COMPANY_CHANGED',
              message: 'Aktivt företag har bytts i en annan flik.',
              message_en: 'The active company was switched in another tab.',
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }
    const pageOrigin = window.location.origin
    const labelled = withTabCompanyHeader(input, init, {
      tabCompanyId: guardStore.tabCompanyId,
      pageOrigin,
    })
    return originalFetch!(labelled.input as RequestInfo, labelled.init).then((response) => {
      // The server names the company it acted on. A tab that shows another one
      // learns it from the first answer, whichever device made the switch, and
      // then asks the server (after a wait, see ACTIVE_COMPANY_VERIFY_DELAY_MS).
      // The server has already refused a write for the wrong company.
      if (isSameOriginApiUrl(url, pageOrigin) && new URL(url, pageOrigin).pathname !== COMPANY_CURRENT_PATH) {
        const observed = companyObservedFromResponse({
          responseCompanyId: response.headers.get(ACTIVE_COMPANY_HEADER),
          tabCompanyId: guardStore.tabCompanyId,
          companySwitchInFlight: guardStore.companySwitchInFlight,
          selfSwitchTargetId: guardStore.selfSwitchTargetId,
        })
        if (observed) guardStore.verifyActiveCompany?.()
      }
      return response
    })
  }) as typeof window.fetch
}

function uninstallFetchGuard(): void {
  if (typeof window === 'undefined' || !originalFetch) return
  window.fetch = originalFetch
  originalFetch = null
}

export default function CompanyTabSync() {
  const { company } = useCompany()
  const companyId = company?.id ?? null
  // Keyed by the company: a tab that renders another company starts over,
  // with nothing raised and nothing observed.
  return companyId ? <TabGuard key={companyId} currentCompanyId={companyId} /> : null
}

function TabGuard({ currentCompanyId }: { currentCompanyId: string }) {
  // Set while the blocking dialog is up. It carries the company the session
  // has active now, so the dialog can name it: the choice between "switch
  // back" and "reload as the new one" is only obvious when both sides are
  // named. Read from the guard store at the moment the dialog is raised (both
  // the observe path and the blocked-write path set observedCompanyId first).
  const [raised, setRaised] = useState<{ observedCompanyId: string | null } | null>(null)

  useEffect(() => {
    guardStore.tabCompanyId = currentCompanyId
    guardStore.observedCompanyId = null
    guardStore.notifyBlocked = () => {
      // A self-initiated switch is hard-navigating this tab away: blocked
      // stray writes still get their 409, but the "switched in another tab"
      // dialog would just flash over the tab's own page load.
      if (!guardStore.selfSwitchTargetId) {
        setRaised({ observedCompanyId: guardStore.observedCompanyId })
      }
    }
    installFetchGuard()

    const observe = (observedId: string | null | undefined) => {
      if (observedId === null || observedId === undefined) return
      guardStore.observedCompanyId = observedId
      if (observedId === guardStore.selfSwitchTargetId) return
      if (isTabMismatch(currentCompanyId, observedId)) {
        setRaised({ observedCompanyId: observedId })
      }
    }

    // Layer 1: BroadcastChannel: live cross-tab sync
    let channel: BroadcastChannel | null = null
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(TAB_SYNC_CHANNEL)
      channel.onmessage = (event: MessageEvent<{ companyId: string | null }>) => {
        observe(event.data?.companyId ?? null)
      }
    }

    // Layer 1b: storage-event fallback (fires in every OTHER tab)
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== TAB_SYNC_STORAGE_KEY) return
      observe(decodeStorageValue(event.newValue))
    }
    window.addEventListener('storage', handleStorage)

    // Layer 2: on focus, verify against the server
    const checkServer = async () => {
      try {
        const res = await fetch('/api/company/current', {
          cache: 'no-store',
          credentials: 'same-origin',
        })
        if (!res.ok) return
        const data = (await res.json()) as { companyId: string | null }
        observe(data.companyId)
      } catch {
        // Network error / offline: do nothing (don't false-positive the guard)
      }
    }

    // Layer 2b: an answer named another company than this tab shows. One
    // question to the server after the wait, however many answers said so.
    let verifyTimer: number | null = null
    guardStore.verifyActiveCompany = () => {
      if (verifyTimer !== null) return
      verifyTimer = window.setTimeout(() => {
        verifyTimer = null
        void checkServer()
      }, ACTIVE_COMPANY_VERIFY_DELAY_MS)
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
        // A bfcache-restored page renders the OLD company after this tab's
        // own switch (back-navigation): the self-switch marker must not keep
        // suppressing the dialog here.
        guardStore.selfSwitchTargetId = null
        void checkServer()
      }
    }
    window.addEventListener('pageshow', handlePageShow)

    return () => {
      channel?.close()
      window.removeEventListener('storage', handleStorage)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pageshow', handlePageShow)
      guardStore.tabCompanyId = null
      guardStore.observedCompanyId = null
      guardStore.notifyBlocked = null
      guardStore.selfSwitchTargetId = null
      guardStore.verifyActiveCompany = null
      if (verifyTimer !== null) window.clearTimeout(verifyTimer)
      uninstallFetchGuard()
    }
  }, [currentCompanyId])

  if (!raised) return null
  return <CompanyTabDialog currentCompanyId={currentCompanyId} observedCompanyId={raised.observedCompanyId} />
}
