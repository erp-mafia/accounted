import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID,
  PEPPOL_BIS_BILLING_PROFILE_ID,
} from '@/lib/invoices/peppol-bis-billing'
import { sha256Hex } from '@/lib/invoices/peppol-delivery'
import type { PeppolSubmission } from '@/lib/invoices/peppol-transport'
import {
  QvaliaApiError,
  createQvaliaTransport,
  describeQvaliaErrorBody,
  extractUblDocumentId,
  extractUblJsonSupplierEndpoint,
  mapQvaliaOutgoingStatus,
  normalizePeppolDocumentTypeId,
  normalizeQvaliaWebhook,
  readQvaliaConfigFromEnv,
  readQvaliaOutgoingStatus,
  type QvaliaConfig,
} from '@/lib/invoices/transports/qvalia'
import { registerConfiguredPeppolTransports } from '@/lib/invoices/transports'
import { getPeppolTransport } from '@/lib/invoices/peppol-transport'
// `/invoices/outgoing/status` answers captured read-only from the Qvalia
// sandbox on 2026-09-29: unedited response bodies, named by integrationId.
import processedA from './fixtures/qvalia/outgoing-status-processed-9f178d7a.json'
import processedB from './fixtures/qvalia/outgoing-status-processed-d3581a0b.json'
import errorA from './fixtures/qvalia/outgoing-status-error-783b9b55.json'
import errorB from './fixtures/qvalia/outgoing-status-error-9ff52b0e.json'
import emptyMetadata from './fixtures/qvalia/outgoing-status-empty-metadata-0ff1b116.json'
// SYNTHESIZED, not captured: on 2026-09-29 no sandbox message answered with
// the create-only object (the one message without an outcome, 0ff1b116,
// answers `metadata: {}` above). Built from the metadata.status object
// captured for a just-accepted message on 2026-09-28 (event
// message-log/create, no status); the integrationId is a placeholder.
import created from './fixtures/qvalia/outgoing-status-created-synthesized.json'

const config: QvaliaConfig = {
  apiKey: 'test-key',
  partnerRegNo: 'SE5560000000',
  accountRegNo: 'SE5560000000',
  baseUrl: 'https://api-qa.qvalia.com',
  authScheme: 'apikey',
  webhookSecret: 'shared-secret-1234567890',
  webhookHeader: 'x-accounted-webhook-key',
}

const XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
  '  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>',
  '  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>',
  '  <cbc:ID>F-2026-42</cbc:ID>',
  '</Invoice>',
].join('\n')

