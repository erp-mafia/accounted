import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPeppolTransport, type PeppolTransport } from '@/lib/invoices/peppol-transport'

const pollMock = vi.fn()
const healthMock = vi.fn()
const serviceClient = vi.hoisted(() => ({ from: () => undefined }))
const logMock = vi.hoisted(() => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  return log
})

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => serviceClient,
}))
vi.mock('@/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logger')>()),
  createLogger: () => logMock,
}))
vi.mock('@/lib/invoices/peppol-delivery-sync', () => ({
  pollOpenPeppolDeliveries: (...args: unknown[]) => pollMock(...args),
}))
vi.mock('@/lib/invoices/peppol-health', () => ({
  runPeppolHealthCheck: (...args: unknown[]) => healthMock(...args),
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
    tenantId: 'SE5560000000',
    lookupRecipient: vi.fn(),
    submit: vi.fn(),
    verifyWebhook: vi.fn(),
    retrieveEvidence: vi.fn(),
    pollDeliveryStatus: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

const healthSummary = {
  skipped: null,
  found: { delivery_failed: 1, delivery_stuck: 0, delivery_retry_stuck: 0, inbound_unrouted: 0 },
  claimed: { delivery_failed: 1, delivery_stuck: 0, delivery_retry_stuck: 0, inbound_unrouted: 0 },
  digest: 'sent',
  senderMails: { sent: 1, failed: 0, noRecipient: 0 },
  released: 0,
}

describe('GET /api/peppol/outbound/status/cron', () => {
  let unregister: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'cron-secret'
    process.env.PEPPOL_TRANSPORT_PROVIDER = 'qvalia'
    pollMock.mockResolvedValue({ polled: 2, advanced: 1, unchanged: 1, failed: 0, errors: [] })
    healthMock.mockResolvedValue(healthSummary)
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
    expect(healthMock).not.toHaveBeenCalled()
  })

  it('is a truthful no-op without an access point or without polling support', async () => {
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    expect(await (await GET(request('cron-secret'))).json()).toEqual({ data: { skipped: true, reason: 'provider_selection_required' } })
    process.env.PEPPOL_TRANSPORT_PROVIDER = 'qvalia'
    unregister = registerPeppolTransport(makeTransport({ pollDeliveryStatus: undefined }))
    expect(await (await GET(request('cron-secret'))).json()).toEqual({ data: { skipped: true, reason: 'polling_unsupported' } })
    expect(healthMock).not.toHaveBeenCalled()
  })

  it('polls the open deliveries and reports the summary', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    const response = await GET(request('cron-secret'))
    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({ polled: 2, advanced: 1 })
    expect((pollMock.mock.calls[0][0] as { transport: PeppolTransport }).transport).toBe(transport)
  })

  it('runs the health check after the poll, on the same service client, and logs its summary with the poll', async () => {
    unregister = registerPeppolTransport(makeTransport())
    const response = await GET(request('cron-secret'))

    expect(response.status).toBe(200)
    expect(healthMock).toHaveBeenCalledTimes(1)
    expect(pollMock.mock.invocationCallOrder[0]).toBeLessThan(healthMock.mock.invocationCallOrder[0])
    expect(healthMock.mock.calls[0][0]).toBe(serviceClient)
    expect((pollMock.mock.calls[0][0] as { service: unknown }).service).toBe(serviceClient)
    expect((await response.json()).data).toMatchObject({ polled: 2, health: healthSummary })
    expect(logMock.info).toHaveBeenCalledWith(
      'peppol outbound status poll complete',
      expect.objectContaining({ polled: 2, errors: 0, health: healthSummary }),
    )
  })

  it('survives a failing health check: the poll still answers 200 and the failure pages', async () => {
    unregister = registerPeppolTransport(makeTransport())
    healthMock.mockRejectedValue(new Error('Failed to claim Peppol alerts: connection reset'))

    const response = await GET(request('cron-secret'))

    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({ polled: 2, health: { failed: true } })
    expect(logMock.error).toHaveBeenCalledWith('peppol health check failed', expect.any(Error), { alert: true })
    expect(logMock.info).toHaveBeenCalledWith(
      'peppol outbound status poll complete',
      expect.objectContaining({ health: { failed: true } }),
    )
  })
})
