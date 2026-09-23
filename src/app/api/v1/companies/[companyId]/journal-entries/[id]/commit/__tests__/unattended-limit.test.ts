/**
 * The approval-authority ceiling on POST /v1/.../journal-entries/:id/commit.
 *
 * This is the REST half of the envelope. The MCP half lives in
 * lib/pending-operations/__tests__/commit-unattended-limit.test.ts. Both must
 * hold, because an API key can reach the ledger through either, and a ceiling
 * enforced on only one of them is not a ceiling.
 *
 * The property under test is not just "it returns 403": it is that the DRAFT
 * SURVIVES. commitEntry must never be called, so the voucher sequence does not
 * advance (BFL 5 kap. 7 §) and a human can commit the same draft from the app.
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
vi.mock('@/lib/bookkeeping/engine', () => ({
  commitEntry: vi.fn().mockResolvedValue({ id: 'entry-1', status: 'posted' }),
  getNextVoucherNumber: vi.fn().mockResolvedValue(143),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { commitEntry } from '@/lib/bookkeeping/engine'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockCommitEntry = commitEntry as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ENTRY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const DRAFT = {
  id: ENTRY_ID,
  status: 'draft',
  fiscal_period_id: 'fp-1',
  voucher_series: 'A',
  entry_date: '2026-08-31',
}

/**
 * Two tables answer here: journal_entries (the pre-flight maybeSingle) and
 * journal_entry_lines (the paginated debit sum). The lines queue returns the
 * rows once and then an empty page, which is what ends fetchAllRows' loop.
 */
function makeSupabase(lineDebits: number[]) {
  const linePages = [
    { data: lineDebits.map((debit_amount, i) => ({ id: `line-${i}`, debit_amount })), error: null },
    { data: [], error: null },
  ]
  const build = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve(linePages.length > 1 ? linePages.shift()! : linePages[0]!)
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          // Three tables answer a single-row read here, and each needs a
          // different answer: company_members proves the key may touch this
          // company (null would be a 404 before the handler ever runs),
          // journal_entries is the draft, and the idempotency store must be
          // null or the request reads as a replay and short-circuits with 409.
          const rows: Record<string, unknown> = {
            company_members: { company_id: COMPANY_ID, user_id: 'user-1', role: 'owner' },
            journal_entries: DRAFT,
          }
          return () => Promise.resolve({ data: rows[table] ?? null, error: null })
        }
        return () => build(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => build(table)) }
}

function makeRequest(dryRun = false): Request {
  return new Request(
    `http://localhost/api/v1/companies/${COMPANY_ID}/journal-entries/${ENTRY_ID}/commit${dryRun ? '?dry_run=true' : ''}`,
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

function auth(unattendedCommitLimit: number | null) {
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['bookkeeping:write'],
    mode: 'live',
    unattendedCommitLimit,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCommitEntry.mockResolvedValue({ id: ENTRY_ID, status: 'posted' })
})

describe('journal-entries.commit: unattended commit limit', () => {
  it('refuses a 50 000 kr draft on a key capped at 10 000, without committing it', async () => {
    auth(10000)
    mockServiceClient.mockReturnValue(makeSupabase([30000, 20000]))

    const res = await POST(makeRequest(), routeParams)
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } }

    expect(res.status).toBe(403)
    expect(body.error.code).toBe('UNATTENDED_COMMIT_LIMIT_EXCEEDED')
    expect(body.error.details).toMatchObject({ attempted: 50000, limit: 10000 })
    // The whole point: the draft is untouched and the sequence never moved.
    expect(mockCommitEntry).not.toHaveBeenCalled()
  })

  it('refuses the dry run too, rather than promising a voucher number it cannot deliver', async () => {
    auth(10000)
    mockServiceClient.mockReturnValue(makeSupabase([50000]))

    const res = await POST(makeRequest(true), routeParams)
    expect(res.status).toBe(403)
  })

  it('commits when the total is at or under the ceiling', async () => {
    auth(10000)
    mockServiceClient.mockReturnValue(makeSupabase([7500, 2500]))

    const res = await POST(makeRequest(), routeParams)
    expect(res.status).toBe(200)
    expect(mockCommitEntry).toHaveBeenCalled()
  })

  it('commits any amount when the key has no ceiling', async () => {
    auth(null)
    mockServiceClient.mockReturnValue(makeSupabase([9_000_000]))

    const res = await POST(makeRequest(), routeParams)
    expect(res.status).toBe(200)
    expect(mockCommitEntry).toHaveBeenCalled()
  })

  it('does not even read the lines when there is no ceiling', async () => {
    auth(null)
    const supabase = makeSupabase([1])
    mockServiceClient.mockReturnValue(supabase)

    await POST(makeRequest(), routeParams)
    const tables = supabase.from.mock.calls.map((c) => c[0])
    expect(tables).not.toContain('journal_entry_lines')
  })
})