function submission(overrides: Partial<PeppolSubmission> = {}): PeppolSubmission {
  return {
    idempotencyKey: '33333333-3333-4333-8333-333333333333',
    tenantReference: 'company-1',
    sender: { scheme: '0007', identifier: '5560160680' },
    recipient: { scheme: '0007', identifier: '5566778899' },
    documentTypeId: PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID,
    processId: PEPPOL_BIS_BILLING_PROFILE_ID,
    filename: 'peppol-invoice-F-2026-42.xml',
    contentType: 'application/xml',
    document: XML,
    documentSha256: sha256Hex(XML),
    ...overrides,
  }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

const SHAPE_ERROR = { kind: 'shape', code: 'CONNECTOR_UPSTREAM_SHAPE', retryable: false }

describe('readQvaliaConfigFromEnv', () => {
  it('returns null until key, partner number and base URL are all present', () => {
    expect(readQvaliaConfigFromEnv({})).toBeNull()
    expect(readQvaliaConfigFromEnv({ QVALIA_API_KEY: 'k', QVALIA_PARTNER_REG_NO: 'p' })).toBeNull()
    expect(readQvaliaConfigFromEnv({
      QVALIA_API_KEY: 'k',
      QVALIA_PARTNER_REG_NO: 'p',
      QVALIA_BASE_URL: 'http://insecure.example',
    })).toBeNull()
  })

  it('defaults the account to the partner number, the bare-key auth that the sandbox accepts, and the documented header', () => {
    const parsed = readQvaliaConfigFromEnv({
      QVALIA_API_KEY: ' k ',
      QVALIA_PARTNER_REG_NO: 'SE1',
      QVALIA_BASE_URL: 'https://api-test.qvalia.com/',
      QVALIA_WEBHOOK_SECRET: 's',
    })
    expect(parsed).toEqual({
      apiKey: 'k',
      partnerRegNo: 'SE1',
      accountRegNo: 'SE1',
      baseUrl: 'https://api-test.qvalia.com',
      authScheme: 'raw',
      webhookSecret: 's',
      webhookHeader: 'x-accounted-webhook-key',
      webhookSigningSecret: null,
    })
  })

  it('reads the webhook signing secret, trimmed', () => {
    const parsed = readQvaliaConfigFromEnv({
      QVALIA_API_KEY: 'k',
      QVALIA_PARTNER_REG_NO: 'SE1',
      QVALIA_BASE_URL: 'https://api.qvalia.com',
      QVALIA_WEBHOOK_SIGNING_SECRET: ' qv_whsec_1 ',
    })
    expect(parsed?.webhookSigningSecret).toBe('qv_whsec_1')
    expect(parsed?.webhookSecret).toBeNull()
  })

  it('honours an explicit account number, the ApiKey prefix and a custom header', () => {
    const parsed = readQvaliaConfigFromEnv({
      QVALIA_API_KEY: 'k',
      QVALIA_PARTNER_REG_NO: 'SE1',
      QVALIA_ACCOUNT_REG_NO: 'SE2',
      QVALIA_BASE_URL: 'https://api.qvalia.com',
      QVALIA_AUTH_SCHEME: 'apikey',
      QVALIA_WEBHOOK_HEADER: 'X-Custom',
    })
    expect(parsed?.accountRegNo).toBe('SE2')
    expect(parsed?.authScheme).toBe('apikey')
    expect(parsed?.webhookHeader).toBe('x-custom')
  })
})

describe('registerConfiguredPeppolTransports', () => {
  it('registers nothing when Qvalia is not configured', () => {
    expect(registerConfiguredPeppolTransports({})).toEqual([])
  })

  it('registers the Qvalia adapter once when configured', () => {
    const env = {
      QVALIA_API_KEY: 'k',
      QVALIA_PARTNER_REG_NO: 'SE1',
      QVALIA_BASE_URL: 'https://api-qa.qvalia.com',
    }
    const first = registerConfiguredPeppolTransports(env)
    expect(first.map((t) => t.provider)).toEqual(['qvalia'])
    expect(getPeppolTransport('qvalia')).toBe(first[0])
    expect(registerConfiguredPeppolTransports(env)).toEqual([])
  })
})

describe('Qvalia transport: tenant label', () => {
  const env = { QVALIA_API_KEY: 'k', QVALIA_PARTNER_REG_NO: 'SE1', QVALIA_BASE_URL: 'https://api-test.qvalia.com' }

  it('labels its deliveries with the sending account, which defaults to the partner number', () => {
    expect(createQvaliaTransport(config).tenantId).toBe('SE5560000000')
    expect(createQvaliaTransport(readQvaliaConfigFromEnv(env)!).tenantId).toBe('SE1')
    expect(createQvaliaTransport(readQvaliaConfigFromEnv({ ...env, QVALIA_ACCOUNT_REG_NO: 'SE2' })!).tenantId).toBe('SE2')
  })

  it('stamps its own label on a webhook event whatever account number the payload spells', async () => {
    const transport = createQvaliaTransport(config)
    const payload = {
      eventType: 'document_delivery',
      accountRegNo: '5560000000',
      direction: 'outgoing',
      integrationId: 'int-1',
      globalTransactionId: 'int-1',
      status: { status: 'processed', event: 'message-log/update', updatedAt: '2026-09-29T19:11:47.070Z' },
    }
    const headers = new Headers({ 'X-Accounted-Webhook-Key': config.webhookSecret! })
    const [event] = await transport.verifyWebhook({ headers, rawBody: new TextEncoder().encode(JSON.stringify(payload)) })
    expect(event.providerTenantId).toBe(transport.tenantId)
    expect(event.rawPayload).toMatchObject({ accountRegNo: '5560000000' })
  })
})

describe('Qvalia transport: lookupRecipient', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const transport = createQvaliaTransport(config, {
    fetch: fetchMock,
    now: () => new Date('2026-08-21T10:00:00.000Z'),
  })

  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('calls the partner lookup with the ApiKey header and maps capabilities', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      status: 'success',
      data: {
        exists: true,
        rootDocTypeExists: true,
        source: 'smp',
        matches: [{
          participantID: { scheme: 'iso6523-actorid-upis', value: '0007:5566778899' },
          docTypes: [
            // Live shape: the SMP service URL wraps the document type id.
            { scheme: 'busdox-docid-qns', value: `https://smp-test.qvalia.com/iso6523-actorid-upis::0007:5566778899/services/busdox-docid-qns::${PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID}` },
            { scheme: 'busdox-docid-qns', value: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2::CreditNote##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1' },
          ],
        }],
      },
    }))

    const result = await transport.lookupRecipient({ scheme: '0007', identifier: '5566778899' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(
      'https://api-qa.qvalia.com/partner/SE5560000000/peppol/lookup/0007%3A5566778899?docTypeRoot=Invoice',
    )
    expect((init?.headers as Record<string, string>).Authorization).toBe('ApiKey test-key')
    expect(result.reachable).toBe(true)
    if (!result.reachable) throw new Error('unreachable')
    expect(result.checkedAt).toBe('2026-08-21T10:00:00.000Z')
    expect(result.capabilities).toHaveLength(2)
    expect(result.capabilities[0]).toEqual({
      documentTypeId: PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID,
      processId: PEPPOL_BIS_BILLING_PROFILE_ID,
    })
  })

  it('reports a participant without an Invoice capability as not reachable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      status: 'success',
      data: { exists: true, rootDocTypeExists: false, matches: [] },
    }))
    const result = await transport.lookupRecipient({ scheme: '0007', identifier: '5566778899' })
    expect(result).toMatchObject({ reachable: false, reasonCode: 'document_type_not_supported' })
  })

  it('treats 204/404 and exists=false as not registered, never as an error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await transport.lookupRecipient({ scheme: '0007', identifier: '1' }))
      .toMatchObject({ reachable: false, reasonCode: 'participant_not_found' })

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'success', data: { exists: false, matches: [] } }))
    expect(await transport.lookupRecipient({ scheme: '0007', identifier: '1' }))
      .toMatchObject({ reachable: false, reasonCode: 'participant_not_registered' })
  })

  it('surfaces credential problems as a retryable auth error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' }))
    await expect(transport.lookupRecipient({ scheme: '0007', identifier: '1' }))
      .rejects.toMatchObject({ kind: 'auth', retryable: true, httpStatus: 401 })
  })
})

