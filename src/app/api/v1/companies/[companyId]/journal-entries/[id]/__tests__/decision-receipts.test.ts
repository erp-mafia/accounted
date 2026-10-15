/**
 * GET /api/v1/companies/:companyId/journal-entries/:id: decision_receipts.
 *
 * The read is additive: the verifikation answers as before, plus the receipts
 * recorded for it (empty for a voucher no recorded decision produced). The
 * reader itself is unit-tested in src/lib/suggestion-log; here it is mocked
 * so the route contract is what is pinned: auth, 404 before any receipt
 * lookup, company scoping, and the field on the response and in the spec.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/suggestion-log/receipts', async () => {
  const actual = await vi.importActual<typeof import('@/lib/suggestion-log/receipts')>('@/lib/suggestion-log/receipts')
  return { ...actual, getDecisionReceipts: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { getDecisionReceipts, buildDecisionReceipt, DecisionReceiptSchema } from '@/lib/suggestion-log/receipts'
import { listEndpoints } from '@/lib/api/v1/registry'
import { createTableMockSupabase } from '@/tests/helpers'
import { GET } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockReceipts = getDecisionReceipts as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ENTRY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const ENTRY_ROW = {
  id: ENTRY_ID,
  fiscal_period_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  voucher_series: 'A',
  voucher_number: 142,
  entry_date: '2026-05-12',
  description: 'Bankavgift maj',
  status: 'posted',
  source_type: 'bank_transaction',
  source_id: null,
  notes: null,
  reverses_id: null,
  reversed_by_id: null,
  correction_of_id: null,
  created_at: '2026-05-12T09:00:00Z',
  updated_at: '2026-05-12T09:00:00Z',
  lines: [],
}

const RECEIPT = buildDecisionReceipt(
  {
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'bank_line',
    transaction_id: '11111111-1111-4111-8111-111111111111',
    inbox_item_id: null,
    document_id: null,
    suggestions: [],
    acted_on: null,
    final: { journal_entry_id: ENTRY_ID, booking: null, account: '6570', vat_treatment: null, lines: [] },
    outcome: 'manual',
    actor_type: 'api_key',
    resolved_by: 'user-1',
    created_at: '2026-05-12T09:00:00.000Z',
  },
  { entries: new Map(), operations: new Map() },
)

/** company_members proves the key may touch this company; journal_entries answers `entryRow`. */
function makeSupabase(entryRow: unknown) {
  return createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, user_id: 'user-1', role: 'owner' } },
    journal_entries: { data: entryRow },
  }).supabase
}

function getRequest({ auth = true } = {}): Request {
  const headers: Record<string, string> = {}
  if (auth) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  return new Request(`http://localhost/api/v1/companies/${COMPANY_ID}/journal-entries/${ENTRY_ID}`, { headers })
}

const params = { params: Promise.resolve({ companyId: COMPANY_ID, id: ENTRY_ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['reports:read'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(makeSupabase(ENTRY_ROW))
  mockReceipts.mockResolvedValue([RECEIPT])
})

describe('GET /journal-entries/:id decision_receipts', () => {
  it('401 without an API key, and no receipt is read', async () => {
    const res = await GET(getRequest({ auth: false }), params)
    expect(res.status).toBe(401)
    expect(mockReceipts).not.toHaveBeenCalled()
  })

  it('404 for an entry outside the company, before any receipt lookup', async () => {
    mockServiceClient.mockReturnValue(makeSupabase(null))
    const res = await GET(getRequest(), params)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('JOURNAL_ENTRY_NOT_FOUND')
    expect(mockReceipts).not.toHaveBeenCalled()
  })

  it('answers the verifikation with its receipts, read for this company and entry', async () => {
    const res = await GET(getRequest(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.voucher_number).toBe(142)
    expect(body.data.decision_receipts).toHaveLength(1)
    expect(DecisionReceiptSchema.safeParse(body.data.decision_receipts[0]).success).toBe(true)
    expect(body.data.decision_receipts[0]).toMatchObject({ outcome: 'manual', rule_version: null, checks: null })
    expect(mockReceipts).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, { journalEntryId: ENTRY_ID })
  })

  it('answers an empty list for a voucher no recorded decision produced', async () => {
    mockReceipts.mockResolvedValue([])
    const body = await (await GET(getRequest(), params)).json()
    expect(body.data.decision_receipts).toEqual([])
  })

  it('a failed receipt lookup keeps the verifikation and answers null (unknown), never an empty "no decision"', async () => {
    mockReceipts.mockRejectedValue(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))
    const res = await GET(getRequest(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.decision_receipts).toBeNull()
    expect(body.data.lines).toBeDefined()
  })

  it('the registered response schema documents decision_receipts', () => {
    const ep = listEndpoints().find((e) => e.operation === 'journal-entries.get')
    const envelope = ep!.response.success as z.ZodObject<z.ZodRawShape>
    const data = envelope.shape.data as z.ZodObject<z.ZodRawShape>
    expect(Object.keys(data.shape)).toContain('decision_receipts')
  })
})
