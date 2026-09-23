'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { performCompanySwitch } from '@/lib/company/switch-client'
import { Button } from '@/components/ui/button'
import {
  TAB_SYNC_CHANNEL,
  TAB_SYNC_STORAGE_KEY,
  decodeStorageValue,
  guardStore,
  isTabMismatch,
  requestHasNextActionHeader,
  resolveObservedCompanyName,
  shouldBlockMutation,
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
 *   - /api requests get the canonical JSON error envelope.
 *   - server-action POSTs (identified by the `next-action` header; verified
 *     to pass through the patched window.fetch on next@16.2.12) get a
 *     text/plain 409, which the flight client surfaces as the thrown action
 *     error. The sanctioned company-switch action passes through
 *     (guardStore.companySwitchInFlight): it is both dialog exits.
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
    return originalFetch!(input as RequestInfo, init)
  }) as typeof window.fetch
}

function uninstallFetchGuard(): void {
  if (typeof window === 'undefined' || !originalFetch) return
  window.fetch = originalFetch
  originalFetch = null
}

export default function CompanyTabSync() {
  const { company, companies, foreignCompanies } = useCompany()
  const t = useTranslations('company_tab_guard')
  const currentCompanyId = company?.id ?? null
  const [mismatch, setMismatch] = useState(false)
  // The company the other tab switched to, so the dialog can name it: the
  // choice between "switch back" and "reload as the new one" is only obvious
  // when both sides are named. Read from the guard store at the moment the
  // dialog is raised (both the observe path and the blocked-write path set
  // observedCompanyId first).
  const [observedCompanyId, setObservedCompanyId] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)

  useEffect(() => {
    if (!currentCompanyId) return

    guardStore.tabCompanyId = currentCompanyId
    guardStore.observedCompanyId = null
    guardStore.notifyBlocked = () => {
      // A self-initiated switch is hard-navigating this tab away: blocked
      // stray writes still get their 409, but the "switched in another tab"
      // dialog would just flash over the tab's own page load.
      if (!guardStore.selfSwitchTargetId) {
        setObservedCompanyId(guardStore.observedCompanyId)
        setMismatch(true)
      }
    }
    installFetchGuard()

    const observe = (observedId: string | null | undefined) => {
      if (observedId === null || observedId === undefined) return
      guardStore.observedCompanyId = observedId
      if (observedId === guardStore.selfSwitchTargetId) return
      if (isTabMismatch(currentCompanyId, observedId)) {
        setObservedCompanyId(observedId)
        setMismatch(true)
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
      uninstallFetchGuard()
    }
  }, [currentCompanyId])

  if (!mismatch || !currentCompanyId) return null

  const newCompanyName = resolveObservedCompanyName(
    observedCompanyId,
    companies,
    foreignCompanies ?? [],
  )

  const handleSwitchBack = async () => {
    setResolving(true)
    // Re-activate THIS tab's company and reload the page we are on (same
    // company, so its data is still valid). Other tabs get the broadcast and
    // face the same dialog: the hazard is symmetric by design.
    const result = await performCompanySwitch(currentCompanyId, {
      destination: window.location.pathname + window.location.search,
    })
    if (result?.error) {
      // Membership lost or persist failure: this tab cannot win the company
      // back, so the only safe exit left is loading the new company.
      window.location.assign('/')
    }
  }

  const handleReloadAsNew = () => {
    setResolving(true)
    // Land on the start page: the current path may not exist (or worse, mean
    // another object) under the new company.
    window.location.assign('/')
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="company-tab-guard-title"
    >
      {/* Veil: deliberately no click-to-close and no Esc: the dialog is
          blocking, its two buttons are the only exits (WL-09). */}
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" aria-hidden="true" />
      <div className="relative w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg">
        <h2 id="company-tab-guard-title" className="font-display text-lg leading-6">
          {t('title')}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {newCompanyName
            ? t('body_named', { company: company?.name ?? '', newCompany: newCompanyName })
            : t('body', { company: company?.name ?? '' })}
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            disabled={resolving}
            onClick={handleReloadAsNew}
          >
            {newCompanyName
              ? t('reload_as_named', { newCompany: newCompanyName })
              : t('reload_as_new')}
          </Button>
          <Button disabled={resolving} onClick={() => void handleSwitchBack()}>
            {t('switch_back', { company: company?.name ?? '' })}
          </Button>
        </div>
      </div>
    </div>
  )
}