describe('Qvalia transport: submit', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const transport = createQvaliaTransport(config, {
    fetch: fetchMock,
    now: () => new Date('2026-08-21T10:05:00.000Z'),
  })

  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('POSTs the exact XML to the partner-scoped outgoing endpoint and returns the integrationId', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      status: 'success',
      data: { message: 'invoice F-2026-42 sent', invoice_id: 'F-2026-42', integrationId: 'int-1' },
    }))

    const receipt = await transport.submit(submission())

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(
      'https://api-qa.qvalia.com/partner/SE5560000000/transaction/SE5560000000/invoices/outgoing',
    )
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/xml')
    expect(init?.body).toBe(XML)
    expect(receipt).toEqual({
      provider: 'qvalia',
      providerSubmissionId: 'int-1',
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
      tenantReference: 'company-1',
      acceptedAt: '2026-08-21T10:05:00.000Z',
    })
  })

  it('falls back to the integrationid response header when the body has none', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<success><message>ok</message></success>', {
      status: 200,
      headers: { 'content-type': 'application/xml', integrationid: 'int-header' },
    }))
    const receipt = await transport.submit(submission())
    expect(receipt.providerSubmissionId).toBe('int-header')
  })

  it('classifies 422 as a permanent rejection with Qvalia’s reason', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(422, {
      status: 'error',
      type: 'validation',
      metadata: { description: 'BR-CO-10 Sum of invoice line net amount' },
    }))
    const error = await transport.submit(submission()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(QvaliaApiError)
    expect(error).toMatchObject({
      kind: 'rejected',
      retryable: false,
      httpStatus: 422,
      detail: 'BR-CO-10 Sum of invoice line net amount',
    })
  })

  it('classifies 5xx and network failures as retryable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'maintenance' }))
    await expect(transport.submit(submission())).rejects.toMatchObject({ kind: 'unavailable', retryable: true })

    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(transport.submit(submission())).rejects.toMatchObject({ kind: 'network', retryable: true })
  })

  it('recovers the integrationId on 409 only when Qvalia’s copy was sent by the same seller', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { status: 'error', data: 'duplicate' }))
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      status: 'success',
      data: [{
        integrationId: 'int-dup',
        Invoice: {
          'cbc:ID': [{ _: 'F-2026-42' }],
          'cac:AccountingSupplierParty': [{
            'cac:Party': [{ 'cbc:EndpointID': [{ _: '556016-0680', $: { schemeID: '0007' } }] }],
          }],
        },
      }],
    }))

    const receipt = await transport.submit(submission())
    expect(receipt.providerSubmissionId).toBe('int-dup')
    expect(String(fetchMock.mock.calls[1][0])).toContain('/invoices/outgoing?documentId=F-2026-42&includeRead=true')
  })

  it('keeps a 409 as a duplicate error when the stored copy belongs to another seller', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { status: 'error', data: 'duplicate' }))
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      status: 'success',
      data: [{
        integrationId: 'int-other',
        Invoice: {
          AccountingSupplierParty: [{ Party: [{ EndpointID: [{ _: '5599999999', schemeID: '0007' }] }] }],
        },
      }],
    }))
    await expect(transport.submit(submission())).rejects.toMatchObject({ kind: 'duplicate', retryable: false })
  })

  it('resends with overwrite=true when the submission replaces a failed one, and answers the new integrationId', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      status: 'success',
      data: { message: 'invoice F-2026-42 sent', invoice_id: 'F-2026-42', integrationId: 'int-new' },
    }))

    const receipt = await transport.submit(submission({ replacesSubmissionId: 'int-failed' }))

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api-qa.qvalia.com/partner/SE5560000000/transaction/SE5560000000/invoices/outgoing?overwrite=true',
    )
    expect(fetchMock.mock.calls[0][1]?.body).toBe(XML)
    expect(receipt.providerSubmissionId).toBe('int-new')
  })

  it('never adopts an earlier integrationId for a resend: its 409 stays a duplicate error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { status: 'error', data: 'duplicate' }))

    await expect(transport.submit(submission({ replacesSubmissionId: 'int-failed' })))
      .rejects.toMatchObject({ kind: 'duplicate', retryable: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('Qvalia transport: verifyWebhook', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const transport = createQvaliaTransport(config, { fetch: fetchMock })
  const delivered = {
    eventType: 'document_delivery',
    accountRegNo: 'SE5560000000',
    documentType: 'Invoice',
    direction: 'outgoing',
    integrationId: 'int-1',
    occurredAt: '2026-08-19T09:26:10.104Z',
    globalTransactionId: 'int-1',
    status: { status: 'processed', event: 'message-log/update', deliveryMethod: 'peppol', updatedAt: '2026-08-19T09:26:09.881Z' },
    peppol_metadata: { messageId: 'abc@QVALIA-PSE000094', accessPoint: 'PSE000094' },
  }

  function webhook(body: unknown, secret: string | null = config.webhookSecret) {
    const headers = new Headers({ 'content-type': 'application/json' })
    if (secret) headers.set('X-Accounted-Webhook-Key', secret)
    return { headers, rawBody: new TextEncoder().encode(JSON.stringify(body)) }
  }

  it('rejects a missing or wrong shared secret before parsing', async () => {
    await expect(transport.verifyWebhook(webhook(delivered, null))).rejects.toMatchObject({ kind: 'auth' })
    await expect(transport.verifyWebhook(webhook(delivered, 'wrong'))).rejects.toMatchObject({ kind: 'auth' })
  })

  it('refuses to verify anything when no secret is configured', async () => {
    const unconfigured = createQvaliaTransport({ ...config, webhookSecret: null }, { fetch: fetchMock })
    await expect(unconfigured.verifyWebhook(webhook(delivered))).rejects.toMatchObject({ kind: 'auth' })
  })

  it('normalizes a processed delivery with the documented dedupe key and a body fingerprint', async () => {
    const request = webhook(delivered)
    const [event] = await transport.verifyWebhook(request)
    expect(event).toMatchObject({
      provider: 'qvalia',
      providerTenantId: 'SE5560000000',
      providerSubmissionId: 'int-1',
      providerEventId: 'document_delivery:int-1:processed',
      idempotencyKey: null,
      eventCode: 'document_delivery',
      normalizedStatus: 'transport_succeeded',
      isTerminal: false,
      detail: 'processed',
      occurredAt: '2026-08-19T09:26:09.881Z',
      verificationMethod: 'shared_secret_header',
    })
    expect(event.eventSha256).toBe(sha256Hex(request.rawBody))
  })

  it('ignores inbound-direction events on the outbound boundary', async () => {
    const events = await transport.verifyWebhook(webhook({ ...delivered, direction: 'incoming' }))
    expect(events).toEqual([])
  })

  it('keeps a recoverable error non-terminal and a validation error terminal', async () => {
    const [recoverable] = await transport.verifyWebhook(webhook({
      ...delivered,
      eventType: 'document_error',
      status: { status: 'error', event: 'message-log/error' },
      error: 'Receiver access point timed out',
    }))
    expect(recoverable).toMatchObject({ normalizedStatus: 'retryable_failure', isTerminal: false })

    const [permanent] = await transport.verifyWebhook(webhook({
      ...delivered,
      eventType: 'document_error',
      status: { status: 'error', event: 'message-log/error' },
      error: 'Peppol validation failed: invoice does not conform to UBL 2.1',
    }))
    expect(permanent).toMatchObject({
      normalizedStatus: 'failed',
      isTerminal: true,
      detail: 'error: Peppol validation failed: invoice does not conform to UBL 2.1',
    })
  })
})

describe('Qvalia transport: verifyWebhook with a signing secret', () => {
  // Fixed vector: HMAC-SHA256('qv_whsec_transport', '1790000000.' + BODY),
  // cross-checked with openssl dgst -sha256 -hmac.
  const SIGNING = 'qv_whsec_transport'
  const T = 1790000000
  const BODY = '{"eventId":"evt_1","eventType":"document_delivery","direction":"outgoing","integrationId":"int-9","globalTransactionId":"int-9","status":{"status":"processed","updatedAt":"2026-09-21T14:13:19.000Z"}}'
  const V1 = 'f92a01f19779983acc443a620aee3612a8babf2928cbd59038cc8e0212d3872b'
  const transport = createQvaliaTransport(
    { ...config, webhookSecret: null, webhookSigningSecret: SIGNING },
    { fetch: vi.fn<typeof fetch>(), now: () => new Date(T * 1000) },
  )

  function signed(signature: string | null, body = BODY) {
    const headers = new Headers({ 'content-type': 'application/json' })
    if (signature) headers.set('X-Qvalia-Signature', signature)
    return { headers, rawBody: new TextEncoder().encode(body) }
  }

  it('accepts a valid signature over the raw bytes and marks the verification method', async () => {
    const [event] = await transport.verifyWebhook(signed(`t=${T},v1=${V1}`))
    expect(event).toMatchObject({
      providerSubmissionId: 'int-9',
      providerEventId: 'document_delivery:int-9:processed',
      verificationMethod: 'hmac_sha256_signature',
    })
  })

  it('rejects a missing, tampered, re-timestamped or stale signature as an auth failure', async () => {
    await expect(transport.verifyWebhook(signed(null))).rejects.toMatchObject({ kind: 'auth' })
    await expect(transport.verifyWebhook(signed(`t=${T},v1=${V1}`, BODY.replace('processed', 'rejected')))).rejects.toMatchObject({ kind: 'auth' })
    await expect(transport.verifyWebhook(signed(`t=${T - 1},v1=${V1}`))).rejects.toMatchObject({ kind: 'auth' })
    const later = createQvaliaTransport(
      { ...config, webhookSecret: null, webhookSigningSecret: SIGNING },
      { fetch: vi.fn<typeof fetch>(), now: () => new Date((T + 301) * 1000) },
    )
    await expect(later.verifyWebhook(signed(`t=${T},v1=${V1}`))).rejects.toMatchObject({ kind: 'auth' })
  })

  it('does not fall back to the shared-secret header once a signing secret is set', async () => {
    const both = createQvaliaTransport(
      { ...config, webhookSigningSecret: SIGNING },
      { fetch: vi.fn<typeof fetch>(), now: () => new Date(T * 1000) },
    )
    const request = signed(null)
    request.headers.set('X-Accounted-Webhook-Key', config.webhookSecret!)
    await expect(both.verifyWebhook(request)).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('normalizeQvaliaWebhook', () => {
  const base = { eventType: 'document_delivery', direction: 'outgoing' }
  it.each([
    ['rejected by buyer', 'business_rejected', true],
    ['accepted', 'business_accepted', true],
    ['acknowledged', 'recipient_acknowledged', false],
    ['delivered', 'transport_succeeded', false],
    ['queued for sending', 'submission_accepted', false],
    ['some new wording', 'submission_accepted', false],
  ])('maps "%s" to %s', (status, expected, terminal) => {
    expect(normalizeQvaliaWebhook({ ...base, status: { status } })).toMatchObject({
      normalizedStatus: expected,
      isTerminal: terminal,
      detail: status,
    })
  })

  it('maps new_document to submission_accepted and ignores unknown event types', () => {
    expect(normalizeQvaliaWebhook({ eventType: 'new_document' })?.normalizedStatus).toBe('submission_accepted')
    expect(normalizeQvaliaWebhook({ eventType: 'something_else' })).toBeNull()
  })
})

describe('Qvalia transport: retrieveEvidence', () => {
  it('captures the message-log status and the provider-held XML copy', async () => {
    const id = processedA.data[0].integrationId
    const fetchMock = vi.fn<typeof fetch>()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, processedA))
    fetchMock.mockResolvedValueOnce(new Response(XML, { status: 200, headers: { 'content-type': 'application/xml' } }))
    const transport = createQvaliaTransport(config, {
      fetch: fetchMock,
      now: () => new Date('2026-08-21T11:00:00.000Z'),
    })

    const [evidence] = await transport.retrieveEvidence(id)

    expect(String(fetchMock.mock.calls[0][0])).toContain(`/invoices/outgoing/status?integrationId=${id}`)
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>).accept).toBe('application/xml')
    expect(evidence).toMatchObject({
      provider: 'qvalia',
      evidenceType: 'qvalia_message_record',
      exactDocument: XML,
      exactDocumentSha256: sha256Hex(XML),
      retrievedAt: '2026-08-21T11:00:00.000Z',
    })
    expect(evidence.payload).toMatchObject({ integrationId: id, status: processedA })
  })
})

describe('helpers', () => {
  it('reduces SMP service URLs to bare Peppol document type ids', () => {
    expect(normalizePeppolDocumentTypeId(
      `https://smp-test.qvalia.com/iso6523-actorid-upis::0007:5567321707/services/busdox-docid-qns::${PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID}`,
    )).toBe(PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID)
    expect(normalizePeppolDocumentTypeId(
      'https://smp-test.qvalia.com/iso6523-actorid-upis::0007:1/services/peppol-doctype-wildcard::urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:peppol:pint:selfbilling-1%40aunz-1::2.1',
    )).toBe('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:peppol:pint:selfbilling-1@aunz-1::2.1')
    expect(normalizePeppolDocumentTypeId(`busdox-docid-qns::${PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID}`))
      .toBe(PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID)
    expect(normalizePeppolDocumentTypeId(PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID))
      .toBe(PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID)
  })

  it('extracts the UBL document id and the seller endpoint', () => {
    expect(extractUblDocumentId(XML)).toBe('F-2026-42')
    expect(extractUblDocumentId('<cbc:ID schemeID="x">A &amp; B</cbc:ID>')).toBe('A & B')
    // Entities are decoded in one pass: "&amp;lt;" is the literal text "&lt;".
    expect(extractUblDocumentId('<cbc:ID>X &amp;lt; Y</cbc:ID>')).toBe('X &lt; Y')
    expect(extractUblDocumentId('<nothing/>')).toBeNull()
    expect(extractUblJsonSupplierEndpoint({
      Invoice: { AccountingSupplierParty: [{ Party: [{ EndpointID: [{ _: '1', schemeID: '0007' }] }] }] },
    })).toEqual({ scheme: '0007', identifier: '1' })
    // Qvalia's live shape: prefixed keys, attributes under `$`.
    expect(extractUblJsonSupplierEndpoint({
      Invoice: {
        $: { xmlns: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2' },
        'cac:AccountingSupplierParty': [{
          'cac:Party': [{ 'cbc:EndpointID': [{ _: '5567321707', $: { schemeID: '0007' } }] }],
        }],
      },
      integrationId: 'a5845a11-4e5a-4700-bca3-e670a6cd8a79',
    })).toEqual({ scheme: '0007', identifier: '5567321707' })
    expect(extractUblJsonSupplierEndpoint({ Invoice: {} })).toBeNull()
  })

  it('describes Qvalia error bodies from the documented envelopes', () => {
    expect(describeQvaliaErrorBody({ statusCode: 400, error: 'Bad Request', message: 'missing ID' })).toBe('missing ID')
    expect(describeQvaliaErrorBody({ metadata: { details: { rule: 'BR-01' } } })).toBe('{"rule":"BR-01"}')
    expect(describeQvaliaErrorBody('plain text')).toBe('plain text')
    expect(describeQvaliaErrorBody(null)).toBeNull()
  })
})

describe('Qvalia transport: receiving side', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const transport = createQvaliaTransport(config, { fetch: fetchMock })

  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('registers a recipient with business card and both billing document types', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'registered', peppolId: '0007:5595386219' }))
    const result = await transport.registerRecipient!({
      participant: { scheme: '0007', identifier: '5595386219' },
      businessCard: { companyName: 'Arcim Technology AB', countryCode: 'SE', geographicalInformation: 'Stockholm', vatNumber: 'SE559538621901', orgNumber: '5595386219' },
      documentTypes: [
        { processId: PEPPOL_BIS_BILLING_PROFILE_ID, documentTypeId: PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID },
      ],
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://api-qa.qvalia.com/partner/SE5560000000/account/SE5560000000/peppol/0007%3A5595386219')
    expect(init?.method).toBe('PUT')
    const body = JSON.parse(String(init?.body))
    expect(body.businessCard).toEqual({
      companyName: 'Arcim Technology AB', countryCode: 'SE', geographicalInformation: 'Stockholm',
      VAT: 'SE559538621901', orgNr: '5595386219', suffix: '',
    })
    expect(body.docTypes).toEqual([{ profile: PEPPOL_BIS_BILLING_PROFILE_ID, document: PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID }])
    expect(result).toMatchObject({ status: 'registered', providerAccountReference: 'SE5560000000' })
  })

  it('treats an unregister of an unknown id as done and surfaces other failures', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
    await expect(transport.unregisterRecipient!({ scheme: '0007', identifier: '1' })).resolves.toBeUndefined()
    expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE')
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }))
    await expect(transport.unregisterRecipient!({ scheme: '0007', identifier: '1' })).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('lists unread inbound invoices through the marking endpoint and keeps the payload', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      status: 'success',
      data: [
        { integrationId: 'in-1', Invoice: { 'cbc:ID': [{ _: '20267497' }] } },
        { integrationId: 'in-2', Invoice: { 'cbc:ID': [{ _: '20267498' }] } },
      ],
    }))
    const messages = await transport.listInboundDocuments!({ documentType: 'Invoice', limit: 10 })
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api-qa.qvalia.com/partner/SE5560000000/transaction/SE5560000000/invoices/incoming/readinvoices?limit=10',
    )
    expect(messages.map((m) => m.providerDocumentId)).toEqual(['in-1', 'in-2'])
    expect(messages[0]).toMatchObject({ provider: 'qvalia', documentType: 'Invoice' })
    expect(messages[0].payload).toHaveProperty('Invoice')
  })

  it('re-syncs with includeRead, handles 204 as empty, and reads credit notes from their own collection', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await transport.listInboundDocuments!({ documentType: 'CreditNote', includeRead: true })).toEqual([])
    expect(String(fetchMock.mock.calls[0][0])).toContain('/creditnotes/incoming?includeRead=true&limit=25')
  })

  it('fetches the exact inbound XML and returns null when the provider has nothing', async () => {
    fetchMock.mockResolvedValueOnce(new Response(XML, { status: 200, headers: { 'content-type': 'application/xml' } }))
    expect(await transport.fetchInboundDocumentXml!('in-1', 'Invoice')).toBe(XML)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/invoices/incoming?integrationId=in-1&includeRead=true&limit=1')
    expect((init?.headers as Record<string, string>).accept).toBe('application/xml')
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await transport.fetchInboundDocumentXml!('in-2', 'Invoice')).toBeNull()
  })
})

