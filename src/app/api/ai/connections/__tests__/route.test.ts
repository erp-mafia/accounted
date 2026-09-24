import { beforeEach, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company') }))
vi.mock('@/lib/onboarding/ai-clients.server', () => ({ loadConnectedAiClients: vi.fn().mockResolvedValue(['claude']) }))
import { requireAuth } from '@/lib/auth/require-auth'
import { loadConnectedAiClients } from '@/lib/onboarding/ai-clients.server'
import { GET } from '../route'
const request = new Request('http://localhost/api/ai/connections')
const params = { params: Promise.resolve({}) }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user' }, supabase: {}, error: null } as never) })
it('requires authentication', async () => {
  vi.mocked(requireAuth).mockResolvedValue({ error: NextResponse.json({}, { status: 401 }) } as never)
  expect((await GET(request, params)).status).toBe(401)
})
it('returns only the current user connection labels, with no-store caching', async () => {
  const response = await GET(request, params)
  expect(await response.json()).toEqual({ data: ['claude'] })
  expect(loadConnectedAiClients).toHaveBeenCalledWith({}, 'user')
  expect(response.headers.get('Cache-Control')).toContain('no-store')
})
