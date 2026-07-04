import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  findMissingActiveAccounts,
  findUnresolvableAccounts,
} from '../account-validation'

// Sequential thenable builder: each awaited query pops the next result.
let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  return { from: vi.fn().mockImplementation(() => makeBuilder()) }
}

beforeEach(() => {
  resultIdx = 0
  results = []
})

describe('findMissingActiveAccounts', () => {
  it('returns accounts not present-and-active, first-seen order, deduped', async () => {
    results = [{ data: [{ account_number: '1930' }], error: null }]
    const missing = await findMissingActiveAccounts(makeClient() as never, 'co-1', [
      '5410',
      '1930',
      '5410',
      '3740',
    ])
    expect(missing).toEqual(['5410', '3740'])
  })

  it('returns empty for empty input without querying', async () => {
    const supabase = makeClient()
    const missing = await findMissingActiveAccounts(supabase as never, 'co-1', [])
    expect(missing).toEqual([])
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('findUnresolvableAccounts', () => {
  it('lets a standard BAS account that is merely absent pass (engine seeds it)', async () => {
    results = [
      // active-accounts read: only 1930 active, 3740 missing
      { data: [{ account_number: '1930' }], error: null },
      // existence read for BAS-seedable: no row at all → engine will seed
      { data: [], error: null },
    ]
    const unresolvable = await findUnresolvableAccounts(makeClient() as never, 'co-1', [
      '1930',
      '3740',
    ])
    expect(unresolvable).toEqual([])
  })

  it('blocks a BAS account that exists but is deactivated (backfill never resurrects)', async () => {
    results = [
      { data: [{ account_number: '1930' }], error: null },
      // 3740 has a row (it surfaced as missing-active, so it must be inactive)
      { data: [{ account_number: '3740' }], error: null },
    ]
    const unresolvable = await findUnresolvableAccounts(makeClient() as never, 'co-1', [
      '1930',
      '3740',
    ])
    expect(unresolvable).toEqual(['3740'])
  })

  it('blocks numbers with no BAS reference without an extra existence read', async () => {
    results = [
      // only the active-accounts read: '9999' has no BAS reference
      { data: [], error: null },
    ]
    const supabase = makeClient()
    const unresolvable = await findUnresolvableAccounts(supabase as never, 'co-1', ['9999'])
    expect(unresolvable).toEqual(['9999'])
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('returns empty when everything is already active', async () => {
    results = [{ data: [{ account_number: '1930' }, { account_number: '5410' }], error: null }]
    const unresolvable = await findUnresolvableAccounts(makeClient() as never, 'co-1', [
      '1930',
      '5410',
    ])
    expect(unresolvable).toEqual([])
  })
})
