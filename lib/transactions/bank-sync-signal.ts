/**
 * Cross-component signal that a bank sync (or reconnect) just changed
 * `bank_connections` rows or imported new transactions.
 *
 * Several surfaces render bank-sync status from a client-side fetch on mount
 * (the transactions-page status chip, the "since last visit" pill, the banking
 * settings panel). Without a shared signal they show stale data until a hard
 * reload: e.g. a manual "Sync now" pulls fresh rows but the neighbouring chip
 * keeps showing the old "synced 2d ago" until the page is reloaded.
 *
 * Sync entry points call `notifyBankSyncUpdated()` on success; status surfaces
 * subscribe with `onBankSyncUpdated()` and refetch. This is a browser-only
 * CustomEvent, so it is a no-op during SSR.
 */
export const BANK_SYNC_UPDATED_EVENT = 'gnubok:bank-sync-updated'

export function notifyBankSyncUpdated(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(BANK_SYNC_UPDATED_EVENT))
}

export function onBankSyncUpdated(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(BANK_SYNC_UPDATED_EVENT, handler)
  return () => window.removeEventListener(BANK_SYNC_UPDATED_EVENT, handler)
}
