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
  for (const m of ['select', 'eq', 'insert', 'update', 'delete', 'lte', 'gte', 'in', 'not', 'or', 'order', 'limit', 'is', 'range']) {
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

import {
  lockPeriod,
  unlockPeriod,
  closePeriod,
  markPeriodClosedExternally,
  reopenExternallyClosedPeriod,
  createNextPeriod,
  findNextPeriod,
  resolvePeriodStatusForDate,
} from '../period-service'
import { getStructuredError } from '@/lib/errors/get-structured-error'

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
      { count: 0, data: null, error: null },       // guard leg 1: untriaged count
      { data: [], error: null },                   // guard leg 2: business-unbooked candidates
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

// ============================================================
// lockPeriod: unbooked-transaction guard
//
// These use a filter-aware client that records the filters the guard
// actually applies and evaluates them against in-memory tables, so the
// assertions turn on which rows the predicate matches rather than on a
// canned count handed back by the mock. Both anchoring locations that
// keep journal_entry_id NULL (transaction_voucher_links, the two payment
// tables) are modelled, because the guard must not block on those.
// ============================================================

type Row = Record<string, unknown>

interface FilterSpec {
  col: string
  op: 'eq' | 'is' | 'gte' | 'lte' | 'in'
  val: unknown
}

/** The dead predicate this guard used to run, kept as a regression fixture. */
const OLD_DEAD_GUARD: FilterSpec[] = [
  { col: 'journal_entry_id', op: 'is', val: null },
  { col: 'is_business', op: 'eq', val: true },
]

function matchesAll(row: Row, specs: FilterSpec[]): boolean {
  return specs.every((s) => {
    const v = row[s.col]
    if (s.op === 'gte') return String(v) >= String(s.val)
    if (s.op === 'lte') return String(v) <= String(s.val)
    if (s.op === 'in') return Array.isArray(s.val) && s.val.includes(v)
    return v === s.val
  })
}

const GUARD_TABLES = [
  'transactions',
  'transaction_voucher_links',
  'invoice_payments',
  'supplier_invoice_payments',
] as const

interface GuardStore {
  transactions?: Row[]
  transaction_voucher_links?: Row[]
  invoice_payments?: Row[]
  supplier_invoice_payments?: Row[]
  /** Table name -> PostgREST error message to return instead of rows. */
  failOn?: Partial<Record<(typeof GUARD_TABLES)[number], string>>
}

/**
 * Client whose guard-table reads are predicate-evaluated against `store`.
 * `fiscal_periods` still comes from the sequential `results` queue.
 *
 * `.range(from, to)` slices the matched rows exactly like PostgREST pages
 * them, so a fetchAllRows caller is actually exercised page by page; a query
 * that never calls `.range()` gets everything back at once (the old
 * cap-oblivious behaviour a real PostgREST would truncate at 1000 rows).
 */
function makeGuardClient(store: GuardStore) {
  const queries: Array<{
    table: string
    specs: FilterSpec[]
    orderedBy: string | null
    range: { from: number; to: number } | null
  }> = []

  function guardBuilder(table: (typeof GUARD_TABLES)[number]) {
    const specs: FilterSpec[] = []
    const record: (typeof queries)[number] = { table, specs, orderedBy: null, range: null }
    queries.push(record)
    let head = false
    const b: Record<string, unknown> = {}
    b.select = vi.fn((_cols?: string, opts?: { head?: boolean }) => {
      head = opts?.head === true
      return b
    })
    for (const op of ['eq', 'is', 'gte', 'lte', 'in'] as const) {
      b[op] = vi.fn((col: string, val: unknown) => {
        specs.push({ col, op, val })
        return b
      })
    }
    b.order = vi.fn((col: string) => {
      record.orderedBy = col
      return b
    })
    b.range = vi.fn((from: number, to: number) => {
      record.range = { from, to }
      return b
    })
    b.then = (resolve: (v: unknown) => void) => {
      const failure = store.failOn?.[table]
      if (failure) return resolve({ data: null, count: null, error: { message: failure } })
      let matched = (store[table] ?? []).filter((r) => matchesAll(r, specs))
      if (record.orderedBy) {
        const col = record.orderedBy
        matched = [...matched].sort((a, c) => String(a[col]).localeCompare(String(c[col])))
      }
      if (record.range) {
        matched = matched.slice(record.range.from, record.range.to + 1)
      }
      return resolve(
        head
          ? { count: matched.length, data: null, error: null }
          : { data: matched, count: null, error: null },
      )
    }
    return b
  }

  const client = {
    from: vi.fn((table: string) =>
      (GUARD_TABLES as readonly string[]).includes(table)
        ? guardBuilder(table as (typeof GUARD_TABLES)[number])
        : makeBuilder(),
    ),
    rpc: vi.fn(),
  }
  return { client, queries }
}

function openPeriod() {
  return makeFiscalPeriod({
    id: 'fp-1',
    locked_at: null,
    is_closed: false,
    period_start: '2026-01-01',
    period_end: '2026-12-31',
  })
}

function tx(overrides: Row): Row {
  return {
    company_id: 'company-1',
    date: '2026-03-15',
    is_business: null,
    is_ignored: false,
    journal_entry_id: null,
    ...overrides,
  }
}

/** Queue for a lock that is expected to succeed: fetch, then update. */
function expectLockToSucceed(period: object) {
  results = [
    { data: period, error: null },
    { data: { ...period, locked_at: '2026-12-31T23:59:59Z' }, error: null },
  ]
}

describe('lockPeriod: unbooked transaction guard', () => {
  it('refuses to lock a period that still holds untriaged bank transactions', async () => {
    results = [{ data: openPeriod(), error: null }]

    // Not yet triaged: is_business IS NULL, not ignored.
    const { client } = makeGuardClient({
      transactions: [
        tx({ id: 't1' }),
        tx({ id: 't2', date: '2026-07-01' }),
        tx({ id: 't3', date: '2026-11-30' }),
      ],
    })

    await expect(lockPeriod(client as never, 'company-1', 'user-1', 'fp-1')).rejects.toThrow(
      /3 banktransaktion\(er\)[\s\S]*3 ej hanterade/,
    )
  })

  it('refuses to lock when a transaction is triaged as a business event but has no verifikat', async () => {
    // The stronger BFL 5 kap 2 § case: the user has already confirmed this is
    // the company's affärshändelse, and a lock would strand it.
    results = [{ data: openPeriod(), error: null }]

    const { client } = makeGuardClient({
      transactions: [
        tx({ id: 'b1', is_business: true, journal_entry_id: null }),
        tx({ id: 'b2', is_business: true, journal_entry_id: null, date: '2026-09-09' }),
      ],
    })

    await expect(lockPeriod(client as never, 'company-1', 'user-1', 'fp-1')).rejects.toThrow(
      /2 banktransaktion\(er\)[\s\S]*2 markerade som affärshändelse men utan verifikat/,
    )
  })

  it('breaks the count down per reason when both kinds are present', async () => {
    results = [{ data: openPeriod(), error: null }]

    const { client } = makeGuardClient({
      transactions: [
        tx({ id: 'u1' }),
        tx({ id: 'u2' }),
        tx({ id: 'b1', is_business: true, journal_entry_id: null }),
      ],
    })

    let thrown: Error | undefined
    try {
      await lockPeriod(client as never, 'company-1', 'user-1', 'fp-1')
    } catch (e) {
      thrown = e as Error
    }
    const message = thrown?.message ?? ''
    expect(message).toContain('3 banktransaktion(er)')
    expect(message).toContain('2 ej hanterade')
    expect(message).toContain('1 markerade som affärshändelse men utan verifikat')
  })

  it('ignores untriaged transactions dated outside the period', async () => {
    expectLockToSucceed(openPeriod())

    const { client } = makeGuardClient({
      transactions: [
        tx({ id: 'before', date: '2025-12-31' }),
        tx({ id: 'after', date: '2027-01-01' }),
        tx({ id: 'biz-before', date: '2025-06-01', is_business: true }),
      ],
    })

    const result = await lockPeriod(client as never, 'company-1', 'user-1', 'fp-1')
    expect(result.locked_at).toBeTruthy()
  })

  it('locks a period whose transactions are all explicitly marked private', async () => {
    expectLockToSucceed(openPeriod())

    // is_business = false is privat uttag: triaged and deliberately excluded.
    // Neither leg of the guard may count it, with or without a journal entry.
    const { client } = makeGuardClient({
      transactions: [
        tx({ id: 'p1', is_business: false, journal_entry_id: 'je-1' }),
        tx({ id: 'p2', is_business: false, journal_entry_id: null }),
      ],
    })

    const result = await lockPeriod(client as never, 'company-1', 'user-1', 'fp-1')
    expect(result.locked_at).toBeTruthy()
  })

  it('locks a clean period: booked, private and ignored rows do not block', async () => {
    expectLockToSucceed(openPeriod())

    const { client } = makeGuardClient({
      transactions: [
        // Booked the 1:1 way.
        tx({ id: 'b1', is_business: true, journal_entry_id: 'je-1' }),
        // Bulk-booked: anchored via transaction_voucher_links, journal_entry_id
        // stays NULL (lib/transactions/is-booked.ts).
        tx({ id: 'b2', is_business: true, journal_entry_id: null }),
        // Multi-allocated across customer invoices.
        tx({ id: 'b3', is_business: true, journal_entry_id: null }),
        // Multi-allocated across supplier invoices.
        tx({ id: 'b4', is_business: true, journal_entry_id: null }),
        // Triaged as private.
        tx({ id: 'p1', is_business: false, journal_entry_id: 'je-2' }),
        // Explicitly suppressed: "never going to book it".
        tx({ id: 'i1', is_business: null, is_ignored: true }),
      ],
      transaction_voucher_links: [{ transaction_id: 'b2' }],
      invoice_payments: [{ transaction_id: 'b3' }],
      supplier_invoice_payments: [{ transaction_id: 'b4' }],
    })

    const result = await lockPeriod(client as never, 'company-1', 'user-1', 'fp-1')
    expect(result.locked_at).toBeTruthy()
  })

  it('paginates the business-unbooked candidate fetch past the 1000-row PostgREST page cap', async () => {
    // Bulk-booked transactions keep journal_entry_id NULL, so >1000 candidates
    // is realistic. A bare .select() would silently stop at 1000 rows; the
    // guard must page through all 1500 and refuse with the full count.
    results = [{ data: openPeriod(), error: null }]

    const rows = Array.from({ length: 1500 }, (_, i) =>
      tx({ id: `t${String(i).padStart(4, '0')}`, is_business: true, journal_entry_id: null }),
    )
    const { client, queries } = makeGuardClient({ transactions: rows })

    await expect(lockPeriod(client as never, 'company-1', 'user-1', 'fp-1')).rejects.toThrow(
      /1500 banktransaktion\(er\)[\s\S]*1500 markerade som affärshändelse men utan verifikat/,
    )

    // The candidate fetch (non-head transactions reads) is paginated with a
    // stable unique order, per the fetch-all.ts ordering invariant.
    const candidatePages = queries.filter((q) => q.table === 'transactions' && q.range !== null)
    expect(candidatePages.length).toBeGreaterThanOrEqual(2)
    for (const page of candidatePages) {
      expect(page.orderedBy).toBe('id')
    }
    expect(candidatePages[0].range).toEqual({ from: 0, to: 999 })
    expect(candidatePages[1].range).toEqual({ from: 1000, to: 1999 })
  })

  it('anchored rows beyond the first page still reduce the blocking count', async () => {
    // 1200 candidates, of which the LAST 100 (sorted by id, i.e. entirely on
    // page 2) are bulk-booked via transaction_voucher_links. Without
    // pagination those rows were never fetched, so their anchoring never
    // mattered; with it, 1200 - 100 = 1100 genuinely unbooked rows block.
    results = [{ data: openPeriod(), error: null }]

    const rows = Array.from({ length: 1200 }, (_, i) =>
      tx({ id: `t${String(i).padStart(4, '0')}`, is_business: true, journal_entry_id: null }),
    )
    const anchoredIds = rows.slice(1100).map((r) => r.id as string)
    const { client } = makeGuardClient({
      transactions: rows,
      transaction_voucher_links: anchoredIds.map((id) => ({ transaction_id: id })),
    })

    await expect(lockPeriod(client as never, 'company-1', 'user-1', 'fp-1')).rejects.toThrow(
      /1100 banktransaktion\(er\)[\s\S]*1100 markerade som affärshändelse men utan verifikat/,
    )
  })

  it('regression: the old journal_entry_id IS NULL + is_business = true guard let untriaged rows through', async () => {
    results = [{ data: openPeriod(), error: null }]

    const untriaged = [tx({ id: 't1' }), tx({ id: 't2' }), tx({ id: 't3' })]

    // The old predicate matches none of them: triage is what sets is_business,
    // so "unbooked AND is_business = true" can never describe an untriaged row.
    // With that as the only guard, locking a period holding 40 untriaged
    // transactions succeeded and the trigger then froze them in place.
    expect(untriaged.filter((r) => matchesAll(r, OLD_DEAD_GUARD))).toHaveLength(0)

    // The guard as it stands now does catch them.
    const { client, queries } = makeGuardClient({ transactions: untriaged })
    await expect(lockPeriod(client as never, 'company-1', 'user-1', 'fp-1')).rejects.toThrow(
      /saknar bokföring/,
    )

    // Leg 1 is the canonical worklist predicate, not the old one.
    const legOne = queries.find((q) => q.table === 'transactions')?.specs ?? []
    expect(legOne).toEqual(
      expect.arrayContaining([
        { col: 'is_business', op: 'is', val: null },
        { col: 'is_ignored', op: 'eq', val: false },
      ]),
    )
    expect(legOne).not.toContainEqual({ col: 'journal_entry_id', op: 'is', val: null })
  })

  it('refuses to lock when the untriaged count query errors, rather than waving the lock through', async () => {
    results = [{ data: openPeriod(), error: null }]

    const { client } = makeGuardClient({
      transactions: [],
      failOn: { transactions: 'connection reset' },
    })

    await expect(lockPeriod(client as never, 'company-1', 'user-1', 'fp-1')).rejects.toThrow(
      /Kunde inte kontrollera obokförda banktransaktioner/,
    )
  })

  it('refuses to lock when an anchor lookup errors: a half-run guard is no guard', async () => {
    results = [{ data: openPeriod(), error: null }]

    const { client } = makeGuardClient({
      transactions: [tx({ id: 'b1', is_business: true, journal_entry_id: null })],
      failOn: { transaction_voucher_links: 'statement timeout' },
    })

    await expect(lockPeriod(client as never, 'company-1', 'user-1', 'fp-1')).rejects.toThrow(
      /Kunde inte kontrollera obokförda banktransaktioner/,
    )
  })

  it('the infra failure message is NOT mapped to the unbooked-transactions code', async () => {
    // An unreachable DB must not send an agent off remediating transactions.
    results = [{ data: openPeriod(), error: null }]
    const { client } = makeGuardClient({
      transactions: [],
      failOn: { transactions: 'connection reset' },
    })

    let thrown: Error | undefined
    try {
      await lockPeriod(client as never, 'company-1', 'user-1', 'fp-1')
    } catch (e) {
      thrown = e as Error
    }
    expect(thrown?.message ?? '').not.toContain('saknar bokföring')
    expect(getStructuredError(thrown as Error).code).not.toBe('PERIOD_HAS_UNBOOKED_TRANSACTIONS')
  })

  // Both legs must produce a message the two mappers recognise. The
  // untriaged-only case is the trap: its breakdown clause never says
  // "affärstransaktion", so the inferCode() regex has to be satisfied by the
  // fixed part of the sentence.
  it.each([
    ['untriaged only', [tx({ id: 't1' }), tx({ id: 't2' })]],
    [
      'business-unbooked only',
      [
        tx({ id: 'b1', is_business: true, journal_entry_id: null }),
        tx({ id: 'b2', is_business: true, journal_entry_id: null }),
      ],
    ],
  ])('throws a message both error mappers still recognise (%s)', async (_label, rows) => {
    results = [{ data: openPeriod(), error: null }]

    const { client } = makeGuardClient({ transactions: rows as Row[] })
    let thrown: Error | undefined
    try {
      await lockPeriod(client as never, 'company-1', 'user-1', 'fp-1')
    } catch (e) {
      thrown = e as Error
    }
    expect(thrown).toBeInstanceOf(Error)
    const message = thrown?.message ?? ''

    // Both lock routes: substring match -> PERIOD_HAS_UNBOOKED_TRANSACTIONS (400).
    expect(message).toContain('saknar bokföring')
    // MCP/agent surfaces: inferCode() in lib/errors/get-structured-error.ts.
    expect(getStructuredError(thrown as Error).code).toBe('PERIOD_HAS_UNBOOKED_TRANSACTIONS')
    // Actionable: how many, why, and where to go.
    expect(message).toContain('2 banktransaktion(er)')
    expect(message).toContain('Transaktioner')
  })
})

// ============================================================
// resolvePeriodStatusForDate: the shared lock helper must fail CLOSED.
// A swallowed PostgREST error used to be reported as `open`, which every
// caller reads as "this date is writable".
// ============================================================

describe('resolvePeriodStatusForDate', () => {
  it('reports a verified open period', async () => {
    results = [
      { data: { bookkeeping_locked_through: null }, error: null },
      { data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null },
    ]

    const status = await resolvePeriodStatusForDate(makeClient() as never, 'company-1', '2026-03-01')
    expect(status).toEqual({ period_id: 'fp-1', status: 'open', lock_date: null })
  })

  it('keeps "no covering period" distinguishable: open with a null period_id and no failure flag', async () => {
    results = [
      { data: { bookkeeping_locked_through: null }, error: null },
      { data: null, error: null },
    ]

    const status = await resolvePeriodStatusForDate(makeClient() as never, 'company-1', '2026-03-01')
    expect(status.status).toBe('open')
    expect(status.period_id).toBeNull()
    expect(status.lookup_failed).toBeUndefined()
  })

  it('fails closed when the company_settings lookup errors', async () => {
    results = [{ data: null, error: { message: 'PGRST301 JWT expired' } }]

    const status = await resolvePeriodStatusForDate(makeClient() as never, 'company-1', '2026-03-01')
    expect(status.status).not.toBe('open')
    expect(status).toEqual({
      period_id: null,
      status: 'locked',
      lock_date: null,
      lookup_failed: true,
    })
  })

  it('fails closed when the fiscal_periods lookup errors', async () => {
    results = [
      { data: { bookkeeping_locked_through: null }, error: null },
      // e.g. two overlapping periods cover the date: .maybeSingle() errors.
      { data: null, error: { message: 'JSON object requested, multiple rows returned' } },
    ]

    const status = await resolvePeriodStatusForDate(makeClient() as never, 'company-1', '2026-03-01')
    expect(status.status).not.toBe('open')
    expect(status.lookup_failed).toBe(true)
    expect(status.period_id).toBeNull()
  })

  it('still resolves the company lock date layer without touching the period lookup verdict', async () => {
    results = [
      { data: { bookkeeping_locked_through: '2026-06-30' }, error: null },
      // Refinement lookup fails: verdict is already locked, so this is non-fatal.
      { data: null, error: { message: 'timeout' } },
    ]

    const status = await resolvePeriodStatusForDate(makeClient() as never, 'company-1', '2026-03-01')
    expect(status.status).toBe('locked')
    expect(status.lock_date).toBe('2026-06-30')
    expect(status.lookup_failed).toBeUndefined()
  })

  it('reports closed and locked periods unchanged', async () => {
    results = [
      { data: { bookkeeping_locked_through: null }, error: null },
      { data: { id: 'fp-1', is_closed: true, locked_at: null }, error: null },
    ]
    await expect(
      resolvePeriodStatusForDate(makeClient() as never, 'company-1', '2026-03-01'),
    ).resolves.toEqual({ period_id: 'fp-1', status: 'closed', lock_date: null })

    resultIdx = 0
    results = [
      { data: { bookkeeping_locked_through: null }, error: null },
      { data: { id: 'fp-2', is_closed: false, locked_at: '2026-01-31T00:00:00Z' }, error: null },
    ]
    await expect(
      resolvePeriodStatusForDate(makeClient() as never, 'company-1', '2026-03-01'),
    ).resolves.toEqual({
      period_id: 'fp-2',
      status: 'locked',
      lock_date: '2026-01-31T00:00:00Z',
    })
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

describe('markPeriodClosedExternally', () => {
  it('closes, locks and stamps closed_externally without a closing entry', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      locked_at: null,
      is_closed: false,
      closing_entry_id: null,
      period_end: '2024-12-31',
    })
    const updated = {
      ...period,
      is_closed: true,
      closed_at: '2025-01-15T10:00:00Z',
      closed_externally: true,
      locked_at: '2025-01-15T10:00:00Z',
    }

    results = [
      { data: period, error: null },          // fetch
      { count: 3, data: null, error: null },  // imported-verifikat count (migrated year)
      { count: 0, data: null, error: null },  // guard leg 1: untriaged count
      { data: [], error: null },              // guard leg 2: business-unbooked candidates
      { data: updated, error: null },         // update
      { data: null, error: null },            // audit_log insert
    ]

    const supabase = makeClient()
    const result = await markPeriodClosedExternally(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(result.is_closed).toBe(true)
    expect(result.closed_externally).toBe(true)
    expect(result.locked_at).toBeTruthy()
  })

  it('allows an empty period (year closed elsewhere, never imported)', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', period_end: '2024-12-31' })
    const updated = { ...period, is_closed: true, closed_externally: true }
    results = [
      { data: period, error: null },          // fetch
      { count: 0, data: null, error: null },  // imported-verifikat count
      { count: 0, data: null, error: null },  // total-verifikat count
      { count: 0, data: null, error: null },  // guard leg 1: untriaged count
      { data: [], error: null },              // guard leg 2: business-unbooked candidates
      { data: updated, error: null },         // update
      { data: null, error: null },            // audit_log insert
    ]

    const supabase = makeClient()
    const result = await markPeriodClosedExternally(supabase as never, 'company-1', 'user-1', 'fp-1')
    expect(result.closed_externally).toBe(true)
  })

  it('refuses a period bookkept natively in Accounted (no imported verifikat)', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', period_end: '2024-12-31' })
    results = [
      { data: period, error: null },          // fetch
      { count: 0, data: null, error: null },  // imported-verifikat count
      { count: 7, data: null, error: null },  // total-verifikat count: native entries
    ]

    const supabase = makeClient()
    await expect(
      markPeriodClosedExternally(supabase as never, 'company-1', 'user-1', 'fp-1')
    ).rejects.toThrow('vanliga årsbokslutet')
  })

  it('rejects an already-closed period', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', is_closed: true })
    results = [{ data: period, error: null }]

    const supabase = makeClient()
    await expect(
      markPeriodClosedExternally(supabase as never, 'company-1', 'user-1', 'fp-1')
    ).rejects.toThrow('already closed')
  })

  it('rejects a period with its own closing entry (normal close applies)', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', closing_entry_id: 'ce-1' })
    results = [{ data: period, error: null }]

    const supabase = makeClient()
    await expect(
      markPeriodClosedExternally(supabase as never, 'company-1', 'user-1', 'fp-1')
    ).rejects.toThrow('closing entry')
  })

  it('rejects a period that has not ended yet', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      period_start: '2999-01-01',
      period_end: '2999-12-31',
    })
    results = [{ data: period, error: null }]

    const supabase = makeClient()
    await expect(
      markPeriodClosedExternally(supabase as never, 'company-1', 'user-1', 'fp-1')
    ).rejects.toThrow('has not ended')
  })

  it('blocks when the period still holds unbooked bank transactions', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', period_end: '2024-12-31' })
    results = [
      { data: period, error: null },
      { count: 1, data: null, error: null },  // imported-verifikat count
      { count: 2, data: null, error: null },  // untriaged
      { data: [], error: null },              // business-unbooked candidates
    ]

    const supabase = makeClient()
    await expect(
      markPeriodClosedExternally(supabase as never, 'company-1', 'user-1', 'fp-1')
    ).rejects.toThrow('Kan inte klarmarkera period')
  })
})

