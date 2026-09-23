/**
 * Tests for /api/dimensions/rules (list + create) and
 * /api/dimensions/rules/[id] (update + delete) — dimensions PR10.
 *
 * Exercises the routes through the real withRouteContext wrapper, mocking
 * only its auth/company dependencies and injecting a queued Supabase mock via
 * requireAuth. Covers: 401, the DTO mapping contract, the account filter
 * validation, the schema's value-presence superRefine, referential 404s, the
 * 23505 → 409 duplicate mapping, PATCH's effective-type validation, and
 * DELETE's count-based 404.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET, POST } from '../rules/route'
import { PATCH, DELETE } from '../rules/[id]/route'

const DIM_ID = '11111111-1111-4111-8111-111111111111'
const VALUE_ID = '22222222-2222-4222-8222-222222222222'
const RULE_ID = '33333333-3333-4333-8333-333333333333'

const noParams = { params: Promise.resolve({}) }
const idParams = createMockRouteParams({ id: RULE_ID })

interface RuleDto {
  account_dimension_rule_id: string
  account_number: string
  dimension_id: string
  sie_dim_no: number
  dimension_name: string
  rule_type: string
  value_id: string | null
  value_code: string | null
  value_name: string | null
  is_active: boolean
}

type RuleBody = { data: { rule: RuleDto } }
type RulesBody = { data: { rules: RuleDto[] } }
type ErrorBody = { error: { code: string; message: string } }

/** Raw row exactly as RULE_SELECT returns it (joined registry aliases). */
function makeRawRule(overrides: Record<string, unknown> = {}) {
  return {
    id: RULE_ID,
    account_number: '4010',
    rule_type: 'default',
    value_id: VALUE_ID,
    is_active: true,
    dimension: { id: DIM_ID, sie_dim_no: 6, name: 'Projekt' },
    value: { code: 'P001', name: 'Projekt Alpha' },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
})

describe('GET /api/dimensions/rules', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(createMockRequest('/api/dimensions/rules'), noParams)

    expect(response.status).toBe(401)
  })

  it('maps rows through the DTO (account_dimension_rule_id + value fields)', async () => {
    enqueue({
      data: [
        makeRawRule(),
        makeRawRule({
          id: '44444444-4444-4444-8444-444444444444',
          account_number: '5010',
          rule_type: 'required',
          value_id: null,
          value: null,
        }),
      ],
    })

    const response = await GET(createMockRequest('/api/dimensions/rules'), noParams)
    const { status, body } = await parseJsonResponse<RulesBody>(response)

    expect(status).toBe(200)
    expect(body.data.rules).toHaveLength(2)
    expect(body.data.rules[0]).toEqual({
      account_dimension_rule_id: RULE_ID,
      account_number: '4010',
      dimension_id: DIM_ID,
      sie_dim_no: 6,
      dimension_name: 'Projekt',
      rule_type: 'default',
      value_id: VALUE_ID,
      value_code: 'P001',
      value_name: 'Projekt Alpha',
      is_active: true,
    })
    // A required rule has no value — the DTO carries explicit nulls.
    expect(body.data.rules[1]).toMatchObject({
      rule_type: 'required',
      value_id: null,
      value_code: null,
      value_name: null,
    })
  })

  it('rejects a malformed account_number filter with 400', async () => {
    const response = await GET(
      createMockRequest('/api/dimensions/rules', { searchParams: { account_number: '40' } }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{ type: string }>(response)

    expect(status).toBe(400)
    // validateQuery's canonical envelope (review fix: inline regex → schema).
    expect(body.type).toBe('validation_error')
  })
})

