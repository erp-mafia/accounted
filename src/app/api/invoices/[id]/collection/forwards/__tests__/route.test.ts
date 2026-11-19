/**
 * POST /api/invoices/[id]/collection/forwards through the real
 * withRouteContext and the real forwarding service over an in-memory
 * database: 401 without a session, 400 on a bad request, 403 for a viewer,
 * 404 for a forward of another invoice, 409 when nothing is left to do, and
 * a person retrying or resolving an issue with every start gate closed.
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createCaseWorld, INVOICE_ID, type CaseWorld } from '@/lib/collections/__tests__/case-fixtures'
import { ADMIN_ID, COMPANY_ID } from '@/lib/collections/__tests__/memory-supabase'
import { openCollectionCase } from '@/lib/collections/open-case'

let world: CaseWorld

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111') }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => world.db.client, createClient: async () => world.db.client }))
vi.mock('@/lib/sandbox/guard', () => ({ isSandboxCompany: vi.fn().mockResolvedValue(false) }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
const drainHook = vi.fn()
vi.mock('@/lib/collections/forward-hook', () => ({ scheduleCollectionForwardDrain: (...args: unknown[]) => drainHook(...args) }))
vi.mock('@/lib/collections/case-document', async () => {
  const { TEST_DOCUMENT: document } = await import('@/lib/collections/__tests__/case-fixtures')
  return {
    HandoverDocumentError: class extends Error {},
    resolveHandoverDocument: vi.fn(async () => document),
    readArchivedDocument: vi.fn(async () => document),
  }
})

import { POST } from '../route'

function call(id: string, body?: unknown): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/invoices/${id}/collection/forwards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

let caseId: string

function forward(row: Record<string, unknown>): Record<string, unknown> {
  const full = {
    id: randomUUID(),
    company_id: COMPANY_ID,
    case_id: caseId,
    kind: 'payment',
    invoice_payment_id: randomUUID(),
    credit_invoice_id: null,
    amount: 100,
    payment_date: '2026-10-05',
    status: 'failed',
    attempts: 8,
    last_error: 'CONNECTOR_TIMEOUT',
    ignored_amount: null,
    forwarded_at: null,
    attention_resolved_at: null,
    created_at: new Date().toISOString(),
    ...row,
  }
  world.db.seed('collection_payment_forwards', [full])
  return world.db.rows('collection_payment_forwards').find((r) => r.id === full.id)!
}

beforeEach(async () => {
  vi.clearAllMocks()
  for (const k of ['COLLECTIONS_ENABLED', 'COLLECTIONS_PILOT_COMPANIES', 'COLLECTIONS_FAKE_ADAPTER', 'GNUBOK_CONNECTOR_KEY']) vi.stubEnv(k, '')
  world = await createCaseWorld()
  world.db.seed('company_members', [{ company_id: COMPANY_ID, user_id: ADMIN_ID, role: 'owner' }])
  const opened = await openCollectionCase(world.deps(), { invoiceId: INVOICE_ID, expectedRemaining: 1250 })
  if (!opened.ok || opened.dryRun) throw new Error('expected a case')
  caseId = opened.case.id
  requireAuthMock.mockResolvedValue({
    user: { id: ADMIN_ID, email: 'ada@test.se', user_metadata: { full_name: 'Ada Admin' }, is_anonymous: false },
    supabase: world.db.client,
    error: null,
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/invoices/[id]/collection/forwards', () => {
  it('answers 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: null,
      error: new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }),
    })
    expect((await call(INVOICE_ID, { forward_id: randomUUID(), action: 'retry' })).status).toBe(401)
  })

  it('answers 400 for a bad id or body', async () => {
    expect((await call('not-a-uuid', { forward_id: randomUUID(), action: 'retry' })).status).toBe(400)
    expect((await call(INVOICE_ID, { forward_id: 'x', action: 'retry' })).status).toBe(400)
    expect((await call(INVOICE_ID, { forward_id: randomUUID(), action: 'send' })).status).toBe(400)
  })

  it('refuses a viewer', async () => {
    const row = forward({})
    world.db.rows('company_members')[0].role = 'viewer'
    expect((await call(INVOICE_ID, { forward_id: row.id, action: 'retry' })).status).toBe(403)
    expect(row.status).toBe('failed')
  })

  it('answers 404 for a forward of another invoice or another company', async () => {
    const row = forward({})
    expect((await call('99999999-9999-4999-8999-999999999999', { forward_id: row.id, action: 'retry' })).status).toBe(404)
    expect((await call(INVOICE_ID, { forward_id: randomUUID(), action: 'retry' })).status).toBe(404)
  })

  it('retries a failed report with every start gate closed, and answers the case with what is left', async () => {
    const row = forward({})
    const excess = forward({ status: 'forwarded', forwarded_at: new Date().toISOString(), ignored_amount: 30, last_error: null, attempts: 1 })
    const res = await call(INVOICE_ID, { forward_id: row.id, action: 'retry' })
    expect(res.status).toBe(200)
    expect(row).toMatchObject({ status: 'pending', attempts: 0, last_error: null })
    expect(drainHook).toHaveBeenCalledWith(COMPANY_ID)
    const body = (await res.json()) as { data: { case: { forwardIssues: Array<{ id: string; issue: string }> } } }
    expect(body.data.case.forwardIssues).toEqual([expect.objectContaining({ id: excess.id, issue: 'excess' })])

    const resolved = await call(INVOICE_ID, { forward_id: excess.id, action: 'resolve' })
    expect(resolved.status).toBe(200)
    expect(excess.attention_resolved_by).toBe(ADMIN_ID)
    // Nothing left to do on it.
    expect((await call(INVOICE_ID, { forward_id: excess.id, action: 'resolve' })).status).toBe(409)
  })
})
