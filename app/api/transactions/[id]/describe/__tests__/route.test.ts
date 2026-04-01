import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeTransaction,
  parseJsonResponse,
} from '@/tests/helpers'

// Mock init
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

// Mock counterparty template lookup
vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  findCounterpartyTemplate: vi.fn().mockResolvedValue(null),
  buildMappingResultFromCounterpartyTemplate: vi.fn(),
  formatCounterpartyName: vi.fn((name: string) => name),
}))

// Mock booking templates
const mockFindMatchingTemplates = vi.fn().mockReturnValue([])
vi.mock('@/lib/bookkeeping/booking-templates', () => ({
  findMatchingTemplates: (...args: unknown[]) => mockFindMatchingTemplates(...args),
}))

// Mock Supabase
const mockCreateClient = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

describe('POST /api/transactions/[id]/describe', () => {
  let POST: typeof import('../route').POST

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../route')
    POST = mod.POST
  })

  it('returns 401 when not authenticated', async () => {
    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Not authenticated' },
    })
    mockCreateClient.mockResolvedValue(supabase)

    const req = createMockRequest('/api/transactions/test-id/describe', {
      method: 'POST',
      body: { description: 'business lunch' },
    })

    const res = await POST(req, createMockRouteParams({ id: 'test-id' }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(401)
    expect(body).toHaveProperty('error', 'Unauthorized')
  })

  it('returns 400 for invalid body (description too short)', async () => {
    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    mockCreateClient.mockResolvedValue(supabase)

    const req = createMockRequest('/api/transactions/test-id/describe', {
      method: 'POST',
      body: { description: 'ab' },
    })

    const res = await POST(req, createMockRouteParams({ id: 'test-id' }))
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(400)
  })

  it('returns 404 when transaction not found', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    enqueueMany([
      // transaction fetch
      { data: null, error: { message: 'Not found' } },
    ])
    mockCreateClient.mockResolvedValue(supabase)

    const req = createMockRequest('/api/transactions/nonexistent/describe', {
      method: 'POST',
      body: { description: 'business lunch' },
    })

    const res = await POST(req, createMockRouteParams({ id: 'nonexistent' }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(404)
    expect(body).toHaveProperty('error', 'Transaction not found')
  })

  it('returns template candidates on happy path', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      merchant_name: 'Restaurant XYZ',
      amount: -450,
    })

    mockFindMatchingTemplates.mockReturnValueOnce([
      {
        template: {
          id: 'restaurant_dining',
          name_sv: 'Restaurangbesök',
          name_en: 'Restaurant dining',
          group: 'representation',
          debit_account: '6071',
          credit_account: '1930',
          description_sv: 'Representation - restaurang',
          vat_rate: 0.12,
          vat_treatment: 'reduced_12',
          deductibility: 'conditional',
          deductibility_note_sv: null,
          special_rules_sv: null,
          risk_level: 'MEDIUM',
        },
        confidence: 0.82,
      },
    ])

    const { supabase, enqueueMany } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    enqueueMany([
      // transaction fetch
      { data: tx, error: null },
      // company_settings
      { data: { entity_type: 'enskild_firma' }, error: null },
      // batch candidate count
      { data: null, error: null, count: 3 },
    ])
    mockCreateClient.mockResolvedValue(supabase)

    const req = createMockRequest('/api/transactions/tx-1/describe', {
      method: 'POST',
      body: { description: 'business lunch with client' },
    })

    const res = await POST(req, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    expect(status).toBe(200)
    expect(body.data.templates).toHaveLength(1)
    expect(body.data.needs_more_detail).toBe(false)
    expect(body.data.ai_suggestion).toBeNull()
    expect(body.data.user_description).toBe('business lunch with client')
    expect(body.data.batch_candidate_count).toBe(3)
    expect(body.data.merchant_name).toBe('Restaurant XYZ')
  })

  it('sets needs_more_detail when confidence is low', async () => {
    const tx = makeTransaction({ id: 'tx-2', merchant_name: null })

    mockFindMatchingTemplates.mockReturnValueOnce([
      {
        template: {
          id: 'misc',
          name_sv: 'Diverse',
          name_en: 'Miscellaneous',
          group: 'other',
          debit_account: '6991',
          credit_account: '1930',
          description_sv: 'Okategoriserad utgift',
          vat_rate: 0,
          vat_treatment: null,
          deductibility: 'full',
          deductibility_note_sv: null,
          special_rules_sv: null,
          risk_level: 'LOW',
        },
        confidence: 0.4,
      },
    ])

    const { supabase, enqueueMany } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    enqueueMany([
      // transaction fetch
      { data: tx, error: null },
      // company_settings
      { data: { entity_type: 'enskild_firma' }, error: null },
    ])
    mockCreateClient.mockResolvedValue(supabase)

    const req = createMockRequest('/api/transactions/tx-2/describe', {
      method: 'POST',
      body: { description: 'some kind of payment' },
    })

    const res = await POST(req, createMockRouteParams({ id: 'tx-2' }))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    expect(status).toBe(200)
    expect(body.data.needs_more_detail).toBe(true)
  })
})