describe('reopenExternallyClosedPeriod', () => {
  it('reopens a klarmarkerad period, clears the lock, and writes the audit row', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      is_closed: true,
      closed_at: '2026-08-27T09:20:13Z',
      closed_externally: true,
      locked_at: '2026-08-27T09:20:13Z',
      closing_entry_id: null,
    })
    const reopened = {
      ...period,
      is_closed: false,
      closed_at: null,
      closed_externally: false,
      locked_at: null,
    }
    results = [
      { data: period, error: null },    // fetch
      { data: reopened, error: null },  // update
      { data: null, error: null },      // audit_log insert
    ]

    const handler = vi.fn()
    eventBus.on('period.unlocked', handler)

    const supabase = makeClient()
    const result = await reopenExternallyClosedPeriod(supabase as never, 'company-1', 'user-1', 'fp-1')

    expect(result.is_closed).toBe(false)
    expect(result.closed_externally).toBe(false)
    expect(result.locked_at).toBeNull()
    expect(handler).toHaveBeenCalledOnce()
    // Three table touches: fetch, update, audit_log.
    expect(supabase.from).toHaveBeenCalledWith('audit_log')
  })

  it('rejects an open period', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', is_closed: false, closed_externally: false })
    results = [{ data: period, error: null }]

    const supabase = makeClient()
    await expect(
      reopenExternallyClosedPeriod(supabase as never, 'company-1', 'user-1', 'fp-1')
    ).rejects.toThrow('not closed')
  })

  it('rejects a period closed by a year-end run (closing entry, not klarmarkera)', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      is_closed: true,
      closed_externally: false,
      closing_entry_id: 'ce-1',
    })
    results = [{ data: period, error: null }]

    const supabase = makeClient()
    await expect(
      reopenExternallyClosedPeriod(supabase as never, 'company-1', 'user-1', 'fp-1')
    ).rejects.toThrow('year-end run')
  })

  it('rejects a klarmarkerad period that later got its own closing entry', async () => {
    const period = makeFiscalPeriod({
      id: 'fp-1',
      is_closed: true,
      closed_externally: true,
      closing_entry_id: 'ce-1',
    })
    results = [{ data: period, error: null }]

    const supabase = makeClient()
    await expect(
      reopenExternallyClosedPeriod(supabase as never, 'company-1', 'user-1', 'fp-1')
    ).rejects.toThrow('year-end run')
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

  // Feedback seq 249297: an SIE import had wired 2026/2027.previous_period_id
  // to 2024/2025 across a missing 2025/2026, and run_year_end seeded the
  // closing balances of 2024/2025 into 2026/2027 because the chained row was
  // returned unchecked. A non-adjacent link must be ignored so the caller
  // creates the chronologically correct next period instead.
  it('ignores a chained period that is not date-adjacent and falls back to the date lookup', async () => {
    const current = makeFiscalPeriod({
      id: 'fp-2024-25',
      period_start: '2024-05-01',
      period_end: '2025-04-30',
    })
    const twoYearsOut = makeFiscalPeriod({
      id: 'fp-2026-27',
      period_start: '2026-05-01',
      period_end: '2027-04-30',
      previous_period_id: 'fp-2024-25',
    })

    results = [
      { data: current, error: null },     // fetch current
      { data: twoYearsOut, error: null }, // chained lookup hits the wrong period
      { data: null, error: null },        // date lookup: 2025-05-01 does not exist
    ]

    const supabase = makeClient()
    const result = await findNextPeriod(supabase as never, 'company-1', 'fp-2024-25')
    expect(result).toBeNull()
  })

  it('prefers the date-adjacent period over a mis-chained one', async () => {
    const current = makeFiscalPeriod({
      id: 'fp-2024-25',
      period_start: '2024-05-01',
      period_end: '2025-04-30',
    })
    const twoYearsOut = makeFiscalPeriod({
      id: 'fp-2026-27',
      period_start: '2026-05-01',
      period_end: '2027-04-30',
      previous_period_id: 'fp-2024-25',
    })
    const adjacent = makeFiscalPeriod({
      id: 'fp-2025-26',
      period_start: '2025-05-01',
      period_end: '2026-04-30',
      previous_period_id: null,
    })

    results = [
      { data: current, error: null },
      { data: twoYearsOut, error: null },
      { data: adjacent, error: null },
    ]

    const supabase = makeClient()
    const result = await findNextPeriod(supabase as never, 'company-1', 'fp-2024-25')
    expect(result?.id).toBe('fp-2025-26')
  })
})

