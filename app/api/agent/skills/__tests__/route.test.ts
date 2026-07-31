/**
 * Tests for GET /api/agent/skills.
 *
 * Locks in the "active for this company" tier semantics the settings panel
 * renders: horizontal and product atoms are always active (product atoms
 * describe how Accounted itself works, added so the assistant can answer
 * feature questions like the template line types); vertical and modifier
 * atoms are active only when the company's agent_profile selected them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const noParams = { params: Promise.resolve({}) }

/** Chainable builder resolving queued {data,error} per from() call, in order. */
function createQueuedSupabase(results: { data?: unknown; error?: unknown }[]) {
  let idx = 0
  const makeBuilder = () => {
    const result = results[idx++] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    for (const m of ['select', 'eq', 'is', 'order', 'maybeSingle', 'single']) {
      b[m] = () => b
    }
    b.then = (resolve: (v: unknown) => void) =>
      resolve({ data: result.data ?? null, error: result.error ?? null })
    return b
  }
  return { from: () => makeBuilder() }
}

function auth(supabase: unknown) {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

const ATOMS = [
  { id: 'horizontal/swedish-vat', tier: 'horizontal', title: 'Swedish VAT', description: 'moms' },
  { id: 'vertical/konsult-it', tier: 'vertical', title: 'Konsult IT', description: 'bransch' },
  { id: 'vertical/e-handel', tier: 'vertical', title: 'E-handel', description: 'bransch' },
  { id: 'modifier/holding-ab', tier: 'modifier', title: 'Holding AB', description: 'situation' },
  { id: 'product/bokforingsmallar', tier: 'product', title: 'Bokföringsmallar', description: 'mallar' },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/agent/skills', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/agent/skills'), noParams)
    expect(res.status).toBe(401)
  })

  it('flags horizontal and product atoms active, vertical/modifier only per profile', async () => {
    const supabase = createQueuedSupabase([
      { data: ATOMS },
      { data: { vertical_atoms: ['vertical/konsult-it'], modifier_atoms: [] } },
    ])
    auth(supabase)

    const { status, body } = await parseJsonResponse<{
      data?: { id: string; active: boolean }[] & { body?: string }
      error?: { code: string }
    }>(
      await GET(createMockRequest('/api/agent/skills'), noParams),
    )
    expect(status).toBe(200)
    const active = Object.fromEntries(
      (body.data as { id: string; active: boolean }[]).map((a) => [a.id, a.active]),
    )
    expect(active).toEqual({
      'horizontal/swedish-vat': true,
      'vertical/konsult-it': true,
      'vertical/e-handel': false,
      'modifier/holding-ab': false,
      'product/bokforingsmallar': true,
    })
  })

  it('keeps product atoms active with no agent_profile row at all', async () => {
    const supabase = createQueuedSupabase([{ data: ATOMS }, { data: null }])
    auth(supabase)

    const { status, body } = await parseJsonResponse<{
      data?: { id: string; active: boolean }[] & { body?: string }
      error?: { code: string }
    }>(
      await GET(createMockRequest('/api/agent/skills'), noParams),
    )
    expect(status).toBe(200)
    const mallar = (body.data as { id: string; active: boolean }[]).find(
      (a) => a.id === 'product/bokforingsmallar',
    )
    expect(mallar?.active).toBe(true)
  })

  it('returns 400 for an empty slug', async () => {
    const supabase = createQueuedSupabase([])
    auth(supabase)

    const res = await GET(createMockRequest('/api/agent/skills?slug='), noParams)
    expect(res.status).toBe(400)
  })

  it('returns 404 for an unknown slug', async () => {
    const supabase = createQueuedSupabase([{ data: null }])
    auth(supabase)

    const { status, body } = await parseJsonResponse<{
      data?: { id: string; active: boolean }[] & { body?: string }
      error?: { code: string }
    }>(
      await GET(createMockRequest('/api/agent/skills?slug=product/finns-inte'), noParams),
    )
    expect(status).toBe(404)
    expect(body.error?.code).toBe('SKILL_NOT_FOUND')
  })

  it('returns 404 for a row the curation switch has turned off', async () => {
    const supabase = createQueuedSupabase([
      {
        data: {
          id: 'product/bokforingsmallar',
          title: 'Bokföringsmallar',
          body: '# Bokföringsmallar',
          is_active: true,
          mcp_exposed: false,
        },
      },
    ])
    auth(supabase)

    const { status, body } = await parseJsonResponse<{
      data?: { id: string; active: boolean }[] & { body?: string }
      error?: { code: string }
    }>(
      await GET(createMockRequest('/api/agent/skills?slug=product/bokforingsmallar'), noParams),
    )
    expect(status).toBe(404)
    expect(body.error?.code).toBe('SKILL_NOT_FOUND')
  })

  it('returns the body for an exposed slug', async () => {
    const supabase = createQueuedSupabase([
      {
        data: {
          id: 'product/bokforingsmallar',
          title: 'Bokföringsmallar',
          body: '# Bokföringsmallar',
          is_active: true,
          mcp_exposed: true,
        },
      },
    ])
    auth(supabase)

    const { status, body } = await parseJsonResponse<{
      data?: { id: string; active: boolean }[] & { body?: string }
      error?: { code: string }
    }>(
      await GET(createMockRequest('/api/agent/skills?slug=product/bokforingsmallar'), noParams),
    )
    expect(status).toBe(200)
    expect(body.data?.body).toBe('# Bokföringsmallar')
  })
})
