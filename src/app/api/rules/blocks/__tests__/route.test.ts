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
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET as listBlocks, POST as createBlock } from '../route'
import { DELETE as archiveBlock } from '../[ruleId]/route'

const RULE_ID = '22222222-2222-4222-8222-222222222222'
const noParams = { params: Promise.resolve({}) }
const ruleParams = (ruleId: string) => ({ params: Promise.resolve({ ruleId }) })

const rule = {
  id: RULE_ID,
  rule_id: RULE_ID,
  version: 1,
  accounts: ['6250'],
  counterparty_key: 'google cloud',
  counterparty_label: 'Google Cloud',
  amount_from_sek: '5000.00',
  vat_treatment: 'reverse_charge',
  note: null,
  valid_from: '2026-10-29T10:00:00Z',
  created_by: 'user-1',
  created_at: '2026-10-29T10:00:00Z',
  revoked_at: null,
  revoked_by: null,
  revoked_reason: null,
}

function post(body: unknown) {
  return createMockRequest('/api/rules/blocks', { method: 'POST', body })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
})

describe('GET /api/rules/blocks', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await listBlocks(createMockRequest('/api/rules/blocks'), noParams)
    expect(res.status).toBe(401)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('lists every version of the company blocks, with whether the caller may manage them', async () => {
    enqueue({ data: [rule] })
    enqueue({ data: true })
    const { status, body } = await parseJsonResponse<{ data: Array<{ id: string; amount_from_sek: number }>; can_manage: boolean }>(
      await listBlocks(createMockRequest('/api/rules/blocks'), noParams),
    )
    expect(status).toBe(200)
    expect(body.can_manage).toBe(true)
    expect(body.data).toHaveLength(1)
    // numeric arrives as a string from PostgREST; the list hands out a number.
    expect(body.data[0].amount_from_sek).toBe(5000)
    expect(findCalls('booking_review_rules', 'eq')[0]).toEqual(['company_id', 'company-1'])
  })

  it('reads as empty before the table exists', async () => {
    enqueue({ error: { code: '42P01', message: 'relation does not exist' } })
    enqueue({ data: false })
    const { status, body } = await parseJsonResponse<{ data: unknown[]; can_manage: boolean }>(
      await listBlocks(createMockRequest('/api/rules/blocks'), noParams),
    )
    expect(status).toBe(200)
    expect(body).toEqual({ data: [], can_manage: false })
  })
})

describe('POST /api/rules/blocks', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await createBlock(post({ accounts: ['6250'] }), noParams)
    expect(res.status).toBe(401)
  })

  it('refuses a member who is not owner or admin', async () => {
    enqueue({ data: false }) // user_is_company_admin
    const res = await createBlock(post({ accounts: ['6250'] }), noParams)
    expect(res.status).toBe(403)
    // Only the wrapper's user_is_company_admin: the rule was never written.
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('refuses a block without any criterion', async () => {
    enqueue({ data: true })
    const res = await createBlock(post({ note: 'nothing to match' }), noParams)
    expect(res.status).toBe(400)
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('refuses an account number that is not four digits', async () => {
    enqueue({ data: true })
    const res = await createBlock(post({ accounts: ['625'] }), noParams)
    expect(res.status).toBe(400)
  })

  it('creates the block through save_booking_review_rule', async () => {
    enqueue({ data: true })
    enqueue({ data: { ok: true, id: RULE_ID, rule_id: RULE_ID, version: 1 } })
    const { status, body } = await parseJsonResponse<{ data: { id: string; rule_id: string; version: number } }>(
      await createBlock(
        post({ accounts: ['6250', '5410'], counterparty: 'Google Cloud', amount_from_sek: 5000, vat_treatment: 'reverse_charge', note: 'Kontrollant granskar' }),
        noParams,
      ),
    )
    expect(status).toBe(201)
    expect(body.data).toEqual({ id: RULE_ID, rule_id: RULE_ID, version: 1 })
    expect(supabase.rpc).toHaveBeenLastCalledWith('save_booking_review_rule', {
      p_company_id: 'company-1',
      p_accounts: ['6250', '5410'],
      p_counterparty: 'Google Cloud',
      p_amount_from_sek: 5000,
      p_vat_treatment: 'reverse_charge',
      p_note: 'Kontrollant granskar',
      p_supersedes: null,
    })
  })

  it('answers 400 when the counterparty names no one', async () => {
    enqueue({ data: true })
    enqueue({ error: { code: '22023', message: 'BOOKING_REVIEW_RULE_UNKNOWN_COUNTERPARTY' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string; details?: { field?: string } } }>(
      await createBlock(post({ counterparty: 'Internet bet' }), noParams),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details?.field).toBe('counterparty')
  })

  it('answers 403 when the database refuses the caller', async () => {
    enqueue({ data: true })
    enqueue({ error: { code: '42501', message: 'BOOKING_REVIEW_RULE_FORBIDDEN' } })
    const res = await createBlock(post({ vat_treatment: 'none' }), noParams)
    expect(res.status).toBe(403)
  })
})

describe('DELETE /api/rules/blocks/[ruleId]', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await archiveBlock(createMockRequest(`/api/rules/blocks/${RULE_ID}`, { method: 'DELETE' }), ruleParams(RULE_ID))
    expect(res.status).toBe(401)
  })

  it('refuses a member who is not owner or admin', async () => {
    enqueue({ data: false })
    const res = await archiveBlock(createMockRequest(`/api/rules/blocks/${RULE_ID}`, { method: 'DELETE' }), ruleParams(RULE_ID))
    expect(res.status).toBe(403)
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('rejects a malformed id', async () => {
    enqueue({ data: true })
    const res = await archiveBlock(createMockRequest('/api/rules/blocks/nope', { method: 'DELETE' }), ruleParams('nope'))
    expect(res.status).toBe(400)
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('returns 404 for a block that does not exist or is already archived', async () => {
    enqueue({ data: true })
    enqueue({ error: { code: 'P0002', message: 'BOOKING_REVIEW_RULE_NOT_FOUND' } })
    const res = await archiveBlock(createMockRequest(`/api/rules/blocks/${RULE_ID}`, { method: 'DELETE' }), ruleParams(RULE_ID))
    expect(res.status).toBe(404)
  })

  it('archives the block through archive_booking_review_rule', async () => {
    enqueue({ data: true })
    enqueue({ data: { ok: true, id: RULE_ID, rule_id: RULE_ID, version: 1, revoked_at: '2026-10-29T11:00:00Z' } })
    const { status, body } = await parseJsonResponse<{ data: { rule_id: string } }>(
      await archiveBlock(createMockRequest(`/api/rules/blocks/${RULE_ID}`, { method: 'DELETE' }), ruleParams(RULE_ID)),
    )
    expect(status).toBe(200)
    expect(body.data.rule_id).toBe(RULE_ID)
    expect(supabase.rpc).toHaveBeenLastCalledWith('archive_booking_review_rule', {
      p_company_id: 'company-1',
      p_rule_id: RULE_ID,
    })
  })
})
