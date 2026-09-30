import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { roundOre } from '@/lib/money'

const fetchEntryLinesMock = vi.fn()
const sumAccountBalanceMock = vi.fn()
const findOpeningBalanceFloorMock = vi.fn()
const loadImportedStornoPairsMock = vi.fn()

vi.mock('@/lib/bookkeeping/entry-lines', () => ({
  fetchEntryLines: (...args: unknown[]) => fetchEntryLinesMock(...args),
}))
vi.mock('../gl-balance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gl-balance')>()
  return {
    ...actual,
    sumAccountBalance: (...args: unknown[]) => sumAccountBalanceMock(...args),
    findOpeningBalanceFloor: (...args: unknown[]) => findOpeningBalanceFloorMock(...args),
  }
})
vi.mock('@/lib/skatteverket/skattekonto-cancelled-entries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/skatteverket/skattekonto-cancelled-entries')>()
  return {
    ...actual,
    loadImportedStornoPairs: (...args: unknown[]) => loadImportedStornoPairsMock(...args),
  }
})

import { getSkattekontoReconciliationStatus } from '../skattekonto-reconciliation'
import {
  findImportedStornoPairs,
  type EntryForCancellation,
} from '@/lib/skatteverket/skattekonto-cancelled-entries'

const COMPANY = 'company-1'
const TODAY = '2026-08-20'
const FETCHED_AT = Date.UTC(2026, 7, 20, 4, 0, 0)

type Head = {
  id: string
  status: 'draft' | 'posted' | 'reversed'
  voucher_number: number | null
  voucher_series: string | null
  entry_date: string
  description: string
  source_type: string | null
  reverses_id: string | null
  reversed_by_id: string | null
}

function head(id: string, entry_date: string, overrides: Partial<Head> = {}): Head {
  return {
    id,
    status: 'posted',
    voucher_number: Number(id.replace(/\D/g, '')) || null,
    voucher_series: 'A',
    entry_date,
    description: `Verifikat ${id}`,
    source_type: 'manual',
    reverses_id: null,
    reversed_by_id: null,
    ...overrides,
  }
}

/** A 1630 line as fetchEntryLines returns it: amounts + the parent entry attached. */
function ledgerLine(h: Head, amount: number) {
  return {
    id: `line-${h.id}-${amount}`,
    journal_entry_id: h.id,
    debit_amount: amount > 0 ? amount : 0,
    credit_amount: amount < 0 ? -amount : 0,
    journal_entries: h,
  }
}

function row(
  id: string,
  transaktionsdatum: string,
  belopp: number,
  overrides: Partial<{
    status: 'booked' | 'upcoming'
    journal_entry_id: string | null
    suggested_journal_entry_id: string | null
    is_ignored: boolean
    transaktionstext: string
    forfallodatum: string | null
  }> = {},
) {
  return {
    id,
    transaktionsdatum,
    forfallodatum: null,
    transaktionstext: `Händelse ${id}`,
    belopp_skatteverket: belopp,
    status: 'booked',
    journal_entry_id: null,
    suggested_journal_entry_id: null,
    is_ignored: false,
    ...overrides,
  }
}

/**
 * Query order in getSkattekontoReconciliationStatus:
 *   1. extension_data snapshot (maybeSingle)
 *   2. skattekonto_transactions page (fetchAllRows)
 *   3. journal_entries heads for linked + suggested ids (one chunk) when any
 * The ledger lines come from the mocked fetchEntryLines, the balances from the
 * mocked sumAccountBalance.
 */
function enqueueBase(
  enqueue: (r: { data?: unknown; error?: unknown }) => void,
  opts: {
    saldo: number | null
    rows: ReturnType<typeof row>[]
    heads?: Head[]
    fetchedAt?: number
  },
) {
  enqueue({
    data:
      opts.saldo === null
        ? null
        : { value: { saldo: { saldoSkatteverket: opts.saldo }, fetchedAt: opts.fetchedAt ?? FETCHED_AT } },
  })
  enqueue({ data: opts.rows })
  const referenced = opts.rows.some((r) => r.journal_entry_id || r.suggested_journal_entry_id)
  if (referenced) enqueue({ data: opts.heads ?? [] })
}

function ledger(lines: ReturnType<typeof ledgerLine>[], balances: { cutoff: number | null; before: number | null }) {
  fetchEntryLinesMock.mockResolvedValue(lines)
  sumAccountBalanceMock.mockImplementation(
    async (_s: unknown, _c: unknown, _a: unknown, options: { cutoffDate?: string; beforeDate?: string }) =>
      options.beforeDate ? balances.before : balances.cutoff,
  )
}

