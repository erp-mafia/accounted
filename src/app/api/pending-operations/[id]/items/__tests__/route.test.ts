/**
 * GET and PATCH /api/pending-operations/[id]/items: the daily collections
 * batch as the review dialog shows it, and taking items out of it (removal
 * only, owner or administrator only, through remove_collection_batch_items).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const isAdminMock = vi.fn()
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  isCompanyAdmin: (...args: unknown[]) => isAdminMock(...args),
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET, PATCH } from '../route'

const OP_ID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'
const A = '11111111-1111-4111-8111-1111111111aa'
const B = '11111111-1111-4111-8111-1111111111bb'

function item(invoiceId: string) {
  return {
    kind: 'open',
    invoice_id: invoiceId,
    case_id: null,
    invoice_number: 'F-1',
    customer_name: 'Kund AB',
    due_date: '2026-09-01',
    remaining_amount: 1250,
    start_step: 'reminder',
    decision_kind: null,
    reminder_fee_agreed: false,
    bank_check: 'pass',
  }
}

const BATCH = {
  id: OP_ID,
  operation_type: 'collections_daily_batch',
  status: 'pending',
  created_at: '2026-10-07T06:15:00Z',
  params: {
    batch_date: '2026-10-07',
    connection_id: '11111111-1111-4111-8111-1111111111ee',
    items: [item(A), item(B)],
    excluded: [{ kind: 'open', invoice_id: '11111111-1111-4111-8111-1111111111ff', invoice_number: 'F-9', customer_name: 'Annan AB', due_date: '2026-09-02', reason: 'bank_stale', block: null }],
  },
}

const patch = (body: unknown, id = OP_ID) =>
  PATCH(createMockRequest(`/api/pending-operations/${id}/items`, { method: 'PATCH', body }), createMockRouteParams({ id }))
const get = (id = OP_ID) => GET(createMockRequest(`/api/pending-operations/${id}/items`), createMockRouteParams({ id }))

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mockSupabase, error: null })
  isAdminMock.mockResolvedValue(true)
})

describe('GET /api/pending-operations/[id]/items', () => {
  it('returns 401 when not authenticated', async () => {
    const { NextResponse } = await import('next/server')
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await get()).status).toBe(401)
  })

  it('returns 400 for an id that is not a uuid', async () => {
    expect((await get('nope')).status).toBe(400)
  })

  it('returns 404 for another operation type or none', async () => {
    enqueue({ data: { ...BATCH, operation_type: 'create_invoice' }, error: null })
    expect((await get()).status).toBe(404)
    enqueue({ data: null, error: null })
    expect((await get()).status).toBe(404)
  })

  it('shows the staged items less the removed ones, the excluded and the removals', async () => {
    enqueue({ data: BATCH, error: null })
    enqueue({ data: [{ invoice_id: B, kind: 'open', removed_by: 'user-1', removed_at: '2026-10-07T07:00:00Z' }], error: null })
    const res = await get()
    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<{ data: { items: Array<{ invoice_id: string }>; excluded: unknown[]; removed: unknown[]; batch_date: string } }>(res)
    expect(body.data.items.map((i) => i.invoice_id)).toEqual([A])
    expect(body.data.excluded).toHaveLength(1)
    expect(body.data.removed).toHaveLength(1)
    expect(body.data.batch_date).toBe('2026-10-07')
    expect(findCall('pending_operations', 'eq')).toEqual(['id', OP_ID])
  })
})

describe('PATCH /api/pending-operations/[id]/items', () => {
  it('returns 401 when not authenticated', async () => {
    const { NextResponse } = await import('next/server')
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await patch({ remove_invoice_ids: [A] })).status).toBe(401)
  })

  it('returns 403 for a member who is not an owner or administrator', async () => {
    isAdminMock.mockResolvedValue(false)
    expect((await patch({ remove_invoice_ids: [A] })).status).toBe(403)
  })

  it('returns 400 for a body without ids', async () => {
    expect((await patch({ remove_invoice_ids: [] })).status).toBe(400)
    expect((await patch({ add_invoice_ids: [A] })).status).toBe(400)
  })

  it('returns 404 for something that is not a batch of this company', async () => {
    enqueue({ data: null, error: null })
    expect((await patch({ remove_invoice_ids: [A] })).status).toBe(404)
  })

  it.each([
    ['COLLECTION_BATCH_NOT_PENDING', 409],
    ['COLLECTION_BATCH_EMPTY', 400],
    ['COLLECTION_BATCH_ADMIN_ONLY', 403],
  ])('answers the database refusing with %s as %s', async (code, status) => {
    enqueue({ data: { id: OP_ID, operation_type: 'collections_daily_batch' }, error: null })
    enqueue({ data: null, error: { message: `${code}: refused` } })
    const res = await patch({ remove_invoice_ids: [A] })
    expect(res.status).toBe(status)
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(JSON.stringify(body)).toContain(code)
  })

  it('takes the items out through the database function and answers with the batch as it now stands', async () => {
    enqueue({ data: { id: OP_ID, operation_type: 'collections_daily_batch' }, error: null })
    enqueue({ data: { removed: 1, remaining: 1 }, error: null })
    enqueue({ data: BATCH, error: null })
    enqueue({ data: [{ invoice_id: B, kind: 'open', removed_by: 'user-1', removed_at: '2026-10-07T07:00:00Z' }], error: null })
    const res = await patch({ remove_invoice_ids: [B] })
    expect(res.status).toBe(200)
    expect(mockSupabase.rpc).toHaveBeenCalledWith('remove_collection_batch_items', { p_operation_id: OP_ID, p_invoice_ids: [B] })
    const { body } = await parseJsonResponse<{ data: { items: Array<{ invoice_id: string }> } }>(res)
    expect(body.data.items.map((i) => i.invoice_id)).toEqual([A])
  })
})

describe('a daily reminder batch', () => {
  function reminderItem(invoiceId: string) {
    return {
      kind: 'reminder',
      invoice_id: invoiceId,
      invoice_number: 'F-1',
      customer_name: 'Kund AB',
      recipient: 'kund@example.se',
      due_date: '2026-12-02',
      level: 1,
      remaining_amount: 1250,
      currency: 'SEK',
      bank: 'fresh',
    }
  }
  const REMINDER_BATCH = {
    id: OP_ID,
    operation_type: 'reminder_daily_batch',
    status: 'pending',
    created_at: '2026-12-17T06:45:00Z',
    params: {
      batch_date: '2026-12-17',
      items: [reminderItem(A), reminderItem(B)],
      excluded: [{ invoice_id: '11111111-1111-4111-8111-1111111111ff', invoice_number: 'F-9', customer_name: 'Annan AB', due_date: '2026-12-01', reason: 'response' }],
    },
  }

  it('shows its items less the ones taken out, the excluded, and which were taken out', async () => {
    enqueue({ data: REMINDER_BATCH, error: null })
    enqueue({ data: [{ invoice_id: B, kind: 'reminder', removed_by: 'user-1', removed_at: '2026-12-17T07:00:00Z' }], error: null })
    const res = await get()
    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<{ data: { items: Array<{ invoice_id: string }>; excluded: unknown[]; removed_invoice_ids: string[] } }>(res)
    expect(body.data.items.map((i) => i.invoice_id)).toEqual([A])
    expect(body.data.excluded).toHaveLength(1)
    expect(body.data.removed_invoice_ids).toEqual([B])
  })

  it('takes items out through the same database function', async () => {
    enqueue({ data: { id: OP_ID, operation_type: 'reminder_daily_batch' }, error: null })
    enqueue({ data: { removed: 1, remaining: 1 }, error: null })
    enqueue({ data: REMINDER_BATCH, error: null })
    enqueue({ data: [{ invoice_id: B, kind: 'reminder', removed_by: 'user-1', removed_at: '2026-12-17T07:00:00Z' }], error: null })
    const res = await patch({ remove_invoice_ids: [B] })
    expect(res.status).toBe(200)
    expect(mockSupabase.rpc).toHaveBeenCalledWith('remove_collection_batch_items', { p_operation_id: OP_ID, p_invoice_ids: [B] })
  })

  it('answers a reminder batch the database cannot find with its own code', async () => {
    enqueue({ data: { id: OP_ID, operation_type: 'reminder_daily_batch' }, error: null })
    enqueue({ data: null, error: { message: 'COLLECTION_BATCH_NOT_FOUND: no such daily batch' } })
    const res = await patch({ remove_invoice_ids: [A] })
    expect(res.status).toBe(404)
    expect(JSON.stringify((await parseJsonResponse(res)).body)).toContain('REMINDER_BATCH_NOT_FOUND')
  })
})
