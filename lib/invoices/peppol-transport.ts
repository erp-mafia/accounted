/**
 * Provider-neutral boundary between Accounted's Peppol lifecycle and a
 * contracted Access Point. Core code must not infer network delivery from an
 * HTTP response: submissions, asynchronous events, and evidence are distinct.
 */

export type PeppolDeliveryStatus =
  | 'staged'
  | 'recipient_verified'
  | 'submitting'
  | 'retryable_failure'
  | 'submission_accepted'
  | 'transport_succeeded'
  | 'recipient_acknowledged'
  | 'business_accepted'
  | 'business_rejected'
  | 'no_route'
  | 'failed'

export interface PeppolParticipant {
  scheme: string
  identifier: string
}
export interface PeppolRecipientCapability {
  documentTypeId: string
  processId: string
}

export type PeppolRecipientLookup =
  | {
      reachable: true
      participant: PeppolParticipant
      capabilities: PeppolRecipientCapability[]
      checkedAt: string
    }
  | {
      reachable: false
      participant: PeppolParticipant
      reasonCode: string
      checkedAt: string
    }

export interface PeppolSubmission {
  idempotencyKey: string
  tenantReference: string
  sender: PeppolParticipant
  recipient: PeppolParticipant
  documentTypeId: string
  processId: string
  filename: string
  contentType: 'application/xml'
  document: string
  documentSha256: string
}

export interface PeppolSubmissionReceipt {
  provider: string
  providerSubmissionId: string
  idempotencyKey: string
  tenantReference: string
  acceptedAt: string
}

export interface PeppolVerifiedEvent {
  provider: string
  providerTenantId: string | null
  providerSubmissionId: string | null
  providerEventId: string | null
  /**
   * Accounted's delivery idempotency key. A provider webhook only knows its
   * own submission id, so an adapter returns `null` here and the webhook route
   * resolves the key from `providerSubmissionId` before persisting.
   */
  idempotencyKey: string | null
  eventCode: string
  normalizedStatus: PeppolDeliveryStatus
  isTerminal: boolean
  detail: string | null
  occurredAt: string
  rawPayload: Record<string, unknown>
  eventSha256: string
  verificationMethod: string
}

export interface PeppolDeliveryEvidence {
  provider: string
  evidenceType: string
  payload: Record<string, unknown>
  exactDocument: string | null
  exactDocumentSha256: string | null
  evidenceSha256: string
  retrievedAt: string
}

export interface PeppolWebhookRequest {
  headers: Headers
  rawBody: Uint8Array
}

/** What the SMP publishes about a receiving participant (Peppol Directory business card). */
export interface PeppolBusinessCard {
  companyName: string
  countryCode: string
  geographicalInformation?: string | null
  vatNumber?: string | null
  orgNumber?: string | null
}

export interface PeppolDocumentTypeRegistration {
  /** Process identifier, e.g. urn:fdc:peppol.eu:2017:poacc:billing:01:1.0 */
  processId: string
  /** Document type identifier, e.g. the BIS Billing 3 Invoice id. */
  documentTypeId: string
}

export interface PeppolRecipientRegistrationInput {
  participant: PeppolParticipant
  businessCard: PeppolBusinessCard
  documentTypes: PeppolDocumentTypeRegistration[]
  description?: string | null
  /**
   * The registering tenant (company id). Providers that hold one account per
   * installation ignore it; the connector transport needs it because the
   * hosted access point enforces a per-company registration quota.
   */
  tenantReference?: string | null
}

export interface PeppolRecipientRegistration {
  status: 'registered' | 'updated'
  participant: PeppolParticipant
  /** Provider account the identifier is attached to (Qvalia accountRegNo). */
  providerAccountReference: string | null
  raw: Record<string, unknown>
}

export type PeppolInboundDocumentType = 'Invoice' | 'CreditNote'

/** One inbound document as the provider hands it over, before Accounted reads it. */
export interface PeppolInboundMessage {
  provider: string
  providerDocumentId: string
  documentType: PeppolInboundDocumentType
  /** UBL-JSON payload (the provider's rendering of the received XML). */
  payload: Record<string, unknown>
  receivedAt: string | null
}

