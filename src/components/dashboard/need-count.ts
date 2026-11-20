'use client'

import { createContext, useEffect, useSyncExternalStore } from 'react'

/**
 * Behöver dig's count for the sidebar row: the number of things Hem counts
 * (countThings over the page's rows, the figure in "Visa alla N som lista"),
 * not a second count of its own. The rows are built by the Att göra page in
 * the browser, so the page publishes the number and the sidebar shows what
 * was last published for the company. It is kept for the browser session,
 * so the row keeps its count on the area's other pages (Rutin) and across a
 * reload; before the page has been seen in a session the row shows none.
 */
const STORAGE_PREFIX = 'accounted:need-count:'
const counts = new Map<string, number>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function read(companyId: string): number | null {
  const known = counts.get(companyId)
  if (known !== undefined) return known
  try {
    const stored = window.sessionStorage.getItem(STORAGE_PREFIX + companyId)
    const parsed = stored === null ? NaN : Number(stored)
    if (Number.isFinite(parsed)) {
      counts.set(companyId, parsed)
      return parsed
    }
  } catch {
    // Storage may be blocked: the count then lives for the page only.
  }
  return null
}

/** Publish the count the Att göra page shows for this company. */
export function publishNeedCount(companyId: string, count: number): void {
  const value = Math.max(0, Math.floor(count))
  if (counts.get(companyId) === value) return
  counts.set(companyId, value)
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + companyId, String(value))
  } catch {
    // See read().
  }
  for (const listener of listeners) listener()
}

/** The Att göra page: publish its count once its rows have loaded (`count` null while loading). */
export function usePublishNeedCount(companyId: string | null | undefined, count: number | null): void {
  useEffect(() => {
    if (companyId && count !== null) publishNeedCount(companyId, count)
  }, [companyId, count])
}

/** The last count published for the company; null when none is known yet. */
export function useNeedCount(companyId: string | null | undefined): number | null {
  return useSyncExternalStore(
    subscribe,
    () => (companyId ? read(companyId) : null),
    () => null,
  )
}

/**
 * True while Hem's top bar holds the page's one filled button (Börja): a
 * block drawn inside the page (the Kom igång steps) then keeps its own
 * actions outline, so one filled button is in view.
 */
export const HemPrimaryTaken = createContext(false)

/**
 * Börja: where a step's table (StepItems, loaded with the step) tells the
 * step what it read, so the step's fields can say the earliest date and the
 * sum. Null outside a step.
 */
export const StepSummarySink = createContext<((summary: { earliest: string | null; sum: { value: number; currency: string | null } | null }) => void) | null>(null)