describe('createNextPeriod chain healing', () => {
  it('relinks a successor that was chained across the gap onto the new period', async () => {
    const current = makeFiscalPeriod({
      id: 'fp-2024-25',
      period_start: '2024-05-01',
      period_end: '2025-04-30',
    })
    const created = makeFiscalPeriod({
      id: 'fp-2025-26',
      period_start: '2025-05-01',
      period_end: '2026-04-30',
      previous_period_id: 'fp-2024-25',
    })

    results = [
      { data: current, error: null },            // fetch current
      { data: [], error: null },                  // overlap check
      { data: created, error: null },             // insert
      { data: [{ id: 'fp-2026-27' }], error: null }, // mis-chained successor starting 2026-05-01
      { data: null, error: null },                // relink update
    ]

    const client = makeClient()
    const builders: Array<Record<string, unknown>> = []
    const from = client.from
    client.from = vi.fn().mockImplementation(() => {
      const b = from()
      builders.push(b)
      return b
    })

    const result = await createNextPeriod(client as never, 'company-1', 'user-1', 'fp-2024-25')
    expect(result.id).toBe('fp-2025-26')

    const relink = builders.find((b) => (b.update as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    expect(relink).toBeDefined()
    expect((relink!.update as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ previous_period_id: 'fp-2025-26' })
    expect((relink!.in as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['id', ['fp-2026-27']])
  })
})