export interface PeppolInboundListOptions {
  documentType: PeppolInboundDocumentType
  limit?: number
  /** Include documents already handed over once (re-sync); default only unread. */
  includeRead?: boolean
}

/**
 * Provider-neutral failure raised by an adapter. `retryable` separates an
 * operational problem (network, rate limit, credentials) from a verdict on the
 * document itself (rejected, duplicate); the send route records them as
 * different lifecycle events.
 */
export class PeppolTransportError extends Error {
  readonly retryable: boolean
  readonly detail: string | null

  constructor(message: string, options: { retryable: boolean; detail?: string | null; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'PeppolTransportError'
    this.retryable = options.retryable
    this.detail = options.detail ?? null
  }
}

export function isPeppolTransportError(error: unknown): error is PeppolTransportError {
  return error instanceof PeppolTransportError
}

export interface PeppolTransport {
  readonly provider: string
  lookupRecipient(participant: PeppolParticipant): Promise<PeppolRecipientLookup>
  submit(submission: PeppolSubmission): Promise<PeppolSubmissionReceipt>
  verifyWebhook(request: PeppolWebhookRequest): Promise<PeppolVerifiedEvent[]>
  retrieveEvidence(providerSubmissionId: string): Promise<PeppolDeliveryEvidence[]>
  /**
   * Receiving side. Optional: a send-only provider leaves these undefined and
   * the product keeps receiving switched off for it.
   */
  registerRecipient?(input: PeppolRecipientRegistrationInput): Promise<PeppolRecipientRegistration>
  unregisterRecipient?(participant: PeppolParticipant): Promise<void>
  listInboundDocuments?(options: PeppolInboundListOptions): Promise<PeppolInboundMessage[]>
  /** The exact received document, for the archive (räkenskapsinformation). */
  fetchInboundDocumentXml?(
    providerDocumentId: string,
    documentType: PeppolInboundDocumentType,
  ): Promise<string | null>
  /**
   * Pull the provider's current delivery status for an outbound submission
   * and return it as verified events (same shape as a webhook, `idempotencyKey`
   * unresolved). For providers without webhooks, or as a safety net when a
   * webhook was missed. Returns [] when the provider has nothing new to say.
   */
  pollDeliveryStatus?(providerSubmissionId: string): Promise<PeppolVerifiedEvent[]>
}

/**
 * Provider id of the instance-side transport that reaches Arcim's access
 * point through the hosted connector (lib/invoices/transports/connector.ts).
 * Declared here so availability resolution needs no import of that module.
 */
export const CONNECTOR_PEPPOL_PROVIDER = 'connector'

const transports = new Map<string, PeppolTransport>()

export function registerPeppolTransport(transport: PeppolTransport): () => void {
  const provider = transport.provider.trim().toLowerCase()
  if (!provider) throw new Error('Peppol transport provider is required')
  if (transports.has(provider)) {
    throw new Error(`Peppol transport already registered: ${provider}`)
  }

  transports.set(provider, transport)
  return () => {
    if (transports.get(provider) === transport) transports.delete(provider)
  }
}

export function getPeppolTransport(provider: string): PeppolTransport | null {
  return transports.get(provider.trim().toLowerCase()) ?? null
}

export type PeppolTransportAvailability =
  | { available: true; provider: string }
  | {
      available: false
      provider: null
      reason: 'provider_selection_required' | 'provider_adapter_unavailable'
    }

export function getPeppolTransportAvailability(): PeppolTransportAvailability {
  const configuredProvider = process.env.PEPPOL_TRANSPORT_PROVIDER?.trim().toLowerCase()
  if (!configuredProvider) {
    // A self-hosted instance in connector mode has exactly one possible
    // provider, so it needs no PEPPOL_TRANSPORT_PROVIDER. Hosted never
    // registers the connector transport, so this branch is inert there.
    if (transports.has(CONNECTOR_PEPPOL_PROVIDER)) {
      return { available: true, provider: CONNECTOR_PEPPOL_PROVIDER }
    }
    return { available: false, provider: null, reason: 'provider_selection_required' }
  }

  if (!transports.has(configuredProvider)) {
    return { available: false, provider: null, reason: 'provider_adapter_unavailable' }
  }

  return { available: true, provider: configuredProvider }
}