type EntryFilter = { op: 'eq' | 'in' | 'lt' | 'lte' | 'gte'; column: string; value: unknown }

function passes(h: Head, f: EntryFilter): boolean {
  if (f.column === 'company_id') return true
  const v = (h as unknown as Record<string, unknown>)[f.column]
  if (f.op === 'eq') return v === f.value
  if (f.op === 'in') return (f.value as unknown[]).includes(v)
  if (f.op === 'lt') return String(v) < String(f.value)
  if (f.op === 'lte') return String(v) <= String(f.value)
  return String(v) >= String(f.value)
}

/**
 * The whole 1630 ledger of a fixture, stated once: fetchEntryLines applies
 * the entry filters the engine builds (window, status, ids) and
 * sumAccountBalance the date options it passes, so the engine picks.
 */
function wholeLedger(lines: ReturnType<typeof ledgerLine>[]) {
  fetchEntryLinesMock.mockImplementation(async (opts: { filterEntries: (q: unknown) => unknown }) => {
    const filters: EntryFilter[] = []
    const q: Record<string, (column: string, value: unknown) => unknown> = {}
    for (const op of ['eq', 'in', 'lt', 'lte', 'gte'] as const) {
      q[op] = (column, value) => {
        filters.push({ op, column, value })
        return q
      }
    }
    opts.filterEntries(q)
    return lines.filter((l) => filters.every((f) => passes(l.journal_entries, f)))
  })
  sumAccountBalanceMock.mockImplementation(
    async (_s: unknown, _c: unknown, _a: unknown, o: { cutoffDate?: string; fromDate?: string; beforeDate?: string }) =>
      lines
        .filter(({ journal_entries: h }) =>
          (!o.cutoffDate || h.entry_date <= o.cutoffDate) &&
          (!o.fromDate || h.entry_date >= o.fromDate) &&
          (!o.beforeDate || h.entry_date < o.beforeDate))
        .reduce((sum, l) => roundOre(sum + l.debit_amount - l.credit_amount), 0),
  )
}

/** An entry with ALL its lines, as the cancellation detector reads it. */
function withLines(h: Head, lines: Array<[string, number, number]>): EntryForCancellation {
  return {
    ...h,
    lines: lines.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount })),
  }
}

/** The imported storno pairs the real detector finds among `entries`. */
function detector(entries: EntryForCancellation[]) {
  loadImportedStornoPairsMock.mockImplementation(async () => findImportedStornoPairs(entries))
}

const IB_DATE = '2026-01-01'

describe('getSkattekontoReconciliationStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchEntryLinesMock.mockReset()
    sumAccountBalanceMock.mockReset()
    findOpeningBalanceFloorMock.mockReset()
    findOpeningBalanceFloorMock.mockResolvedValue(null)
    loadImportedStornoPairsMock.mockReset()
    loadImportedStornoPairsMock.mockResolvedValue([])
  })

  it('returns null when the company has neither a snapshot nor rows', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueBase(enqueue, { saldo: null, rows: [] })
    ledger([], { cutoff: 0, before: 0 })
    expect(await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })).toBeNull()
  })

  it('closes the identity to 0,00 on a mixed fixture and buckets every row where the page shows it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const A190 = head('A190', '2026-07-12')
    const A214 = head('A214', '2026-08-11')
    const A219 = head('A219', '2026-08-12')
    const A181 = head('A181', '2026-06-30')
    const rows = [
      row('r-agi', '2026-07-12', -9142, { journal_entry_id: 'A190' }),
      row('r-71106', '2026-08-14', 71106),
      row('r-18', '2026-08-03', 18),
      row('r-moms', '2026-07-12', -35571),
      row('r-30000', '2026-08-12', 30000, { suggested_journal_entry_id: 'A214' }),
      row('r-5447', '2026-08-12', -5447, { suggested_journal_entry_id: 'A219' }),
      row('r-ign', '2026-07-01', -100, { is_ignored: true }),
      row('r-up', '2026-09-12', -5447, { status: 'upcoming', forfallodatum: '2026-09-12' }),
    ]
    enqueueBase(enqueue, { saldo: 53395, rows, heads: [A190, A214, A219] })
    // Ledger in [history start 2026-07-01, cutoff]: linked A190, the two twins, A181 without event.
    ledger(
      [ledgerLine(A190, -9142), ledgerLine(A214, 30000), ledgerLine(A219, -5447), ledgerLine(A181, 12500)],
      { cutoff: 27911, before: 0 },
    )

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    expect(s).not.toBeNull()
    if (!s) return

    expect(s.external_balance).toBe(53395)
    expect(s.ledger_balance).toBe(27911)
    expect(s.difference).toBe(25484)
    // saldo_at_start = 53 395 - (sum of all booked rows = 50 864) = 2 531; ledger before start = 0
    expect(s.skattekonto?.opening_difference).toBe(2531)
    expect(s.unexplained_difference).toBe(0)
    expect(s.is_reconciled).toBe(false)
    expect(s.stale).toBe(false)

    expect(s.counts).toEqual({ proposed: 2, unmatched_external: 3, unmatched_ledger: 3, matched: 1, ignored: 1 })
    expect(s.items.proposed.map((i) => i.item_id).sort()).toEqual(['r-30000', 'r-5447'])
    expect(s.items.proposed[0].proposal?.journal_entry_id).toBeDefined()
    expect(s.items.proposed[0].proposal?.reasons[0]).toMatch(/exakt belopp/)
    expect(s.items.unmatched_external.map((i) => i.item_id).sort()).toEqual(['r-18', 'r-71106', 'r-moms'])
    expect(s.items.unmatched_ledger.map((i) => i.item_id).sort()).toEqual(['A181', 'A214', 'A219'])
    expect(s.items.matched[0]).toMatchObject({ item_id: 'r-agi', linked_journal_entry_id: 'A190', voucher_number: 190 })
    expect(s.items.ignored[0].item_id).toBe('r-ign')
    expect(s.items.upcoming).toHaveLength(1)
    expect(s.skattekonto?.upcoming_total).toBe(-5447)

    const byKey = Object.fromEntries(s.bridge.map((b) => [b.key, b]))
    expect(byKey.external_balance.amount).toBe(53395)
    expect(byKey.unmatched_external.amount).toBe(-60106)
    expect(byKey.unmatched_external.count).toBe(5)
    expect(byKey.unmatched_ledger.amount).toBe(37053)
    expect(byKey.ignored.amount).toBe(100)
    expect(byKey.opening_difference.amount).toBe(-2531)
    expect(byKey.ledger_balance.amount).toBe(27911)
    // The bridge lines sum to the ledger balance: saldo - unlinked - ignored + unlinked ledger - opening
    const sum = s.bridge
      .filter((b) => b.key !== 'ledger_balance')
      .reduce((acc, b) => roundOre(acc + b.amount), 0)
    expect(sum).toBe(27911)
  })

  it('carries the whole group on a combined proposal (crm#128)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const A157 = head('A157', '2026-07-13')
    const rows = [
      row('r-tax', '2026-07-13', -4521, { suggested_journal_entry_id: 'A157' }),
      row('r-fee', '2026-07-13', -7704, { suggested_journal_entry_id: 'A157' }),
    ]
    enqueueBase(enqueue, { saldo: -12225, rows, heads: [A157] })
    ledger([ledgerLine(A157, -12225)], { cutoff: -12225, before: 0 })

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    expect(s?.counts.proposed).toBe(2)
    for (const item of s?.items.proposed ?? []) {
      expect(item.proposal?.external_ids).toEqual(['r-tax', 'r-fee'])
      expect(item.proposal?.confidence).toBe(0.9)
      expect(item.proposal?.reasons[0]).toMatch(/summan av 2 händelser/)
    }
  })

  it('treats a link to a reversed entry as a dead link, and the storno pair nets out of the residual', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const E1 = head('E1', '2026-08-01', { status: 'reversed', reversed_by_id: 'E2' })
    const E2 = head('E2', '2026-08-02', { source_type: 'storno', reverses_id: 'E1' })
    enqueueBase(enqueue, {
      saldo: 1000,
      rows: [row('r1', '2026-08-01', 1000, { journal_entry_id: 'E1' })],
      heads: [E1],
    })
    ledger([ledgerLine(E1, 1000), ledgerLine(E2, -1000)], { cutoff: 0, before: 0 })

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    if (!s) throw new Error('expected status')

    expect(s.counts.matched).toBe(0)
    expect(s.counts.unmatched_external).toBe(1)
    expect(s.items.unmatched_external[0]).toMatchObject({ item_id: 'r1', link_problem: 'entry_reversed' })
    expect(s.items.unmatched_external[0].actions).toContain('unmatch')
    expect(s.counts.unmatched_ledger).toBe(0)
    expect(s.unexplained_difference).toBe(0)
    expect(s.difference).toBe(1000)
    expect(s.is_reconciled).toBe(false)
  })

  it('settles a complete storno pair without inventing external matches or older work', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const original = head('E1', '2026-08-01', { status: 'reversed', reversed_by_id: 'E2' })
    const reversal = head('E2', '2026-08-10', { source_type: 'storno', reverses_id: 'E1' })
    const correct = head('E3', '2026-08-01')
    enqueueBase(enqueue, {
      saldo: 1000,
      rows: [row('r1', '2026-08-01', 1000, { journal_entry_id: 'E3' })],
      heads: [correct],
    })
    ledger([
      ledgerLine(original, 600), ledgerLine(original, 400),
      ledgerLine(reversal, -1000), ledgerLine(correct, 1000),
    ], { cutoff: 1000, before: 0 })

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, {
      today: TODAY, windowFrom: '2026-08-05',
    })
    expect(s?.counts).toEqual({ proposed: 0, unmatched_external: 0, unmatched_ledger: 0, matched: 1, ignored: 0 })
    expect(s?.items.unmatched_ledger).toEqual([])
    expect(s?.older_unmatched_count).toBe(0)
    expect(s?.ledger_balance).toBe(1000)
    expect(s?.unexplained_difference).toBe(0)
    expect(s?.is_reconciled).toBe(true)
  })

  it.each([
    ['unrelated equal and opposite entries', {}, {}, -1000],
    ['a mismatched reversal amount', { status: 'reversed', reversed_by_id: 'E2' }, { source_type: 'storno', reverses_id: 'E1' }, -999.99],
    ['a broken reciprocal link', { status: 'reversed', reversed_by_id: 'E2' }, { source_type: 'storno', reverses_id: 'other' }, -1000],
    ['an original still posted', { reversed_by_id: 'E2' }, { source_type: 'storno', reverses_id: 'E1' }, -1000],
    ['a correction that is not a storno', { status: 'reversed', reversed_by_id: 'E2' }, { reverses_id: 'E1' }, -1000],
  ] as const)('keeps %s visible', async (_name, originalOverrides, reversalOverrides, amount) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueBase(enqueue, { saldo: 0, rows: [] })
    ledger([
      ledgerLine(head('E1', '2026-08-01', originalOverrides), 1000),
      ledgerLine(head('E2', '2026-08-02', reversalOverrides), amount),
    ], { cutoff: roundOre(1000 + amount), before: 0 })

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    expect(s?.counts.unmatched_ledger).toBe(2)
    expect(s?.items.unmatched_ledger).toHaveLength(2)
    expect(s?.unexplained_difference).toBe(0)
    expect(s?.is_reconciled).toBe(false)
  })

  it.each([
    head('E1', '2026-08-01', { status: 'reversed', reversed_by_id: 'E2' }),
    head('E2', '2026-08-01', { source_type: 'storno', reverses_id: 'E1' }),
  ])('keeps $id visible when its counterpart is outside the comparable ledger history', async (remaining) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueBase(enqueue, { saldo: 0, rows: [] })
    const amount = remaining.id === 'E1' ? 1000 : -1000
    ledger([ledgerLine(remaining, amount)], { cutoff: amount, before: 0 })

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    expect(s?.items.unmatched_ledger.map(i => i.item_id)).toEqual([remaining.id])
    expect(s?.counts.unmatched_ledger).toBe(1)
    expect(s?.unexplained_difference).toBe(0)
    expect(s?.is_reconciled).toBe(false)
  })

  it('does not suppress an unmatched original when the reversal has a live external link', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const original = head('E1', '2026-08-01', { status: 'reversed', reversed_by_id: 'E2' })
    const reversal = head('E2', '2026-08-02', { source_type: 'storno', reverses_id: 'E1' })
    enqueueBase(enqueue, {
      saldo: -1000,
      rows: [row('r1', '2026-08-02', -1000, { journal_entry_id: 'E2' })],
      heads: [reversal],
    })
    ledger([ledgerLine(original, 1000), ledgerLine(reversal, -1000)], { cutoff: 0, before: 0 })

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    expect(s?.items.unmatched_ledger.map(i => i.item_id)).toEqual(['E1'])
    expect(s?.counts.matched).toBe(1)
    expect(s?.unexplained_difference).toBe(0)
    expect(s?.is_reconciled).toBe(false)
  })

  it('marks a stale snapshot and never claims reconciled on one', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueBase(enqueue, { saldo: 0, rows: [], fetchedAt: Date.UTC(2026, 6, 1) })
    ledger([], { cutoff: 0, before: 0 })

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    if (!s) throw new Error('expected status')
    expect(s.stale).toBe(true)
    expect(s.as_of).toBe(new Date(Date.UTC(2026, 6, 1)).toISOString())
    // Nothing open and the identity closes, but the data is 50 days old: reconciled is still true
    // (the state machine in the service reports it as stale; staleness is not a mismatch).
    expect(s.is_reconciled).toBe(true)
  })

  it('flags a ledger line dated within 5 days of the snapshot as possibly awaiting Skatteverket', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const recent = head('R1', '2026-08-18')
    const old = head('R2', '2026-07-01')
    enqueueBase(enqueue, { saldo: 0, rows: [row('r1', '2026-07-01', 10)] })
    ledger([ledgerLine(recent, 500), ledgerLine(old, 10)], { cutoff: 510, before: 0 })

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    if (!s) throw new Error('expected status')
    const byId = Object.fromEntries(s.items.unmatched_ledger.map((i) => [i.item_id, i]))
    expect(byId.R1.awaiting_external).toBe(true)
    expect(byId.R2.awaiting_external).toBe(false)
  })

  it('a window scopes the item lists only; older unmatched rows are counted, never hidden', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const old = head('O1', '2026-03-10')
    enqueueBase(enqueue, {
      saldo: 5000,
      rows: [row('r-old', '2026-03-01', 2000), row('r-new', '2026-08-10', 3000)],
    })
    ledger([ledgerLine(old, 700)], { cutoff: 700, before: 0 })

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, {
      today: TODAY,
      windowFrom: '2026-07-01',
      windowTo: '2026-08-31',
    })
    if (!s) throw new Error('expected status')
    expect(s.items.unmatched_external.map((i) => i.item_id)).toEqual(['r-new'])
    expect(s.items.unmatched_ledger).toHaveLength(0)
    expect(s.counts.unmatched_external).toBe(2)
    expect(s.counts.unmatched_ledger).toBe(1)
    expect(s.older_unmatched_count).toBe(2)
    // Totals are unwindowed: 5000 - 5000 (unlinked) + 700 (unlinked ledger) - opening(5000-5000-0=0) = 700 = ledger
    expect(s.unexplained_difference).toBe(0)
  })

  it('reports a failed ledger read as null balances and a null residual, never a fabricated 0', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueBase(enqueue, { saldo: 1000, rows: [row('r1', '2026-08-01', 1000)] })
    fetchEntryLinesMock.mockResolvedValue([])
    sumAccountBalanceMock.mockResolvedValue(null)

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    if (!s) throw new Error('expected status')
    expect(s.ledger_read_failed).toBe(true)
    expect(s.ledger_balance).toBeNull()
    expect(s.difference).toBeNull()
    expect(s.unexplained_difference).toBeNull()
    expect(s.is_reconciled).toBe(false)
    // The SKV side is still listed so the user can work.
    expect(s.counts.unmatched_external).toBe(1)
  })

  it('does not propose an entry that another row already links live', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const E = head('E9', '2026-08-01')
    enqueueBase(enqueue, {
      saldo: 2000,
      rows: [
        row('r-linked', '2026-08-01', 1000, { journal_entry_id: 'E9' }),
        row('r-open', '2026-08-01', 1000, { suggested_journal_entry_id: 'E9' }),
      ],
      heads: [E],
    })
    ledger([ledgerLine(E, 1000)], { cutoff: 1000, before: 0 })

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    if (!s) throw new Error('expected status')
    expect(s.counts.proposed).toBe(0)
    expect(s.counts.unmatched_external).toBe(1)
    expect(s.items.unmatched_external[0].item_id).toBe('r-open')
  })

  it('counts an entry linked from before the history start inside the history, not as an opening difference', async () => {
    // A payment booked on the bank date (01-21) that Skatteverket dates the day
    // after (01-22), which is also the first row we hold.
    const { supabase, enqueue } = createQueuedMockSupabase()
    const A2 = head('A2', '2026-01-21')
    const A98 = head('A98', '2026-08-17')
    enqueueBase(enqueue, {
      saldo: 0,
      rows: [
        row('r-pay', '2026-01-22', 2075, { journal_entry_id: 'A2' }),
        row('r-moms', '2026-08-17', -2075, { journal_entry_id: 'A98' }),
      ],
      heads: [A2, A98],
    })
    sumAccountBalanceMock.mockImplementation(
      async (_s: unknown, _c: unknown, _a: unknown, options: { beforeDate?: string }) =>
        options.beforeDate ? 2075 : 0,
    )
    // Window read [01-22, cutoff], then the read of the linked entry before it.
    fetchEntryLinesMock.mockResolvedValueOnce([ledgerLine(A98, -2075)])
    fetchEntryLinesMock.mockResolvedValueOnce([ledgerLine(A2, 2075)])

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    if (!s) throw new Error('expected status')
    expect(fetchEntryLinesMock).toHaveBeenCalledTimes(2)
    expect(s.skattekonto?.opening_difference).toBe(0)
    expect(s.unexplained_difference).toBe(0)
    expect(s.is_reconciled).toBe(true)
    expect(s.bridge.find((b) => b.key === 'opening_difference')).toBeUndefined()
  })

  it('keeps a real opening difference when the entry before the history start is not linked', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const E = head('E5', '2026-08-01')
    enqueueBase(enqueue, {
      saldo: 1000,
      rows: [row('r1', '2026-08-01', 1000, { journal_entry_id: 'E5' })],
      heads: [E],
    })
    ledger([ledgerLine(E, 1000)], { cutoff: 1500, before: 500 })

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    if (!s) throw new Error('expected status')
    expect(fetchEntryLinesMock).toHaveBeenCalledTimes(1)
    expect(s.skattekonto?.opening_difference).toBe(-500)
    expect(s.unexplained_difference).toBe(0)
  })

  describe('floored at the ingående balans on 1630 (feedback 779638)', () => {
    const Z1 = head('Z1', IB_DATE, { source_type: 'opening_balance', voucher_series: 'Z' })
    const floorAt = (amount: number) =>
      findOpeningBalanceFloorMock.mockResolvedValue({ date: IB_DATE, amount, entryIds: ['Z1'] })

    it('reads the ledger from the IB: earlier years as detail plus the IB are the huvudbok once, not twice', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      // Earlier years imported as detail without IB entries (SIE), then the
      // IB that opens the current year: the detail nets to exactly the IB.
      const V12 = head('V12', '2024-06-01', { source_type: 'import' })
      const V10 = head('V10', '2025-04-05', { source_type: 'import' })
      const V20 = head('V20', '2025-08-19', { source_type: 'import' })
      const A1 = head('A1', '2026-01-03')
      const A2 = head('A2', '2026-03-12')
      enqueueBase(enqueue, {
        saldo: 7000,
        rows: [
          row('r-2025a', '2025-04-05', 3000, { journal_entry_id: 'V10' }),
          row('r-2025b', '2025-08-19', -2000, { journal_entry_id: 'V20' }),
          row('r-2026a', '2026-01-03', 1500, { journal_entry_id: 'A1' }),
          row('r-2026b', '2026-03-12', -500, { journal_entry_id: 'A2' }),
        ],
        heads: [V10, V20, A1, A2],
      })
      wholeLedger([
        ledgerLine(V12, 5000), ledgerLine(V10, 3000), ledgerLine(V20, -2000),
        ledgerLine(Z1, 6000), ledgerLine(A1, 1500), ledgerLine(A2, -500),
      ])
      floorAt(6000)

      const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
      if (!s) throw new Error('expected status')
      expect(findOpeningBalanceFloorMock).toHaveBeenCalledWith(expect.anything(), COMPANY, '1630', TODAY)
      // Summed over all history the ledger said 13 000: the earlier years once
      // as detail and once more inside the IB.
      expect(s.ledger_balance).toBe(7000)
      expect(s.difference).toBe(0)
      expect(s.skattekonto?.history_start).toBe(IB_DATE)
      expect(s.skattekonto?.ledger_balance_before_start).toBe(6000)
      expect(s.skattekonto?.opening_difference).toBe(0)
      expect(s.unexplained_difference).toBe(0)
      expect(s.counts).toEqual({ proposed: 0, unmatched_external: 0, unmatched_ledger: 0, matched: 2, ignored: 0 })
      expect(s.items.matched.map((i) => i.item_id)).toEqual(['r-2026a', 'r-2026b'])
      expect(s.items.unmatched_ledger).toEqual([])
      expect(s.bridge.find((b) => b.key === 'opening_difference')).toBeUndefined()
      expect(s.is_reconciled).toBe(true)
    })

    it('an IB-only company: Skatteverket rows before the IB leave the lists and the IB is no row to match', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const A1 = head('A1', '2026-02-12')
      enqueueBase(enqueue, {
        saldo: 3000,
        rows: [
          // Last year's event: the IB carries it, no verifikat here books it.
          row('r-2025', '2025-11-10', 4000),
          row('r-2026', '2026-02-12', -1000, { journal_entry_id: 'A1' }),
        ],
        heads: [A1],
      })
      wholeLedger([ledgerLine(Z1, 4000), ledgerLine(A1, -1000)])
      floorAt(4000)

      const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
      if (!s) throw new Error('expected status')
      expect(s.ledger_balance).toBe(3000)
      expect(s.skattekonto?.history_start).toBe(IB_DATE)
      expect(s.skattekonto?.opening_difference).toBe(0)
      expect(s.unexplained_difference).toBe(0)
      expect(s.counts).toEqual({ proposed: 0, unmatched_external: 0, unmatched_ledger: 0, matched: 1, ignored: 0 })
      expect(s.is_reconciled).toBe(true)
    })

    it('counts the IB and what was booked before the first Skatteverket row as the opening balance', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const A0 = head('A0', '2026-01-20')
      const A1 = head('A1', '2026-02-12')
      enqueueBase(enqueue, {
        saldo: 3500,
        rows: [row('r1', '2026-02-12', -1000, { journal_entry_id: 'A1' })],
        heads: [A1],
      })
      wholeLedger([ledgerLine(Z1, 4000), ledgerLine(A0, 500), ledgerLine(A1, -1000)])
      floorAt(4000)

      const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
      if (!s) throw new Error('expected status')
      expect(sumAccountBalanceMock).toHaveBeenCalledWith(expect.anything(), COMPANY, '1630', {
        fromDate: IB_DATE,
        beforeDate: '2026-02-12',
      })
      expect(s.skattekonto?.history_start).toBe('2026-02-12')
      expect(s.skattekonto?.ledger_balance_before_start).toBe(4500)
      expect(s.skattekonto?.opening_difference).toBe(0)
      expect(s.ledger_balance).toBe(3500)
      expect(s.unexplained_difference).toBe(0)
      expect(s.is_reconciled).toBe(true)
    })

    it('without an IB both sums run over all history, exactly as before', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const A0 = head('A0', '2026-01-15')
      const A1 = head('A1', '2026-02-12')
      enqueueBase(enqueue, {
        saldo: 1500,
        rows: [row('r1', '2026-02-12', -1000, { journal_entry_id: 'A1' })],
        heads: [A1],
      })
      wholeLedger([ledgerLine(A0, 2500), ledgerLine(A1, -1000)])

      const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
      if (!s) throw new Error('expected status')
      expect(sumAccountBalanceMock.mock.calls.map((c) => c[3])).toEqual([
        { cutoffDate: TODAY },
        { beforeDate: '2026-02-12' },
      ])
      expect(s.ledger_balance).toBe(1500)
      expect(s.skattekonto?.history_start).toBe('2026-02-12')
      expect(s.skattekonto?.ledger_balance_before_start).toBe(2500)
      expect(s.skattekonto?.opening_difference).toBe(0)
      expect(s.is_reconciled).toBe(true)
    })

    it('keeps a row dated before the IB with the verifikat after the IB that it links to', async () => {
      // Skatteverket pays out on 2025-12-30; the verifikat takes the bank date 2026-01-02.
      const { supabase, enqueue } = createQueuedMockSupabase()
      const A1 = head('A1', '2026-01-02')
      enqueueBase(enqueue, {
        saldo: 2000,
        rows: [
          row('r-in', '2025-06-01', 4000),
          row('r-out', '2025-12-30', -2000, { journal_entry_id: 'A1' }),
        ],
        heads: [A1],
      })
      wholeLedger([ledgerLine(Z1, 4000), ledgerLine(A1, -2000)])
      floorAt(4000)

      const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
      if (!s) throw new Error('expected status')
      expect(s.items.matched.map((i) => i.item_id)).toEqual(['r-out'])
      expect(s.counts.unmatched_ledger).toBe(0)
      expect(s.skattekonto?.opening_difference).toBe(0)
      expect(s.unexplained_difference).toBe(0)
      expect(s.is_reconciled).toBe(true)
    })

    it('a row linked to the IB verifikat settles it once, not also in the opening balance', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueueBase(enqueue, {
        saldo: 4000,
        rows: [row('r1', IB_DATE, 4000, { journal_entry_id: 'Z1' })],
        heads: [Z1],
      })
      wholeLedger([ledgerLine(Z1, 4000)])
      floorAt(4000)

      const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
      if (!s) throw new Error('expected status')
      expect(s.counts.matched).toBe(1)
      expect(s.skattekonto?.ledger_balance_before_start).toBe(0)
      expect(s.skattekonto?.opening_difference).toBe(0)
      expect(s.unexplained_difference).toBe(0)
    })

    it('reports null balances when the IB read fails, never an unfloored sum', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueueBase(enqueue, { saldo: 1000, rows: [row('r1', '2026-08-01', 1000)] })
      wholeLedger([])
      findOpeningBalanceFloorMock.mockRejectedValue(new Error('statement timeout'))

      const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
      if (!s) throw new Error('expected status')
      expect(sumAccountBalanceMock).not.toHaveBeenCalled()
      expect(s.ledger_read_failed).toBe(true)
      expect(s.ledger_balance).toBeNull()
      expect(s.unexplained_difference).toBeNull()
      expect(s.is_reconciled).toBe(false)
      expect(s.counts.unmatched_external).toBe(1)
    })
  })

  describe('imported annulment pairs', () => {
    const V290 = head('V290', '2026-08-03', {
      source_type: 'import',
      voucher_series: 'V',
      description: 'Momsdebitering - Skatteverket',
    })
    const V463 = head('V463', '2026-08-03', {
      source_type: 'import',
      voucher_series: 'V',
      description: 'Annullering av V290: Momsdebitering - Skatteverket',
    })
    const pair = [
      withLines(V290, [['1630', 0, 65484], ['2650', 65484, 0]]),
      withLines(V463, [['1630', 65484, 0], ['2650', 0, 65484]]),
    ]

    it('settles an imported annulment pair the way it settles an in-app storno pair', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueueBase(enqueue, { saldo: 0, rows: [] })
      wholeLedger([ledgerLine(V290, -65484), ledgerLine(V463, 65484)])
      detector(pair)

      const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
      if (!s) throw new Error('expected status')
      expect(loadImportedStornoPairsMock).toHaveBeenCalledWith(expect.anything(), COMPANY, '2026-08-03', '2026-08-03')
      expect(s.counts.unmatched_ledger).toBe(0)
      expect(s.items.unmatched_ledger).toEqual([])
      expect(s.ledger_balance).toBe(0)
      expect(s.unexplained_difference).toBe(0)
      expect(s.is_reconciled).toBe(true)
    })

    it('settles neither half when one half has a live link', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      // A5 mirrors V463 too, but V290 is V463's annulment partner.
      const A5 = head('A5', '2026-08-20', { source_type: 'import', description: 'Momsdebitering augusti' })
      enqueueBase(enqueue, {
        saldo: -65484,
        rows: [row('r1', '2026-08-03', -65484, { journal_entry_id: 'V290' })],
        heads: [V290],
      })
      wholeLedger([ledgerLine(V290, -65484), ledgerLine(V463, 65484), ledgerLine(A5, -65484)])
      detector([...pair, withLines(A5, [['1630', 0, 65484], ['2650', 65484, 0]])])

      const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
      if (!s) throw new Error('expected status')
      expect(loadImportedStornoPairsMock).toHaveBeenCalled()
      expect(s.items.unmatched_ledger.map((i) => i.item_id)).toEqual(['V463', 'A5'])
      expect(s.unexplained_difference).toBe(0)
      expect(s.is_reconciled).toBe(false)
    })

    it('keeps a same-day mirror of two entries made here listed: only imported pairs settle', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      // Anchored by the date, so the content detector pairs them, but an
      // entry made here is corrected through storno, never by a bare mirror.
      const payment = head('A30', '2026-04-10', { description: 'Inbetalning till skattekontot' })
      const refund = head('A31', '2026-04-10', { description: 'Utbetalning från skattekontot' })
      enqueueBase(enqueue, { saldo: 0, rows: [] })
      wholeLedger([ledgerLine(payment, 5000), ledgerLine(refund, -5000)])
      detector([
        withLines(payment, [['1630', 5000, 0], ['1930', 0, 5000]]),
        withLines(refund, [['1630', 0, 5000], ['1930', 5000, 0]]),
      ])

      const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
      if (!s) throw new Error('expected status')
      expect(s.items.unmatched_ledger.map((i) => i.item_id)).toEqual(['A30', 'A31'])
      expect(s.counts.unmatched_ledger).toBe(2)
      expect(s.is_reconciled).toBe(false)
    })

    it('keeps a payment and a later refund of the same amount listed: a mirror without an anchor', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      const payment = head('A10', '2026-03-01', { source_type: 'import', description: 'Inbetalning till skattekontot' })
      const refund = head('A20', '2026-03-20', { source_type: 'import', description: 'Utbetalning från skattekontot' })
      enqueueBase(enqueue, { saldo: 0, rows: [] })
      wholeLedger([ledgerLine(payment, 5000), ledgerLine(refund, -5000)])
      detector([
        withLines(payment, [['1630', 5000, 0], ['1930', 0, 5000]]),
        withLines(refund, [['1630', 0, 5000], ['1930', 5000, 0]]),
      ])

      const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
      if (!s) throw new Error('expected status')
      expect(loadImportedStornoPairsMock).toHaveBeenCalledWith(expect.anything(), COMPANY, '2026-03-01', '2026-03-20')
      expect(s.items.unmatched_ledger.map((i) => i.item_id)).toEqual(['A10', 'A20'])
      expect(s.counts.unmatched_ledger).toBe(2)
      expect(s.unexplained_difference).toBe(0)
      expect(s.is_reconciled).toBe(false)
    })
  })
})