describe('readQvaliaOutgoingStatus', () => {
  it('reads the message-log object the endpoint actually answers with', () => {
    expect(readQvaliaOutgoingStatus(processedA.data[0])).toEqual({ status: 'processed', updatedAt: '2026-09-29T19:11:47.070Z' })
    expect(readQvaliaOutgoingStatus(errorA.data[0])).toEqual({ status: 'error', updatedAt: '2026-09-28T13:55:29.357Z' })
  })

  it('reads a message without an outcome (create-only object, empty metadata) as no status', () => {
    expect(readQvaliaOutgoingStatus(created.data[0])).toEqual({ status: null, updatedAt: '2026-09-28T13:55:00.844Z' })
    expect(readQvaliaOutgoingStatus(emptyMetadata.data[0])).toEqual({ status: null, updatedAt: null })
  })

  it('reads the documented flat string; updatedAt from the object, else metadata, else the record', () => {
    expect(readQvaliaOutgoingStatus({ metadata: { status: 'processed', updatedAt: 'm' }, updatedAt: 'r' }))
      .toEqual({ status: 'processed', updatedAt: 'm' })
    expect(readQvaliaOutgoingStatus({ metadata: { status: 'processed' }, updatedAt: 'r' }))
      .toEqual({ status: 'processed', updatedAt: 'r' })
    expect(readQvaliaOutgoingStatus({ metadata: { status: { status: 'error', updatedAt: 'o' }, updatedAt: 'm' }, updatedAt: 'r' }))
      .toEqual({ status: 'error', updatedAt: 'o' })
    expect(readQvaliaOutgoingStatus({ metadata: { status: { status: 'error' }, updatedAt: 'm' }, updatedAt: 'r' }))
      .toEqual({ status: 'error', updatedAt: 'm' })
  })

  it.each([
    ['a number', { metadata: { status: 3 } }, 'metadata.status is number'],
    ['an array', { metadata: { status: ['processed'] } }, 'metadata.status is array'],
    ['null', { metadata: { status: null } }, 'metadata.status is null'],
    ['an object with a non-string status', { metadata: { status: { event: 'message-log/update', status: 200 } } }, 'metadata.status.status is number'],
    ['a record without metadata', { integrationId: 'int-1', readAt: null }, 'status record metadata is undefined'],
    ['a record that is not an object', 'processed', 'status record is string'],
  ])('throws a non-retryable shape error for %s instead of skipping it', (_label, record, detail) => {
    const error = thrown(() => readQvaliaOutgoingStatus(record))
    expect(error).toBeInstanceOf(QvaliaApiError)
    expect(error).toMatchObject({ ...SHAPE_ERROR, detail })
  })
})

