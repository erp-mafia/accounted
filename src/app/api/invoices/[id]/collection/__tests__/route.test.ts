/**
 * /api/invoices/[id]/collection (GET, POST) and .../actions (POST) through
 * the real withRouteContext, the real case services and the fake adapter
 * over an in-memory database: 401 without a session, 400 on a bad request,
 * 404 for an invoice of another company, 503 for a handover while
 * collections is dark, and the happy paths. An open case stays readable and
 * actionable with every start gate closed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { CollectionsAdapter } from '@/lib/collections/port'
import { createCaseWorld, INVOICE_ID, type CaseWorld } from '@/lib/collections/__tests__/case-fixtures'
import { ADMIN_ID, COMPANY_ID } from '@/lib/collections/__tests__/memory-supabase'

let world: CaseWorld
let adapter: CollectionsAdapter

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111') }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => world.db.client, createClient: async () => world.db.client }))
const hasCapabilityMock = vi.fn()
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: (...args: unknown[]) => hasCapabilityMock(...args),
}))
vi.mock('@/lib/sandbox/guard', () => ({ isSandboxCompany: vi.fn().mockResolvedValue(false) }))
vi.mock('@/lib/collections/adapters', () => ({ collectionsAdapterFor: () => adapter, ensureCollectionsAdapters: () => {} }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/collections/case-document', async () => {
  const { TEST_DOCUMENT: document } = await import('@/lib/collections/__tests__/case-fixtures')
  return {
    HandoverDocumentError: class extends Error {},
    resolveHandoverDocument: vi.fn(async () => document),
    readArchivedDocument: vi.fn(async () => document),
  }
})

import { GET, POST } from '../route'
import { POST as ACTION } from '../actions/route'

type Handler = (request: Request, params: { params: Promise<{ id: string }> }) => Promise<Response>

function call(handler: Handler, method: 'GET' | 'POST', id: string, body?: unknown, query = ''): Promise<Response> {
  return handler(
    new Request(`http://localhost/api/invoices/${id}/collection${query}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

function switchOn() {
  vi.stubEnv('COLLECTIONS_ENABLED', '1')
  vi.stubEnv('COLLECTIONS_PILOT_COMPANIES', COMPANY_ID)
}

const OPEN_BODY = { start_step: 'reminder', expected_remaining: 1250 }

beforeEach(async () => {
  vi.clearAllMocks()
  for (const k of ['COLLECTIONS_ENABLED', 'COLLECTIONS_PILOT_COMPANIES', 'COLLECTIONS_FAKE_ADAPTER', 'GNUBOK_CONNECTOR_KEY']) vi.stubEnv(k, '')
  world = await createCaseWorld()
  // These routes run on the wall clock: a bank synced an hour ago.
  world.db.rows('bank_connections')[0].last_synced_at = new Date(Date.now() - 3_600_000).toISOString()
  world.db.seed('company_members', [{ company_id: COMPANY_ID, user_id: ADMIN_ID, role: 'owner' }])
  adapter = world.fake
  requireAuthMock.mockResolvedValue({
    user: { id: ADMIN_ID, email: 'ada@test.se', user_metadata: { full_name: 'Ada Admin' }, is_anonymous: false },
    supabase: world.db.client,
    error: null,
  })
  hasCapabilityMock.mockResolvedValue(true)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('authentication and validation', () => {
  it('answers 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: null,
      error: new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }),
    })
    expect((await call(GET, 'GET', INVOICE_ID)).status).toBe(401)
    expect((await call(POST, 'POST', INVOICE_ID, OPEN_BODY)).status).toBe(401)
    expect((await call(ACTION, 'POST', INVOICE_ID, { action: 'pause' })).status).toBe(401)
  })

  it('answers 400 for a bad id or body', async () => {
    expect((await call(GET, 'GET', 'not-a-uuid')).status).toBe(400)
    expect((await call(POST, 'POST', INVOICE_ID, { expected_remaining: 'x' })).status).toBe(400)
    expect((await call(POST, 'POST', INVOICE_ID, { ...OPEN_BODY, dismissed_transaction_ids: ['nope'] })).status).toBe(400)
    expect((await call(ACTION, 'POST', INVOICE_ID, { action: 'escalate' })).status).toBe(400)
    expect((await call(ACTION, 'POST', INVOICE_ID, { action: 'pause', until: '1 nov' })).status).toBe(400)
  })

  it('answers 404 for an invoice the company does not have', async () => {
    const other = '99999999-9999-4999-8999-999999999999'
    expect((await call(GET, 'GET', other)).status).toBe(404)
    expect((await call(POST, 'POST', other, OPEN_BODY)).status).toBe(404)
  })

  it('refuses a viewer the writes', async () => {
    world.db.rows('company_members')[0].role = 'viewer'
    switchOn()
    expect((await call(POST, 'POST', INVOICE_ID, OPEN_BODY)).status).toBe(403)
    expect((await call(ACTION, 'POST', INVOICE_ID, { action: 'pause' })).status).toBe(403)
    expect(world.db.rows('collection_cases')).toEqual([])
  })
})

describe('GET /api/invoices/[id]/collection', () => {
  it('answers hidden and no case while collections is dark', async () => {
    const res = await call(GET, 'GET', INVOICE_ID, undefined, '?readiness=1')
    expect(res.status).toBe(200)
    const body = await json<{ data: { availability: { start: string }; case: unknown; readiness: unknown } }>(res)
    expect(body.data).toMatchObject({ availability: { start: 'hidden' }, case: null, readiness: null })
  })

  it('answers the dialog checklist once the company can hand over', async () => {
    switchOn()
    const res = await call(GET, 'GET', INVOICE_ID, undefined, '?readiness=1')
    const body = await json<{ data: { availability: { start: string; displayName: string }; readiness: Record<string, unknown> } }>(res)
    expect(body.data.availability).toMatchObject({ start: 'ready', displayName: 'Acme Inkasso' })
    expect(body.data.readiness).toMatchObject({
      eligible: true,
      claim: { amount: 1250, remaining: 1250 },
      customer: { kind: 'business', identity: 'not_needed', missingAddress: [] },
      bankCheck: { outcome: 'pass' },
      deliveryAttestation: null,
      watching: false,
    })
  })
})

describe('POST /api/invoices/[id]/collection', () => {
  it('answers 503 while collections is switched off, and hands nothing over', async () => {
    const res = await call(POST, 'POST', INVOICE_ID, OPEN_BODY)
    expect(res.status).toBe(503)
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('COLLECTIONS_DISABLED')
    expect(world.db.rows('collection_cases')).toEqual([])
  })

  it('answers the paywall without the paid capability', async () => {
    switchOn()
    hasCapabilityMock.mockResolvedValue(false)
    expect((await call(POST, 'POST', INVOICE_ID, OPEN_BODY)).status).toBe(403)
  })

  it('hands the invoice over and answers the case', async () => {
    switchOn()
    const res = await call(POST, 'POST', INVOICE_ID, OPEN_BODY)
    expect(res.status).toBe(200)
    const body = await json<{ data: { case: Record<string, unknown>; registered: boolean } }>(res)
    expect(body.data).toMatchObject({ registered: true, case: { invoiceId: INVOICE_ID, submissionStatus: 'registered', isOpen: true } })
    expect(body.data.case).not.toHaveProperty('provider_case_ref')
    expect(JSON.stringify(body)).not.toContain('fake.')
  })

  it('answers 409 when the amount still owed changed', async () => {
    switchOn()
    const res = await call(POST, 'POST', INVOICE_ID, { ...OPEN_BODY, expected_remaining: 1000 })
    expect(res.status).toBe(409)
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('COLLECTION_REMAINING_CHANGED')
  })
})

describe('an open case with every start gate closed', () => {
  it('stays readable and can be paused', async () => {
    switchOn()
    expect((await call(POST, 'POST', INVOICE_ID, OPEN_BODY)).status).toBe(200)
    vi.stubEnv('COLLECTIONS_ENABLED', '')
    hasCapabilityMock.mockResolvedValue(false)

    const read = await json<{ data: { case: { stage: string; actions: string[] } } }>(await call(GET, 'GET', INVOICE_ID))
    expect(read.data.case).toMatchObject({ stage: 'registered' })
    expect(read.data.case.actions).toContain('pause')

    const res = await call(ACTION, 'POST', INVOICE_ID, { action: 'pause' })
    expect(res.status).toBe(200)
    expect((await json<{ data: { case: { stage: string } } }>(res)).data.case.stage).toBe('paused')
  })
})

describe('POST /api/invoices/[id]/collection/actions', () => {
  it('answers 404 without an open case', async () => {
    const res = await call(ACTION, 'POST', INVOICE_ID, { action: 'pause' })
    expect(res.status).toBe(404)
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('COLLECTION_CASE_NOT_FOUND')
  })

  it('takes the actions the case offers, one after the other, and refuses the rest with 409', async () => {
    switchOn()
    await call(POST, 'POST', INVOICE_ID, OPEN_BODY)
    const refused = await call(ACTION, 'POST', INVOICE_ID, { action: 'approve_legal_action' })
    expect(refused.status).toBe(409)
    expect((await json<{ error: { code: string } }>(refused)).error.code).toBe('CONNECTOR_COLLECTIONS_ACTION_UNAVAILABLE')
    expect((await call(ACTION, 'POST', INVOICE_ID, { action: 'pause', message: null })).status).toBe(200)
    expect((await call(ACTION, 'POST', INVOICE_ID, { action: 'resume' })).status).toBe(200)
    expect(world.db.rows('collection_case_events').filter((e) => e.kind === 'user_action').map((e) => e.label)).toEqual(['pause', 'resume'])
  })

  it('asks for the fee to be confirmed before withdrawing after the free days', async () => {
    switchOn()
    await call(POST, 'POST', INVOICE_ID, OPEN_BODY)
    world.db.rows('collection_cases')[0].opened_at = new Date(Date.now() - 20 * 86_400_000).toISOString()

    const read = await json<{ data: { withdrawFee: { mayApply: boolean; freeDays: number } } }>(await call(GET, 'GET', INVOICE_ID))
    expect(read.data.withdrawFee).toMatchObject({ mayApply: true, freeDays: 14 })

    const refused = await call(ACTION, 'POST', INVOICE_ID, { action: 'withdraw' })
    expect(refused.status).toBe(409)
    const error = (await json<{ error: { code: string; message: string } }>(refused)).error
    expect(error.code).toBe('COLLECTION_WITHDRAW_FEE_UNACKNOWLEDGED')
    expect(error.message).toContain('Acme Inkasso')
    expect(world.db.rows('collection_cases')[0].is_open).toBe(true)

    const res = await call(ACTION, 'POST', INVOICE_ID, { action: 'withdraw', fee_acknowledged: true })
    expect(res.status).toBe(200)
    expect((await json<{ data: { case: { isOpen: boolean; closeReason: string } } }>(res)).data.case).toMatchObject({
      isOpen: false,
      closeReason: 'withdrawn',
    })
  })

  it('answers "the customer has paid" with the payment to book, and checks an approval when the dialog opens', async () => {
    switchOn()
    await call(POST, 'POST', INVOICE_ID, OPEN_BODY)
    const row = world.db.rows('collection_cases')[0]
    Object.assign(row, { stage: 'awaiting_decision', decision_kind: 'debtor_says_paid', actions: ['already_paid', 'confirm_not_paid'] })
    const paid = await call(ACTION, 'POST', INVOICE_ID, { action: 'already_paid' })
    expect(paid.status).toBe(409)
    expect((await json<{ error: { code: string } }>(paid)).error.code).toBe('COLLECTION_REGISTER_PAYMENT')

    Object.assign(row, { decision_kind: 'approve_collection_notice', actions: ['approve_step', 'pause', 'withdraw'], last_synced_at: new Date().toISOString() })
    const read = await json<{ data: { readiness: unknown; escalation: Record<string, unknown> } }>(
      await call(GET, 'GET', INVOICE_ID, undefined, '?readiness=1'),
    )
    expect(read.data.readiness).toBeNull()
    expect(read.data.escalation).toMatchObject({ remaining: 1250, providerOutstanding: 1250, refusal: null, bankCheck: { outcome: 'pass' } })
  })
})

