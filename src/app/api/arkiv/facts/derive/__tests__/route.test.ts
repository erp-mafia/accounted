import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({ tag: 'service' })) }))
vi.mock('@/lib/arkiv/facts/derive-company', () => ({ deriveCompanyFacts: vi.fn() }))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { deriveCompanyFacts } from '@/lib/arkiv/facts/derive-company'

const call = () => POST(new Request('http://localhost/api/arkiv/facts/derive', { method: 'POST' }), { params: Promise.resolve({}) } as never)

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ARKIV_BRAIN_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('POST /api/arkiv/facts/derive', () => {
  it('answers 401 without a session', async () => {
    ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await parseJsonResponse(await call())).status).toBe(401)
    expect(deriveCompanyFacts).not.toHaveBeenCalled()
  })

  it('is not there for a company outside the rollout', async () => {
    process.env.ARKIV_BRAIN_COMPANY_IDS = 'someone-else'
    expect((await parseJsonResponse(await call())).status).toBe(404)
    expect(deriveCompanyFacts).not.toHaveBeenCalled()
  })

  it('derives the facts for the active company with BAS names for the accounts', async () => {
    ;(deriveCompanyFacts as ReturnType<typeof vi.fn>).mockResolvedValue({ recorded: 9, predicates: ['revenue_12m'] })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect(body).toEqual({ data: { recorded: 9, predicates: ['revenue_12m'] } })
    const [client, companyId, today, accountName] = (deriveCompanyFacts as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, string, string, (a: string) => string | null]
    expect(client).toEqual({ tag: 'service' })
    expect(companyId).toBe('company-1')
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(accountName('1930')).toMatch(/konto/i)
    expect(accountName('0000')).toBeNull()
  })

  it('reports a failed derivation', async () => {
    ;(deriveCompanyFacts as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('graph snapshot fetch failed: boom'))
    const { status } = await parseJsonResponse(await call())
    expect(status).toBe(500)
  })
})
