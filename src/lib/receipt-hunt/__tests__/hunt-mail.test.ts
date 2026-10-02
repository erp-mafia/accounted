/**
 * The mailbox leg's accounting of its own work: how many purchases it could
 * search at all, and how many it did. The press reports the difference as
 * what is left, so a salary or tax run, which the search never looks for,
 * must not be in either number.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSearch } = vi.hoisted(() => ({ mockSearch: vi.fn() }))
vi.mock('@/lib/mail-search/service', () => ({
  getMailSearchService: () => ({
    isConfigured: () => true,
    search: (...args: unknown[]) => mockSearch(...args),
    fetchAttachment: vi.fn(),
    searchFailureCount: () => 0,
    releaseCache: vi.fn(),
  }),
}))
vi.mock('../mail-intelligence', () => ({ extractMailDocuments: vi.fn(async () => []) }))

import { huntCompany } from '../hunt'

type Row = Record<string, unknown>

/** Every builder returns the chain; awaiting it yields the table's rows. */
function mockSupabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let from = 0
      let to = Number.MAX_SAFE_INTEGER
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'not', 'in', 'lte', 'gte', 'order', 'limit']) chain[m] = vi.fn(() => chain)
      chain.range = vi.fn((f: number, t: number) => {
        from = f
        to = t
        return chain
      })
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: (tables[table] ?? []).slice(from, to + 1), error: null }).then(resolve)
      return chain
    },
  } as never
}

function purchase(id: string, description: string, amount: number) {
  return {
    id,
    company_id: 'co-1',
    date: '2026-05-02',
    description,
    merchant_name: null,
    amount,
    currency: 'SEK',
    amount_sek: amount,
    exchange_rate: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSearch.mockResolvedValue([])
})

describe('huntCompany mail leg: searchable and searched', () => {
  it('leaves salary and tax runs out of what can be searched, and searches the largest first', async () => {
    const supabase = mockSupabase({
      transactions: [
        purchase('salary', 'LÖN SEPTEMBER', -45000),
        purchase('tax', 'Skatteverket 16556', -30000),
        purchase('big', 'CLAS OHLSON', -2400),
        purchase('mid', 'CIRCLE K 421', -900),
        purchase('small', 'SPOTIFY', -129),
      ],
      company_members: [{ user_id: 'user-1', role: 'owner' }],
    })

    const result = await huntCompany(supabase, 'co-1', 'run-1', { searchMail: true, mailSearchLimit: 2 })

    expect(result.candidates).toBe(5)
    expect(result.mail).toMatchObject({ searchable: 3, searched: 2 })
    // The two largest searchable purchases, never the salary or the tax run.
    const amounts = mockSearch.mock.calls.map(([, query]) => (query as { amount: number }).amount)
    expect(amounts).toEqual([2400, 900])
  })

  it('reports nothing searchable when every purchase is a salary or tax run', async () => {
    const supabase = mockSupabase({
      transactions: [purchase('salary', 'LÖN SEPTEMBER', -45000)],
      company_members: [{ user_id: 'user-1', role: 'owner' }],
    })

    const result = await huntCompany(supabase, 'co-1', 'run-1', { searchMail: true })

    expect(result.mail).toMatchObject({ searchable: 0, searched: 0 })
    expect(mockSearch).not.toHaveBeenCalled()
  })
})
