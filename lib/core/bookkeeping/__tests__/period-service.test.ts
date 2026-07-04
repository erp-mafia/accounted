import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeFiscalPeriod } from '@/tests/helpers'

// ============================================================
// Mock: separate client (no .then) from query builder (thenable)
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown; count?: number | null }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'delete', 'lte', 'gte', 'in', 'not', 'or', 'order', 'limit', 'is']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.maybeSingle = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  // Thenable for chains awaited without .single()
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  // Client has NO .then: won't be consumed by `await createClient()`
  return {
    from: vi.fn().mockImplementation(() => makeBuilder()),
    rpc: vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null }),
  }
}

import { lockPeriod, unlockPeriod, closePeriod, createNextPeriod, findNextPeriod } from '../period-service'

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  resultIdx = 0
  results = []
})

describe('lockPeriod', () => {
  it('sets locked_at and emits period.locked', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', locked_at: null, is_closed: false })
    const lockedPeriod = { ...period, locked_at: '2024-12-31T23:59:59Z' }

    results = [
      { data: period, error: null },              // fetch
      { count: 0, data: null, error: null },       // uncategorized tx count check
      { data: lockedPeriod, error: null },         // update
    ]

    const handler = vi.fn()
    eventBus.on('period.locked', handler)

    const supabase = makeClient()
    const result = await lockPeriod(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(result.locked_at).toBeTruthy()
    expect(handler).toHaveBeenCalledOnce()
  })

  it('rejects already-locked period', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      locked_at: '2024-06-01T00:00:00Z',
      is_closed: false,
    })

    results = [{ data: period, error: null }]

    const supabase = makeClient()
    await expect(lockPeriod(supabase as never, 'company-1', 'user-1', 'fp-1')).rejects.toThrow('already locked')
  })
})

describe('closePeriod', () => {
  it('requires period is locked and has closing_entry_id', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      locked_at: '2024-12-31T23:59:59Z',
      is_closed: false,
      closing_entry_id: 'ce-1',
    })
    const closedPeriod = { ...period, is_closed: true, closed_at: '2024-12-31T23:59:59Z' }

    results = [
      { data: period, error: null },
      { data: closedPeriod, error: null },
    ]

    const supabase = makeClient()
    const result = await closePeriod(supabase as never, 'company-1', 'user-1', 'fp-1')
    expect(result.is_closed).toBe(true)
  })

  it('rejects if not locked', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      locked_at: null,
      is_closed: false,
      closing_entry_id: 'ce-1',
    })

    results = [{ data: period, error: null }]

    const supabase = makeClient()
    await expect(closePeriod(supabase as never, 'company-1', 'user-1', 'fp-1')).rejects.toThrow('must be locked')
  })

  it('rejects if no closing_entry_id', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      locked_at: '2024-12-31T23:59:59Z',
      is_closed: false,
      closing_entry_id: null,
    })

    results = [{ data: period, error: null }]

    const supabase = makeClient()
    await expect(closePeriod(supabase as never, 'company-1', 'user-1', 'fp-1')).rejects.toThrow(
      'Year-end closing must be executed'
    )
  })
})

describe('unlockPeriod', () => {
  it('clears locked_at and emits period.unlocked', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      locked_at: '2024-12-31T23:59:59Z',
      is_closed: false,
    })
    const unlocked = { ...period, locked_at: null }

    results = [
      { data: period, error: null },
      { data: unlocked, error: null },
      { data: null, error: null }, // audit_log insert
    ]

    const handler = vi.fn()
    eventBus.on('period.unlocked', handler)

    const supabase = makeClient()
    const result = await unlockPeriod(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(result.locked_at).toBeNull()
    expect(handler).toHaveBeenCalledOnce()
  })

  it('rejects period that is not locked', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', locked_at: null, is_closed: false })

    results = [{ data: period, error: null }]

    const supabase = makeClient()
    await expect(unlockPeriod(supabase as never, 'company-1', 'user-1', 'fp-1')).rejects.toThrow('not locked')
  })

  it('rejects closed period', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      locked_at: '2024-12-31T23:59:59Z',
      is_closed: true,
    })

    results = [{ data: period, error: null }]

    const supabase = makeClient()
    await expect(unlockPeriod(supabase as never, 'company-1', 'user-1', 'fp-1')).rejects.toThrow(
      'Cannot unlock a closed period'
    )
  })
})

