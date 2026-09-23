import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-a') }))
vi.mock('@/lib/entitlements/has-capability', () => ({ requireCapability: vi.fn() }))
vi.mock('@/lib/entitlements/keys', () => ({ CAPABILITY: { ai: 'ai' } }))
vi.mock('@/lib/rate-limits/agent', () => ({ checkAgentRateLimit: vi.fn(), agentRateLimitResponseBody: () => ({ error: 'För många frågor.' }) }))
const generateStructured = vi.fn()
const getAiStatus = vi.fn()
vi.mock('@/lib/ai', () => ({ getAiService: () => ({ generateStructured }), getAiStatus: () => getAiStatus() }))

import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { checkAgentRateLimit } from '@/lib/rate-limits/agent'
import { POST } from '../route'

const ctx = { params: Promise.resolve({}) }
const body = { client: 'Claude', locale: 'sv', description: 'Gå igenom leverantörsfakturorna varje månad.', turns: [] }
const post = (payload: unknown) => POST(new Request('http://localhost/api/skills/draft', { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } }), ctx)
const question = { kind: 'question', question: 'Alla leverantörer?', topic: 'Leverantörer', suggestions: ['Alla', 'Några'], name: null, lede: null, steps: null, rules: null, facts: null }

beforeEach(() => {
  vi.clearAllMocks(); reset()
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user' }, supabase, error: null } as never)
  vi.mocked(requireWritePermission).mockResolvedValue({ ok: true } as never)
  vi.mocked(requireCapability).mockResolvedValue(null as never)
  vi.mocked(checkAgentRateLimit).mockResolvedValue({ ok: true })
  getAiStatus.mockReturnValue({ configured: true })
  generateStructured.mockResolvedValue({ value: question, model: 'm', usage: {} })
})

describe('POST /api/skills/draft', () => {
  it('requires authentication', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: NextResponse.json({}, { status: 401 }) } as never)
    expect((await post(body)).status).toBe(401)
    expect(generateStructured).not.toHaveBeenCalled()
  })

  it.each([
    [{ ...body, description: '' }],
    [{ ...body, client: 'Gemini' }],
    [{ ...body, turns: [1, 2, 3, 4].map(() => ({ question: 'Q', answer: 'A' })) }],
    [{ ...body, company_id: 'other' }],
  ])('rejects an invalid conversation', async (payload) => {
    expect((await post(payload)).status).toBe(400)
    expect(generateStructured).not.toHaveBeenCalled()
  })

  it('answers 503 when no AI is configured', async () => {
    getAiStatus.mockReturnValue({ configured: false })
    expect((await post(body)).status).toBe(503)
  })

  it('answers 429 when the user is rate limited', async () => {
    vi.mocked(checkAgentRateLimit).mockResolvedValue({ ok: false, scope: 'minute', retryAfterSec: 30 })
    expect((await post(body)).status).toBe(429)
    expect(generateStructured).not.toHaveBeenCalled()
  })

  it('returns the next question', async () => {
    const response = await post(body)
    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual({ kind: 'question', question: 'Alla leverantörer?', topic: 'Leverantörer', suggestions: ['Alla', 'Några'] })
  })

  it('answers 502 when the model gives nothing usable', async () => {
    generateStructured.mockResolvedValue({ value: { kind: 'summary' }, model: 'm', usage: {} })
    expect((await post(body)).status).toBe(502)
  })
})
