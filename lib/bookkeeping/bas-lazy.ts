/**
 * Lazily loaded BAS chart for client code.
 *
 * The full chart (lib/bookkeeping/bas-data, ~1,276 accounts, 315 KB
 * uncompressed) used to be statically imported by lib/bookkeeping/
 * account-descriptions.ts and, through AccountCombobox and ui/account-number,
 * ended up in the shared client bundle of 81 dashboard routes. Here it is a
 * dynamic import: one code-split chunk, fetched once per session after first
 * paint, and only by surfaces that actually show BAS names or descriptions.
 *
 * Server code keeps importing bas-reference / bas-data statically.
 */

import type { BASReferenceAccount } from './bas-reference'

let loaded: BASReferenceAccount[] | null = null
let byNumber: Map<string, BASReferenceAccount> | null = null
let loading: Promise<BASReferenceAccount[]> | null = null
const listeners = new Set<() => void>()

/** Start (or join) the chunk load. Resolves with the full chart. */
export function ensureBasLoaded(): Promise<BASReferenceAccount[]> {
  if (loaded) return Promise.resolve(loaded)
  if (!loading) {
    loading = import('./bas-data')
      .then(({ BAS_REFERENCE }) => {
        loaded = BAS_REFERENCE
        byNumber = new Map(BAS_REFERENCE.map((a) => [a.account_number, a]))
        for (const listener of listeners) listener()
        return BAS_REFERENCE
      })
      .catch((err) => {
        loading = null
        throw err
      })
  }
  return loading
}

/** The chart if the chunk has arrived, else null (never blocks). */
export function getBasLoaded(): BASReferenceAccount[] | null {
  return loaded
}

export function getBasLoadedByNumber(accountNumber: string): BASReferenceAccount | undefined {
  return byNumber?.get(accountNumber)
}

export function isBasLoaded(): boolean {
  return loaded !== null
}

/** Subscribe to "the chunk arrived" (useSyncExternalStore contract). */
export function subscribeBasLoaded(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
