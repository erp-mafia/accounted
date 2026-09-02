import { describe, it, expect, vi } from 'vitest'
import { createConnectorPeppolTransport, CONNECTOR_PROVIDER } from '../connector'
import { isPeppolTransportError } from '@/lib/invoices/peppol-transport'

const upstream = { baseUrl: 'https://app.gnubok.se/api/connect/peppol', key: 'gnubok_ck_test' }
const participant = { scheme: '0007', identifier: '5561234567' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function build(fetchImpl: typeof fetch) {
  return createConnectorPeppolTransport(upstream, { fetch: fetchImpl })
}

describe('connector Peppol transport', () => {
  it('identifies as the connector provider and rewrites provider on everything it returns', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ provider: 'qvalia', providerSubmissionId: 'int-1', idempotencyKey: 'k', tenantReference: 'c1', acceptedAt: 't' }))
    const transport = build(fetchMock as unknown as typeof fetch)
    expect(transport.provider).toBe(CONNECTOR_PROVIDER)
    const receipt = await transport.submit({
      idempotencyKey: 'k', tenantReference: 'c1', sender: participant, recipient: participant,
      documentTypeId: 'd', processId: 'p', filename: 'f.xml', contentType: 'application/xml', document: '<x/>', documentSha256: 'a'.repeat(64),
    })
    expect(receipt.provider).toBe('connector')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://app.gnubok.se/api/connect/peppol/submit')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer gnubok_ck_test')
    expect(headers['X-Connector-Company']).toBe('c1')
  })

  it('sends the tenant as the company header on registration and refuses without one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'registered', participant, providerAccountReference: 'accounted-connector', raw: {} }))
    const transport = build(fetchMock as unknown as typeof fetch)
    const input = { participant, businessCard: { companyName: 'AB', countryCode: 'SE' }, documentTypes: [{ processId: 'p', documentTypeId: 'd' }] }
    await expect(transport.registerRecipient!(input)).rejects.toSatisfy((e: unknown) => isPeppolTransportError(e) && !e.retryable)
    const result = await transport.registerRecipient!({ ...input, tenantReference: 'company-1' })
    expect(result.participant).toEqual(participant)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://app.gnubok.se/api/connect/peppol/recipient')
    expect(init.method).toBe('PUT')
    expect((init.headers as Record<string, string>)['X-Connector-Company']).toBe('company-1')
  })

  it('unregisters through query parameters and lists inbound via the archive operation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse([{ provider: 'qvalia', providerDocumentId: 'doc-1', documentType: 'Invoice', payload: {}, receivedAt: null }]))
      .mockResolvedValueOnce(jsonResponse({ xml: '<Invoice/>' }))
      .mockResolvedValueOnce(jsonResponse({ xml: null }))
    const transport = build(fetchMock as unknown as typeof fetch)
    await transport.unregisterRecipient!(participant)
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://app.gnubok.se/api/connect/peppol/recipient?scheme=0007&identifier=5561234567')
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe('DELETE')
    const inbound = await transport.listInboundDocuments!({ documentType: 'Invoice', limit: 5 })
    expect(inbound).toEqual([{ provider: 'connector', providerDocumentId: 'doc-1', documentType: 'Invoice', payload: {}, receivedAt: null }])
    expect(await transport.fetchInboundDocumentXml!('doc-1', 'Invoice')).toBe('<Invoice/>')
    expect(await transport.fetchInboundDocumentXml!('doc-1', 'Invoice')).toBeNull()
  })

  it('polls status and evidence with the connector provider stamped on and the owning company resolved', async () => {
    const event = {
      provider: 'qvalia', providerTenantId: '5560000000', providerSubmissionId: 'int-1', providerEventId: 'e1', idempotencyKey: null,
      eventCode: 'status_poll', normalizedStatus: 'transport_succeeded', isTerminal: false, detail: null, occurredAt: 't',
      rawPayload: {}, eventSha256: 'a'.repeat(64), verificationMethod: 'provider_poll',
    }
    const evidence = {
      provider: 'qvalia', evidenceType: 'qvalia_message_record', payload: {}, exactDocument: null, exactDocumentSha256: null,
      evidenceSha256: 'b'.repeat(64), retrievedAt: 't',
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([event]))
      .mockResolvedValueOnce(jsonResponse([evidence]))
    const transport = createConnectorPeppolTransport(upstream, {
      fetch: fetchMock as unknown as typeof fetch,
      companyFor: async (id) => (id === 'int-1' ? 'company-7' : null),
    })
    expect(await transport.pollDeliveryStatus!('int-1')).toEqual([{ ...event, provider: 'connector' }])
    expect(await transport.retrieveEvidence('int-1')).toEqual([{ ...evidence, provider: 'connector' }])
    for (const call of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect((call[1].headers as Record<string, string>)['X-Connector-Company']).toBe('company-7')
    }
  })

  it('turns hosted refusals into PeppolTransportErrors carrying the retryable flag and code', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'quota', code: 'CONNECTOR_QUOTA_EXCEEDED', retryable: false }, 403))
      .mockResolvedValueOnce(jsonResponse({ error: 'busy', code: 'CONNECTOR_RATE_LIMITED' }, 429))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
    const transport = build(fetchMock as unknown as typeof fetch)
    await expect(transport.lookupRecipient(participant)).rejects.toSatisfy(
      (e: unknown) => isPeppolTransportError(e) && e.retryable === false && /CONNECTOR_QUOTA_EXCEEDED/.test(e.detail ?? ''),
    )
    await expect(transport.lookupRecipient(participant)).rejects.toSatisfy((e: unknown) => isPeppolTransportError(e) && e.retryable === true)
    await expect(transport.lookupRecipient(participant)).rejects.toSatisfy((e: unknown) => isPeppolTransportError(e) && e.retryable === true)
  })

  it('does not verify webhooks: the hosted service owns them', async () => {
    const transport = build(vi.fn() as unknown as typeof fetch)
    await expect(transport.verifyWebhook({ headers: new Headers(), rawBody: new Uint8Array() })).rejects.toSatisfy(
      (e: unknown) => isPeppolTransportError(e) && e.retryable === false,
    )
  })
})

describe('transport security', () => {
  it('refuses a plain-http hosted URL except for loopback', () => {
    expect(() => createConnectorPeppolTransport({ baseUrl: 'http://connect.example.se/api/connect/peppol', key: 'k' })).toThrow(/https/)
    expect(() => createConnectorPeppolTransport({ baseUrl: 'http://localhost:3000/api/connect/peppol', key: 'k' })).not.toThrow()
  })

  it('maps a stalled or failing body read to a retryable transport error', async () => {
    const stalled = { ok: true, status: 200, text: () => Promise.reject(new Error('body stalled')) } as unknown as Response
    const transport = build(vi.fn().mockResolvedValue(stalled) as unknown as typeof fetch)
    await expect(transport.lookupRecipient(participant)).rejects.toSatisfy((e: unknown) => isPeppolTransportError(e) && e.retryable === true)
  })
})

describe('contract validation', () => {
  it('rejects a hosted answer that does not match the contract as a non-retryable protocol error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ reachable: 'maybe' }))
    const transport = build(fetchMock as unknown as typeof fetch)
    await expect(transport.lookupRecipient(participant)).rejects.toSatisfy(
      (e: unknown) => isPeppolTransportError(e) && e.retryable === false && /unexpected response shape/.test(e.message),
    )
  })
})
