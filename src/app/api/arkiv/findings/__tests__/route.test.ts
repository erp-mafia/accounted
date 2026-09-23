import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'

const call = () => GET(new Request('http://localhost/api/arkiv/findings'), { params: Promise.resolve({}) } as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/arkiv/findings', () => {
  it('is 404 outside the rollout', async () => {
    process.env.ARKIV_COMPANY_IDS = 'someone-else'
    expect((await parseJsonResponse(await call())).status).toBe(404)
  })

  it("lists the company's open findings, warnings first", async () => {
    enqueue({
      data: [
        {
          id: 'f-1',
          kind: 'settings_mismatch',
          key: 'settings_mismatch:moms_period',
          severity: 'warning',
          subject_kind: 'company',
          subject_id: null,
          detail: { field: 'moms_period', current: 'quarterly', proposed: 'yearly' },
          first_seen_at: '2026-09-15T05:10:00Z',
          last_seen_at: '2026-09-15T05:10:00Z',
        },
      ],
    })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect(body).toEqual({
      data: [expect.objectContaining({ finding_id: 'f-1', kind: 'settings_mismatch', detail: { field: 'moms_period', current: 'quarterly', proposed: 'yearly' } })],
    })
    expect(findCalls('arkiv_findings', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['status', 'open'],
    ])
  })

  it('answers 500 without internals when the read fails', async () => {
    enqueue({ error: { message: 'permission denied for table arkiv_findings' } })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(500)
    expect(JSON.stringify(body)).not.toContain('permission denied')
  })
})
