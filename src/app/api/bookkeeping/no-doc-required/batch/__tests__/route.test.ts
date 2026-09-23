import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'
import { NextResponse } from 'next/server'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn() }))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

const mockUser = { id: 'user-1', email: 't@t.se' }
const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

function makeReq(body: unknown) {
  return new Request('http://localhost/api/bookkeeping/no-doc-required/batch', {
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

describe('POST /api/bookkeeping/no-doc-required/batch', () => {
  it('returns 401 when not authenticated', async () => {
    ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(makeReq({ journal_entry_ids: [UUID_A] }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 403 for read-only members', async () => {
    ;(requireWritePermission as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    })
    const res = await POST(makeReq({ journal_entry_ids: [UUID_A] }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(403)
  })

  it('returns 400 for an empty id list', async () => {
    const res = await POST(makeReq({ journal_entry_ids: [] }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns 400 for non-uuid ids', async () => {
    const res = await POST(makeReq({ journal_entry_ids: ['not-a-uuid'] }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('exempts only owned, posted entries (defense in depth)', async () => {
    enqueue({ data: [{ id: UUID_A }], error: null }) // ownership query: only A owned
    enqueue({ error: null }) // helper upsert
    const res = await POST(makeReq({ journal_entry_ids: [UUID_A, UUID_B], reason: 'Importerad' }))
    const { status, body } = await parseJsonResponse<{ data: { exempted: number } }>(res)
    expect(status).toBe(200)
    expect(body.data.exempted).toBe(1)
  })

  it('returns exempted:0 without writing when no ids are owned', async () => {
    enqueue({ data: [], error: null }) // ownership query → none owned
    const res = await POST(makeReq({ journal_entry_ids: [UUID_A] }))
    const { status, body } = await parseJsonResponse<{ data: { exempted: number } }>(res)
    expect(status).toBe(200)
    expect(body.data.exempted).toBe(0)
  })
})
