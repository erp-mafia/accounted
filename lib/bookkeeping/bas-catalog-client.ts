'use client'

import type { SearchableAccount } from '@/lib/bookkeeping/account-search'

/**
 * Client-side loader for the full BAS catalogue used by AccountCombobox.
 *
 * The catalogue is static reference data, identical for every company, so we
 * fetch it once per session and share the in-flight promise across every
 * combobox instance and form mount. A failed fetch clears the cache so the
 * next caller retries rather than being stuck with an empty list.
 */
export interface CatalogAccount extends SearchableAccount {
  account_number: string
  account_name: string
  account_class: number
  account_group: string
  description: string | null
}

let cache: Promise<CatalogAccount[]> | null = null

export function loadBasCatalog(): Promise<CatalogAccount[]> {
  if (!cache) {
    cache = fetch('/api/bookkeeping/accounts/bas-catalog')
      .then((res) => {
        if (!res.ok) throw new Error(`bas-catalog ${res.status}`)
        return res.json()
      })
      .then((body) => (body?.data as CatalogAccount[]) ?? [])
      .catch(() => {
        cache = null // allow a retry on the next call
        return []
      })
  }
  return cache
}
