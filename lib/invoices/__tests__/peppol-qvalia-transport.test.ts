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
  normalizePeppolDocumentTypeId,
  normalizeQvaliaWebhook,
  readQvaliaConfigFromEnv,
  type QvaliaConfig,
} from '@/lib/invoices/transports/qvalia'
import { registerConfiguredPeppolTransports } from '@/lib/invoices/transports'
import { getPeppolTransport } from '@/lib/invoices/peppol-transport'

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
    })
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
          ID: [{ _: 'F-2026-42' }],
          AccountingSupplierParty: [{ Party: [{ EndpointID: [{ _: '556016-0680', schemeID: '0007' }] }] }],
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
    const fetchMock = vi.fn<typeof fetch>()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [{ uuid: 'int-1', readAt: null, metadata: { status: 'processed' } }]))
    fetchMock.mockResolvedValueOnce(new Response(XML, { status: 200, headers: { 'content-type': 'application/xml' } }))
    const transport = createQvaliaTransport(config, {
      fetch: fetchMock,
      now: () => new Date('2026-08-21T11:00:00.000Z'),
    })

    const [evidence] = await transport.retrieveEvidence('int-1')

    expect(String(fetchMock.mock.calls[0][0])).toContain('/invoices/outgoing/status?integrationId=int-1')
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>).accept).toBe('application/xml')
    expect(evidence).toMatchObject({
      provider: 'qvalia',
      evidenceType: 'qvalia_message_record',
      exactDocument: XML,
      exactDocumentSha256: sha256Hex(XML),
      retrievedAt: '2026-08-21T11:00:00.000Z',
    })
    expect(evidence.payload).toMatchObject({ integrationId: 'int-1', status: [{ uuid: 'int-1' }] })
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
    expect(extractUblJsonSupplierEndpoint({ Invoice: {} })).toBeNull()
  })

  it('describes Qvalia error bodies from the documented envelopes', () => {
    expect(describeQvaliaErrorBody({ statusCode: 400, error: 'Bad Request', message: 'missing ID' })).toBe('missing ID')
    expect(describeQvaliaErrorBody({ metadata: { details: { rule: 'BR-01' } } })).toBe('{"rule":"BR-01"}')
    expect(describeQvaliaErrorBody('plain text')).toBe('plain text')
    expect(describeQvaliaErrorBody(null)).toBeNull()
  })
})
