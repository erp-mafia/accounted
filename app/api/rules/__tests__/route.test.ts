import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET as listRules } from '../route'
import { GET as getRule, PATCH as patchRule } from '../[id]/route'

const RULE_ID = '11111111-1111-4111-8111-111111111111'
const rule = {
  id: RULE_ID,
  counterparty_name: 'google cloud emea',
  counterparty_aliases: ['GOOGLE CLOUD EMEA'],
  debit_account: '6540',
  credit_account: '1930',
  vat_treatment: 'reverse_charge',
  vat_account: null,
  category: 'expense_software',
  occurrence_count: 14,
  corrections: 0,
  confidence: 0.9,
  last_seen_date: '2026-09-04',
  source: 'auto_learned',
  mode: 'propose',
  paused_at: null,
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-09-04T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
})

describe('GET /api/rules', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await listRules(createMockRequest('/api/rules'), { params: Promise.resolve({}) })
    expect(res.status).toBe(401)
  })

  it('lists the company rules most used first', async () => {
    enqueue({ data: [rule] })
    const { status, body } = await parseJsonResponse<{ data: Array<{ id: string; mode: string }> }>(
      await listRules(createMockRequest('/api/rules'), { params: Promise.resolve({}) }),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual([rule])
    expect(findCalls('categorization_templates', 'order')[0]).toEqual(['occurrence_count', { ascending: false }])
  })
})

describe('GET /api/rules/[id]', () => {
  it('rejects a malformed id', async () => {
    const res = await getRule(createMockRequest('/api/rules/nope'), { params: Promise.resolve({ id: 'nope' }) })
    expect(res.status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns 404 for a rule of another company', async () => {
    enqueue({ data: null })
    const res = await getRule(createMockRequest(`/api/rules/${RULE_ID}`), { params: Promise.resolve({ id: RULE_ID }) })
    expect(res.status).toBe(404)
  })

  it('returns the rule with this year’s matches by bank text', async () => {
    enqueue({ data: rule })
    enqueue({ data: [{ id: 'tx-1', date: '2026-09-04', description: 'GOOGLE CLOUD EMEA', amount: -412.5, currency: 'SEK', journal_entry_id: 'je-1' }] })
    const { status, body } = await parseJsonResponse<{ data: { rule: { id: string }; matches: Array<{ id: string }> } }>(
      await getRule(createMockRequest(`/api/rules/${RULE_ID}`), { params: Promise.resolve({ id: RULE_ID }) }),
    )
    expect(status).toBe(200)
    expect(body.data.rule.id).toBe(RULE_ID)
    expect(body.data.matches.map((m) => m.id)).toEqual(['tx-1'])
    // The alias filter is built from sanitised names only.
    expect(findCalls('transactions', 'or')[0]).toEqual(['description.ilike.%google cloud emea%'])
  })
})

describe('PATCH /api/rules/[id]', () => {
  const patch = (body: unknown) =>
    patchRule(createMockRequest(`/api/rules/${RULE_ID}`, { method: 'PATCH', body }), {
      params: Promise.resolve({ id: RULE_ID }),
    })

  it('rejects an unknown mode', async () => {
    const res = await patch({ mode: 'sideways' })
    expect(res.status).toBe(400)
  })

  it('refuses the auto step until the autopilot tier exists', async () => {
    const { status, body } = await parseJsonResponse<{ error: string }>(await patch({ mode: 'auto' }))
    expect(status).toBe(400)
    expect(body.error).toMatch(/autopilot/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('pauses a rule', async () => {
    enqueue({ data: { ...rule, mode: 'paused', paused_at: '2026-09-07T10:00:00Z' } })
    const { status, body } = await parseJsonResponse<{ data: { mode: string } }>(await patch({ mode: 'paused' }))
    expect(status).toBe(200)
    expect(body.data.mode).toBe('paused')
    expect(findCalls('categorization_templates', 'update')[0]).toEqual([{ mode: 'paused' }])
  })

  it('returns 404 when the rule is not the company’s', async () => {
    enqueue({ data: null })
    const res = await patch({ mode: 'propose' })
    expect(res.status).toBe(404)
  })
})
