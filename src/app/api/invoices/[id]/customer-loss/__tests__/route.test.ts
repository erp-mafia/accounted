/**
 * /api/invoices/[id]/customer-loss (GET, POST) through the real
 * withRouteContext: 401 without a session, 400 on a bad request, 404 for an
 * unknown invoice, 503 while CUSTOMER_LOSS_ENABLED is off, each kind's
 * service called with the person and the date, and a refusal answered with
 * its registered code. The services themselves are tested in
 * lib/customer-loss/__tests__.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const INVOICE_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
  isCompanyAdmin: vi.fn().mockResolvedValue(true),
  companyAdminRequiredResponse: vi.fn(),
}))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}), createServiceClient: () => ({}) }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const doubtful = vi.fn()
const confirmed = vi.fn()
const recovered = vi.fn()
const loadState = vi.fn()
vi.mock('@/lib/customer-loss/doubtful', () => ({ recordDoubtfulLoss: (...a: unknown[]) => doubtful(...a) }))
vi.mock('@/lib/customer-loss/confirmed', () => ({ recordConfirmedLoss: (...a: unknown[]) => confirmed(...a) }))
vi.mock('@/lib/customer-loss/recovered', () => ({ recordRecoveredLoss: (...a: unknown[]) => recovered(...a) }))
vi.mock('@/lib/customer-loss/state', () => ({ loadCustomerLossState: (...a: unknown[]) => loadState(...a) }))
vi.mock('@/lib/customer-loss/view', () => ({ buildCustomerLossView: (_s: unknown, o: { enabled: boolean }) => ({ enabled: o.enabled }) }))

import { GET, POST } from '../route'

function call(handler: typeof GET, method: 'GET' | 'POST', id: string, body?: unknown): Promise<Response> {
  return handler(
    new Request(`http://localhost/api/invoices/${id}/customer-loss`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

const OK = { ok: true, writeOffId: 'w-1', journalEntryId: 'je-1', invoiceStatus: 'written_off', amount: 1250 }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('CUSTOMER_LOSS_ENABLED', '1')
  requireAuthMock.mockResolvedValue({ user: { id: USER_ID, email: 'a@test.se', is_anonymous: false }, supabase: {}, error: null })
  loadState.mockResolvedValue({ ok: true, state: {} })
})
afterEach(() => vi.unstubAllEnvs())

describe('authentication and validation', () => {
  it('answers 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: null,
      error: new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }),
    })
    expect((await call(GET, 'GET', INVOICE_ID)).status).toBe(401)
    expect((await call(POST, 'POST', INVOICE_ID, { kind: 'doubtful', reason: 'x' })).status).toBe(401)
  })

  it('answers 400 on a bad id or body', async () => {
    expect((await call(POST, 'POST', 'not-a-uuid', { kind: 'doubtful', reason: 'x' })).status).toBe(400)
    expect((await call(POST, 'POST', INVOICE_ID, { kind: 'doubtful' })).status).toBe(400)
    expect((await call(POST, 'POST', INVOICE_ID, { kind: 'recovered', reason: 'x' })).status).toBe(400)
    expect((await call(POST, 'POST', INVOICE_ID, { kind: 'written_off', reason: 'x' })).status).toBe(400)
    expect(doubtful).not.toHaveBeenCalled()
  })

  it('answers 404 for an invoice it cannot see', async () => {
    loadState.mockResolvedValue({ ok: false, code: 'CUSTOMER_LOSS_INVOICE_NOT_FOUND' })
    expect((await call(GET, 'GET', INVOICE_ID)).status).toBe(404)
    doubtful.mockResolvedValue({ ok: false, code: 'CUSTOMER_LOSS_INVOICE_NOT_FOUND' })
    expect((await call(POST, 'POST', INVOICE_ID, { kind: 'doubtful', reason: 'x' })).status).toBe(404)
  })
})

describe('the flag', () => {
  it('refuses every new decision while CUSTOMER_LOSS_ENABLED is off, and still shows the view', async () => {
    vi.stubEnv('CUSTOMER_LOSS_ENABLED', '')
    const res = await call(POST, 'POST', INVOICE_ID, { kind: 'doubtful', reason: 'x' })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CUSTOMER_LOSS_DISABLED')
    expect(doubtful).not.toHaveBeenCalled()
    const view = await call(GET, 'GET', INVOICE_ID)
    expect(view.status).toBe(200)
    expect(((await view.json()) as { data: { enabled: boolean } }).data.enabled).toBe(false)
  })
})

describe('booking', () => {
  it('books a befarad loss for the person on the chosen date', async () => {
    doubtful.mockResolvedValue({ ...OK, invoiceStatus: 'overdue' })
    const res = await call(POST, 'POST', INVOICE_ID, { kind: 'doubtful', reason: 'Svarar inte', entry_date: '2026-06-30' })
    expect(res.status).toBe(200)
    expect(doubtful).toHaveBeenCalledWith({}, 'company-1', USER_ID, {
      invoiceId: INVOICE_ID,
      entryDate: '2026-06-30',
      reason: 'Svarar inte',
      decidedBy: USER_ID,
    })
    expect(((await res.json()) as { data: { invoice_status: string } }).data.invoice_status).toBe('overdue')
  })

  it('books a konstaterad loss with its evidence', async () => {
    confirmed.mockResolvedValue(OK)
    const res = await call(POST, 'POST', INVOICE_ID, {
      kind: 'confirmed',
      reason: 'Konkurs',
      evidence_document_id: '44444444-4444-4444-8444-444444444444',
    })
    expect(res.status).toBe(200)
    expect(confirmed).toHaveBeenCalledWith(
      {},
      'company-1',
      USER_ID,
      expect.objectContaining({ evidenceDocumentId: '44444444-4444-4444-8444-444444444444', reason: 'Konkurs' }),
    )
  })

  it('answers a refusal with its registered code', async () => {
    confirmed.mockResolvedValue({ ok: false, code: 'CUSTOMER_LOSS_EVIDENCE_REQUIRED' })
    const res = await call(POST, 'POST', INVOICE_ID, { kind: 'confirmed', reason: 'Konkurs' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CUSTOMER_LOSS_EVIDENCE_REQUIRED')
  })

  it('books a recovery on the bank by default', async () => {
    recovered.mockResolvedValue(OK)
    const res = await call(POST, 'POST', INVOICE_ID, { kind: 'recovered', reason: 'Utdelning', amount: 125 })
    expect(res.status).toBe(200)
    expect(recovered).toHaveBeenCalledWith({}, 'company-1', USER_ID, expect.objectContaining({ amount: 125, paymentAccount: '1930' }))
  })
})
