import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-a') }))
vi.mock('@/lib/agent-skills/agent-bundle', () => ({ loadAgentsOverview: vi.fn() }))

import { requireAuth } from '@/lib/auth/require-auth'
import { loadAgentsOverview } from '@/lib/agent-skills/agent-bundle'
import { GET } from '../route'

const { supabase, reset } = createQueuedMockSupabase()
const ctx = { params: Promise.resolve({}) }
const get = (query = '') => GET(new Request(`http://localhost/api/agents${query}`), ctx)

beforeEach(() => {
  vi.clearAllMocks(); reset()
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user' }, supabase, error: null } as never)
})

describe('GET /api/agents', () => {
  it('requires authentication', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: NextResponse.json({}, { status: 401 }) } as never)
    expect((await get()).status).toBe(401)
    expect(loadAgentsOverview).not.toHaveBeenCalled()
  })

  it('rejects an unknown client', async () => {
    expect((await get('?client=gemini')).status).toBe(400)
    expect(loadAgentsOverview).not.toHaveBeenCalled()
  })

  it('returns the overview for the active company and client', async () => {
    vi.mocked(loadAgentsOverview).mockResolvedValue({ agents: [], facts: 2, agreements: 0, remembered: 0, documents: 0, own_knowledge: {}, own_default: [] })
    const response = await get('?client=chatgpt')
    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual({ agents: [], facts: 2, agreements: 0, remembered: 0, documents: 0, own_knowledge: {}, own_default: [] })
    expect(loadAgentsOverview).toHaveBeenCalledWith(supabase, 'company-a', 'chatgpt')
  })
})
