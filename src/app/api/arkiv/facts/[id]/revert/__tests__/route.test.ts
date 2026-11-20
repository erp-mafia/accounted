import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({ tag: 'service' })) }))
vi.mock('@/lib/arkiv/facts/store', () => ({ revertFact: vi.fn() }))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { revertFact } from '@/lib/arkiv/facts/store'

const FACT = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const call = (body: unknown) => POST(new Request(`http://localhost/api/arkiv/facts/${FACT}/revert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: FACT }) } as never)

// The resolver reports the caller's role on the facts object it is handed;
// withRouteContext's write guard reads it from there.
function asRole(role: string) {
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockImplementation(async (_s: unknown, _u: unknown, resolved?: { role?: string }) => {
    if (resolved) resolved.role = role
    return 'company-1'
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_BRAIN_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  asRole('member')
})

describe('POST /api/arkiv/facts/[id]/revert', () => {
  it('is 403 for a viewer and reverts nothing', async () => {
    asRole('viewer')
    expect((await parseJsonResponse(await call({ reason: 'fel' }))).status).toBe(403)
    expect(revertFact).not.toHaveBeenCalled()
  })

  it('needs a reason, an own fact, and a fact not already deprecated', async () => {
    expect((await parseJsonResponse(await call({ reason: '' }))).status).toBe(400)
    enqueue({ data: null })
    expect((await parseJsonResponse(await call({ reason: 'fel' }))).status).toBe(404)
    enqueue({ data: { id: FACT, rank: 'deprecated' } })
    expect((await parseJsonResponse(await call({ reason: 'fel' }))).status).toBe(409)
    expect(revertFact).not.toHaveBeenCalled()
  })

  it('reverts through the service client with the person on the reason', async () => {
    enqueue({ data: { id: FACT, rank: 'normal' } })
    ;(revertFact as ReturnType<typeof vi.fn>).mockResolvedValue('fact-prev')
    const { status, body } = await parseJsonResponse(await call({ reason: 'Fel sida lästes.' }))
    expect(status).toBe(200)
    expect(body).toEqual({ data: { fact_id: FACT, reinstated_fact_id: 'fact-prev' } })
    expect(revertFact).toHaveBeenCalledWith({ tag: 'service' }, FACT, 'Fel sida lästes. (user-1)')
  })
})
