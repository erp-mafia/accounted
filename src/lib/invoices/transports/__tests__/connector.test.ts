import { afterEach, describe, it, expect, vi } from 'vitest'
import { createConnectorPeppolTransport, CONNECTOR_PROVIDER } from '../connector'
import { isPeppolTransportError, type PeppolTransport, type PeppolTransportError } from '@/lib/invoices/peppol-transport'

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
    // The label the send writes on the delivery row with its first event.
    expect(transport.tenantId).toBe('connector')
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

  it('sends a resend\'s replacesSubmissionId in the body and carries a duplicate invoice number as its non-retryable code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      error: 'Qvalia already holds an invoice with this number for this receiver',
      code: 'PEPPOL_DUPLICATE_INVOICE_NUMBER',
      retryable: false,
      detail: 'Duplicate Invoice, F-1 request rejected!',
    }, 409))
    const transport = build(fetchMock as unknown as typeof fetch)
    const error = await transport.submit({
      idempotencyKey: 'k', tenantReference: 'c1', sender: participant, recipient: participant,
      documentTypeId: 'd', processId: 'p', filename: 'f.xml', contentType: 'application/xml', document: '<x/>', documentSha256: 'a'.repeat(64),
      replacesSubmissionId: 'int-failed',
    }).catch((e: unknown) => e)

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.replacesSubmissionId).toBe('int-failed')
    expect(error).toMatchObject({
      code: 'PEPPOL_DUPLICATE_INVOICE_NUMBER',
      retryable: false,
      detail: 'Duplicate Invoice, F-1 request rejected!',
    })
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

  it('passes the listing cursor through when set and leaves it out otherwise', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse([]))
    const transport = build(fetchMock as unknown as typeof fetch)
    await transport.listInboundDocuments!({ documentType: 'Invoice', limit: 5, receivedAfter: '2026-09-01T00:00:00.000Z' })
    await transport.listInboundDocuments!({ documentType: 'CreditNote' })
    const first = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    const second = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string)
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://app.gnubok.se/api/connect/peppol/inbound/list')
    expect(first).toEqual({ documentType: 'Invoice', limit: 5, receivedAfter: '2026-09-01T00:00:00.000Z' })
    expect(second).toEqual({ documentType: 'CreditNote' })
  })

  it('polls status and evidence with the connector provider stamped on and the owning company resolved', async () => {
    const event = {
      provider: 'qvalia', providerTenantId: 'SE5595386219', providerSubmissionId: 'int-1', providerEventId: 'e1', idempotencyKey: null,
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
    // The access point's own account number never reaches the instance: the
    // event carries the label the send wrote on the delivery row.
    expect(await transport.pollDeliveryStatus!('int-1')).toEqual([{ ...event, provider: 'connector', providerTenantId: 'connector' }])
    expect(await transport.retrieveEvidence('int-1')).toEqual([{ ...evidence, provider: 'connector' }])
    for (const call of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect((call[1].headers as Record<string, string>)['X-Connector-Company']).toBe('company-7')
    }
  })

  it.each([
    ['the access point account number', 'SE5595386219'],
    ['no tenant at all', null],
    ['a tenant label of its own', 'accounted-connect'],
  ])('labels every polled event with the connector tenant whatever the service sent (%s)', async (_label, tenant) => {
    const event = (status: string, id: string) => ({
      provider: 'qvalia', providerTenantId: tenant, providerSubmissionId: 'int-1', providerEventId: id, idempotencyKey: null,
      eventCode: 'status_poll', normalizedStatus: status, isTerminal: status === 'failed', detail: status, occurredAt: 't',
      rawPayload: { accountRegNo: 'SE5595386219' }, eventSha256: 'c'.repeat(64), verificationMethod: 'provider_poll',
    })
    const transport = build(vi.fn().mockResolvedValue(jsonResponse([
      event('transport_succeeded', 'e1'),
      event('failed', 'e2'),
    ])) as unknown as typeof fetch)
    const events = await transport.pollDeliveryStatus!('int-1')
    expect(events).toHaveLength(2)
    for (const polled of events) {
      expect(polled).toMatchObject({ provider: 'connector', providerTenantId: 'connector', providerSubmissionId: 'int-1' })
    }
    expect(events.map((e) => e.normalizedStatus)).toEqual(['transport_succeeded', 'failed'])
  })

  it('turns hosted refusals into PeppolTransportErrors carrying the retryable flag, the code and the bare detail', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'quota', code: 'CONNECTOR_QUOTA_EXCEEDED', retryable: false, detail: 'slot 11 of 10' }, 403))
      .mockResolvedValueOnce(jsonResponse({ error: 'busy', code: 'CONNECTOR_RATE_LIMITED' }, 429))
      .mockResolvedValueOnce(jsonResponse({ error: 'Qvalia answered 500', code: 'CONNECTOR_UPSTREAM_ERROR', detail: 'Something went wrong with the request' }, 502))
      .mockResolvedValueOnce(new Response('gateway timeout', { status: 504 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
    const transport = build(fetchMock as unknown as typeof fetch)
    const failures: unknown[] = []
    for (let i = 0; i < 5; i += 1) {
      failures.push(await transport.lookupRecipient(participant).catch((e: unknown) => e))
    }
    expect(failures.every(isPeppolTransportError)).toBe(true)
    const [quota, busy, upstream, plain, network] = failures as PeppolTransportError[]
    // The code travels on its own; detail is the hosted detail and nothing else.
    expect(quota).toMatchObject({ retryable: false, code: 'CONNECTOR_QUOTA_EXCEEDED', detail: 'slot 11 of 10', message: 'Connector: quota' })
    expect(busy).toMatchObject({ retryable: true, code: 'CONNECTOR_RATE_LIMITED', detail: null })
    expect(upstream).toMatchObject({
      retryable: true,
      code: 'CONNECTOR_UPSTREAM_ERROR',
      detail: 'Something went wrong with the request',
      message: 'Connector: Qvalia answered 500',
    })
    expect(upstream.detail).not.toMatch(/CONNECTOR_UPSTREAM_ERROR/)
    // No envelope: the status is the code.
    expect(plain).toMatchObject({ retryable: true, code: 'HTTP_504', detail: null })
    expect(network).toMatchObject({ retryable: true, code: 'CONNECTOR_UNREACHABLE' })
  })

  it('codes the missing tenant reference on registration', async () => {
    const transport = build(vi.fn() as unknown as typeof fetch)
    await expect(transport.registerRecipient!({
      participant, businessCard: { companyName: 'AB', countryCode: 'SE' }, documentTypes: [],
    })).rejects.toMatchObject({ retryable: false, code: 'CONNECTOR_COMPANY_MISSING' })
  })

  it('does not verify webhooks: the hosted service owns them', async () => {
    const transport = build(vi.fn() as unknown as typeof fetch)
    await expect(transport.verifyWebhook({ headers: new Headers(), rawBody: new Uint8Array() })).rejects.toSatisfy(
      (e: unknown) => isPeppolTransportError(e) && e.retryable === false,
    )
  })
})

