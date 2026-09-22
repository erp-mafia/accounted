import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, reset, findCall } = createQueuedMockSupabase()
const service = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => service.supabase) }))

import { DELETE } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'

const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LINK = 'llllllll-llll-4lll-8lll-llllllllllll'
const call = () => DELETE(new Request(`http://localhost/api/documents/${DOC}/links/${LINK}`, { method: 'DELETE' }), { params: Promise.resolve({ id: DOC, linkId: LINK }) } as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  service.reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('DELETE /api/documents/[id]/links/[linkId]', () => {
  it('is 404 outside the rollout', async () => {
    process.env.ARKIV_COMPANY_IDS = 'someone-else'
    expect((await parseJsonResponse(await call())).status).toBe(404)
  })

  it('retires a live link of the company\'s document, and answers 404 when none is live', async () => {
    service.enqueue({ data: [{ id: LINK }] })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect(body).toEqual({ data: { id: LINK, retired: true } })
    expect(service.findCall('document_links', 'update')?.[0]).toMatchObject({ retired_reason: 'retired by person user-1' })
    expect(service.findCall('document_links', 'is')).toEqual(['retired_at', null])
    expect(findCall('document_links', 'update')).toBeUndefined()

    service.enqueue({ data: [] })
    expect((await parseJsonResponse(await call())).status).toBe(404)
  })
})
