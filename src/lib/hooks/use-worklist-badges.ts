'use client'

import { useCallback } from 'react'
import useSWR, { mutate as globalMutate, type SWRConfiguration } from 'swr'

export interface WorklistBadges {
  /**
   * Agent-staged operations awaiting review, the Agentförslag row: the Att
   * göra predicate (lib/worklist countPendingOperations), so the daily
   * batches and system suggestions, rows of their own, are left out.
   */
  pendingOperations: number
  /**
   * Documents waiting in Inkorg, the Inkorg row: the Att göra predicate
   * (countInboxDocuments with the pairing read), so a receipt riding on its
   * invoice is one item, as on the page.
   */
  inbox: number
}

const BADGES_KEY = 'worklist-badges'

/** A return to the tab or a navigation re-reads the counts only when the last answer is this old. */
export const BADGES_STALE_MS = 15_000
/** Backstop while the tab stays visible; a hidden tab never polls. */
export const BADGES_REFRESH_MS = 60_000
/** Trailing debounce for refreshWorklistBadges: a bulk booking or bank sync emits one event per row. */
export const BADGES_BURST_MS = 400

/**
 * The badges used to be kept live by three Supabase Realtime subscriptions
 * per open tab (transactions, skattekonto_transactions, pending_operations).
 * Every open dashboard tab, visible or not, kept the Realtime WAL poller
 * running and added an RLS check per published change; that poll was the
 * single biggest database consumer. Three head-count queries when the tab
 * is looked at cost a fraction of that. The list pages that do hold a live
 * channel (Transaktioner, Granskning) call refreshWorklistBadges() from it,
 * so the badge still follows changes instantly where the user is working.
 */
export const WORKLIST_BADGES_SWR_OPTIONS = {
  // SWR's focus event covers both window focus and the tab becoming visible.
  revalidateOnFocus: true,
  focusThrottleInterval: BADGES_STALE_MS,
  revalidateOnReconnect: true,
  dedupingInterval: BADGES_STALE_MS,
  refreshInterval: BADGES_REFRESH_MS,
  refreshWhenHidden: false,
  refreshWhenOffline: false,
  // Never blank a badge while a refresh is in flight.
  keepPreviousData: true,
} satisfies SWRConfiguration

function isBadgesKey(key: unknown): boolean {
  return Array.isArray(key) && key[0] === BADGES_KEY
}

let burst: ReturnType<typeof setTimeout> | null = null

/**
 * Re-read the nav badge counts (bypasses the dedupe window) once a burst of
 * calls has gone quiet for BADGES_BURST_MS, so a bulk change of 500 rows is
 * one refresh, not 500. Called by the list pages whose own realtime channel
 * saw a change that moves a count. Client-only: it touches the SWR cache.
 */
export function refreshWorklistBadges(): void {
  if (burst) clearTimeout(burst)
  burst = setTimeout(() => {
    burst = null
    void globalMutate(isBadgesKey)
  }, BADGES_BURST_MS)
}

const lastFetchedAt = new Map<string, number>()

/**
 * Whether a navigation should re-read: the last answer is at least
 * BADGES_STALE_MS old. Never fetched means SWR's own mount fetch is on its
 * way, so a nudge then would only double it.
 */
export function badgesAreStale(lastAt: number | undefined, now: number): boolean {
  return lastAt !== undefined && now - lastAt >= BADGES_STALE_MS
}

/**
 * Client-side nav badge counts (Stil v3: Agentförslag and Inkorg only). They
 * load after mount from /api/worklist/badges, which runs the same predicates
 * as Att göra so the menu and the home page never disagree, and refresh on
 * return to the tab, on navigation (when stale), on a 60 s backstop while
 * visible, and on demand from the live list pages.
 */
export function useWorklistBadges(companyId: string | null | undefined) {
  const { data, mutate } = useSWR<WorklistBadges>(
    companyId ? [BADGES_KEY, companyId] : null,
    async ([, id]: [string, string]) => {
      const res = await fetch('/api/worklist/badges')
      lastFetchedAt.set(id, Date.now())
      // A failed read keeps the last counts (keepPreviousData) rather than
      // blanking the menu; SWR retries on the next trigger.
      if (!res.ok) throw new Error(`worklist badges ${res.status}`)
      const body = (await res.json()) as { data: { pending_operations: number; inbox: number } }
      return { pendingOperations: body.data.pending_operations, inbox: body.data.inbox }
    },
    WORKLIST_BADGES_SWR_OPTIONS,
  )

  // Navigation: re-read only when the counts are older than the stale
  // window, so moving between pages does not fire three queries per click.
  const nudge = useCallback(() => {
    if (!companyId) return
    if (badgesAreStale(lastFetchedAt.get(companyId), Date.now())) void mutate()
  }, [companyId, mutate])

  return {
    pendingOperations: data?.pendingOperations ?? 0,
    inbox: data?.inbox ?? 0,
    // SWR's bound mutate is referentially stable, so consumers can list it in
    // effect deps without re-subscribing on every render.
    refresh: mutate,
    nudge,
  }
}
