import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPeppolTransport, type PeppolTransport } from '@/lib/invoices/peppol-transport'

const syncMock = vi.fn()
const deliverMock = vi.fn()

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => ({ from: vi.fn() }),
}))
vi.mock('@/lib/invoices/peppol-inbound', () => ({
  syncInboundPeppolDocuments: (...args: unknown[]) => syncMock(...args),
}))
vi.mock('@/lib/invoices/peppol-inbox-delivery', () => ({
  deliverPeppolDocumentToInbox: (...args: unknown[]) => deliverMock(...args),
}))

import { GET } from '../route'

function request(secret: string | null): Request {
  return new Request('http://localhost:3000/api/peppol/inbound/cron', {
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
    listInboundDocuments: vi.fn().mockResolvedValue([]),
    fetchInboundDocumentXml: vi.fn(),
    ...overrides,
  }
}

describe('GET /api/peppol/inbound/cron', () => {
  let unregister: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'cron-secret'
    process.env.PEPPOL_TRANSPORT_PROVIDER = 'qvalia'
    syncMock.mockResolvedValue({ listed: 1, archived: 1, duplicates: 0, routed: 0, unrouted: 0, delivered: 1, failed: 0, errors: [] })
  })

  afterEach(() => {
    unregister?.()
    unregister = null
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    delete process.env.CRON_SECRET
  })

  it('rejects a call without the cron secret', async () => {
    unregister = registerPeppolTransport(makeTransport())
    const response = await GET(request(null))
    expect(response.status).toBe(401)
    expect(syncMock).not.toHaveBeenCalled()
  })

  it('is a truthful no-op when no access point is switched on', async () => {
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    const response = await GET(request('cron-secret'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { skipped: true, reason: 'provider_selection_required' } })
    expect(syncMock).not.toHaveBeenCalled()
  })

  it('skips a send-only transport', async () => {
    unregister = registerPeppolTransport(makeTransport({ listInboundDocuments: undefined }))
    const response = await GET(request('cron-secret'))
    expect(await response.json()).toEqual({ data: { skipped: true, reason: 'receiving_unsupported' } })
  })

  it('runs the sync with the inbox deliverer and reports the summary', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    const response = await GET(request('cron-secret'))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.data).toMatchObject({ listed: 1, delivered: 1 })
    expect(syncMock).toHaveBeenCalledTimes(1)
    const args = syncMock.mock.calls[0][0] as { transport: PeppolTransport; deliver: (d: unknown) => unknown }
    expect(args.transport).toBe(transport)
    await args.deliver({ row: {}, companyId: 'c', document: {}, xml: null })
    expect(deliverMock).toHaveBeenCalledTimes(1)
  })
})
