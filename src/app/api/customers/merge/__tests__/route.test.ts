/**
 * POST /api/customers/merge and /merge/undo (crm#1398, crm#1299): the
 * dashboard doors of the customer merge. The rules are the service's
 * (lib/customers/merge-customers.ts); these pin auth, validation, the dry run
 * and how a refusal reaches the dialog.
 */
import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const mock = createTableMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { POST } from '../route'
import { POST as UNDO } from '../undo/route'

const SURVIVOR = '11111111-1111-4111-8111-111111111111'
const DUPLICATE = '22222222-2222-4222-8222-222222222222'
const MERGE_ID = '33333333-3333-4333-8333-333333333333'

const ANSWER = {
  ok: true,
  dry_run: false,
  survivor: { customer_id: SURVIVOR, name: 'Kunden AB', customer_number: '120' },
  merged: [{
    customer_id: DUPLICATE, name: 'Kunden AB', customer_number: '120', merge_id: MERGE_ID, was_archived: false,
    invoices: 1, sales_orders: 0, recurring_invoice_schedules: 0, deadlines: 0, source_records: 0,
  }],
  totals: { invoices: 1, sales_orders: 0, recurring_invoice_schedules: 0, deadlines: 0 },
}

const noParams = { params: Promise.resolve({}) }
const merge = (body: unknown) => POST(createMockRequest('/api/customers/merge', { method: 'POST', body }), noParams)
const undo = (body: unknown) => UNDO(createMockRequest('/api/customers/merge/undo', { method: 'POST', body }), noParams)

type Body = { data?: Record<string, unknown>; dry_run?: boolean; error?: { code: string; message: string } }

describe('POST /api/customers/merge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mock.reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mock.supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    mock.setTable('customers', { data: [] })
  })

  it('returns 401 when unauthenticated, before touching anything', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })

    const response = await merge({ survivor_customer_id: SURVIVOR, merged_customer_ids: [DUPLICATE] })

    expect(response.status).toBe(401)
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 for a body without merged customers', async () => {
    const response = await merge({ survivor_customer_id: SURVIVOR, merged_customer_ids: [] })

    expect(response.status).toBe(400)
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 404 when a card is not the company\'s', async () => {
    mock.setTable('rpc:merge_customers', { data: { ok: false, code: 'CUSTOMER_NOT_FOUND', details: { customer_ids: [DUPLICATE] } } })

    const { status, body } = await parseJsonResponse<Body>(await merge({ survivor_customer_id: SURVIVOR, merged_customer_ids: [DUPLICATE] }))

    expect(status).toBe(404)
    expect(body.error?.code).toBe('CUSTOMER_NOT_FOUND')
  })

  it('returns 409 with a Swedish message for two different legal persons', async () => {
    mock.setTable('rpc:merge_customers', {
      data: { ok: false, code: 'CUSTOMER_MERGE_IDENTITY_CONFLICT', details: { customer_id: DUPLICATE, field: 'org_number' } },
    })

    const { status, body } = await parseJsonResponse<Body>(await merge({ survivor_customer_id: SURVIVOR, merged_customer_ids: [DUPLICATE] }))

    expect(status).toBe(409)
    expect(body.error?.code).toBe('CUSTOMER_MERGE_IDENTITY_CONFLICT')
    expect(body.error?.message).toMatch(/olika kunder/)
  })

  it('answers the preview for dry_run and calls only the read-only preview', async () => {
    mock.setTable('rpc:customer_merge_preview', { data: { ...ANSWER, dry_run: true } })

    const { status, body } = await parseJsonResponse<Body>(
      await merge({ survivor_customer_id: SURVIVOR, merged_customer_ids: [DUPLICATE], dry_run: true }),
    )

    expect(status).toBe(200)
    expect(body.dry_run).toBe(true)
    expect(body.data).toMatchObject({ totals: { invoices: 1 } })
    expect(mock.findCall('rpc:merge_customers', 'rpc')).toBeUndefined()
  })

  it('merges and answers what moved', async () => {
    mock.setTable('rpc:merge_customers', { data: ANSWER })

    const { status, body } = await parseJsonResponse<Body>(await merge({ survivor_customer_id: SURVIVOR, merged_customer_ids: [DUPLICATE] }))

    expect(status).toBe(200)
    expect(body.dry_run).toBe(false)
    expect(body.data).toMatchObject({ survivor: { customer_id: SURVIVOR }, merged: [{ merge_id: MERGE_ID }] })
    expect(mock.findCall('rpc:merge_customers', 'rpc')?.[0]).toMatchObject({ p_company_id: 'company-1', p_user_id: 'user-1' })
  })
})

describe('POST /api/customers/merge/undo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mock.reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mock.supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await undo({ merge_id: MERGE_ID })).status).toBe(401)
  })

  it('returns 400 for a merge id that is not a uuid', async () => {
    expect((await undo({ merge_id: 'nope' })).status).toBe(400)
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 404 for a merge of another company', async () => {
    mock.setTable('rpc:undo_customer_merge', { data: { ok: false, code: 'CUSTOMER_MERGE_NOT_FOUND', details: { merge_id: MERGE_ID } } })
    const { status, body } = await parseJsonResponse<Body>(await undo({ merge_id: MERGE_ID }))
    expect(status).toBe(404)
    expect(body.error?.code).toBe('CUSTOMER_MERGE_NOT_FOUND')
  })

  it('undoes the merge', async () => {
    const restored = { invoices: 1, sales_orders: 0, recurring_invoice_schedules: 0, deadlines: 0, source_records: 0 }
    mock.setTable('rpc:undo_customer_merge', {
      data: { ok: true, merge_id: MERGE_ID, survivor_customer_id: SURVIVOR, restored_customer_id: DUPLICATE, restored },
    })
    const { status, body } = await parseJsonResponse<Body>(await undo({ merge_id: MERGE_ID }))
    expect(status).toBe(200)
    expect(body.data).toEqual({ merge_id: MERGE_ID, survivor_customer_id: SURVIVOR, restored_customer_id: DUPLICATE, restored })
  })
})
