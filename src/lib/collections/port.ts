import type {
  CollectionsCancelOnboardingRequest,
  CollectionsCase,
  CollectionsCaseActionRequest,
  CollectionsCaseDocumentRequest,
  CollectionsCaseRef,
  CollectionsChanges,
  CollectionsChangesRequest,
  CollectionsConnection,
  CollectionsCreditNoteRequest,
  CollectionsDirectPaymentRequest,
  CollectionsDisconnectRequest,
  CollectionsDocument,
  CollectionsOnboardingRequest,
  CollectionsOpenCaseReceipt,
  CollectionsOpenCaseRequest,
  CollectionsPaymentReceipt,
  CollectionsRevertPaymentRequest,
  CollectionsSettingsUpdateRequest,
  CollectionsSettlement,
  CollectionsSettlementBookedRequest,
  CollectionsSettlementRef,
  CollectionsSettlementSummary,
  CollectionsSettlementsRequest,
  CollectionsSignatureStart,
  CollectionsSignatureStartRequest,
  CollectionsTermsAcceptRequest,
} from '@accounted/connect-contract'

/**
 * The collections port: reminders, debt collection and the provider's
 * payouts, in provider-neutral terms.
 *
 * Provider code lives only in Accounted Connect. This repository has one
 * adapter per port that talks to Connect (adapters/connector.ts) and a
 * deterministic fake (adapters/fake.ts) for tests, local development and
 * sandbox companies. Which one serves a company is decided by its connection
 * row (`collection_connections.route`), never by a company-wide setting
 * (registry.ts).
 *
 * Input and output types are the contract's own (`z.infer` of the schemas in
 * @accounted/connect-contract), so the port and the wire cannot drift.
 * Failures are thrown as CollectionsError (errors.ts).
 *
 * Gating is NOT the adapter's job: the start gates and the obligation paths
 * are decided in flags.ts by every caller (routes, operations, crons) before
 * an adapter is called.
 */

/** Who a company call is for. */
export interface CollectionsCallContext {
  /** The ledger's own company id, sent as X-Connector-Company. */
  companyId: string
  /**
   * The opaque handle onboarding returned; null before. Sent as
   * X-Connector-Connection, so Connect checks ownership by hash without
   * storing the provider's id.
   */
  connectionHandle: string | null
}

/** Which implementation an adapter is; equals `collection_connections.route` of the rows it serves. */
export type CollectionsRoute = 'connect' | 'fake'

export interface CollectionsAdapter {
  readonly route: CollectionsRoute

  // The connection (one per company).
  connection(ctx: CollectionsCallContext): Promise<CollectionsConnection>
  onboard(ctx: CollectionsCallContext, input: CollectionsOnboardingRequest): Promise<CollectionsConnection>
  cancelOnboarding(ctx: CollectionsCallContext, input: CollectionsCancelOnboardingRequest): Promise<CollectionsConnection>
  acceptTerms(ctx: CollectionsCallContext, input: CollectionsTermsAcceptRequest): Promise<CollectionsConnection>
  startSignature(ctx: CollectionsCallContext, input: CollectionsSignatureStartRequest): Promise<CollectionsSignatureStart>
  updateSettings(ctx: CollectionsCallContext, input: CollectionsSettingsUpdateRequest): Promise<CollectionsConnection>
  disconnect(ctx: CollectionsCallContext, input: CollectionsDisconnectRequest): Promise<CollectionsConnection>

  // Cases.
  openCase(ctx: CollectionsCallContext, input: CollectionsOpenCaseRequest): Promise<CollectionsOpenCaseReceipt>
  getCase(ctx: CollectionsCallContext, ref: CollectionsCaseRef): Promise<CollectionsCase>
  caseAction(ctx: CollectionsCallContext, input: CollectionsCaseActionRequest): Promise<CollectionsCase>
  caseDocument(ctx: CollectionsCallContext, input: CollectionsCaseDocumentRequest): Promise<CollectionsDocument>

  // Money the ledger reports to the provider: every direct payment and credit note on a case invoice.
  registerPayment(ctx: CollectionsCallContext, input: CollectionsDirectPaymentRequest): Promise<CollectionsPaymentReceipt>
  revertPayment(ctx: CollectionsCallContext, input: CollectionsRevertPaymentRequest): Promise<CollectionsPaymentReceipt>
  registerCreditNote(ctx: CollectionsCallContext, input: CollectionsCreditNoteRequest): Promise<CollectionsPaymentReceipt>

  // The change feed, key-wide: each change names its company.
  changes(input: CollectionsChangesRequest): Promise<CollectionsChanges>

  // Settlements (the provider's payouts).
  settlements(ctx: CollectionsCallContext, input: CollectionsSettlementsRequest): Promise<CollectionsSettlementSummary[]>
  settlement(ctx: CollectionsCallContext, input: CollectionsSettlementRef): Promise<CollectionsSettlement>
  settlementDocument(ctx: CollectionsCallContext, input: CollectionsSettlementRef): Promise<CollectionsDocument>
  markSettlementBooked(ctx: CollectionsCallContext, input: CollectionsSettlementBookedRequest): Promise<null>
}
