import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'

const ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const call = (body: unknown) =>
  POST(new Request(`http://localhost/api/arkiv/findings/${ID}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: ID }),
  } as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_BRAIN_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('POST /api/arkiv/findings/[id]', () => {
  it('rejects a resolution it does not know', async () => {
    expect((await parseJsonResponse(await call({ resolution: 'ignored' }))).status).toBe(400)
  })

  it("is 404 for a finding that is not open or not the company's", async () => {
    enqueue({ data: null })
    expect((await parseJsonResponse(await call({ resolution: 'dismissed' }))).status).toBe(404)
    expect(findCalls('arkiv_findings', 'eq')).toEqual([
      ['id', ID],
      ['company_id', 'company-1'],
      ['status', 'open'],
    ])
  })

  it('closes the finding as applied or dismissed, stamped with the person', async () => {
    enqueue({ data: { id: ID } })
    const { status, body } = await parseJsonResponse(await call({ resolution: 'applied' }))
    expect(status).toBe(200)
    expect(body).toEqual({ data: { finding_id: ID, status: 'resolved' } })
    expect(findCall('arkiv_findings', 'update')?.[0]).toMatchObject({ status: 'resolved', resolution: 'applied', resolved_by_user_id: 'user-1', resolved_at: expect.any(String) })

    reset()
    enqueue({ data: { id: ID } })
    expect((await parseJsonResponse(await call({ resolution: 'dismissed' }))).body).toEqual({ data: { finding_id: ID, status: 'dismissed' } })
    expect(findCall('arkiv_findings', 'update')?.[0]).toMatchObject({ status: 'dismissed', resolution: 'dismissed' })
  })
})

describe('POST /api/arkiv/findings/[id], phase 9 notes', () => {
  it('stores why a missing document was dismissed', async () => {
    enqueue({ data: { id: ID, kind: 'document_expected', detail: { rule: 'loan' } } })
    const { status, body } = await parseJsonResponse(await call({ resolution: 'dismissed', note: 'not_applicable' }))
    expect(status).toBe(200)
    expect(body).toEqual({ data: { finding_id: ID, status: 'dismissed' } })
    expect(JSON.stringify(findCalls('arkiv_findings', 'update'))).toContain('"resolution_note":"not_applicable"')
  })

  it('refuses a note it does not know', async () => {
    expect((await parseJsonResponse(await call({ resolution: 'dismissed', note: 'because' }))).status).toBe(400)
  })
})