describe('createNextPeriod', () => {
  it('calculates correct dates for standard (Jan-Dec) fiscal year', async () => {
    const current = makeFiscalPeriod({
      id: 'fp-2024',
      period_start: '2024-01-01',
      period_end: '2024-12-31',
    })

    const nextPeriod = makeFiscalPeriod({
      id: 'fp-2025',
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      previous_period_id: 'fp-2024',
    })

    results = [
      { data: current, error: null },      // fetch current
      { data: null, error: null },          // check if next exists (maybeSingle)
      { data: nextPeriod, error: null },    // insert
    ]

    const supabase = makeClient()
    const result = await createNextPeriod(supabase as never, 'company-1', 'user-1', 'fp-2024')
    expect(result.period_start).toBe('2025-01-01')
    expect(result.period_end).toBe('2025-12-31')
    expect(result.previous_period_id).toBe('fp-2024')
  })

  it('calculates correct dates for broken (Jul-Jun) fiscal year', async () => {
    const current = makeFiscalPeriod({
      id: 'fp-2024',
      period_start: '2023-07-01',
      period_end: '2024-06-30',
    })

    const nextPeriod = makeFiscalPeriod({
      id: 'fp-2025',
      name: 'FY 2024/2025',
      period_start: '2024-07-01',
      period_end: '2025-06-30',
      previous_period_id: 'fp-2024',
    })

    results = [
      { data: current, error: null },
      { data: null, error: null },
      { data: nextPeriod, error: null },
    ]

    const supabase = makeClient()
    const result = await createNextPeriod(supabase as never, 'company-1', 'user-1', 'fp-2024')
    expect(result.period_start).toBe('2024-07-01')
    expect(result.period_end).toBe('2025-06-30')
  })
})

describe('findNextPeriod', () => {
  it('returns the period chained via previous_period_id', async () => {
    const current = makeFiscalPeriod({
      id: 'fp-2024',
      period_start: '2024-01-01',
      period_end: '2024-12-31',
    })
    const next = makeFiscalPeriod({
      id: 'fp-2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      previous_period_id: 'fp-2024',
    })

    results = [
      { data: current, error: null }, // fetch current
      { data: next, error: null },    // chained lookup (.maybeSingle)
    ]

    const supabase = makeClient()
    const result = await findNextPeriod(supabase as never, 'company-1', 'fp-2024')
    expect(result?.id).toBe('fp-2025')
  })

  it('falls back to period_start lookup when chain is missing', async () => {
    const current = makeFiscalPeriod({
      id: 'fp-2024',
      period_start: '2024-01-01',
      period_end: '2024-12-31',
    })
    const next = makeFiscalPeriod({
      id: 'fp-2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      previous_period_id: null,
    })

    results = [
      { data: current, error: null }, // fetch current
      { data: null, error: null },    // chained lookup misses
      { data: next, error: null },    // date lookup hits
    ]

    const supabase = makeClient()
    const result = await findNextPeriod(supabase as never, 'company-1', 'fp-2024')
    expect(result?.id).toBe('fp-2025')
  })

  it('returns null when no next period exists', async () => {
    const current = makeFiscalPeriod({
      id: 'fp-2024',
      period_start: '2024-01-01',
      period_end: '2024-12-31',
    })

    results = [
      { data: current, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ]

    const supabase = makeClient()
    const result = await findNextPeriod(supabase as never, 'company-1', 'fp-2024')
    expect(result).toBeNull()
  })

  it('returns null when current period not found', async () => {
    results = [{ data: null, error: { message: 'not found' } }]

    const supabase = makeClient()
    const result = await findNextPeriod(supabase as never, 'company-1', 'missing')
    expect(result).toBeNull()
  })
})
