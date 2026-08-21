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
}

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
    return { available: false, provider: null, reason: 'provider_selection_required' }
  }

  if (!transports.has(configuredProvider)) {
    return { available: false, provider: null, reason: 'provider_adapter_unavailable' }
  }

  return { available: true, provider: configuredProvider }
}
