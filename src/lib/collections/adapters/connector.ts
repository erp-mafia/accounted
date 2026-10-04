import { COLLECTIONS_OPERATIONS, type CollectionsOperation } from '@accounted/connect-contract'
import { callConnectorOperation, ConnectorCallError } from '@/lib/connect/instance/connector-fetch'
import type { ConnectorUpstream } from '@/lib/connect/instance/upstreams'
import { CollectionsError } from '../errors'
import type { CollectionsAdapter, CollectionsCallContext } from '../port'

/**
 * The collections adapter that talks to Accounted Connect
 * (`/api/connect/collections/*` under GNUBOK_CONNECT_URL). It speaks the
 * contract's operations only: Connect owns the provider's API, its ids and
 * its credentials, and answers with provider-neutral shapes.
 *
 * Every company call carries X-Connector-Company and, once onboarded,
 * X-Connector-Connection; every call carries X-Connect-Contract-Version
 * (lib/connect/instance/connector-fetch.ts). Requests are validated against
 * the contract before they leave; answers are validated on the way in, and a
 * mismatch is a protocol error that is never retried.
 */

/**
 * Timeout ladder (build spec 1.4): Connect gives the resumable writes
 * (onboard, openCase) 120 s and everything else 30 s, so the ledger waits a
 * little longer than Connect for each and hears Connect's own answer, its
 * timeout included, instead of abandoning a call Connect is still making. A
 * timeout is never treated as a failure: the caller keeps the row as
 * submitted and retries with the same idempotency key, which Connect resumes
 * or replays.
 */
export const COLLECTIONS_LONG_TIMEOUT_MS = 130_000
export const COLLECTIONS_DEFAULT_TIMEOUT_MS = 30_000
const LONG_OPERATIONS: ReadonlySet<CollectionsOperation> = new Set(['onboard', 'openCase'])

export function collectionsTimeoutMs(operation: CollectionsOperation): number {
  return LONG_OPERATIONS.has(operation) ? COLLECTIONS_LONG_TIMEOUT_MS : COLLECTIONS_DEFAULT_TIMEOUT_MS
}

export interface ConnectorCollectionsAdapterDeps {
  fetch?: typeof fetch
  /** Override the timeout per operation (tests). */
  timeoutMs?: (operation: CollectionsOperation) => number
}

export function createConnectorCollectionsAdapter(
  upstream: ConnectorUpstream,
  deps: ConnectorCollectionsAdapterDeps = {},
): CollectionsAdapter {
  const timeoutFor = deps.timeoutMs ?? collectionsTimeoutMs

  async function call<O extends CollectionsOperation>(
    operation: O,
    ctx: CollectionsCallContext | null,
    body: unknown,
  ) {
    try {
      return await callConnectorOperation({
        upstream,
        operation: `collections.${operation}`,
        def: COLLECTIONS_OPERATIONS[operation],
        body,
        companyId: ctx?.companyId ?? null,
        connectionHandle: ctx?.connectionHandle ?? null,
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
    connection: (ctx) => call('connection', ctx, {}),
    onboard: (ctx, input) => call('onboard', ctx, input),
    cancelOnboarding: (ctx, input) => call('cancelOnboarding', ctx, input),
    acceptTerms: (ctx, input) => call('acceptTerms', ctx, input),
    startSignature: (ctx, input) => call('startSignature', ctx, input),
    updateSettings: (ctx, input) => call('updateSettings', ctx, input),
    disconnect: (ctx, input) => call('disconnect', ctx, input),
    openCase: (ctx, input) => call('openCase', ctx, input),
    getCase: (ctx, ref) => call('getCase', ctx, ref),
    caseAction: (ctx, input) => call('caseAction', ctx, input),
    caseDocument: (ctx, input) => call('caseDocument', ctx, input),
    registerPayment: (ctx, input) => call('registerPayment', ctx, input),
    revertPayment: (ctx, input) => call('revertPayment', ctx, input),
    registerCreditNote: (ctx, input) => call('registerCreditNote', ctx, input),
    changes: (input) => call('changes', null, input),
    settlements: (ctx, input) => call('settlements', ctx, input),
    settlement: (ctx, input) => call('settlement', ctx, input),
    settlementDocument: (ctx, input) => call('settlementDocument', ctx, input),
    markSettlementBooked: (ctx, input) => call('settlementBooked', ctx, input),
  }
}
