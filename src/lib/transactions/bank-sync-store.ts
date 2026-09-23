/**
 * Module-level store for on-demand bank sync state, shared by every
 * `useBankSync()` instance via `useSyncExternalStore`.
 *
 * Two surfaces on the transactions page trigger syncs independently: the
 * "Synka bank nu" row in the Importera split button (TransactionStatusBar)
 * and the footer "Synka nu" button (BankSyncNowButton). With hook-local
 * state, a sync started from one surface left the other enabled and
 * spinner-less, so a second concurrent sync of the same connection could be
 * started (#1162). Hoisting the state here makes busy/connections identical
 * across all instances, and lets the first mounted instance's fetch serve
 * the rest (no duplicate `bank_connections` query per surface).
 *
 * Pure state + pub/sub only: the Supabase fetch stays in the hook so this
 * module is trivially unit-testable.
 */

export interface BankConn {
  id: string
  bank_name: string
  status: string
  provider: string
  last_synced_at: string | null
}

export interface BankSyncState {
  /** null until the first load for `companyId` has completed */
  connections: BankConn[] | null
  /** company the loaded connections belong to */
  companyId: string | null
  /** id of the connection currently syncing or reconnecting */
  busyId: string | null
  /** true across a whole "sync everything" run, including between connections */
  syncingAll: boolean
}

const INITIAL_STATE: BankSyncState = {
  connections: null,
  companyId: null,
  busyId: null,
  syncingAll: false,
}

let state: BankSyncState = INITIAL_STATE
let loadingCompanyId: string | null = null
const listeners = new Set<() => void>()

function emit(next: BankSyncState): void {
  state = next
  for (const listener of listeners) listener()
}

export function subscribeBankSync(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Stable-identity snapshot: only replaced when something actually changed. */
export function getBankSyncSnapshot(): BankSyncState {
  return state
}

/**
 * Claim the connections fetch for a company. Returns true when the caller
 * should run the query (first instance to mount, or a retry after a failed
 * load); false when the list is already loaded for that company or another
 * instance's fetch is in flight.
 */
export function claimConnectionsLoad(companyId: string): boolean {
  if (state.companyId === companyId && state.connections !== null) return false
  if (loadingCompanyId === companyId) return false
  loadingCompanyId = companyId
  return true
}

export function publishConnections(companyId: string, connections: BankConn[]): void {
  // Only the fetch that still owns the load claim may publish. A resolve
  // arriving after the active company switched (and re-claimed the slot)
  // would otherwise clobber the newer company's list with stale data.
  if (loadingCompanyId !== companyId) return
  loadingCompanyId = null
  emit({ ...state, companyId, connections })
}

/** Fetch failed: release the claim so a later mount can retry. */
export function releaseConnectionsLoad(companyId: string): void {
  if (loadingCompanyId === companyId) loadingCompanyId = null
}

export function setBusyConnection(connectionId: string | null): void {
  if (state.busyId === connectionId) return
  emit({ ...state, busyId: connectionId })
}

/** Clear busy only if this connection still owns it (mirrors the old
 *  `setBusyId(prev => prev === id ? null : prev)` guard). */
export function clearBusyConnection(connectionId: string): void {
  if (state.busyId !== connectionId) return
  emit({ ...state, busyId: null })
}

export function setSyncingAll(syncingAll: boolean): void {
  if (state.syncingAll === syncingAll) return
  emit({ ...state, syncingAll })
}

/** Reflect a status change (e.g. a sync hit a dead PSD2 session) on every
 *  surface at once. */
export function markConnectionStatus(connectionId: string, status: string): void {
  if (!state.connections) return
  emit({
    ...state,
    connections: state.connections.map((c) =>
      c.id === connectionId ? { ...c, status } : c,
    ),
  })
}

/** Reset to the initial state (tests, sign-out). */
export function resetBankSyncStore(): void {
  loadingCompanyId = null
  emit(INITIAL_STATE)
}
