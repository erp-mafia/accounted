import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'
import { NextResponse } from 'next/server'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn() }))

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }))
vi.mock('@/lib/logger', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
    child: (): unknown => logger,
  }
  return { createLogger: () => logger }
})

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

const mockUser = { id: 'user-1', email: 't@t.se' }

function makeReq(body: unknown) {
  return new Request('http://localhost/api/bookkeeping/no-doc-required/bulk-missing', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: mockUser, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
  ;(requireWritePermission as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
})

describe('POST /api/bookkeeping/no-doc-required/bulk-missing', () => {
  it('returns 401 when not authenticated', async () => {
    ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(makeReq({}))
    expect((await parseJsonResponse(res)).status).toBe(401)
  })

  it('returns 403 for read-only members', async () => {
    ;(requireWritePermission as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    })
    const res = await POST(makeReq({}))
    expect((await parseJsonResponse(res)).status).toBe(403)
  })

  it('returns 400 for a non-uuid period_id', async () => {
    const res = await POST(makeReq({ period_id: 'not-a-uuid' }))
    expect((await parseJsonResponse(res)).status).toBe(400)
  })

  it('returns 400 for a shaped-but-invalid date', async () => {
    const res = await POST(makeReq({ date_from: '9999-99-99' }))
    expect((await parseJsonResponse(res)).status).toBe(400)
  })

  it('returns 400 for an invalid series filter', async () => {
    const res = await POST(makeReq({ series: 'all' }))
    expect((await parseJsonResponse(res)).status).toBe(400)
  })

  // The predicate lives in the list_verifikat_missing_underlag RPC (one call
  // per page, pinned to the badge's RPC by the pg-real suites); the route
  // only asks for the total (dry run) or pages the ids, then marks them.
  const RPC = 'list_verifikat_missing_underlag'
  const rpcCalls = () =>
    mockSupabase.rpc.mock.calls.filter(([name]) => name === RPC) as unknown as [string, Record<string, unknown>][]

  it('dry_run reads only the total, in one RPC call with no writes (crm#1390)', async () => {
    enqueue({ data: { ok: true, total_count: 4600, ids: ['a'] }, error: null })
    const res = await POST(
      makeReq({ period_id: '550e8400-e29b-41d4-a716-446655440000', series: 'A', dry_run: true }),
    )
    const { status, body } = await parseJsonResponse<{ data: { count: number } }>(res)
    expect(status).toBe(200)
    expect(body.data.count).toBe(4600)
    expect(rpcCalls()).toHaveLength(1)
    expect(rpcCalls()[0][1]).toMatchObject({
      p_company_id: 'company-1',
      p_period_id: '550e8400-e29b-41d4-a716-446655440000',
      p_series: 'A',
      p_limit: 1,
    })
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('marks every missing entry across RPC pages and returns the count', async () => {
    const ids = (from: number, count: number) => Array.from({ length: count }, (_, i) => `id-${from + i}`)
    enqueue({ data: { ok: true, total_count: 1200, ids: ids(0, 1000) }, error: null })
    enqueue({ data: { ok: true, total_count: 1200, ids: ids(1000, 200) }, error: null })
    enqueue({ error: null }) // helper upsert, chunk 1
    enqueue({ error: null }) // helper upsert, chunk 2
    enqueue({ error: null }) // helper upsert, chunk 3
    const res = await POST(makeReq({ period_id: null, reason: 'Importerad' }))
    const { status, body } = await parseJsonResponse<{ data: { exempted: number } }>(res)
    expect(status).toBe(200)
    expect(body.data.exempted).toBe(1200)
    expect(rpcCalls().map(([, args]) => args.p_offset)).toEqual([0, 1000])
    expect(mockSupabase.from).toHaveBeenCalledWith('journal_entry_no_doc_required')
  })

  it('logs the driver error and answers with the mapped text when the RPC fails (#2395)', async () => {
    const driverError = { message: 'canceling statement due to statement timeout', code: '57014', details: null, hint: null }
    enqueue({ data: null, error: driverError })
    const res = await POST(makeReq({ dry_run: true }), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(400)
    expect(typeof body.error).toBe('string')
    const call = mockLogError.mock.calls.find(([msg]) => msg === 'failed to resolve missing-underlag entries')
    expect(call).toBeDefined()
    expect(call![2]).toEqual({ cause: driverError })
  })

  it('writes nothing when nothing matches the filters', async () => {
    enqueue({ data: { ok: true, total_count: 0, ids: [] }, error: null })
    const res = await POST(makeReq({ reason: 'Importerad' }))
    const { status, body } = await parseJsonResponse<{ data: { exempted: number } }>(res)
    expect(status).toBe(200)
    expect(body.data.exempted).toBe(0)
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })
})
