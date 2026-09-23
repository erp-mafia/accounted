/**
 * Tests for POST /api/agent/onboarding/stream — auth surface only.
 *
 * The composer pipeline itself is exercised via lib tests; here we lock in
 * the guard order: 401, membership 403, and the viewer refusal (the pipeline
 * upserts agent_profiles, so viewers must not be able to trigger it).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/rate-limits/agent', () => ({
  checkAgentRateLimit: vi.fn().mockResolvedValue({ ok: true }),
  agentRateLimitResponseBody: () => ({ error: 'För många förfrågningar.' }),
}))

vi.mock('@/lib/sandbox/guard', () => ({ guardSandbox: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/entitlements/has-capability', () => ({
  requireCapability: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/entitlements/keys', () => ({ CAPABILITY: { ai: 'ai' } }))

// Pipeline internals — never reached in these tests, stubbed so the module loads.
vi.mock('@/lib/agent/composer/inputs', () => ({
  gatherComposerInputs: vi.fn(),
  inputsToSourceSignals: vi.fn(),
}))
vi.mock('@/lib/agent/composer/atom-selection', () => ({
  selectAtoms: vi.fn(),
  filterRedundantQuestions: vi.fn(),
}))
vi.mock('@/lib/agent/composer/narrative', () => ({ writeNarrative: vi.fn() }))
vi.mock('@/lib/agent/composer/fallback', () => ({
  fallbackAtomSelection: vi.fn(),
  fallbackNarrative: vi.fn(),
}))
vi.mock('@/lib/agent/composer/prewarm', () => ({ preWarmAtomCache: vi.fn() }))
vi.mock('@/lib/agent/composer/client', () => ({ OPUS_MODEL: 'opus-test' }))
vi.mock('@/lib/agent/composer/tic-fetch', () => ({ ensureTicSnapshot: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

import { createClient } from '@/lib/supabase/server'
import { POST } from '../onboarding/stream/route'

const mockCreateClient = vi.mocked(createClient)

function mockAuth(userId: string | null, membership: { role: string } | null) {
  mockCreateClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: userId ? { id: userId } : null } }),
    },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: membership, error: null }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/agent/onboarding/stream', () => {
  it('returns 401 when not authenticated', async () => {
    mockAuth(null, null)
    const req = createMockRequest('/api/agent/onboarding/stream', { method: 'POST', body: {} })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('returns 403 for a non-member', async () => {
    mockAuth('user-1', null)
    const req = createMockRequest('/api/agent/onboarding/stream', { method: 'POST', body: {} })
    const { status } = await parseJsonResponse(await POST(req))
    expect(status).toBe(403)
  })

  it('refuses a viewer with 403 (pipeline upserts agent_profiles)', async () => {
    mockAuth('user-1', { role: 'viewer' })
    const req = createMockRequest('/api/agent/onboarding/stream', { method: 'POST', body: {} })
    const { status, body } = await parseJsonResponse<{ error: string }>(await POST(req))
    expect(status).toBe(403)
    expect(body.error).toContain('läsbehörighet')
  })
})
