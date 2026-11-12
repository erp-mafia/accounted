import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { createServiceClient } from '@/lib/supabase/server'
import { shouldShowOtherAccountHint } from '../other-account-hint'
import type { SupabaseClient } from '@supabase/supabase-js'

const mockCreateServiceClient = vi.mocked(createServiceClient)

interface QueryResult {
  data?: unknown
  error?: unknown
}

/**
 * Chainable query mock keyed by table name: every method returns the chain and
 * records its arguments, and awaiting it resolves with the configured
 * { data, error } for that table. A table may be given an ARRAY of results,
 * consumed one per from() call with the last one repeating, so the chunked
 * existence probe can be answered chunk by chunk.
 */
function buildClient(resultsByTable: Record<string, QueryResult | QueryResult[]>) {
  const queues = new Map<string, QueryResult[]>(
    Object.entries(resultsByTable).map(([table, value]) => [
      table,
      Array.isArray(value) ? [...value] : [value],
    ]),
  )
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []

  return {
    calls,
    from: vi.fn((table: string) => {
      const queue = queues.get(table) ?? []
      const configured = (queue.length > 1 ? queue.shift() : queue[0]) ?? {}
      const result = { data: configured.data ?? null, error: configured.error ?? null }
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'is', 'limit', 'order', 'range']) {
        chain[m] = (...args: unknown[]) => {
          calls.push({ table, method: m, args })
          return chain
        }
      }
      ;(chain as { then?: unknown }).then = (resolve: (v: unknown) => void) => resolve(result)
      return chain
    }),
  }
}

/** The company filters the journal_entries existence probes were issued with. */
function probeFilters(client: ReturnType<typeof buildClient>) {
  return client.calls.filter((c) => c.table === 'journal_entries' && c.method === 'in')
}

const USER = 'user-1'
const OWN_COMPANY = { id: 'own-co', org_number: '5560125790' }

/** A company_members row of the caller as the session client returns it: the company embedded. */
function membership(company: { id: string; org_number: string | null }, archivedAt: string | null = null) {
  return { company_id: company.id, companies: { ...company, archived_at: archivedAt } }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateServiceClient.mockReturnValue(
    buildClient({ companies: { data: [] }, journal_entries: { data: [] } }) as never,
  )
})

describe('shouldShowOtherAccountHint', () => {
  it('is false when the account has journal entries (common case, no probe)', async () => {
    const supabase = buildClient({
      company_members: { data: [membership(OWN_COMPANY)] },
      journal_entries: { data: [{ id: 'je1' }] },
    })
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient, USER)).resolves.toBe(false)
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('scopes the own-account probe to the caller\'s companies', async () => {
    // Without company_id the probe falls back on the RLS qual, which under the
    // authenticated role turns into a sequential scan of journal_entries on
    // the blocking Hem render.
    const supabase = buildClient({
      company_members: { data: [membership(OWN_COMPANY)] },
      journal_entries: { data: [{ id: 'je1' }] },
    })

    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient, USER)).resolves.toBe(false)
    expect(probeFilters(supabase).map((c) => c.args)).toEqual([['company_id', ['own-co']]])
  })

  it('chunks the probe and stops at the first company with entries', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      id: `co-${i}`,
      org_number: '5560125790',
    }))
    const supabase = buildClient({
      company_members: { data: many.map((c) => membership(c)) },
      // First chunk finds nothing, second one does: the third must never run.
      journal_entries: [{ data: [] }, { data: [{ id: 'je1' }] }, { data: [] }],
    })

    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient, USER)).resolves.toBe(false)
    const chunks = probeFilters(supabase).map((c) => (c.args[1] as string[]).length)
    expect(chunks).toEqual([100, 100])
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('is true when the account is empty and a same-orgnr company elsewhere has entries', async () => {
    const supabase = buildClient({
      company_members: { data: [membership(OWN_COMPANY)] },
      journal_entries: { data: [] },
    })
    mockCreateServiceClient.mockReturnValue(
      buildClient({
        companies: { data: [{ id: 'own-co' }, { id: 'other-co' }] },
        journal_entries: { data: [{ id: 'je-other' }] },
      }) as never,
    )
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient, USER)).resolves.toBe(true)
  })

  it('is false when the same-orgnr company elsewhere is also empty', async () => {
    const supabase = buildClient({
      company_members: { data: [membership(OWN_COMPANY)] },
      journal_entries: { data: [] },
    })
    mockCreateServiceClient.mockReturnValue(
      buildClient({
        companies: { data: [{ id: 'own-co' }, { id: 'other-co' }] },
        journal_entries: { data: [] },
      }) as never,
    )
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient, USER)).resolves.toBe(false)
  })

  it('is false when no other account shares the org number', async () => {
    const supabase = buildClient({
      company_members: { data: [membership(OWN_COMPANY)] },
      journal_entries: { data: [] },
    })
    mockCreateServiceClient.mockReturnValue(
      buildClient({
        companies: { data: [{ id: 'own-co' }] },
        journal_entries: { data: [{ id: 'je-other' }] },
      }) as never,
    )
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient, USER)).resolves.toBe(false)
  })

  it('is false when the user has no companies', async () => {
    const supabase = buildClient({ company_members: { data: [] }, journal_entries: { data: [] } })
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient, USER)).resolves.toBe(false)
  })

  it('is false when own companies have no org number', async () => {
    const supabase = buildClient({
      company_members: { data: [membership({ id: 'own-co', org_number: null })] },
      journal_entries: { data: [] },
    })
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient, USER)).resolves.toBe(false)
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it("reads the caller's companies through their memberships, never companies by RLS alone", async () => {
    // A bare select on companies leaves the scoping to RLS, which Postgres
    // applies as a filter on a scan of every active company (prod 2026-11-12:
    // 3 194 rows walked for 24, on each Hem render).
    const supabase = buildClient({
      company_members: { data: [membership(OWN_COMPANY)] },
      journal_entries: { data: [{ id: 'je1' }] },
    })
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient, USER)).resolves.toBe(false)
    expect(supabase.calls.filter((c) => c.table === 'company_members' && c.method === 'eq').map((c) => c.args)).toEqual([['user_id', USER]])
    expect(supabase.calls.some((c) => c.table === 'companies')).toBe(false)
  })

  it('leaves out an archived company and one the caller cannot read', async () => {
    const supabase = buildClient({
      company_members: {
        data: [
          membership({ id: 'archived-co', org_number: '5560125790' }, '2026-01-01T00:00:00Z'),
          { company_id: 'hidden-co', companies: null },
          membership(OWN_COMPANY),
        ],
      },
      journal_entries: { data: [{ id: 'je1' }] },
    })
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient, USER)).resolves.toBe(false)
    expect(probeFilters(supabase).map((c) => c.args)).toEqual([['company_id', ['own-co']]])
  })

  it('fails soft to false on query errors', async () => {
    const supabase = buildClient({
      company_members: { error: { message: 'boom' } },
      journal_entries: { data: [] },
    })
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient, USER)).resolves.toBe(false)
  })

  it('fails soft to false when the service client throws', async () => {
    const supabase = buildClient({
      company_members: { data: [membership(OWN_COMPANY)] },
      journal_entries: { data: [] },
    })
    mockCreateServiceClient.mockImplementation(() => {
      throw new Error('no service key')
    })
    await expect(shouldShowOtherAccountHint(supabase as unknown as SupabaseClient, USER)).resolves.toBe(false)
  })
})
