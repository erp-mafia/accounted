import type { CollectionsAdapter, CollectionsRoute } from './port'

/**
 * Which collections adapter serves a company: the one whose route equals the
 * company's connection row (`collection_connections.route`), set once when
 * the row is created (chooseCollectionsRoute). Never a company-wide or
 * installation-wide switch, so a sandbox company on the fake and a real
 * company on Connect can live side by side.
 *
 * Registration is explicit (adapters/index.ts ensureCollectionsAdapters): the
 * fake is always available, the Connect adapter only when this installation
 * has a connector key. A 'connect' row on an installation without one
 * resolves to null and the capability reports itself unavailable; it never
 * falls back to the fake.
 */

const adapters = new Map<CollectionsRoute, CollectionsAdapter>()

export function registerCollectionsAdapter(adapter: CollectionsAdapter): void {
  adapters.set(adapter.route, adapter)
}

export function getRegisteredCollectionsAdapter(route: CollectionsRoute): CollectionsAdapter | null {
  return adapters.get(route) ?? null
}

/** The adapter for a connection row, or null when its route has none on this installation. */
export function resolveCollectionsAdapter(connection: { route: CollectionsRoute }): CollectionsAdapter | null {
  return getRegisteredCollectionsAdapter(connection.route)
}

/**
 * The route a NEW connection row gets. 'fake' for a sandbox company (it must
 * never reach a real provider) and for local development that asked for it
 * (COLLECTIONS_FAKE_ADAPTER=1, never in production); 'connect' otherwise.
 * The value is stored on the row and never re-decided.
 */
export function chooseCollectionsRoute(input: { sandbox: boolean; fakeAdapterRequested: boolean }): CollectionsRoute {
  return input.sandbox || input.fakeAdapterRequested ? 'fake' : 'connect'
}

/** Test seam: forget every registered adapter. */
export function __resetCollectionsAdaptersForTests(): void {
  adapters.clear()
}
