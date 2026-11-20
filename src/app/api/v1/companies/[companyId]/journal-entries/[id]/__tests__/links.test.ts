/**
 * GET /api/v1/companies/:companyId/journal-entries/:id: links.
 *
 * The read is additive: the verifikation answers as before, plus what is
 * linked to it with each link's recorded basis (src/lib/links/voucher-links.ts,
 * unit-tested there and mocked here) so the route contract is what is pinned:
 * auth, 404 before any link lookup, company scoping, null (unknown) on a
 * failed lookup, and the field in the spec.
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
  return { ...actual, getDecisionReceipts: vi.fn(async () => []) }
})
vi.mock('@/lib/links/voucher-links', async () => {
  const actual = await vi.importActual<typeof import('@/lib/links/voucher-links')>('@/lib/links/voucher-links')
  return { ...actual, getVoucherLinks: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { getVoucherLinks, VoucherLinkSchema, type VoucherLink } from '@/lib/links/voucher-links'
import { listEndpoints } from '@/lib/api/v1/registry'
import { createTableMockSupabase } from '@/tests/helpers'
import { GET } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockLinks = getVoucherLinks as ReturnType<typeof vi.fn>

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

const LINK: VoucherLink = {
  kind: 'bank_transaction',
  transaction_id: '11111111-1111-4111-8111-111111111111',
  via: 'pointer',
  document_id: null,
  invoice_id: null,
  invoice_payment_id: null,
  supplier_invoice_id: null,
  supplier_invoice_payment_id: null,
  settlement_id: null,
  basis: 'client_asserted',
  evidence: null,
}

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

describe('GET /journal-entries/:id links', () => {
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
    mockLinks.mockResolvedValue([LINK])
  })

  it('401 without an API key, and no link is read', async () => {
    const res = await GET(getRequest({ auth: false }), params)
    expect(res.status).toBe(401)
    expect(mockLinks).not.toHaveBeenCalled()
  })

  it('404 for an entry outside the company, before any link lookup', async () => {
    mockServiceClient.mockReturnValue(makeSupabase(null))
    const res = await GET(getRequest(), params)
    expect(res.status).toBe(404)
    expect(mockLinks).not.toHaveBeenCalled()
  })

  it('answers the links with their basis, read for this company and entry', async () => {
    const res = await GET(getRequest(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.voucher_number).toBe(142)
    expect(body.data.links).toEqual([LINK])
    expect(VoucherLinkSchema.safeParse(body.data.links[0]).success).toBe(true)
    expect(mockLinks).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, ENTRY_ID)
  })

  it('a failed link lookup keeps the verifikation and answers null (unknown), never an empty list', async () => {
    mockLinks.mockRejectedValue(new Error('canceling statement due to statement timeout'))
    const res = await GET(getRequest(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.links).toBeNull()
    expect(body.data.lines).toBeDefined()
  })

  it('the registered response schema documents links', () => {
    const ep = listEndpoints().find((e) => e.operation === 'journal-entries.get')
    const envelope = ep!.response.success as z.ZodObject<z.ZodRawShape>
    const data = envelope.shape.data as z.ZodObject<z.ZodRawShape>
    expect(Object.keys(data.shape)).toContain('links')
  })
})
