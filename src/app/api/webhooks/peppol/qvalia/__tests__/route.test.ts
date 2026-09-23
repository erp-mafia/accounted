import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpcMock = vi.fn()
const maybeSingleMock = vi.fn()
const fromMock = vi.fn()

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
  }),
}))

const fetchMock = vi.fn<typeof fetch>()

import { POST } from '../route'

const SECRET = 'shared-secret-1234567890'
const ENV = {
  QVALIA_API_KEY: 'k',
  QVALIA_PARTNER_REG_NO: 'SE5560000000',
  QVALIA_BASE_URL: 'https://api-qa.qvalia.com',
  QVALIA_WEBHOOK_SECRET: SECRET,
}

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

function request(body: unknown, secret: string | null = SECRET): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (secret) headers['X-Accounted-Webhook-Key'] = secret
  return new Request('http://localhost:3000/api/webhooks/peppol/qvalia', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function queryChain(result: { data: unknown; error: unknown }) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: maybeSingleMock.mockResolvedValue(result),
  }
  return chain
}

describe('POST /api/webhooks/peppol/qvalia', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(process.env, ENV)
    vi.stubGlobal('fetch', fetchMock)
    rpcMock.mockResolvedValue({ data: { id: 'delivery-1' }, error: null })
    fromMock.mockReturnValue(queryChain({
      data: { company_id: 'company-1', idempotency_key: '33333333-3333-4333-8333-333333333333' },
      error: null,
    }))
    // Evidence retrieval: status list, then XML copy.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ uuid: 'int-1', metadata: { status: 'processed' } }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    fetchMock.mockResolvedValueOnce(new Response('<Invoice/>', {
      status: 200,
      headers: { 'content-type': 'application/xml' },
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const key of Object.keys(ENV)) delete process.env[key]
  })

  it('answers 503 when the webhook secret is not configured', async () => {
    delete process.env.QVALIA_WEBHOOK_SECRET
    const response = await POST(request(delivered))
    expect(response.status).toBe(503)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('answers 401 for a missing or wrong shared secret and records nothing', async () => {
    expect((await POST(request(delivered, null))).status).toBe(401)
    expect((await POST(request(delivered, 'wrong'))).status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('answers 400 for a body that is not JSON', async () => {
    const response = await POST(request('not json'))
    expect(response.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('resolves the delivery by integrationId, records the verified event and stores evidence', async () => {
    const response = await POST(request(delivered))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ received: true, recorded: 1, unmatched: 0, failed: 0 })

    expect(fromMock).toHaveBeenCalledWith('peppol_deliveries')
    const eventCall = rpcMock.mock.calls.find((call) => call[0] === 'record_peppol_delivery_event')
    expect(eventCall?.[1]).toMatchObject({
      p_company_id: 'company-1',
      p_idempotency_key: '33333333-3333-4333-8333-333333333333',
      p_provider: 'qvalia',
      p_provider_submission_id: 'int-1',
      p_provider_event_id: 'document_delivery:int-1:processed',
      p_normalized_status: 'transport_succeeded',
      p_is_terminal: false,
      p_verification_method: 'shared_secret_header',
    })
    const evidenceCall = rpcMock.mock.calls.find((call) => call[0] === 'record_peppol_delivery_evidence')
    expect(evidenceCall?.[1]).toMatchObject({
      p_company_id: 'company-1',
      p_provider: 'qvalia',
      p_evidence_type: 'qvalia_message_record',
      p_document_payload: '<Invoice/>',
    })
  })

  it('acknowledges events for unknown submissions with 200 so Qvalia stops retrying', async () => {
    fromMock.mockReturnValue(queryChain({ data: null, error: null }))
    const response = await POST(request(delivered))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: true, recorded: 0, unmatched: 1, failed: 0 })
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('ignores inbound-direction events and never touches the database for them', async () => {
    const response = await POST(request({ ...delivered, direction: 'incoming', eventType: 'new_document' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: true, recorded: 0, unmatched: 0, failed: 0 })
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('answers 500 when our own persistence fails so Qvalia retries later', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'db down' } })
    const response = await POST(request(delivered))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ received: true, recorded: 0, failed: 1 })
  })

  it('keeps the verified event when evidence retrieval fails', async () => {
    fetchMock.mockReset()
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const response = await POST(request(delivered))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: true, recorded: 1, unmatched: 0, failed: 0 })
    expect(rpcMock.mock.calls.filter((call) => call[0] === 'record_peppol_delivery_evidence')).toHaveLength(0)
  })
})
