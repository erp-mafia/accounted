'use client'

import { useEffect, useSyncExternalStore } from 'react'

/**
 * A page whose URL sits under one sidebar row while its content belongs to
 * another names the row it belongs to: the invoice editor at /invoices/new
 * or /invoices/[id]/edit editing an offert claims Offerter, so the sidebar
 * follows the document type (also when it changes in the title's dropdown)
 * instead of the URL. DashboardNav lights the claimed row.
 *
 * One claim at a time, tied to the pathname it was made on, so a claim can
 * never outlive its page even if a cleanup is missed.
 */
interface NavRowClaim {
  pathname: string
  href: string
}

let current: NavRowClaim | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function publish(next: NavRowClaim | null) {
  current = next
  for (const listener of listeners) listener()
}

/** Claim the sidebar row `href` while mounted on `pathname`; null claims nothing. */
export function useClaimNavRow(pathname: string, href: string | null): void {
  useEffect(() => {
    if (!href) return
    const claim = { pathname, href }
    publish(claim)
    return () => {
      if (current === claim) publish(null)
    }
  }, [pathname, href])
}

/** The row claimed on `pathname`, or null when the URL decides. */
export function useNavRowClaim(pathname: string): string | null {
  const claim = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
  return claim && claim.pathname === pathname ? claim.href : null
}
