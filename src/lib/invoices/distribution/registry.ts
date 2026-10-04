import type { CollectionsRoute } from '@/lib/collections/port'
import type { DeliveryAdapter } from './port'

/**
 * Which delivery adapter serves a company: the one whose route equals the
 * company's collections connection row (delivery shares the connection and
 * the paid capability with collections). Same rules as
 * lib/collections/registry.ts: explicit registration, no fallback from
 * 'connect' to the fake.
 */

const adapters = new Map<CollectionsRoute, DeliveryAdapter>()

export function registerDeliveryAdapter(adapter: DeliveryAdapter): void {
  adapters.set(adapter.route, adapter)
}

export function getRegisteredDeliveryAdapter(route: CollectionsRoute): DeliveryAdapter | null {
  return adapters.get(route) ?? null
}

export function resolveDeliveryAdapter(connection: { route: CollectionsRoute }): DeliveryAdapter | null {
  return getRegisteredDeliveryAdapter(connection.route)
}

/** Test seam: forget every registered adapter. */
export function __resetDeliveryAdaptersForTests(): void {
  adapters.clear()
}
