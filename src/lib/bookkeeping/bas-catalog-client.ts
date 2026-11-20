'use client'

import type { SearchableAccount } from '@/lib/bookkeeping/account-search'
import { isAccountNumber } from '@/lib/invariants/account-number'

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
      .catch((err) => {
        // Callers degrade gracefully (search falls back to the active chart),
        // so this log is the only trace a catalog fetch failure leaves.
        console.error('[bas-catalog] fetch failed:', err)
        cache = null // allow a retry on the next call
        return []
      })
  }
  return cache
}

/**
 * Whether an account the person picked in a kontoväljare is one its host
 * activates before booking: a BAS catalogue account the active chart does
 * not hold, which the picker listed as activated at booking ("Aktiveras vid
 * bokföring"). A number outside the catalogue is not: the booking's own
 * refusal says what to do with it.
 */
export function pickNeedsActivation(
  accountNumber: string,
  activeChart: readonly { account_number: string; is_active?: boolean | null }[],
  catalog: readonly { account_number: string }[],
): boolean {
  return (
    !activeChart.some((a) => a.account_number === accountNumber && a.is_active !== false) &&
    catalog.some((a) => a.account_number === accountNumber)
  )
}

/**
 * Activate the BAS accounts a booking is about to post to that are not active
 * in the chart: added from the BAS reference when the chart lacks them,
 * reactivated when the company deactivated them. Only for an account the
 * person picked from a list that said it would be activated at booking
 * (pickNeedsActivation), in front of a booking path that takes only active
 * accounts (the categorize route's account override): the pick is the
 * person's explicit choice, as the activation confirm is in
 * JournalEntryForm. Never for an account a proposal brought (the
 * assistant's, the one a review opened with): the booking refuses it and
 * offers "Aktivera och bokför", so an account the company deactivated on
 * purpose is not switched back on unasked. `chart` is the whole chart,
 * inactive accounts included. Never throws: an account that could not be
 * activated stays as it was and the booking's own refusal says why.
 * Resolves to the numbers activated.
 */
export async function activateBasAccounts(
  accountNumbers: readonly string[],
  chart: readonly { account_number: string; is_active?: boolean | null }[],
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<string[]> {
  const active = new Set(chart.filter((a) => a.is_active !== false).map((a) => a.account_number))
  const needed = [...new Set(accountNumbers)].filter((n) => isAccountNumber(n) && !active.has(n))
  if (needed.length === 0) return []
  try {
    // The activate route inserts what the chart lacks from the BAS reference
    // and reactivates what is there but inactive; a number outside BAS comes
    // back as unknown, not activated.
    const res = await fetchImpl('/api/bookkeeping/accounts/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_numbers: needed }),
    })
    if (!res.ok) return []
    const body = (await res.json().catch(() => null)) as { data?: { account_number?: string }[] } | null
    return (body?.data ?? []).map((a) => a.account_number).filter((n): n is string => typeof n === 'string')
  } catch {
    return []
  }
}
