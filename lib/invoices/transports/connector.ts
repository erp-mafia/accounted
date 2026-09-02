import { PEPPOL_OPERATIONS, connectorErrorSchema } from '@accounted/connect-contract'
import type { z } from 'zod'
import { CONNECTOR_COMPANY_HEADER, type ConnectorUpstream } from '@/lib/connect/instance/upstreams'
import {
  CONNECTOR_PEPPOL_PROVIDER,
  PeppolTransportError,
  type PeppolDeliveryEvidence,
  type PeppolInboundMessage,
  type PeppolRecipientLookup,
  type PeppolRecipientRegistration,
  type PeppolSubmissionReceipt,
  type PeppolVerifiedEvent,
  type PeppolInboundListOptions,
  type PeppolParticipant,
  type PeppolRecipientRegistrationInput,
  type PeppolSubmission,
  type PeppolTransport,
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
  /**
   * Resolve the instance company that made a submission (from
   * peppol_deliveries) so status and evidence reads carry the company the
   * hosted side bound the submission to. Optional for tests; the production
   * factory in transports/index.ts wires it to the instance database.
   */
  companyFor?: (providerSubmissionId: string) => Promise<string | null>
  /** Same for a receiving registration (from peppol_registrations). */
  companyForParticipant?: (participant: PeppolParticipant) => Promise<string | null>
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
  const parsed = connectorErrorSchema.safeParse(body)
  const envelope = parsed.success ? parsed.data : null
  const code = envelope?.code ?? `HTTP_${status}`
  const message = envelope?.error || `Connector answered ${status}`
  const retryable = typeof envelope?.retryable === 'boolean' ? envelope.retryable : status === 429 || status >= 500
  const detail = [code, envelope?.detail ?? null].filter(Boolean).join(': ')
  return new PeppolTransportError(`Connector: ${message}`, { retryable, detail: detail || null })
}

/** Validate a hosted answer against the contract; a shape mismatch is a protocol error, never retried. */
function parseResponse<T>(schema: z.ZodType<T>, json: unknown, operation: string): T {
  const parsed = schema.safeParse(json)
  if (parsed.success) return parsed.data
  throw new PeppolTransportError(`Connector: unexpected response shape from ${operation}`, {
    retryable: false,
    detail: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  })
}

/**
 * The connector key travels as a bearer token, so the hosted origin must be
 * https. Plain http is tolerated for loopback only (local development against
 * a hosted dev server), the same rule getConnectorConfig() applies when it
 * reads GNUBOK_CONNECT_URL.
 */
function assertTransportSecurity(baseUrl: string): void {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new PeppolTransportError('Connector: invalid hosted URL', { retryable: false })
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return
  throw new PeppolTransportError('Connector: the hosted URL must be https (the connector key is a bearer token)', {
    retryable: false,
  })
}

export function createConnectorPeppolTransport(
  upstream: ConnectorUpstream,
  deps: ConnectorTransportDeps = {},
): PeppolTransport {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const baseUrl = upstream.baseUrl.replace(/\/+$/, '')
  assertTransportSecurity(baseUrl)

  async function call<T>(
    operation: string,
    schema: z.ZodType<T>,
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    options: { companyRef?: string | null } = {},
  ): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    // The body is read INSIDE the timeout window: a response whose headers
    // arrive and whose body then stalls must not hold the caller forever,
    // and a body-read failure is a transport failure like any other.
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
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
      const json = await readJson(response)
      if (!response.ok) throw failureFromResponse(response.status, json)
      return parseResponse(schema, json, operation)
    } catch (error) {
      if (error instanceof PeppolTransportError) throw error
      throw new PeppolTransportError('Connector: could not reach the hosted service', { retryable: true, cause: error })
    } finally {
      clearTimeout(timeout)
    }
  }

  function withProvider<T extends { provider: string }>(value: T): T {
    return { ...value, provider: CONNECTOR_PROVIDER }
  }

  async function lookupRecipient(participant: PeppolParticipant): Promise<PeppolRecipientLookup> {
    return call('lookup', PEPPOL_OPERATIONS.lookup.response, 'POST', PEPPOL_OPERATIONS.lookup.path, { participant })
  }

  async function submit(submission: PeppolSubmission): Promise<PeppolSubmissionReceipt> {
    const receipt = await call('submit', PEPPOL_OPERATIONS.submit.response, 'POST', PEPPOL_OPERATIONS.submit.path, submission, {
      companyRef: submission.tenantReference,
    })
    return withProvider(receipt)
  }

  async function verifyWebhook(_webhook: PeppolWebhookRequest): Promise<PeppolVerifiedEvent[]> {
    throw new PeppolTransportError('Connector: delivery webhooks are handled by the hosted service; poll instead', {
      retryable: false,
    })
  }

  // The PeppolTransport read methods carry no tenant, but the hosted side
  // binds submissions to (key, company). The instance resolves the company
  // from its own peppol_deliveries row before polling, via deps.companyFor.
  async function companyFor(providerSubmissionId: string): Promise<string | null> {
    return deps.companyFor ? deps.companyFor(providerSubmissionId) : null
  }

  async function retrieveEvidence(providerSubmissionId: string): Promise<PeppolDeliveryEvidence[]> {
    const items = await call('evidence', PEPPOL_OPERATIONS.evidence.response, 'POST', PEPPOL_OPERATIONS.evidence.path, { providerSubmissionId }, {
      companyRef: await companyFor(providerSubmissionId),
    })
    return (items ?? []).map(withProvider)
  }

  async function pollDeliveryStatus(providerSubmissionId: string): Promise<PeppolVerifiedEvent[]> {
    const events = await call('status', PEPPOL_OPERATIONS.status.response, 'POST', PEPPOL_OPERATIONS.status.path, { providerSubmissionId }, {
      companyRef: await companyFor(providerSubmissionId),
    })
    return (events ?? []).map(withProvider)
  }

  async function registerRecipient(input: PeppolRecipientRegistrationInput): Promise<PeppolRecipientRegistration> {
    if (!input.tenantReference) {
      throw new PeppolTransportError('Connector: a tenant reference is required to register a recipient', {
        retryable: false,
      })
    }
    const result = await call('register', PEPPOL_OPERATIONS.register.response, 'PUT', PEPPOL_OPERATIONS.register.path, input, {
      companyRef: input.tenantReference,
    })
    return { ...result, participant: input.participant }
  }

  async function unregisterRecipient(participant: PeppolParticipant): Promise<void> {
    const query = new URLSearchParams({ scheme: participant.scheme, identifier: participant.identifier })
    await call('unregister', PEPPOL_OPERATIONS.unregister.response, 'DELETE', `${PEPPOL_OPERATIONS.unregister.path}?${query.toString()}`, undefined, {
      companyRef: deps.companyForParticipant ? await deps.companyForParticipant(participant) : null,
    })
  }

  async function listInboundDocuments(options: PeppolInboundListOptions): Promise<PeppolInboundMessage[]> {
    const items = await call('inboundList', PEPPOL_OPERATIONS.inboundList.response, 'POST', PEPPOL_OPERATIONS.inboundList.path, options)
    return (items ?? []).map(withProvider)
  }

  async function fetchInboundDocumentXml(
    providerDocumentId: string,
    documentType: PeppolInboundListOptions['documentType'],
  ): Promise<string | null> {
    const result = await call('inboundXml', PEPPOL_OPERATIONS.inboundXml.response, 'POST', PEPPOL_OPERATIONS.inboundXml.path, { providerDocumentId, documentType })
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
