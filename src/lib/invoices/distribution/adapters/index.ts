import { deliveryConnectorMode } from '@/lib/connect/instance/upstreams'
import type { CollectionsRoute } from '@/lib/collections/port'
import type { DeliveryAdapter } from '../port'
import { getRegisteredDeliveryAdapter, registerDeliveryAdapter, resolveDeliveryAdapter } from '../registry'
import { createConnectorDeliveryAdapter } from './connector'
import { createFakeDeliveryAdapter } from './fake'

/**
 * Register the delivery adapters this installation can run: the fake always,
 * the Connect adapter when a connector key is configured. Idempotent.
 */
export function ensureDeliveryAdapters(): void {
  if (!getRegisteredDeliveryAdapter('fake')) registerDeliveryAdapter(createFakeDeliveryAdapter())
  if (!getRegisteredDeliveryAdapter('connect')) {
    const upstream = deliveryConnectorMode()
    if (upstream) registerDeliveryAdapter(createConnectorDeliveryAdapter(upstream))
  }
}

/** ensureDeliveryAdapters() + resolveDeliveryAdapter(): what callers use. */
export function deliveryAdapterFor(connection: { route: CollectionsRoute }): DeliveryAdapter | null {
  ensureDeliveryAdapters()
  return resolveDeliveryAdapter(connection)
}
