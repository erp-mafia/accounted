import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPeppolTransport, type PeppolTransport } from '@/lib/invoices/peppol-transport'

const syncMock = vi.fn()
const reprocessMock = vi.fn()
const deliverMock = vi.fn()
const logMock = vi.hoisted(() => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  return log
})

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => ({ from: vi.fn() }),
}))
vi.mock('@/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logger')>()),
  createLogger: () => logMock,
}))
vi.mock('@/lib/invoices/peppol-inbound', () => ({
  syncInboundPeppolDocuments: (...args: unknown[]) => syncMock(...args),
  reprocessInboundPeppolDocuments: (...args: unknown[]) => reprocessMock(...args),
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

const cleanSync = { listed: 1, archived: 1, duplicates: 0, routed: 0, unrouted: 0, delivered: 1, failed: 0, terminal: 0, terminalDocuments: [], errors: [] }
const cleanReprocess = { candidates: 2, xmlFetched: 1, xmlMissed: 0, retried: 0, held: 0, routed: 1, delivered: 1, terminal: 0, terminalDocuments: [], errors: [] }
const pages = () => logMock.error.mock.calls.filter(([, context]) => (context as { alert?: boolean } | undefined)?.alert === true)

describe('GET /api/peppol/inbound/cron', () => {
  let unregister: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'cron-secret'
    process.env.PEPPOL_TRANSPORT_PROVIDER = 'qvalia'
    syncMock.mockResolvedValue(cleanSync)
    reprocessMock.mockResolvedValue(cleanReprocess)
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
    expect(reprocessMock).not.toHaveBeenCalled()
  })

  it('is a truthful no-op when no access point is switched on', async () => {
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    const response = await GET(request('cron-secret'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { skipped: true, reason: 'provider_selection_required' } })
    expect(syncMock).not.toHaveBeenCalled()
    expect(reprocessMock).not.toHaveBeenCalled()
  })

  it('skips a send-only transport', async () => {
    unregister = registerPeppolTransport(makeTransport({ listInboundDocuments: undefined }))
    const response = await GET(request('cron-secret'))
    expect(await response.json()).toEqual({ data: { skipped: true, reason: 'receiving_unsupported' } })
    expect(reprocessMock).not.toHaveBeenCalled()
  })

  it('runs the sync, then the reprocessing pass with the same deliverer, and reports both', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    const response = await GET(request('cron-secret'))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.data).toMatchObject({ listed: 1, delivered: 1, reprocess: cleanReprocess })
    expect(syncMock).toHaveBeenCalledTimes(1)
    expect(reprocessMock).toHaveBeenCalledTimes(1)
    expect(syncMock.mock.invocationCallOrder[0]).toBeLessThan(reprocessMock.mock.invocationCallOrder[0])

    const syncArgs = syncMock.mock.calls[0][0] as { transport: PeppolTransport; deliver: (d: unknown) => unknown }
    const reprocessArgs = reprocessMock.mock.calls[0][0] as { transport: PeppolTransport; deliver: (d: unknown) => unknown }
    expect(syncArgs.transport).toBe(transport)
    expect(reprocessArgs.transport).toBe(transport)
    expect(reprocessArgs.deliver).toBe(syncArgs.deliver)
    await reprocessArgs.deliver({ row: {}, companyId: 'c', document: {}, xml: null })
    expect(deliverMock).toHaveBeenCalledTimes(1)

    expect(logMock.info).toHaveBeenCalledWith('peppol inbound reprocess complete', expect.objectContaining({ candidates: 2, errors: 0 }))
    expect(logMock.error).not.toHaveBeenCalled()
  })

  it('pages exactly once per run when the reprocessing pass leaves real failures', async () => {
    unregister = registerPeppolTransport(makeTransport())
    reprocessMock.mockResolvedValue({
      ...cleanReprocess,
      errors: [
        { id: 'doc-a', providerDocumentId: 'pd-a', reason: 'connection reset' },
        { id: 'doc-b', providerDocumentId: 'pd-b', reason: 'storage down' },
      ],
    })
    const response = await GET(request('cron-secret'))
    expect(response.status).toBe(200)
    expect(logMock.warn).toHaveBeenCalledWith(
      'peppol inbound reprocess left failures to retry',
      expect.objectContaining({ ids: ['doc-a', 'doc-b'] }),
    )
    expect(pages()).toHaveLength(1)
    expect(pages()[0][1]).toMatchObject({
      alert: true, errorCount: 2, reprocessErrorIds: ['doc-a', 'doc-b'], syncErrorProviderDocumentIds: [], terminalCount: 0,
    })
  })

  it('pages once for listing-sync failures too, even when the reprocessing pass is clean', async () => {
    unregister = registerPeppolTransport(makeTransport())
    syncMock.mockResolvedValue({
      ...cleanSync, failed: 1,
      errors: [
        { providerDocumentId: 'list:CreditNote', reason: 'Qvalia answered 503' },
        { providerDocumentId: 'pd-old', reason: 'Failed to archive inbound Peppol document: connection failure' },
      ],
    })
    reprocessMock.mockResolvedValue(cleanReprocess)
    const response = await GET(request('cron-secret'))
    expect(response.status).toBe(200)
    expect(pages()).toHaveLength(1)
    expect(pages()[0][1]).toMatchObject({
      alert: true,
      errorCount: 2,
      syncErrorProviderDocumentIds: ['list:CreditNote', 'pd-old'],
      reprocessErrorIds: [],
      errorReasons: [
        'sync list:CreditNote: Qvalia answered 503',
        'sync pd-old: Failed to archive inbound Peppol document: connection failure',
      ],
      terminalCount: 0,
    })
  })

  it('pages once, listing provider document ids, when a document became terminal in this run', async () => {
    unregister = registerPeppolTransport(makeTransport())
    syncMock.mockResolvedValue({
      ...cleanSync, terminal: 1,
      terminalDocuments: [{ id: 'stub-1', providerDocumentId: 'pd-stub', reason: 'terminal: payload unarchivable: check' }],
    })
    reprocessMock.mockResolvedValue({
      ...cleanReprocess, terminal: 1,
      terminalDocuments: [{ id: 'doc-x', providerDocumentId: 'pd-x', reason: 'terminal: xml unavailable upstream after 3 attempts' }],
    })
    await GET(request('cron-secret'))
    expect(pages()).toHaveLength(1)
    expect(pages()[0][1]).toMatchObject({
      alert: true,
      errorCount: 0,
      terminalCount: 2,
      terminalProviderDocumentIds: ['pd-stub', 'pd-x'],
      terminalReasons: ['pd-stub: terminal: payload unarchivable: check', 'pd-x: terminal: xml unavailable upstream after 3 attempts'],
    })
  })

  it('does not page for old terminal rows, transport retries, XML misses under budget or held documents', async () => {
    unregister = registerPeppolTransport(makeTransport())
    // Old terminal rows are not candidates, so the pass reports terminal: 0 for them.
    reprocessMock.mockResolvedValue({ ...cleanReprocess, retried: 4, xmlMissed: 2, held: 3, terminal: 0 })
    await GET(request('cron-secret'))
    expect(logMock.warn).not.toHaveBeenCalledWith('peppol inbound reprocess left failures to retry', expect.anything())
    expect(logMock.error).not.toHaveBeenCalled()
    expect(pages()).toHaveLength(0)
  })
})
