import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPeppolTransport, type PeppolTransport } from '@/lib/invoices/peppol-transport'

const pollMock = vi.fn()

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => ({ from: vi.fn() }),
}))
vi.mock('@/lib/invoices/peppol-delivery-sync', () => ({
  pollOpenPeppolDeliveries: (...args: unknown[]) => pollMock(...args),
}))

import { GET } from '../route'

function request(secret: string | null): Request {
  return new Request('http://localhost:3000/api/peppol/outbound/status/cron', {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  })
}

function makeTransport(overrides: Partial<PeppolTransport> = {}): PeppolTransport {
  return {
    provider: 'qvalia',
    lookupRecipient: vi.fn(),
    submit: vi.fn(),
    verifyWebhook: vi.fn(),
    retrieveEvidence: vi.fn(),
    pollDeliveryStatus: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

describe('GET /api/peppol/outbound/status/cron', () => {
  let unregister: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'cron-secret'
    process.env.PEPPOL_TRANSPORT_PROVIDER = 'qvalia'
    pollMock.mockResolvedValue({ polled: 2, advanced: 1, unchanged: 1, failed: 0, errors: [] })
  })

  afterEach(() => {
    unregister?.()
    unregister = null
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    delete process.env.CRON_SECRET
  })

  it('rejects a call without the cron secret', async () => {
    unregister = registerPeppolTransport(makeTransport())
    expect((await GET(request(null))).status).toBe(401)
    expect(pollMock).not.toHaveBeenCalled()
  })

  it('is a truthful no-op without an access point or without polling support', async () => {
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    expect(await (await GET(request('cron-secret'))).json()).toEqual({ data: { skipped: true, reason: 'provider_selection_required' } })
    process.env.PEPPOL_TRANSPORT_PROVIDER = 'qvalia'
    unregister = registerPeppolTransport(makeTransport({ pollDeliveryStatus: undefined }))
    expect(await (await GET(request('cron-secret'))).json()).toEqual({ data: { skipped: true, reason: 'polling_unsupported' } })
  })

  it('polls the open deliveries and reports the summary', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    const response = await GET(request('cron-secret'))
    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({ polled: 2, advanced: 1 })
    expect((pollMock.mock.calls[0][0] as { transport: PeppolTransport }).transport).toBe(transport)
  })
})