describe('per-operation timeouts', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Like fetch: nothing but the request's signal ends the wait. */
  function hangingFetch() {
    const signals: AbortSignal[] = []
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal
      signals.push(signal)
      signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
    }))
    return { fetchImpl, signals }
  }

  const submission = {
    idempotencyKey: 'k', tenantReference: 'c1', sender: participant, recipient: participant,
    documentTypeId: 'd', processId: 'p', filename: 'f.xml', contentType: 'application/xml' as const, document: '<x/>', documentSha256: 'a'.repeat(64),
  }
  const registration = {
    participant, businessCard: { companyName: 'AB', countryCode: 'SE' }, documentTypes: [{ processId: 'p', documentTypeId: 'd' }], tenantReference: 'c1',
  }

  // The ladder: Qvalia call 20 s < Connect route 45 s < hosted submit 50 s < hosted route 90 s.
  it.each<[string, number, (t: PeppolTransport) => Promise<unknown>]>([
    ['lookup', 25_000, (t) => t.lookupRecipient(participant)],
    ['submit', 50_000, (t) => t.submit(submission)],
    ['register', 50_000, (t) => t.registerRecipient!(registration)],
    ['unregister', 50_000, (t) => t.unregisterRecipient!(participant)],
    ['status', 30_000, (t) => t.pollDeliveryStatus!('int-1')],
    ['evidence', 30_000, (t) => t.retrieveEvidence('int-1')],
    ['inbound list', 30_000, (t) => t.listInboundDocuments!({ documentType: 'Invoice' })],
    ['inbound xml', 30_000, (t) => t.fetchInboundDocumentXml!('doc-1', 'Invoice')],
  ])('gives up on %s after %i ms, as a retryable unreachable failure', async (_operation, timeoutMs, run) => {
    vi.useFakeTimers()
    const { fetchImpl, signals } = hangingFetch()
    const outcome = run(build(fetchImpl as unknown as typeof fetch)).catch((e: unknown) => e)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(timeoutMs - 1)
    expect(signals[0].aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signals[0].aborted).toBe(true)
    expect(await outcome).toMatchObject({ retryable: true, code: 'CONNECTOR_UNREACHABLE' })
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
      (e: unknown) => isPeppolTransportError(e) && e.retryable === false && /unexpected response shape/.test(e.message)
        && e.code === 'CONNECTOR_PROTOCOL_ERROR',
    )
  })
})