describe('mapQvaliaOutgoingStatus', () => {
  it.each([
    [null, null],
    ['pending', null],
    ['delayed', null],
    ['warning', null],
    ['processed', { normalizedStatus: 'transport_succeeded', isTerminal: false }],
    ['processed_with_warning', { normalizedStatus: 'transport_succeeded', isTerminal: false }],
    ['error', { normalizedStatus: 'failed', isTerminal: true }],
    [' Processed ', { normalizedStatus: 'transport_succeeded', isTerminal: false }],
    ['ERROR', { normalizedStatus: 'failed', isTerminal: true }],
  ])('maps %j to %j', (status, expected) => {
    expect(mapQvaliaOutgoingStatus(status)).toEqual(expected)
  })

  it.each(['delivered', 'rejected', 'failed', ''])('throws on the undocumented value %j instead of guessing from its wording', (status) => {
    const error = thrown(() => mapQvaliaOutgoingStatus(status))
    expect(error).toBeInstanceOf(QvaliaApiError)
    expect(error).toMatchObject({ ...SHAPE_ERROR, detail: `undocumented outgoing status ${JSON.stringify(status)}` })
  })
})

describe('Qvalia transport: pollDeliveryStatus (sandbox answers)', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const transport = createQvaliaTransport(config, { fetch: fetchMock, now: () => new Date('2026-09-29T20:00:00.000Z') })

  beforeEach(() => {
    fetchMock.mockReset()
  })

  it.each([
    ['9f178d7a', 'processed', 'transport_succeeded', false, processedA],
    ['d3581a0b', 'processed', 'transport_succeeded', false, processedB],
    ['783b9b55', 'error', 'failed', true, errorA],
    ['9ff52b0e', 'error', 'failed', true, errorB],
  ] as const)('%s: records %s as %s (terminal: %s)', async (_label, status, normalizedStatus, isTerminal, fixture) => {
    const record = fixture.data[0]
    const { integrationId } = record
    const { updatedAt } = record.metadata.status
    fetchMock.mockResolvedValueOnce(jsonResponse(200, fixture))
    const events = await transport.pollDeliveryStatus!(integrationId)
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `https://api-qa.qvalia.com/partner/SE5560000000/transaction/SE5560000000/invoices/outgoing/status?integrationId=${integrationId}&includeRead=true&limit=1`,
    )
    expect(events).toEqual([{
      provider: 'qvalia',
      providerTenantId: transport.tenantId,
      providerSubmissionId: integrationId,
      providerEventId: `document_delivery:${integrationId}:${status}`,
      idempotencyKey: null,
      eventCode: 'status_poll',
      normalizedStatus,
      isTerminal,
      detail: status,
      occurredAt: updatedAt,
      rawPayload: record,
      eventSha256: sha256Hex(`${integrationId}:${status}:${updatedAt}`),
      verificationMethod: 'provider_poll',
    }])
  })

  it('gives the same transition the same identity on every poll, whatever the body looks like', async () => {
    const id = processedA.data[0].integrationId
    fetchMock.mockResolvedValueOnce(jsonResponse(200, processedA))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(processedA, null, 2), { status: 200 }))
    const [first] = await transport.pollDeliveryStatus!(id)
    const [second] = await transport.pollDeliveryStatus!(id)
    expect(second.providerEventId).toBe(first.providerEventId)
    expect(second.eventSha256).toBe(first.eventSha256)
  })

  it('yields nothing while the message has no outcome or a non-final one, for an empty data array, and for an id Qvalia does not know', async () => {
    const pending = { status: 'success', data: [{ ...created.data[0], metadata: { status: { event: 'message-log/update', status: 'pending', updatedAt: 't' } } }] }
    for (const body of [created, emptyMetadata, pending, { status: 'success', data: [] }]) {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, body))
      expect(await transport.pollDeliveryStatus!('int-1')).toEqual([])
    }
    // 204 is the sandbox's answer for an integrationId it does not know (captured 2026-09-29).
    for (const status of [204, 404]) {
      fetchMock.mockResolvedValueOnce(new Response(null, { status }))
      expect(await transport.pollDeliveryStatus!('int-1')).toEqual([])
    }
  })

  it('throws a non-retryable shape error for an answer it cannot read, instead of skipping the record', async () => {
    const cases: Array<[Response, string]> = [
      [jsonResponse(200, { status: 'success', data: [{ integrationId: 'int-1', metadata: { status: 7 } }] }), 'metadata.status is number'],
      [jsonResponse(200, { status: 'success', data: [{ integrationId: 'int-1', readAt: null }] }), 'status record metadata is undefined'],
      [jsonResponse(200, { status: 'success', data: [{ integrationId: 'int-1', metadata: { status: { event: 'message-log/update', status: 'bounced' } } }] }), 'undocumented outgoing status "bounced"'],
      [jsonResponse(200, { status: 'success' }), 'status answer without a data array (data: undefined)'],
      [jsonResponse(200, [{ integrationId: 'int-1', metadata: { status: 'processed' } }]), 'status answer without a data array (array body)'],
      [new Response('<html><body>Gateway</body></html>', { status: 200 }), 'status answer without a data array (non-JSON body)'],
      [new Response('', { status: 200 }), 'status answer without a data array (empty body)'],
    ]
    for (const [response, detail] of cases) {
      fetchMock.mockResolvedValueOnce(response)
      await expect(transport.pollDeliveryStatus!('int-1')).rejects.toMatchObject({ ...SHAPE_ERROR, detail })
    }
  })
})