describe('POST /api/dimensions/rules', () => {
  const postRequest = (body: Record<string, unknown>) =>
    createMockRequest('/api/dimensions/rules', { method: 'POST', body })

  const validDefaultBody = {
    account_number: '4010',
    dimension_id: DIM_ID,
    rule_type: 'default',
    value_id: VALUE_ID,
  }

  it('creates a default rule (dimension → value → account → insert) with 201', async () => {
    enqueue({ data: { id: DIM_ID, is_active: true } }) // dimension lookup
    enqueue({ data: { id: VALUE_ID, is_active: true } }) // value lookup
    enqueue({ data: { account_number: '4010' } }) // chart lookup
    enqueue({ data: makeRawRule() }) // insert returning RULE_SELECT

    const response = await POST(postRequest(validDefaultBody), noParams)
    const { status, body } = await parseJsonResponse<RuleBody>(response)

    expect(status).toBe(201)
    expect(body.data.rule.account_dimension_rule_id).toBe(RULE_ID)
    expect(body.data.rule.rule_type).toBe('default')
    expect(body.data.rule.value_code).toBe('P001')
  })

  it('rejects a required rule that carries a value (schema superRefine)', async () => {
    const response = await POST(
      postRequest({
        account_number: '4010',
        dimension_id: DIM_ID,
        rule_type: 'required',
        value_id: VALUE_ID,
      }),
      noParams,
    )

    expect(response.status).toBe(400)
  })

  it('rejects a default rule without a value (schema superRefine)', async () => {
    const response = await POST(
      postRequest({ account_number: '4010', dimension_id: DIM_ID, rule_type: 'default' }),
      noParams,
    )

    expect(response.status).toBe(400)
  })

  it('returns 404 for a dimension the company does not have', async () => {
    enqueue({ data: null }) // dimension lookup misses

    const response = await POST(postRequest(validDefaultBody), noParams)
    const { status, body } = await parseJsonResponse<ErrorBody>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('DIMENSION_NOT_FOUND')
  })

  it('maps the UNIQUE violation (23505) to 409 DIMENSION_RULE_EXISTS', async () => {
    enqueue({ data: { id: DIM_ID, is_active: true } })
    enqueue({ data: { id: VALUE_ID, is_active: true } })
    enqueue({ data: { account_number: '4010' } })
    enqueue({
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    })

    const response = await POST(postRequest(validDefaultBody), noParams)
    const { status, body } = await parseJsonResponse<ErrorBody>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('DIMENSION_RULE_EXISTS')
  })
})

describe('PATCH /api/dimensions/rules/[id]', () => {
  const patchRequest = (body: Record<string, unknown>) =>
    createMockRequest(`/api/dimensions/rules/${RULE_ID}`, { method: 'PATCH', body })

  it('pauses a rule via is_active without touching the value', async () => {
    enqueue({
      data: { id: RULE_ID, rule_type: 'default', value_id: VALUE_ID, dimension_id: DIM_ID },
    }) // existing lookup
    enqueue({ data: makeRawRule({ is_active: false }) }) // update returning RULE_SELECT

    const response = await PATCH(patchRequest({ is_active: false }), idParams)
    const { status, body } = await parseJsonResponse<RuleBody>(response)

    expect(status).toBe(200)
    expect(body.data.rule.is_active).toBe(false)
    expect(body.data.rule.account_dimension_rule_id).toBe(RULE_ID)
  })

  it('rejects switching to required while the stored value remains (effective type)', async () => {
    enqueue({
      data: { id: RULE_ID, rule_type: 'default', value_id: VALUE_ID, dimension_id: DIM_ID },
    })

    const response = await PATCH(patchRequest({ rule_type: 'required' }), idParams)
    const { status, body } = await parseJsonResponse<ErrorBody>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })

  it('returns 404 for a rule outside the company', async () => {
    enqueue({ data: null })

    const response = await PATCH(patchRequest({ is_active: false }), idParams)
    const { status, body } = await parseJsonResponse<ErrorBody>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('DIMENSION_RULE_NOT_FOUND')
  })
})

describe('DELETE /api/dimensions/rules/[id]', () => {
  it('deletes the rule and confirms', async () => {
    enqueue({ count: 1 })

    const response = await DELETE(
      createMockRequest(`/api/dimensions/rules/${RULE_ID}`, { method: 'DELETE' }),
      idParams,
    )
    const { status, body } = await parseJsonResponse<{ data: { deleted: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.deleted).toBe(true)
  })

  it('returns 404 when nothing was deleted (count 0)', async () => {
    enqueue({ count: 0 })

    const response = await DELETE(
      createMockRequest(`/api/dimensions/rules/${RULE_ID}`, { method: 'DELETE' }),
      idParams,
    )
    const { status, body } = await parseJsonResponse<ErrorBody>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('DIMENSION_RULE_NOT_FOUND')
  })
})
