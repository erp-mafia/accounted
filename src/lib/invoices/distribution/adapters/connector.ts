import { DELIVERY_OPERATIONS, type DeliveryOperation } from '@accounted/connect-contract'
import { callConnectorOperation, ConnectorCallError } from '@/lib/connect/instance/connector-fetch'
import type { ConnectorUpstream } from '@/lib/connect/instance/upstreams'
import { CollectionsError } from '@/lib/collections/errors'
import type { CollectionsCallContext } from '@/lib/collections/port'
import type { DeliveryAdapter } from '../port'

/**
 * The delivery adapter that talks to Accounted Connect
 * (`/api/connect/delivery/*`), with the same headers, validation and error
 * mapping as the collections Connect adapter.
 *
 * Connect gives `send` 120 s (it registers, uploads and dispatches, each step
 * resumable), so the ledger waits 130 s for it and 30 s for the rest. A
 * timeout leaves the delivery row reserved and is retried with the same key.
 */
export const DELIVERY_SEND_TIMEOUT_MS = 130_000
export const DELIVERY_DEFAULT_TIMEOUT_MS = 30_000

export function deliveryTimeoutMs(operation: DeliveryOperation): number {
  return operation === 'send' ? DELIVERY_SEND_TIMEOUT_MS : DELIVERY_DEFAULT_TIMEOUT_MS
}

export interface ConnectorDeliveryAdapterDeps {
  fetch?: typeof fetch
  timeoutMs?: (operation: DeliveryOperation) => number
}

export function createConnectorDeliveryAdapter(
  upstream: ConnectorUpstream,
  deps: ConnectorDeliveryAdapterDeps = {},
): DeliveryAdapter {
  const timeoutFor = deps.timeoutMs ?? deliveryTimeoutMs

  async function call<O extends DeliveryOperation>(operation: O, ctx: CollectionsCallContext, body: unknown) {
    try {
      return await callConnectorOperation({
        upstream,
        operation: `delivery.${operation}`,
        def: DELIVERY_OPERATIONS[operation],
        body,
        companyId: ctx.companyId,
        connectionHandle: ctx.connectionHandle,
        timeoutMs: timeoutFor(operation),
        fetch: deps.fetch,
      })
    } catch (error) {
      if (error instanceof ConnectorCallError) throw CollectionsError.from(error)
      throw error
    }
  }

  return {
    route: 'connect',
    methods: (ctx, input) => call('methods', ctx, input),
    send: (ctx, input) => call('send', ctx, input),
    status: (ctx, input) => call('status', ctx, input),
  }
}
