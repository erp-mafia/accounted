import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
  isCompanyAdmin: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/bolaget/roles', () => ({ loadRoles: vi.fn() }))
vi.mock('@/lib/bokslut/arsredovisning/signature-service', () => ({ listSignatureRequests: vi.fn() }))

import { GET, POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { loadRoles } from '@/lib/bolaget/roles'
import { listSignatureRequests } from '@/lib/bokslut/arsredovisning/signature-service'

const PERIOD = '11111111-1111-4111-8111-111111111111'
const url = `http://localhost/api/bookkeeping/fiscal-periods/${PERIOD}/arsredovisning/signatures/from-roles`
const params = { params: Promise.resolve({ id: PERIOD }) }
const previous = process.env.BOLAGET_COMPANY_IDS

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

afterEach(() => {
  if (previous === undefined) delete process.env.BOLAGET_COMPANY_IDS
  else process.env.BOLAGET_COMPANY_IDS = previous
})

describe('GET .../arsredovisning/signatures/from-roles', () => {
  it('is 401 without a session', async () => {
    ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
      error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    })
    expect((await GET(new Request(url), params as never)).status).toBe(401)
  })

  it('answers nobody to add (200, empty) outside the Bolaget rollout, without reading the registers', async () => {
    // The årsredovisning page asks on every load; outside the rollout the
    // true answer is an empty list, not a failed request.
    process.env.BOLAGET_COMPANY_IDS = 'someone-else'
    const { status, body } = await parseJsonResponse<{ data: { candidates: unknown[] } }>(await GET(new Request(url), params as never))
    expect(status).toBe(200)
    expect(body.data.candidates).toEqual([])
    expect(loadRoles).not.toHaveBeenCalled()
    expect(listSignatureRequests).not.toHaveBeenCalled()
  })
})

describe('POST .../arsredovisning/signatures/from-roles', () => {
  it('still refuses outside the Bolaget rollout', async () => {
    process.env.BOLAGET_COMPANY_IDS = 'someone-else'
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await POST(new Request(url, { method: 'POST' }), params as never),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('BOLAGET_DISABLED')
    expect(loadRoles).not.toHaveBeenCalled()
  })
})
