import { describe, it, expect, vi, beforeEach } from 'vitest'
import { findUnlinkedOpeningBalance } from '../unlinked'

// Table-keyed FIFO results; every filter the lookup applies is recorded.
type MockResult = { data?: unknown; error?: unknown }
let mockResults: Record<string, MockResult[]>
let filters: Array<[table: string, column: string, value: unknown]>

function makeClient() {
  const from = vi.fn((table: string) => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'in', 'order', 'range']) b[m] = vi.fn(() => b)
    b.eq = vi.fn((column: string, value: unknown) => {
      filters.push([table, column, value])
      return b
    })
    b.then = (resolve: (v: unknown) => void) => resolve(mockResults[table]?.shift() ?? { data: [], error: null })
    return b
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from } as any
}

const line = (entryId: string, id: string, account: string, debit: number, credit: number) => ({
  id,
  journal_entry_id: entryId,
  account_number: account,
  debit_amount: debit,
  credit_amount: credit,
  dimensions: null,
})

beforeEach(() => {
  mockResults = {}
  filters = []
})

describe('findUnlinkedOpeningBalance', () => {
  it('finds the posted IB verifikat dated on the first day of the year', async () => {
    mockResults = {
      journal_entries: [{ data: [{ id: 'ib-1' }], error: null }],
      journal_entry_lines: [
        { data: [line('ib-1', 'l1', '1930', 400, 0), line('ib-1', 'l2', '2081', 0, 400)], error: null },
      ],
    }

    const found = await findUnlinkedOpeningBalance(makeClient(), 'company-1', '2026-05-01')

    expect(found?.entryId).toBe('ib-1')
    expect(found?.lines.map((l) => l.account_number)).toEqual(['1930', '2081'])
    expect(filters).toEqual([
      ['journal_entries', 'company_id', 'company-1'],
      ['journal_entries', 'source_type', 'opening_balance'],
      ['journal_entries', 'status', 'posted'],
      ['journal_entries', 'entry_date', '2026-05-01'],
    ])
  })

  it('is null, and reads no lines, when the year has no such verifikat', async () => {
    const supabase = makeClient()

    expect(await findUnlinkedOpeningBalance(supabase, 'company-1', '2026-05-01')).toBeNull()
    expect(supabase.from.mock.calls.map((c: unknown[]) => c[0])).toEqual(['journal_entries'])
  })

  it('is null with more than one: which is the IB is not for a report to guess', async () => {
    mockResults = {
      journal_entries: [{ data: [{ id: 'ib-1' }, { id: 'ib-2' }], error: null }],
      journal_entry_lines: [
        { data: [line('ib-1', 'l1', '1930', 400, 0), line('ib-2', 'l2', '1940', 100, 0)], error: null },
      ],
    }

    expect(await findUnlinkedOpeningBalance(makeClient(), 'company-1', '2026-05-01')).toBeNull()
  })

  it('is null when the verifikat carries a result line, which must stay in the period', async () => {
    mockResults = {
      journal_entries: [{ data: [{ id: 'ib-1' }], error: null }],
      journal_entry_lines: [
        { data: [line('ib-1', 'l1', '1930', 0, 50), line('ib-1', 'l2', '6570', 50, 0)], error: null },
      ],
    }

    expect(await findUnlinkedOpeningBalance(makeClient(), 'company-1', '2026-05-01')).toBeNull()
  })
})
