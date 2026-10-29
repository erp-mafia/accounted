/**
 * An API key's unattended ceiling on POST /supplier-invoices/:id/approve
 * (#125). An attest posts nothing, but it releases the invoice for payment,
 * which is why the staged agent operation (approve_supplier_invoice) is
 * priced too. The attest service, every door's one path, refuses a key's
 * attest above its ceiling: the route never reads the ceiling itself.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
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
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})
vi.mock('@/lib/events', () => ({ eventBus: { emit: vi.fn().mockResolvedValue(undefined) } }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { POST as approve } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SI_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function auth(unattendedCommitLimit: number | null) {
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'Leverantörsrobot',
    scopes: ['suppliers:read', 'suppliers:write'],
    mode: 'live',
    unattendedCommitLimit,
  })
}

/** A registered invoice, attested by its update; the key's user keeps the books. */
function client(invoice: Record<string, unknown>) {
  const row = {
    id: SI_ID,
    company_id: COMPANY_ID,
    user_id: 'user-2',
    status: 'registered',
    approved_at: null,
    approved_by: null,
    due_date: '2099-12-31',
    remaining_amount: invoice.total,
    currency: 'SEK',
    total_sek: null,
    exchange_rate: null,
    is_credit_note: false,
    arrival_number: 42,
    supplier_invoice_number: 'F-1',
    ...invoice,
  }
  const supplierInvoices: TableMockResolver = (calls) =>
    calls.some((c) => c.method === 'update')
      ? { data: { ...row, status: 'approved', approved_at: '2026-10-28T10:00:00.000Z', approved_by: 'user-1' } }
      : { data: row }
  // The gate's membership read is single-row; the attest service lists who keeps the books.
  const members: TableMockResolver = (calls) =>
    calls.some((c) => c.method === 'maybeSingle' || c.method === 'single')
      ? { data: { company_id: COMPANY_ID, user_id: 'user-1', role: 'owner' } }
      : { data: [{ user_id: 'user-1', role: 'owner' }] }
  const attestations: TableMockResolver = (calls) =>
    calls.some((c) => c.method === 'insert') ? { data: { id: 'att-1' } } : { data: [] }
  return createTableMockSupabase({
    company_members: members,
    supplier_invoices: supplierInvoices,
    supplier_invoice_attestations: attestations,
    company_settings: { data: { accounting_method: 'faktureringsmetoden' } },
  })
}

const send = (query = '') =>
  approve(
    new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}/approve${query}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-fixture-not-a-real-key', 'Idempotency-Key': crypto.randomUUID() },
    }),
    { params: Promise.resolve({ companyId: COMPANY_ID, id: SI_ID }) },
  )

const attested = (c: ReturnType<typeof client>) => c.findCalls('supplier_invoices', 'update').length > 0

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /supplier-invoices/:id/approve: unattended ceiling', () => {
  it('refuses to attest a 12 000 kr invoice on a key capped at 10 000, writing nothing', async () => {
    auth(10000)
    const c = client({ total: 12000 })
    mockServiceClient.mockReturnValue(c.supabase)

    const res = await send()
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.error.code).toBe('UNATTENDED_COMMIT_LIMIT_EXCEEDED')
    expect(body.error.details).toMatchObject({ attempted: 12000, limit: 10000 })
    expect(attested(c)).toBe(false)
    expect(c.findCalls('supplier_invoice_attestations', 'insert')).toEqual([])
  })

  it('prices a foreign invoice in SEK', async () => {
    auth(10000)
    const c = client({ total: 1000, currency: 'EUR', total_sek: 11500, exchange_rate: 11.5 })
    mockServiceClient.mockReturnValue(c.supabase)

    const res = await send()

    expect(res.status).toBe(403)
    expect((await res.json()).error.details).toMatchObject({ attempted: 11500, limit: 10000 })
    expect(attested(c)).toBe(false)
  })

  it('refuses a foreign invoice it cannot price in SEK, as the attest policy does', async () => {
    auth(10000)
    const c = client({ total: 100, currency: 'USD', total_sek: null, exchange_rate: null })
    mockServiceClient.mockReturnValue(c.supabase)

    const res = await send()

    expect(res.status).toBe(403)
    expect((await res.json()).error.details).toMatchObject({ attempted: null, limit: 10000, reason: 'sek_total_unknown' })
    expect(attested(c)).toBe(false)
  })

  it('attests a credit note above the ceiling: it releases no payment', async () => {
    auth(10000)
    const c = client({ total: 50000, is_credit_note: true })
    mockServiceClient.mockReturnValue(c.supabase)

    expect((await send()).status).toBe(200)
    expect(attested(c)).toBe(true)
  })

  it('refuses the dry run too', async () => {
    auth(10000)
    mockServiceClient.mockReturnValue(client({ total: 12000 }).supabase)

    expect((await send('?dry_run=true')).status).toBe(403)
  })

  it('attests a 3 000 kr invoice on the same key', async () => {
    auth(10000)
    const c = client({ total: 3000 })
    mockServiceClient.mockReturnValue(c.supabase)

    const res = await send()

    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ status: 'approved', attest: { approved: true } })
    expect(attested(c)).toBe(true)
  })

  it('attests any amount for a key without a ceiling', async () => {
    auth(null)
    const c = client({ total: 9_000_000 })
    mockServiceClient.mockReturnValue(c.supabase)

    expect((await send()).status).toBe(200)
    expect(attested(c)).toBe(true)
  })
})
