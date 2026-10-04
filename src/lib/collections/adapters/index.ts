import { collectionsConnectorMode } from '@/lib/connect/instance/upstreams'
import { getRegisteredCollectionsAdapter, registerCollectionsAdapter, resolveCollectionsAdapter } from '../registry'
import type { CollectionsAdapter, CollectionsRoute } from '../port'
import { createConnectorCollectionsAdapter } from './connector'
import { createFakeCollectionsAdapter } from './fake'

/**
 * Register the collections adapters this installation can run: the fake
 * always (sandbox companies and local development use it), the Connect
 * adapter when a connector key is configured (collectionsConnectorMode()).
 * Idempotent; an adapter registered earlier (a test's) is kept.
 */
export function ensureCollectionsAdapters(): void {
  if (!getRegisteredCollectionsAdapter('fake')) registerCollectionsAdapter(createFakeCollectionsAdapter())
  if (!getRegisteredCollectionsAdapter('connect')) {
    const upstream = collectionsConnectorMode()
    if (upstream) registerCollectionsAdapter(createConnectorCollectionsAdapter(upstream))
  }
}

/** ensureCollectionsAdapters() + resolveCollectionsAdapter(): what callers use. */
export function collectionsAdapterFor(connection: { route: CollectionsRoute }): CollectionsAdapter | null {
  ensureCollectionsAdapters()
  return resolveCollectionsAdapter(connection)
}
