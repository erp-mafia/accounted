/**
 * The dry run on POST /v1/.../journal-entries/:id/commit must leave the voucher
 * series exactly where it was.
 *
 * It used to project the number by calling next_voucher_number, which is not a
 * peek: it increments voucher_sequences.last_number. Every dry run therefore
 * consumed a real number, and the next real commit got a later one, leaving a
 * gap in the löpnummer series that needs a documented explanation (BFL 5 kap.
 * 7 §, BFNAR 2013:2). The projection is now a plain read of last_number + 1.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ENTRY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const DRAFT = {
  id: ENTRY_ID,
  status: 'draft',
  fiscal_period_id: 'fp-1',
  voucher_series: 'B',
  entry_date: '2026-08-31',
}

/**
 * Every table read answers through one Proxy; single-row reads are keyed by
 * table. The `sequence` row stands for voucher_sequences: null means the
 * series has no row yet (nothing committed in it this period).
 */
function makeSupabase(sequence: { last_number: number } | null) {
  const filters: Array<[string, string, unknown]> = []
  const build = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          const rows: Record<string, unknown> = {
            company_members: { company_id: COMPANY_ID, user_id: 'user-1', role: 'owner' },
            journal_entries: DRAFT,
            voucher_sequences: sequence,
          }
          return () => Promise.resolve({ data: rows[table] ?? null, error: null })
        }
        if (prop === 'eq') {
          return (column: string, value: unknown) => {
            filters.push([table, column, value])
            return build(table)
          }
        }
        return () => build(table)
      },
    }
    return new Proxy({}, handler)
  }
  return {
    from: vi.fn((table: string) => build(table)),
    rpc: vi.fn().mockResolvedValue({ data: 999, error: null }),
    filters,
  }
}

function makeRequest(): Request {
  return new Request(
    `http://localhost/api/v1/companies/${COMPANY_ID}/journal-entries/${ENTRY_ID}/commit?dry_run=true`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Content-Type': 'application/json',
        'Idempotency-Key': `idem${Math.floor(Math.random() * 1e6)}-1010-4abc-8def-1234567890ab`,
      },
    },
  )
}

const routeParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: ENTRY_ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['bookkeeping:write'],
    mode: 'live',
    unattendedCommitLimit: null,
  })
})

describe('journal-entries.commit: dry run', () => {
  it('projects last_number + 1 without calling next_voucher_number', async () => {
    const supabase = makeSupabase({ last_number: 142 })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(makeRequest(), routeParams)
    const body = (await res.json()) as { data: { dry_run: boolean; preview: Record<string, unknown> } }

    expect(res.status).toBe(200)
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      voucher_series: 'B',
      voucher_number_assigned_on_commit: 143,
    })
    // The point: nothing advanced the series.
    expect(supabase.rpc).not.toHaveBeenCalledWith('next_voucher_number', expect.anything())
    // The read is scoped to the draft's own company, period and series.
    expect(supabase.filters).toEqual(
      expect.arrayContaining([
        ['voucher_sequences', 'company_id', COMPANY_ID],
        ['voucher_sequences', 'fiscal_period_id', 'fp-1'],
        ['voucher_sequences', 'voucher_series', 'B'],
      ]),
    )
  })

  it('projects 1 for a series with no voucher_sequences row yet', async () => {
    const supabase = makeSupabase(null)
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(makeRequest(), routeParams)
    const body = (await res.json()) as { data: { dry_run: boolean; preview: Record<string, unknown> } }

    expect(res.status).toBe(200)
    expect(body.data.preview.voucher_number_assigned_on_commit).toBe(1)
    expect(supabase.rpc).not.toHaveBeenCalledWith('next_voucher_number', expect.anything())
  })
})
