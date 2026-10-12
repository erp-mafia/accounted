/**
 * POST /api/invoices/[id]/collection/possible-payments through the real
 * withRouteContext and the real sweep service over an in-memory database:
 * 401 without a session, 400 on a bad request, 403 for a viewer, 404 for a
 * possible payment of another invoice, 409 when it is answered already, and
 * a person dismissing one with every start gate closed.
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
    new Request(`http://localhost/api/invoices/${id}/collection/possible-payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

let caseId: string

function hit(): Record<string, unknown> {
  const transactionId = randomUUID()
  world.db.seed('transactions', [
    {
      id: transactionId,
      company_id: COMPANY_ID,
      date: '2026-10-05',
      amount: 1250,
      description: 'Inbetalning',
      reference: '20261042',
      is_ignored: false,
      invoice_id: null,
      supplier_invoice_id: null,
      journal_entry_id: null,
      is_business: null,
    },
  ])
  const row = {
    id: randomUUID(),
    company_id: COMPANY_ID,
    case_id: caseId,
    transaction_id: transactionId,
    reason: 'reference',
    amount: 1250,
    transaction_date: '2026-10-05',
    status: 'open',
    pause_state: 'paused',
    pause_attempts: 1,
    pause_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  world.db.seed('collection_sweep_hits', [row])
  return world.db.rows('collection_sweep_hits').find((r) => r.id === row.id)!
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

describe('POST /api/invoices/[id]/collection/possible-payments', () => {
  it('answers 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: null,
      error: new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }),
    })
    expect((await call(INVOICE_ID, { hit_id: randomUUID(), action: 'dismiss' })).status).toBe(401)
  })

  it('answers 400 for a bad id or body', async () => {
    expect((await call('not-a-uuid', { hit_id: randomUUID(), action: 'dismiss' })).status).toBe(400)
    expect((await call(INVOICE_ID, { hit_id: 'x', action: 'dismiss' })).status).toBe(400)
    expect((await call(INVOICE_ID, { hit_id: randomUUID(), action: 'book' })).status).toBe(400)
  })

  it('refuses a viewer', async () => {
    const row = hit()
    world.db.rows('company_members')[0].role = 'viewer'
    expect((await call(INVOICE_ID, { hit_id: row.id, action: 'dismiss' })).status).toBe(403)
    expect(row.status).toBe('open')
  })

  it('answers 404 for a possible payment of another invoice or that does not exist', async () => {
    const row = hit()
    expect((await call('99999999-9999-4999-8999-999999999999', { hit_id: row.id, action: 'dismiss' })).status).toBe(404)
    expect((await call(INVOICE_ID, { hit_id: randomUUID(), action: 'dismiss' })).status).toBe(404)
  })

  it('dismisses with every start gate closed and answers the case without it, then 409', async () => {
    const row = hit()
    const other = hit()
    const res = await call(INVOICE_ID, { hit_id: row.id, action: 'dismiss' })
    expect(res.status).toBe(200)
    expect(row).toMatchObject({ status: 'dismissed', resolved_by: ADMIN_ID })
    const body = (await res.json()) as { data: { case: { possiblePayments: Array<{ id: string }> } } }
    expect(body.data.case.possiblePayments.map((p) => p.id)).toEqual([other.id])
    expect((await call(INVOICE_ID, { hit_id: row.id, action: 'dismiss' })).status).toBe(409)
  })
})
