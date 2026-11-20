import type {
  DeliveryMethods,
  DeliveryMethodsRequest,
  DeliveryReceipt,
  DeliverySendRequest,
  DeliveryStatus,
  DeliveryStatusRequest,
} from '@accounted/connect-contract'
import type { CollectionsCallContext, CollectionsRoute } from '@/lib/collections/port'

/**
 * The delivery port: sending an invoice the ledger issued, as its own PDF,
 * by post, to a digital mailbox or as an e-invoice in the debtor's internet
 * bank, through the provider the company activated for collections.
 *
 * The contract family and Connect's paths are named `delivery`; inside the
 * ledger the user-facing act and the invoice_deliveries channel are named
 * `distribution` ("Utskick"), because a channel `delivery` inside a table
 * called invoice_deliveries would say nothing.
 *
 * Same shape as the collections port (lib/collections/port.ts): contract
 * types in and out, one Connect adapter and one deterministic fake, the
 * adapter picked by the company's connection row, failures thrown as
 * CollectionsError, and gating decided by the caller in
 * lib/collections/flags.ts (send and the methods lookup are start paths).
 */
export interface DeliveryAdapter {
  readonly route: CollectionsRoute
  /** Whether a debtor is reachable by Kivra or e-invoice. Called only on an explicit pick of one of them. */
  methods(ctx: CollectionsCallContext, input: DeliveryMethodsRequest): Promise<DeliveryMethods>
  send(ctx: CollectionsCallContext, input: DeliverySendRequest): Promise<DeliveryReceipt>
  status(ctx: CollectionsCallContext, input: DeliveryStatusRequest): Promise<DeliveryStatus[]>
}
