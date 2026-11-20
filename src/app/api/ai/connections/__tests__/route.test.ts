import { beforeEach, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company') }))
vi.mock('@/lib/onboarding/ai-clients.server', () => ({ loadAiConnection: vi.fn() }))
import { requireAuth } from '@/lib/auth/require-auth'
import { loadAiConnection } from '@/lib/onboarding/ai-clients.server'
import { GET } from '../route'
const request = new Request('http://localhost/api/ai/connections')
const params = { params: Promise.resolve({}) }
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user' }, supabase: {}, error: null } as never)
  vi.mocked(loadAiConnection).mockResolvedValue({ connected: true, clients: ['claude'] })
})
it('requires authentication', async () => {
  vi.mocked(requireAuth).mockResolvedValue({ error: NextResponse.json({}, { status: 401 }) } as never)
  expect((await GET(request, params)).status).toBe(401)
})
it('returns only the current user connection labels, with no-store caching', async () => {
  const response = await GET(request, params)
  expect(await response.json()).toEqual({ data: ['claude'], agentConnected: true })
  expect(loadAiConnection).toHaveBeenCalledWith({}, 'user')
  expect(response.headers.get('Cache-Control')).toContain('no-store')
})
it('reads a key that names no client as a connected agent with no client to hand work to', async () => {
  vi.mocked(loadAiConnection).mockResolvedValue({ connected: true, clients: [] })
  expect(await (await GET(request, params)).json()).toEqual({ data: [], agentConnected: true })
})
it('reads no key as not connected', async () => {
  vi.mocked(loadAiConnection).mockResolvedValue({ connected: false, clients: [] })
  expect(await (await GET(request, params)).json()).toEqual({ data: [], agentConnected: false })
})
