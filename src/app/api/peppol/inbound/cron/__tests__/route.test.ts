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

// The head count of companies with receiving on, read only when the cron skips.
const receiversCount = vi.hoisted(() => vi.fn())
const accessEq = vi.hoisted(() => vi.fn())

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => ({
    from: vi.fn((table: string) => table === 'peppol_access'
      ? { select: () => ({ eq: (...a: unknown[]) => { accessEq(...a); return { eq: (...b: unknown[]) => { accessEq(...b); return receiversCount() } } } }) }
      : undefined),
  }),
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
const withdrawMock = vi.fn()
const registerGrantedMock = vi.fn()
vi.mock('@/lib/invoices/peppol-registration', () => ({
  withdrawRevokedPeppolRegistrations: (...args: unknown[]) => withdrawMock(...args),
  registerGrantedPeppolReceivers: (...args: unknown[]) => registerGrantedMock(...args),
}))
const planRuleMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/invoices/peppol-plan-rule', () => ({
  applyPeppolPlanRule: (...args: unknown[]) => planRuleMock(...args),
}))
const proposeMock = vi.fn()
vi.mock('@/lib/operations/inbox-bank-match', () => ({
  proposeBankMatchForInboxItem: (...args: unknown[]) => proposeMock(...args),
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
    tenantId: 'SE5560000000',
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
const NO_PLAN_CHANGE = { enabled: [], paused: [], failed: [] }
const pages = () => logMock.error.mock.calls.filter(([, context]) => (context as { alert?: boolean } | undefined)?.alert === true)

describe('GET /api/peppol/inbound/cron', () => {
  let unregister: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'cron-secret'
    process.env.PEPPOL_TRANSPORT_PROVIDER = 'qvalia'
    syncMock.mockResolvedValue(cleanSync)
    reprocessMock.mockResolvedValue(cleanReprocess)
    withdrawMock.mockResolvedValue({ withdrawn: [], failed: [] })
    registerGrantedMock.mockResolvedValue({ registered: [], failed: [], skipped: [] })
    receiversCount.mockResolvedValue({ count: 0, error: null })
    planRuleMock.mockResolvedValue(NO_PLAN_CHANGE)
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
    expect(await response.json()).toEqual({ data: { skipped: true, reason: 'provider_selection_required', plan: NO_PLAN_CHANGE } })
    expect(syncMock).not.toHaveBeenCalled()
    expect(reprocessMock).not.toHaveBeenCalled()
    // No company asked to receive: said at info, nothing pages.
    expect(accessEq.mock.calls).toEqual([['status', 'enabled'], ['receive_enabled', true]])
    expect(logMock.info).toHaveBeenCalledWith('peppol inbound skipped; no company has receiving on', { reason: 'provider_selection_required' })
    expect(pages()).toHaveLength(0)
  })

  it('pages when it skips while companies have receiving on (accounted#115)', async () => {
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    receiversCount.mockResolvedValue({ count: 2, error: null })
    const response = await GET(request('cron-secret'))
    expect(response.status).toBe(200)
    expect(pages()).toEqual([[
      'peppol inbound skipped while companies have receiving on; their e-invoices are not fetched',
      { alert: true, reason: 'provider_selection_required', receivers: 2 },
    ]])
  })

  it('pages when it cannot tell whether anyone is waiting', async () => {
    process.env.PEPPOL_TRANSPORT_PROVIDER = 'not-registered-here'
    receiversCount.mockResolvedValue({ count: null, error: { message: 'statement timeout' } })
    const response = await GET(request('cron-secret'))
    expect(await response.json()).toEqual({ data: { skipped: true, reason: 'provider_adapter_unavailable', plan: NO_PLAN_CHANGE } })
    expect(logMock.error).toHaveBeenCalledWith('peppol inbound skipped, and the companies with receiving on could not be counted',
      expect.objectContaining({ message: 'statement timeout' }), { alert: true, reason: 'provider_adapter_unavailable' })
  })

  it('skips a send-only transport', async () => {
    unregister = registerPeppolTransport(makeTransport({ listInboundDocuments: undefined }))
    receiversCount.mockResolvedValue({ count: 1, error: null })
    const response = await GET(request('cron-secret'))
    expect(await response.json()).toEqual({ data: { skipped: true, reason: 'receiving_unsupported', plan: NO_PLAN_CHANGE } })
    expect(reprocessMock).not.toHaveBeenCalled()
    expect(pages()).toEqual([[expect.any(String), { alert: true, reason: 'receiving_unsupported', receivers: 1 }]])
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

    const syncArgs = syncMock.mock.calls[0][0] as { transport: PeppolTransport; deliver: (d: unknown) => unknown; deadline: number; functionEndsAt: number }
    const reprocessArgs = reprocessMock.mock.calls[0][0] as { transport: PeppolTransport; deliver: (d: unknown) => unknown; deadline: number }
    // Both passes are bounded inside the 300 s limit, and the reprocessing pass
    // keeps time of its own after a listing that used all of the first budget.
    const called = Date.now()
    expect(syncArgs.deadline).toBeGreaterThan(called + 100_000)
    expect(syncArgs.deadline).toBeLessThanOrEqual(called + 150_000)
    expect(reprocessArgs.deadline - syncArgs.deadline).toBe(90_000)
    // A listing that marks its page read may take until the reserve before the
    // function's 300 s end, not a fixed limit of the transport's own.
    expect(syncArgs.functionEndsAt - syncArgs.deadline).toBe(150_000)
    expect(syncArgs.transport).toBe(transport)
    expect(reprocessArgs.transport).toBe(transport)
    expect(reprocessArgs.deliver).toBe(syncArgs.deliver)
    deliverMock.mockResolvedValueOnce({ inboxItemId: 'item-1', xmlDocumentId: null })
    await reprocessArgs.deliver({ row: {}, companyId: 'c', document: {}, xml: null })
    expect(deliverMock).toHaveBeenCalledTimes(1)
    // Match on arrival: the delivered e-invoice is checked against the bank at once.
    expect(proposeMock).toHaveBeenCalledWith(expect.anything(), 'c', 'item-1', expect.anything())
    deliverMock.mockResolvedValueOnce({ inboxItemId: null, xmlDocumentId: null, holdReason: 'awaiting_xml' })
    await syncArgs.deliver({ row: {}, companyId: 'c', document: {}, xml: null })
    expect(proposeMock).toHaveBeenCalledTimes(1)

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

  it('applies the plan rule first, before the withdrawal, and reports what it switched', async () => {
    unregister = registerPeppolTransport(makeTransport())
    planRuleMock.mockResolvedValue({ enabled: ['c-paying'], paused: ['c-lapsed'], failed: [] })
    const body = await (await GET(request('cron-secret'))).json()
    expect(planRuleMock).toHaveBeenCalledTimes(1)
    expect(planRuleMock.mock.invocationCallOrder[0]).toBeLessThan(withdrawMock.mock.invocationCallOrder[0])
    expect(body.data.plan).toEqual({ enabled: ['c-paying'], paused: ['c-lapsed'], failed: [] })
    expect(logMock.info).toHaveBeenCalledWith('peppol access follows the plan', { enabled: ['c-paying'], paused: ['c-lapsed'] })
    expect(pages()).toHaveLength(0)
  })

  it('applies the plan rule even when no access point is switched on', async () => {
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    planRuleMock.mockResolvedValue({ enabled: ['c-paying'], paused: [], failed: [] })
    const body = await (await GET(request('cron-secret'))).json()
    expect(planRuleMock).toHaveBeenCalledTimes(1)
    expect(body.data).toMatchObject({ skipped: true, plan: { enabled: ['c-paying'] } })
  })

  it('pages when the plan rule fails, and still runs the rest', async () => {
    unregister = registerPeppolTransport(makeTransport())
    planRuleMock.mockResolvedValue({ enabled: [], paused: [], failed: [{ companyId: 'c-x', reason: 'boom' }] })
    await GET(request('cron-secret'))
    expect(pages()).toHaveLength(1)
    expect(pages()[0][1]).toMatchObject({ alert: true, failed: [{ companyId: 'c-x', reason: 'boom' }] })
    expect(syncMock).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    syncMock.mockResolvedValue(cleanSync)
    reprocessMock.mockResolvedValue(cleanReprocess)
    withdrawMock.mockResolvedValue({ withdrawn: [], failed: [] })
    registerGrantedMock.mockResolvedValue({ registered: [], failed: [], skipped: [] })
    planRuleMock.mockRejectedValue(new Error('grants read timed out'))
    const body = await (await GET(request('cron-secret'))).json()
    expect(body.data.plan).toEqual({ failed: true })
    expect(logMock.error).toHaveBeenCalledWith('peppol plan rule failed', expect.any(Error), { alert: true })
    expect(withdrawMock).toHaveBeenCalledTimes(1)
    expect(syncMock).toHaveBeenCalledTimes(1)
  })

  it('withdraws revoked registrations before the sync and reports them', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    withdrawMock.mockResolvedValue({ withdrawn: ['c-box'], failed: [] })
    const body = await (await GET(request('cron-secret'))).json()
    expect(withdrawMock).toHaveBeenCalledWith(expect.objectContaining({ transport }))
    expect(withdrawMock.mock.invocationCallOrder[0]).toBeLessThan(syncMock.mock.invocationCallOrder[0])
    expect(body.data.withdrawal).toEqual({ withdrawn: ['c-box'], failed: [] })
    expect(logMock.info).toHaveBeenCalledWith('peppol receiving withdrawn for revoked access', { companyIds: ['c-box'] })
    expect(pages()).toHaveLength(0)
  })

  it('pages on a failed withdrawal and still runs the sync', async () => {
    unregister = registerPeppolTransport(makeTransport())
    withdrawMock.mockResolvedValue({ withdrawn: [], failed: [{ companyId: 'c-box', reason: 'CONNECTOR_UPSTREAM_ERROR' }] })
    await GET(request('cron-secret'))
    expect(pages()).toHaveLength(1)
    expect(pages()[0][1]).toMatchObject({ alert: true, failed: [{ companyId: 'c-box', reason: 'CONNECTOR_UPSTREAM_ERROR' }] })
    expect(syncMock).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    syncMock.mockResolvedValue(cleanSync)
    reprocessMock.mockResolvedValue(cleanReprocess)
    withdrawMock.mockRejectedValue(new Error('db down'))
    const body = await (await GET(request('cron-secret'))).json()
    expect(body.data.withdrawal).toEqual({ failed: true })
    expect(logMock.error).toHaveBeenCalledWith('peppol receiving withdrawal failed', expect.any(Error), { alert: true })
    expect(syncMock).toHaveBeenCalledTimes(1)
  })

  it('registers granted receivers after the withdrawal and before the sync, and reports them', async () => {
    const transport = makeTransport()
    unregister = registerPeppolTransport(transport)
    const outcome = { registered: ['c-compiled'], failed: [], skipped: [{ companyId: 'c-ef', reason: 'PEPPOL_REGISTRATION_PERSONAL_NUMBER' }] }
    registerGrantedMock.mockResolvedValue(outcome)
    const body = await (await GET(request('cron-secret'))).json()
    expect(registerGrantedMock).toHaveBeenCalledWith(expect.objectContaining({ transport }))
    expect(withdrawMock.mock.invocationCallOrder[0]).toBeLessThan(registerGrantedMock.mock.invocationCallOrder[0])
    expect(registerGrantedMock.mock.invocationCallOrder[0]).toBeLessThan(syncMock.mock.invocationCallOrder[0])
    expect(body.data.registration).toEqual(outcome)
    expect(logMock.info).toHaveBeenCalledWith('peppol receiving registered for granted access', { companyIds: ['c-compiled'] })
    expect(pages()).toHaveLength(0)
  })

  it('pages on a failed registration and still runs the sync', async () => {
    unregister = registerPeppolTransport(makeTransport())
    registerGrantedMock.mockResolvedValue({
      registered: [], failed: [{ companyId: 'c-elsewhere', reason: 'CONNECTOR_PEPPOL_PARTICIPANT_PUBLISHED_ELSEWHERE' }], skipped: [],
    })
    await GET(request('cron-secret'))
    expect(pages()).toHaveLength(1)
    expect(pages()[0][1]).toMatchObject({ alert: true, failed: [{ companyId: 'c-elsewhere', reason: 'CONNECTOR_PEPPOL_PARTICIPANT_PUBLISHED_ELSEWHERE' }] })
    expect(syncMock).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    syncMock.mockResolvedValue(cleanSync)
    reprocessMock.mockResolvedValue(cleanReprocess)
    withdrawMock.mockResolvedValue({ withdrawn: [], failed: [] })
    registerGrantedMock.mockRejectedValue(new Error('db down'))
    const body = await (await GET(request('cron-secret'))).json()
    expect(body.data.registration).toEqual({ failed: true })
    expect(logMock.error).toHaveBeenCalledWith('peppol receiving registration failed', expect.any(Error), { alert: true })
    expect(syncMock).toHaveBeenCalledTimes(1)
  })
})
