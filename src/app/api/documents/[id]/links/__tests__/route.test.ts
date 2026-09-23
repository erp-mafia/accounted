import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({ tag: 'service' })) }))
vi.mock('@/lib/arkiv/agreements/store', () => ({ linkByPerson: vi.fn() }))

import { GET, POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { linkByPerson } from '@/lib/arkiv/agreements/store'

const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const ASSET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const params = { params: Promise.resolve({ id: DOC }) } as never
const get = () => GET(new Request(`http://localhost/api/documents/${DOC}/links`), params)
const post = (body: unknown) => POST(new Request(`http://localhost/api/documents/${DOC}/links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), params)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/documents/[id]/links', () => {
  it('lists the live links', async () => {
    enqueue({ data: [{ id: 'l1', target_kind: 'party', target_id: 'p1', basis: 'proven', method: 'org_number', confidence: 1, created_at: '2026-09-15T00:00:00Z' }] })
    const { status, body } = await parseJsonResponse(await get())
    expect(status).toBe(200)
    expect((body as { data: unknown[] }).data).toHaveLength(1)
    expect(findCall('document_links', 'is')).toEqual(['retired_at', null])
  })
})

describe('POST /api/documents/[id]/links', () => {
  it('rejects an unknown kind or a malformed id', async () => {
    expect((await parseJsonResponse(await post({ target_kind: 'invoice', target_id: ASSET }))).status).toBe(400)
    expect((await parseJsonResponse(await post({ target_kind: 'asset', target_id: 'nope' }))).status).toBe(400)
  })

  it('is 404 when the document or the target is not the company\'s', async () => {
    enqueue({ data: null })
    expect((await parseJsonResponse(await post({ target_kind: 'asset', target_id: ASSET }))).status).toBe(404)
    enqueue({ data: { id: DOC } })
    enqueue({ data: null })
    expect((await parseJsonResponse(await post({ target_kind: 'asset', target_id: ASSET }))).status).toBe(404)
    expect(linkByPerson).not.toHaveBeenCalled()
  })

  it('creates a proven person link and answers 409 for a duplicate', async () => {
    enqueue({ data: { id: DOC } })
    enqueue({ data: { id: ASSET } })
    ;(linkByPerson as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'link-1' })
    const { status, body } = await parseJsonResponse(await post({ target_kind: 'asset', target_id: ASSET }))
    expect(status).toBe(201)
    expect(body).toEqual({ data: { id: 'link-1', document_id: DOC, target_kind: 'asset', target_id: ASSET } })
    expect(linkByPerson).toHaveBeenCalledWith({ tag: 'service' }, { companyId: 'company-1', documentId: DOC, userId: 'user-1', targetKind: 'asset', targetId: ASSET })

    enqueue({ data: { id: DOC } })
    enqueue({ data: { id: ASSET } })
    ;(linkByPerson as ReturnType<typeof vi.fn>).mockResolvedValue({ conflict: true })
    expect((await parseJsonResponse(await post({ target_kind: 'asset', target_id: ASSET }))).status).toBe(409)
  })

  it('only links live parties', async () => {
    enqueue({ data: { id: DOC } })
    enqueue({ data: { id: ASSET } })
    ;(linkByPerson as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'link-2' })
    await post({ target_kind: 'party', target_id: ASSET })
    expect(findCall('parties', 'is')).toEqual(['merged_into', null])
  })
})
