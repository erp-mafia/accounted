import { CONNECTOR_COMPANY_HEADER, type ConnectorUpstream } from '@/lib/connect/instance/upstreams'
import {
  CONNECTOR_PEPPOL_PROVIDER,
  PeppolTransportError,
  type PeppolDeliveryEvidence,
  type PeppolInboundListOptions,
  type PeppolInboundMessage,
  type PeppolParticipant,
  type PeppolRecipientLookup,
  type PeppolRecipientRegistration,
  type PeppolRecipientRegistrationInput,
  type PeppolSubmission,
  type PeppolSubmissionReceipt,
  type PeppolTransport,
  type PeppolVerifiedEvent,
  type PeppolWebhookRequest,
} from '@/lib/invoices/peppol-transport'

/**
 * Instance-side Peppol transport for connector mode (WS3).
 *
 * A self-hosted instance with a connector key and no Qvalia keys of its own
 * reaches Arcim's contracted access point through the hosted proxy
 * (`app/api/connect/peppol/*`). The proxy speaks the PeppolTransport
 * operations, not Qvalia paths, so the instance never learns Arcim's partner
 * or account numbers and the hosted side can enforce ownership: a key can
 * only poll, fetch evidence for, or receive documents belonging to
 * participants and submissions it registered itself.
 *
 * Webhooks are not brokered: Qvalia posts to the hosted webhook, which only
 * knows hosted deliveries. The instance learns outbound status by polling
 * (`pollDeliveryStatus`, already driven by /api/peppol/outbound/status/cron).
 */

export const CONNECTOR_PROVIDER = CONNECTOR_PEPPOL_PROVIDER

const FETCH_TIMEOUT_MS = 60_000

export interface ConnectorTransportDeps {
  fetch?: typeof fetch
}

interface ConnectorErrorBody {
  error?: string
  code?: string
  retryable?: boolean
  detail?: string | null
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { error: text.slice(0, 500) }
  }
}

function failureFromResponse(status: number, body: unknown): PeppolTransportError {
  const parsed = (body && typeof body === 'object' ? body : {}) as ConnectorErrorBody
  const code = typeof parsed.code === 'string' ? parsed.code : `HTTP_${status}`
  const message = typeof parsed.error === 'string' && parsed.error ? parsed.error : `Connector answered ${status}`
  const retryable = typeof parsed.retryable === 'boolean' ? parsed.retryable : status === 429 || status >= 500
  const detail = [code, typeof parsed.detail === 'string' ? parsed.detail : null].filter(Boolean).join(': ')
  return new PeppolTransportError(`Connector: ${message}`, { retryable, detail: detail || null })
}

export function createConnectorPeppolTransport(
  upstream: ConnectorUpstream,
  deps: ConnectorTransportDeps = {},
): PeppolTransport {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const baseUrl = upstream.baseUrl.replace(/\/+$/, '')

  async function call<T>(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    options: { companyRef?: string | null } = {},
  ): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        signal: controller.signal,
        redirect: 'error',
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${upstream.key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(options.companyRef ? { [CONNECTOR_COMPANY_HEADER]: options.companyRef } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      throw new PeppolTransportError('Connector: could not reach the hosted service', { retryable: true, cause: error })
    } finally {
      clearTimeout(timeout)
    }
    const json = await readJson(response)
    if (!response.ok) throw failureFromResponse(response.status, json)
    return json as T
  }

  function withProvider<T extends { provider: string }>(value: T): T {
    return { ...value, provider: CONNECTOR_PROVIDER }
  }

  async function lookupRecipient(participant: PeppolParticipant): Promise<PeppolRecipientLookup> {
    return call<PeppolRecipientLookup>('POST', '/lookup', { participant })
  }

  async function submit(submission: PeppolSubmission): Promise<PeppolSubmissionReceipt> {
    const receipt = await call<PeppolSubmissionReceipt>('POST', '/submit', submission, {
      companyRef: submission.tenantReference,
    })
    return withProvider(receipt)
  }

  async function verifyWebhook(_webhook: PeppolWebhookRequest): Promise<PeppolVerifiedEvent[]> {
    throw new PeppolTransportError('Connector: delivery webhooks are handled by the hosted service; poll instead', {
      retryable: false,
    })
  }

  async function retrieveEvidence(providerSubmissionId: string): Promise<PeppolDeliveryEvidence[]> {
    const items = await call<PeppolDeliveryEvidence[]>('POST', '/evidence', { providerSubmissionId })
    return (items ?? []).map(withProvider)
  }

  async function pollDeliveryStatus(providerSubmissionId: string): Promise<PeppolVerifiedEvent[]> {
    const events = await call<PeppolVerifiedEvent[]>('POST', '/status', { providerSubmissionId })
    return (events ?? []).map(withProvider)
  }

  async function registerRecipient(input: PeppolRecipientRegistrationInput): Promise<PeppolRecipientRegistration> {
    if (!input.tenantReference) {
      throw new PeppolTransportError('Connector: a tenant reference is required to register a recipient', {
        retryable: false,
      })
    }
    const result = await call<PeppolRecipientRegistration>('PUT', '/recipient', input, {
      companyRef: input.tenantReference,
    })
    return { ...result, participant: input.participant }
  }

  async function unregisterRecipient(participant: PeppolParticipant): Promise<void> {
    const query = new URLSearchParams({ scheme: participant.scheme, identifier: participant.identifier })
    await call<unknown>('DELETE', `/recipient?${query.toString()}`, undefined)
  }

  async function listInboundDocuments(options: PeppolInboundListOptions): Promise<PeppolInboundMessage[]> {
    const items = await call<PeppolInboundMessage[]>('POST', '/inbound/list', options)
    return (items ?? []).map(withProvider)
  }

  async function fetchInboundDocumentXml(
    providerDocumentId: string,
    documentType: PeppolInboundListOptions['documentType'],
  ): Promise<string | null> {
    const result = await call<{ xml: string | null }>('POST', '/inbound/xml', { providerDocumentId, documentType })
    return typeof result?.xml === 'string' && result.xml.trim().startsWith('<') ? result.xml : null
  }

  return {
    provider: CONNECTOR_PROVIDER,
    lookupRecipient,
    submit,
    verifyWebhook,
    retrieveEvidence,
    pollDeliveryStatus,
    registerRecipient,
    unregisterRecipient,
    listInboundDocuments,
    fetchInboundDocumentXml,
  }
}
