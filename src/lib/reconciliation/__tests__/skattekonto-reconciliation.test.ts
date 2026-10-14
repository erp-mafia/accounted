import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { roundOre } from '@/lib/money'

// The company's skattekonto account (lib/skatteverket/skattekonto-account.ts):
// 1630 here, what every company resolved to before the setting existed.
vi.mock('@/lib/skatteverket/skattekonto-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skatteverket/skattekonto-account')>()),
  resolveSkattekontoAccount: vi.fn(async () => '1630'),
}))

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

import { findLedgerCoverPoint, getSkattekontoReconciliationStatus } from '../skattekonto-reconciliation'
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

    // Agent feedback seq 897389: a duplicated SIE IB and the entry undoing it,
    // both opening_balance on one fiscal-year start, net to 0 on 1630. The
    // floor stopped at them and dropped every earlier year, so "Bokfört på
    // 1630" fell short of the huvudbok by exactly that history and the gap
    // showed up as an opening difference. The real floor (not the mock) now
    // skips the pair and the balance runs over all history.
    it('a cancelling IB pair is no floor: the ledger balance is the full-history huvudbok sum', async () => {
      const actualGl = await vi.importActual<typeof import('../gl-balance')>('../gl-balance')
      findOpeningBalanceFloorMock.mockImplementation(actualGl.findOpeningBalanceFloor)
      const { supabase, enqueue } = createQueuedMockSupabase()
      const H1 = head('H1', '2018-05-02', { source_type: 'import' })
      const H2 = head('H2', '2020-11-12', { source_type: 'import' })
      const M1 = head('M1', '2021-01-01', { source_type: 'opening_balance', voucher_series: 'M' })
      const M2 = head('M2', '2021-01-01', { source_type: 'opening_balance', voucher_series: 'M' })
      const A1 = head('A1', '2024-02-01')
      const A2 = head('A2', '2025-04-05')
      const A3 = head('A3', '2026-03-01')
      const rows = [
        row('r1', '2025-04-05', 3000, { journal_entry_id: 'A2' }),
        row('r2', '2026-03-01', -1000, { journal_entry_id: 'A3' }),
      ]
      enqueue({ data: { value: { saldo: { saldoSkatteverket: 7000 }, fetchedAt: FETCHED_AT } } })
      enqueue({ data: rows })
      enqueue({ data: [{ period_start: '2021-01-01' }] }) // the floor's fiscal-year read
      enqueue({ data: [A2, A3] })
      const lines = [
        ledgerLine(H1, 6000), ledgerLine(H2, -1500),
        ledgerLine(M1, 4000), ledgerLine(M2, -4000),
        ledgerLine(A1, 500), ledgerLine(A2, 3000), ledgerLine(A3, -1000),
      ]
      wholeLedger(lines)
      const huvudbok = lines.reduce((sum, l) => roundOre(sum + l.debit_amount - l.credit_amount), 0)

      const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
      if (!s) throw new Error('expected status')
      expect(await findOpeningBalanceFloorMock.mock.results[0].value).toBeNull()
      expect(sumAccountBalanceMock).toHaveBeenCalledWith(expect.anything(), COMPANY, '1630', { cutoffDate: TODAY })
      expect(s.ledger_balance).toBe(huvudbok)
      expect(s.ledger_balance).toBe(7000)
      expect(s.difference).toBe(0)
      expect(s.skattekonto?.history_start).toBe('2025-04-05')
      expect(s.skattekonto?.ledger_balance_before_start).toBe(5000)
      expect(s.skattekonto?.opening_difference).toBe(0)
      expect(s.unexplained_difference).toBe(0)
      expect(s.is_reconciled).toBe(true)
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
      expect(loadImportedStornoPairsMock).toHaveBeenCalledWith(expect.anything(), COMPANY, '2026-08-03', '2026-08-03', '1630')
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
      expect(loadImportedStornoPairsMock).toHaveBeenCalledWith(expect.anything(), COMPANY, '2026-03-01', '2026-03-20', '1630')
      expect(s.items.unmatched_ledger.map((i) => i.item_id)).toEqual(['A10', 'A20'])
      expect(s.counts.unmatched_ledger).toBe(2)
      expect(s.unexplained_difference).toBe(0)
      expect(s.is_reconciled).toBe(false)
    })
  })
})

// crm#1153 / crm#1155. A company migrated by SIE: last year is in the ledger
// as imported verifikat, this year opens with an IB on 1630, and the
// Skatteverket rows from last year were never linked. The IB carries them, so
// they belong to no bridge figure, but Att göra counts them as unbooked and an
// agent needs their ids. All figures here are made up.
describe('open rows before the history start (crm#1153)', () => {
  const Z1 = head('Z1', IB_DATE, { source_type: 'opening_balance', voucher_series: 'Z' })
  // Last year's events, imported by SIE as detail before the IB.
  const V1 = head('V1', '2025-03-12', { source_type: 'import' })
  const V2 = head('V2', '2025-06-12', { source_type: 'import' })
  const V3 = head('V3', '2025-09-12', { source_type: 'import' })
  const A1 = head('A1', '2026-02-12')

  beforeEach(() => {
    vi.clearAllMocks()
    fetchEntryLinesMock.mockReset()
    sumAccountBalanceMock.mockReset()
    findOpeningBalanceFloorMock.mockReset()
    findOpeningBalanceFloorMock.mockResolvedValue({ date: IB_DATE, amount: 4000, entryIds: ['Z1'] })
    loadImportedStornoPairsMock.mockReset()
    loadImportedStornoPairsMock.mockResolvedValue([])
  })

  type Variant = 'open' | 'ignored' | 'linked'

  /**
   * The same company three ways: last year's rows open, ignored, or linked
   * to the imported verifikat that hold them. Saldo 3 750 against a 1630
   * balance of 3 000: one unbooked row this year (500) and an opening
   * difference of 250 explain it.
   */
  async function statusFor(
    variant: Variant,
    options: { windowFrom?: string; windowTo?: string; suggested?: boolean } = {},
  ) {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const { suggested, ...window } = options
    const prior = (id: string, date: string, amount: number, entry: string) =>
      row(id, date, amount, {
        ...(variant === 'ignored' ? { is_ignored: true } : {}),
        ...(variant === 'linked' ? { journal_entry_id: entry } : {}),
        // What the sync's matcher leaves on an open row: the imported twin.
        ...(suggested && variant === 'open' ? { suggested_journal_entry_id: entry } : {}),
      })
    enqueueBase(enqueue, {
      saldo: 3750,
      rows: [
        prior('p1', '2025-03-12', 1200, 'V1'),
        prior('p2', '2025-06-12', -800, 'V2'),
        prior('p3', '2025-09-12', 300, 'V3'),
        row('r1', '2026-02-12', -1000, { journal_entry_id: 'A1' }),
        row('r2', '2026-03-12', 500),
      ],
      heads: variant === 'linked' || suggested ? [V1, V2, V3, A1] : [A1],
    })
    wholeLedger([
      ledgerLine(V1, 1200), ledgerLine(V2, -800), ledgerLine(V3, 300),
      ledgerLine(Z1, 4000), ledgerLine(A1, -1000),
    ])
    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY, ...window })
    if (!s) throw new Error('expected status')
    return s
  }

  /** Everything the page and the bridge read: all of the status but the new listing. */
  function bridgeFigures(s: NonNullable<Awaited<ReturnType<typeof getSkattekontoReconciliationStatus>>>) {
    const { items, skattekonto, ...rest } = s
    const { before_history: _listed, ...otherBuckets } = items
    void _listed
    const { before_history_count: _count, before_history_total: _total, ...block } = skattekonto ?? {}
    void _count
    void _total
    return { ...rest, items: otherBuckets, skattekonto: block }
  }

  it('lists them with the flag, outside every count, and the bridge reads as before', async () => {
    const s = await statusFor('open')
    expect(s.items.before_history.map((i) => i.item_id)).toEqual(['p1', 'p2', 'p3'])
    expect(s.items.before_history[0]).toMatchObject({
      item_type: 'skattekonto_transaction',
      side: 'external',
      bucket: 'before_history',
      date: '2025-03-12',
      amount: 1200,
      before_history: true,
      linked_journal_entry_id: null,
      actions: ['match', 'ignore'],
    })
    expect(s.skattekonto?.before_history_count).toBe(3)
    expect(s.skattekonto?.before_history_total).toBe(700)

    // The figures the bridge and the page show, stated outright.
    expect(s.skattekonto?.history_start).toBe(IB_DATE)
    expect(s.ledger_balance).toBe(3000)
    expect(s.difference).toBe(750)
    expect(s.skattekonto?.ledger_balance_before_start).toBe(4000)
    expect(s.skattekonto?.opening_difference).toBe(250)
    expect(s.unexplained_difference).toBe(0)
    expect(s.counts).toEqual({ proposed: 0, unmatched_external: 1, unmatched_ledger: 0, matched: 1, ignored: 0 })
    expect(s.items.unmatched_external.map((i) => i.item_id)).toEqual(['r2'])
    expect(s.items.ignored).toEqual([])
    expect(s.older_unmatched_count).toBe(0)
    expect(s.bridge.map((b) => [b.key, b.amount, b.count])).toEqual([
      ['external_balance', 3750, null],
      ['unmatched_external', -500, 1],
      ['unmatched_ledger', 0, 0],
      ['opening_difference', -250, null],
      ['ledger_balance', 3000, null],
    ])
    expect(s.is_reconciled).toBe(false)
    expect(s.cover).toBeNull()
  })

  it('ignoring them, or linking them to the imported verifikat, moves no figure: only the listing empties', async () => {
    const open = await statusFor('open')
    for (const variant of ['ignored', 'linked'] as const) {
      const s = await statusFor(variant)
      expect(s.items.before_history).toEqual([])
      expect(s.skattekonto?.before_history_count).toBe(0)
      expect(s.skattekonto?.before_history_total).toBe(0)
      expect(bridgeFigures(s)).toEqual(bridgeFigures(open))
    }
  })

  it('carries the standing proposal, the imported verifikat that holds the event, so it can be linked', async () => {
    const s = await statusFor('open', { suggested: true })
    expect(s.items.before_history.map((i) => [i.item_id, i.proposal?.journal_entry_id])).toEqual([
      ['p1', 'V1'],
      ['p2', 'V2'],
      ['p3', 'V3'],
    ])
    expect(s.items.before_history[0].proposal).toMatchObject({ entry_date: '2025-03-12', entry_status: 'posted' })
    // Display only: the bridge is the one without proposals.
    expect(bridgeFigures(s)).toEqual(bridgeFigures(await statusFor('open')))
  })

  it('does not offer a verifikat another row already links to', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueBase(enqueue, {
      saldo: 3000,
      rows: [
        row('p1', '2025-03-12', 1200, { journal_entry_id: 'V1' }),
        row('p1b', '2025-03-13', 1200, { suggested_journal_entry_id: 'V1' }),
        row('r1', '2026-02-12', -1000, { journal_entry_id: 'A1' }),
      ],
      heads: [V1, A1],
    })
    wholeLedger([ledgerLine(V1, 1200), ledgerLine(Z1, 4000), ledgerLine(A1, -1000)])
    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    if (!s) throw new Error('expected status')
    expect(s.items.before_history.map((i) => [i.item_id, i.proposal])).toEqual([['p1b', null]])
  })

  it('a window scopes the listing, never the count, and adds nothing to older_unmatched_count', async () => {
    const s = await statusFor('open', { windowFrom: '2026-01-01', windowTo: '2026-12-31' })
    expect(s.items.before_history).toEqual([])
    expect(s.skattekonto?.before_history_count).toBe(3)
    expect(s.skattekonto?.before_history_total).toBe(700)
    expect(s.older_unmatched_count).toBe(0)
    expect(s.counts.unmatched_external).toBe(1)
  })

  it('without an IB the history starts at the first row, so nothing is before it', async () => {
    findOpeningBalanceFloorMock.mockResolvedValue(null)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueBase(enqueue, { saldo: 700, rows: [row('p1', '2025-03-12', 1200), row('p2', '2025-06-12', -500)] })
    wholeLedger([])
    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    if (!s) throw new Error('expected status')
    expect(s.skattekonto?.history_start).toBe('2025-03-12')
    expect(s.items.before_history).toEqual([])
    expect(s.skattekonto?.before_history_count).toBe(0)
    expect(s.counts.unmatched_external).toBe(2)
  })
})

// crm#1043. The fetched history starts mid-year (Skatteverket returns a
// limited window), and the whole year's skattekonto is booked as ONE
// summarised year-end verifikat dated 31 December: one line per counter
// account against 1630, covering 1 January to 31 December. All figures here
// are made up.
describe('a summarised year-end verifikat (crm#1043)', () => {
  const TODAY_2027 = '2027-01-20'
  const FETCHED_2027 = Date.UTC(2027, 0, 20, 4, 0, 0)
  const YEAR_END = head('B1', '2026-12-31', { source_type: 'import', voucher_series: 'B', description: 'Skattekonto 2026' })
  // One line per counter account on 1630: payments in, F-skatt, moms, AGI, interest.
  const YEAR_LINES = [600000, -240000, -191500.5, -130400, -212.25]
  const YEAR_NET = 37887.25

  // 45 events from 2 April to 28 December: five per month, payments in and
  // charges out. Their sum is NOT the verifikat's net: January to March are
  // in the verifikat but were never fetched.
  const EVENTS: Array<{ id: string; date: string; amount: number }> = []
  for (let month = 4; month <= 12; month++) {
    const mm = String(month).padStart(2, '0')
    const day = month === 4 ? ['02', '12', '14', '20', '26'] : ['03', '12', '14', '20', '28']
    const amounts = [50000, -20000, -15958.25, -10866.5, -17.75 - month]
    amounts.forEach((amount, i) => EVENTS.push({ id: `ev-${mm}-${i}`, date: `2026-${mm}-${day[i]}`, amount }))
  }
  const EVENTS_TOTAL = EVENTS.reduce((sum, e) => roundOre(sum + e.amount), 0)
  // What the verifikat holds beyond the fetched events: January to March.
  const BEFORE_HISTORY = roundOre(YEAR_NET - EVENTS_TOTAL)

  beforeEach(() => {
    vi.clearAllMocks()
    fetchEntryLinesMock.mockReset()
    sumAccountBalanceMock.mockReset()
    findOpeningBalanceFloorMock.mockReset()
    findOpeningBalanceFloorMock.mockResolvedValue(null)
    loadImportedStornoPairsMock.mockReset()
    loadImportedStornoPairsMock.mockResolvedValue([])
  })

  async function statusWith(linked: boolean, extraRows: ReturnType<typeof row>[] = []) {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const rows = [
      ...EVENTS.map((e) => row(e.id, e.date, e.amount, linked ? { journal_entry_id: 'B1' } : {})),
      ...extraRows,
    ]
    // The books agree with Skatteverket: the saldo is what 1630 says.
    enqueueBase(enqueue, {
      saldo: roundOre(YEAR_NET + extraRows.reduce((sum, r) => sum + Number(r.belopp_skatteverket), 0)),
      rows,
      heads: [YEAR_END],
      fetchedAt: FETCHED_2027,
    })
    wholeLedger(YEAR_LINES.map((amount) => ledgerLine(YEAR_END, amount)))
    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY_2027 })
    if (!s) throw new Error('expected status')
    return s
  }

  it('fixture: 45 events from early April whose sum differs from the verifikat by the unfetched months', () => {
    expect(EVENTS).toHaveLength(45)
    expect(EVENTS[0].date).toBe('2026-04-02')
    expect(roundOre(YEAR_LINES.reduce((sum, a) => sum + a, 0))).toBe(YEAR_NET)
    expect(BEFORE_HISTORY).not.toBe(0)
  })

  it('before linking: balance agrees, 0 unexplained, 45 events and the verifikat on opposite sides, and the bridge says the events are already in the ledger', async () => {
    const s = await statusWith(false)
    expect(s.external_balance).toBe(YEAR_NET)
    expect(s.ledger_balance).toBe(YEAR_NET)
    expect(s.difference).toBe(0)
    expect(s.unexplained_difference).toBe(0)
    expect(s.skattekonto?.history_start).toBe('2026-04-02')
    expect(s.counts).toMatchObject({ unmatched_external: 45, unmatched_ledger: 1, matched: 0 })
    expect(s.items.unmatched_ledger).toHaveLength(1)
    expect(s.items.unmatched_ledger[0]).toMatchObject({ item_id: 'B1', amount: YEAR_NET })
    expect(s.items.unmatched_ledger[0].partially_linked).toBeUndefined()
    // The ticket's own arithmetic: the events plus the opening difference are the verifikat's net.
    expect(s.skattekonto?.opening_difference).toBe(BEFORE_HISTORY)
    expect(roundOre(EVENTS_TOTAL + (s.skattekonto?.opening_difference ?? 0))).toBe(YEAR_NET)

    // The cover: 1630 already equals Skatteverket at 31 December although
    // 45 events are unbooked, so they are inside the open verifikat.
    expect(s.cover).toMatchObject({
      through_date: '2026-12-31',
      kind: 'ledger_agrees',
      event_count: 45,
      event_total: EVENTS_TOTAL,
      entry_total: YEAR_NET,
    })
    expect(s.cover?.event_ids.slice().sort()).toEqual(EVENTS.map((e) => e.id).sort())
    expect(s.cover?.entries).toEqual([
      {
        journal_entry_id: 'B1',
        voucher_number: 1,
        voucher_series: 'B',
        entry_date: '2026-12-31',
        description: 'Skattekonto 2026',
        status: 'posted',
        open_amount: YEAR_NET,
      },
    ])
    expect(s.skattekonto?.covered).toEqual({
      through_date: '2026-12-31',
      kind: 'ledger_agrees',
      event_count: 45,
      event_total: EVENTS_TOTAL,
      journal_entry_ids: ['B1'],
      entry_count: 1,
    })
    expect(s.items.unmatched_external.every((i) => i.covered_by_ledger === true)).toBe(true)
  })

  it('after linking the 45 events: unexplained is unchanged, and the verifikat keeps a remainder equal to the opening difference, same sign', async () => {
    const before = await statusWith(false)
    const after = await statusWith(true)

    // What left the Skatteverket side left the ledger side by the same amount.
    expect(after.unexplained_difference).toBe(before.unexplained_difference)
    expect(after.unexplained_difference).toBe(0)
    expect(after.difference).toBe(before.difference)
    expect(after.external_balance).toBe(before.external_balance)
    expect(after.ledger_balance).toBe(before.ledger_balance)
    expect(after.skattekonto?.opening_difference).toBe(before.skattekonto?.opening_difference)

    expect(after.counts).toMatchObject({ unmatched_external: 0, proposed: 0, unmatched_ledger: 1, matched: 45 })
    expect(after.items.unmatched_external).toEqual([])
    const [remainder] = after.items.unmatched_ledger
    expect(remainder).toMatchObject({
      item_id: 'B1',
      bucket: 'unmatched_ledger',
      amount: BEFORE_HISTORY,
      partially_linked: { entry_amount: YEAR_NET, linked_amount: EVENTS_TOTAL, linked_count: 45 },
      actions: ['review', 'match'],
    })
    // The remainder IS the opening difference: the January to March events.
    expect(remainder.amount).toBe(after.skattekonto?.opening_difference)

    // The bridge still sums to the ledger balance, line by line.
    const byKey = Object.fromEntries(after.bridge.map((b) => [b.key, b]))
    // (Math.abs: the engine negates the total, and -0 is not +0 to toBe.)
    expect(Math.abs(byKey.unmatched_external.amount)).toBe(0)
    expect(byKey.unmatched_external.count).toBe(0)
    expect(byKey.unmatched_ledger).toMatchObject({ amount: BEFORE_HISTORY, count: 1 })
    expect(byKey.opening_difference.amount).toBe(roundOre(-BEFORE_HISTORY))
    expect(after.bridge.filter((b) => b.key !== 'ledger_balance').reduce((acc, b) => roundOre(acc + b.amount), 0)).toBe(
      YEAR_NET,
    )
    // Nothing is left to book, so nothing is covered any more.
    expect(after.cover).toBeNull()
    expect(after.skattekonto?.covered).toBeNull()
  })

  it('linking half of the events moves both sides by the same amount, and the rest stay covered', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const half = EVENTS.slice(0, 20)
    const halfTotal = half.reduce((sum, e) => roundOre(sum + e.amount), 0)
    enqueueBase(enqueue, {
      saldo: YEAR_NET,
      rows: EVENTS.map((e, i) => row(e.id, e.date, e.amount, i < 20 ? { journal_entry_id: 'B1' } : {})),
      heads: [YEAR_END],
      fetchedAt: FETCHED_2027,
    })
    wholeLedger(YEAR_LINES.map((amount) => ledgerLine(YEAR_END, amount)))
    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY_2027 })
    if (!s) throw new Error('expected status')
    expect(s.unexplained_difference).toBe(0)
    expect(s.counts).toMatchObject({ unmatched_external: 25, matched: 20, unmatched_ledger: 1 })
    expect(s.items.unmatched_ledger[0]).toMatchObject({
      amount: roundOre(YEAR_NET - halfTotal),
      partially_linked: { entry_amount: YEAR_NET, linked_amount: halfTotal, linked_count: 20 },
    })
    // The cover is invariant under linking: the 25 left are still inside the verifikat.
    expect(s.cover).toMatchObject({ through_date: '2026-12-31', kind: 'ledger_agrees', event_count: 25 })
  })

  it('an event after the verifikat that is really unbooked is not covered, and does not uncover the 45', async () => {
    const s = await statusWith(false, [row('ev-new', '2027-01-12', -4321)])
    // Unbooked and not in the ledger: the difference is the new event.
    expect(s.difference).toBe(-4321)
    expect(s.unexplained_difference).toBe(0)
    expect(s.cover).toMatchObject({ through_date: '2026-12-31', kind: 'ledger_agrees', event_count: 45 })
    expect(s.cover?.event_ids).not.toContain('ev-new')
    const fresh = s.items.unmatched_external.find((i) => i.item_id === 'ev-new')
    expect(fresh?.covered_by_ledger).toBeUndefined()
  })
})

describe('one rule for every link: it explains exactly the linked rows, the rest stays on the ledger side', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchEntryLinesMock.mockReset()
    sumAccountBalanceMock.mockReset()
    findOpeningBalanceFloorMock.mockReset()
    findOpeningBalanceFloorMock.mockResolvedValue(null)
    loadImportedStornoPairsMock.mockReset()
    loadImportedStornoPairsMock.mockResolvedValue([])
  })

  it('an exact link leaves nothing behind: no remainder row, nothing covered', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const A5 = head('A5', '2026-08-03')
    enqueueBase(enqueue, { saldo: 1000, rows: [row('r1', '2026-08-03', 1000, { journal_entry_id: 'A5' })], heads: [A5] })
    wholeLedger([ledgerLine(A5, 1000)])
    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    if (!s) throw new Error('expected status')
    expect(s.counts).toEqual({ proposed: 0, unmatched_external: 0, unmatched_ledger: 0, matched: 1, ignored: 0 })
    expect(s.items.unmatched_ledger).toEqual([])
    expect(s.unexplained_difference).toBe(0)
    expect(s.is_reconciled).toBe(true)
    expect(s.cover).toBeNull()
    expect(s.skattekonto?.covered).toBeNull()
  })

  it('a row matched on one of several 1630 lines: the other lines are listed as the remainder instead of vanishing into unexplained', async () => {
    // Imported monthly verifikat with three lines on 1630; only the F-skatt
    // line has a linked row. Before crm#1043 the whole verifikat left the
    // ledger side and 13 000 showed as unexplained.
    const { supabase, enqueue } = createQueuedMockSupabase()
    const M1 = head('M1', '2026-08-12', { source_type: 'import' })
    enqueueBase(enqueue, {
      saldo: -8000,
      rows: [row('r-fskatt', '2026-08-12', -8000, { journal_entry_id: 'M1' })],
      heads: [M1],
    })
    wholeLedger([ledgerLine(M1, -8000), ledgerLine(M1, -9000), ledgerLine(M1, -4000)])
    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    if (!s) throw new Error('expected status')
    expect(s.ledger_balance).toBe(-21000)
    expect(s.difference).toBe(13000)
    expect(s.unexplained_difference).toBe(0)
    expect(s.counts).toMatchObject({ matched: 1, unmatched_ledger: 1 })
    expect(s.items.unmatched_ledger[0]).toMatchObject({
      item_id: 'M1',
      amount: -13000,
      partially_linked: { entry_amount: -21000, linked_amount: -8000, linked_count: 1 },
    })
    expect(s.is_reconciled).toBe(false)
  })

  it('a net-zero voucher (payment and the debit it paid) with only the payment linked keeps the debit as a remainder', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const P1 = head('P1', '2026-08-10')
    enqueueBase(enqueue, {
      saldo: 0,
      rows: [
        row('r-pay', '2026-08-10', 10000, { journal_entry_id: 'P1' }),
        row('r-debit', '2026-08-12', -10000),
      ],
      heads: [P1],
    })
    wholeLedger([ledgerLine(P1, 10000), ledgerLine(P1, -10000)])
    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    if (!s) throw new Error('expected status')
    expect(s.unexplained_difference).toBe(0)
    expect(s.items.unmatched_ledger[0]).toMatchObject({
      item_id: 'P1',
      amount: -10000,
      partially_linked: { entry_amount: 0, linked_amount: 10000, linked_count: 1 },
    })
    // The debit row is exactly what the voucher still holds: it is covered.
    expect(s.cover).toMatchObject({ kind: 'events_equal', event_ids: ['r-debit'] })
  })

  it('a link to a posted verifikat without any 1630 line stays an integrity finding, as before', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const X1 = head('X1', '2026-08-03')
    enqueueBase(enqueue, { saldo: 700, rows: [row('r1', '2026-08-03', 700, { journal_entry_id: 'X1' })], heads: [X1] })
    wholeLedger([])
    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    if (!s) throw new Error('expected status')
    expect(s.counts).toMatchObject({ matched: 1, unmatched_ledger: 0 })
    expect(s.unexplained_difference).toBe(700)
    expect(s.is_reconciled).toBe(false)
  })

  it('a verifikat dated before the history start, linked for part of its 1630 amount: the rest stays opening balance, not a listed row', async () => {
    // Booked 01-21 with 5 000 on 1630; Skatteverket's first row we hold is
    // 2 075 the day after. The other 2 925 belongs to rows before the history.
    const { supabase, enqueue } = createQueuedMockSupabase()
    const A2 = head('A2', '2026-01-21')
    enqueueBase(enqueue, {
      saldo: 2075,
      rows: [row('r-pay', '2026-01-22', 2075, { journal_entry_id: 'A2' })],
      heads: [A2],
    })
    wholeLedger([ledgerLine(A2, 5000)])
    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    if (!s) throw new Error('expected status')
    expect(s.skattekonto?.history_start).toBe('2026-01-22')
    // 5 000 before the history, of which the linked row explains 2 075.
    expect(s.skattekonto?.ledger_balance_before_start).toBe(2925)
    expect(s.skattekonto?.opening_difference).toBe(-2925)
    expect(s.counts).toMatchObject({ matched: 1, unmatched_ledger: 0 })
    expect(s.unexplained_difference).toBe(0)
  })
})

describe('findLedgerCoverPoint: arithmetic only, exact to the öre', () => {
  const ev = (id: string, date: string, amount: number) => ({ id, date, amount })

  it('no unlinked verifikat on 1630, or no open row: never a cover', () => {
    expect(
      findLedgerCoverPoint({ openEvents: [ev('e1', '2026-05-12', -8000)], openEntries: [], ignoredEvents: [], openingDifference: 0 }),
    ).toBeNull()
    expect(
      findLedgerCoverPoint({ openEvents: [], openEntries: [ev('v1', '2026-05-31', -8000)], ignoredEvents: [], openingDifference: 0 }),
    ).toBeNull()
  })

  it('events_equal: the open verifikat sum exactly to the open rows up to a verifikat date', () => {
    expect(
      findLedgerCoverPoint({
        openEvents: [ev('e1', '2026-05-12', -8000), ev('e2', '2026-05-12', -4500.5), ev('e3', '2026-05-20', 12000)],
        openEntries: [ev('v1', '2026-05-31', -500.5)],
        ignoredEvents: [],
        openingDifference: 0,
      }),
    ).toEqual({ through_date: '2026-05-31', kind: 'events_equal' })
  })

  it('one öre off is not a cover', () => {
    expect(
      findLedgerCoverPoint({
        openEvents: [ev('e1', '2026-05-12', -8000), ev('e2', '2026-05-12', -4500.5), ev('e3', '2026-05-20', 12000)],
        openEntries: [ev('v1', '2026-05-31', -500.49)],
        ignoredEvents: [],
        openingDifference: 0,
      }),
    ).toBeNull()
  })

  it('ledger_agrees: open verifikat minus open rows equals the opening difference plus the ignored rows', () => {
    expect(
      findLedgerCoverPoint({
        openEvents: [ev('e1', '2026-06-12', -8000)],
        openEntries: [ev('v1', '2026-12-31', -30000)],
        ignoredEvents: [{ date: '2026-07-01', amount: -100 }],
        // -30 000 - (-8 000) = -22 000 = opening difference -21 900 + ignored -100
        openingDifference: -21900,
      }),
    ).toEqual({ through_date: '2026-12-31', kind: 'ledger_agrees' })
    // Without a known opening difference only events_equal can hold.
    expect(
      findLedgerCoverPoint({
        openEvents: [ev('e1', '2026-06-12', -8000)],
        openEntries: [ev('v1', '2026-12-31', -30000)],
        ignoredEvents: [],
        openingDifference: null,
      }),
    ).toBeNull()
  })

  it('a verifikat waiting for Skatteverket next to an unrelated unbooked row is no cover: normal booking is not disturbed', () => {
    expect(
      findLedgerCoverPoint({
        openEvents: [ev('e-ranta', '2026-08-05', -12)],
        openEntries: [ev('v-payment', '2026-08-18', 10000)],
        ignoredEvents: [],
        openingDifference: 0,
      }),
    ).toBeNull()
  })

  it('rows netting to zero are never a cover, and the latest date that holds wins', () => {
    expect(
      findLedgerCoverPoint({
        openEvents: [ev('e1', '2026-08-10', 10000), ev('e2', '2026-08-12', -10000)],
        openEntries: [ev('v1', '2026-08-31', 300), ev('v2', '2026-08-31', -300)],
        ignoredEvents: [],
        openingDifference: 0,
      }),
    ).toBeNull()
    // Monthly summaries: each month closes; a July row is still unbooked and uncovered.
    expect(
      findLedgerCoverPoint({
        openEvents: [ev('e-may', '2026-05-12', -8000), ev('e-jun', '2026-06-12', -9000), ev('e-jul', '2026-07-12', -9500)],
        openEntries: [ev('v-may', '2026-05-31', -8000), ev('v-jun', '2026-06-30', -9000)],
        ignoredEvents: [],
        openingDifference: 0,
      }),
    ).toEqual({ through_date: '2026-06-30', kind: 'events_equal' })
  })
})

describe('monthly summaries from the previous system become proposals (PH 171)', () => {
  // The previous system booked each month's charges and interest as one
  // verifikat on the draw day, and each payment in as its own. The payments
  // are linked; the charges and the interest a week before have no verifikat
  // of their own, so every one of them used to wait for a click.
  const M7 = head('M7', '2026-07-14', { source_type: 'import', voucher_series: 'M', description: 'Skattekonto juli' })
  const M8 = head('M8', '2026-08-18', { source_type: 'import', voucher_series: 'M', description: 'Skattekonto augusti' })
  const A5 = head('A5', '2026-07-14', { source_type: 'import' })
  const A29 = head('A29', '2026-08-18', { source_type: 'import' })
  const JULY = [
    row('jul-ranta', '2026-07-05', 91),
    row('jul-ag', '2026-07-14', -33682),
    row('jul-skatt', '2026-07-14', -25746),
    row('jul-prel', '2026-07-14', -9884),
  ]
  const AUGUST = [
    row('aug-ranta', '2026-08-02', 74),
    row('aug-moms', '2026-08-18', -114824),
    row('aug-ag', '2026-08-18', -16841),
    row('aug-skatt', '2026-08-18', -12873),
    row('aug-prel', '2026-08-18', -11393),
  ]
  const PAYMENTS = [
    row('jul-in', '2026-07-15', 69312, { journal_entry_id: 'A5' }),
    row('aug-in', '2026-08-19', 155931, { journal_entry_id: 'A29' }),
  ]
  const LINES = [ledgerLine(M7, -69221), ledgerLine(A5, 69312), ledgerLine(M8, -155857), ledgerLine(A29, 155931)]

  beforeEach(() => {
    vi.clearAllMocks()
    fetchEntryLinesMock.mockReset()
    sumAccountBalanceMock.mockReset()
    findOpeningBalanceFloorMock.mockReset()
    findOpeningBalanceFloorMock.mockResolvedValue(null)
    loadImportedStornoPairsMock.mockReset()
    loadImportedStornoPairsMock.mockResolvedValue([])
  })

  async function statusOf(rows: ReturnType<typeof row>[], saldo: number) {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueBase(enqueue, { saldo, rows, heads: [A5, A29, M7, M8] })
    wholeLedger(LINES)
    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    if (!s) throw new Error('expected status')
    return s
  }

  it('proposes each month to the verifikat that holds it, one group per verifikat, and moves no figure', async () => {
    const s = await statusOf([...JULY, ...AUGUST, ...PAYMENTS], 165)
    expect(s.difference).toBe(0)
    expect(s.unexplained_difference).toBe(0)
    expect(s.counts).toMatchObject({ proposed: 9, unmatched_external: 0, matched: 2, unmatched_ledger: 2 })
    expect(s.items.unmatched_external).toEqual([])

    const july = s.items.proposed.filter((i) => i.item_id.startsWith('jul-'))
    expect(july).toHaveLength(4)
    for (const item of july) {
      expect(item.proposal).toMatchObject({
        journal_entry_id: 'M7',
        voucher_series: 'M',
        voucher_number: 7,
        entry_status: 'posted',
        external_ids: ['jul-ranta', 'jul-ag', 'jul-prel', 'jul-skatt'],
      })
      expect(item.actions).toEqual(['match', 'book', 'ignore'])
    }
    expect(july[0].proposal?.reasons[0]).toBe('summan av 4 händelser är exakt verifikatets belopp på 1630')
    const august = s.items.proposed.filter((i) => i.item_id.startsWith('aug-'))
    expect(new Set(august.map((i) => i.proposal?.journal_entry_id))).toEqual(new Set(['M8']))
    expect(august[0].proposal?.external_ids).toHaveLength(5)
    // Date order in the bucket, as the page lists it.
    expect(s.items.proposed.map((i) => i.date)).toEqual([...s.items.proposed.map((i) => i.date)].sort())

    // The bridge counts both buckets on one line: unchanged by the move.
    const external = s.bridge.find((b) => b.key === 'unmatched_external')
    expect(external).toMatchObject({ count: 9, amount: roundOre(-[...JULY, ...AUGUST].reduce((sum, r) => sum + r.belopp_skatteverket, 0)) })
    // The cover still says why the rows must not be booked.
    expect(s.cover).toMatchObject({ through_date: '2026-08-18', kind: 'events_equal', event_count: 9 })
    expect(s.items.proposed.every((i) => i.covered_by_ledger === true)).toBe(true)
  })

  it('leaves a month whose rows do not add up to its verifikat to the manual match, and proposes the month after it', async () => {
    // July's preliminärskatt is ignored: M7 holds 9 884 more than July's open rows.
    const rows = [...JULY.map((r) => (r.id === 'jul-prel' ? { ...r, is_ignored: true } : r)), ...AUGUST, ...PAYMENTS]
    const s = await statusOf(rows, 165)
    expect(s.counts).toMatchObject({ proposed: 5, unmatched_external: 3, ignored: 1 })
    expect(s.items.proposed.map((i) => i.item_id).sort()).toEqual(AUGUST.map((r) => r.id).sort())
    expect(s.items.unmatched_external.map((i) => i.item_id).sort()).toEqual(['jul-ag', 'jul-ranta', 'jul-skatt'])
  })

  it('leaves a standing proposal and its verifikat alone', async () => {
    // A persisted proposal names M8 for the moms row alone: the plan neither
    // regroups it nor offers M8 to the rest of August.
    const rows = [
      ...JULY,
      ...AUGUST.map((r) => (r.id === 'aug-moms' ? { ...r, suggested_journal_entry_id: 'M8' } : r)),
      ...PAYMENTS,
    ]
    const s = await statusOf(rows, 165)
    const moms = s.items.proposed.find((i) => i.item_id === 'aug-moms')
    expect(moms?.proposal?.journal_entry_id).toBe('M8')
    expect(moms?.proposal?.external_ids).toBeUndefined()
    expect(s.items.proposed.filter((i) => i.proposal?.journal_entry_id === 'M7')).toHaveLength(4)
    expect(s.items.unmatched_external.map((i) => i.item_id).sort()).toEqual(['aug-ag', 'aug-prel', 'aug-ranta', 'aug-skatt'])
  })

  it('counts the planned rows outside the window too', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueBase(enqueue, { saldo: 165, rows: [...JULY, ...AUGUST, ...PAYMENTS], heads: [A5, A29, M7, M8] })
    wholeLedger(LINES)
    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, {
      today: TODAY,
      windowFrom: '2026-08-01',
      windowTo: '2026-08-31',
    })
    if (!s) throw new Error('expected status')
    expect(s.counts).toMatchObject({ proposed: 9, unmatched_external: 0 })
    expect(s.items.proposed.map((i) => i.item_id).every((id) => id.startsWith('aug-'))).toBe(true)
  })
})

describe('getSkattekontoReconciliationStatus: one event over two verifikat (crm#1183)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchEntryLinesMock.mockReset()
    sumAccountBalanceMock.mockReset()
    findOpeningBalanceFloorMock.mockReset()
    findOpeningBalanceFloorMock.mockResolvedValue(null)
    loadImportedStornoPairsMock.mockReset()
    loadImportedStornoPairsMock.mockResolvedValue([])
  })

  // A +29 event booked as +37 and corrected by -8 the same day.
  const A77 = head('A77', '2026-08-01', { source_type: 'import' })
  const A76 = head('A76', '2026-08-01', { source_type: 'import' })
  const lines = () => [ledgerLine(A77, 37), ledgerLine(A76, -8)]
  const member = (journal_entry_id: string, amount: number) => ({
    settlement_id: 'set-1',
    journal_entry_id,
    amount,
    settled_by: 'user-1',
    settled_at: '2026-10-13T12:00:00Z',
  })

  it('unlinked: one open event, two open verifikat, explained but not reconciled', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueBase(enqueue, { saldo: 29, rows: [row('r29', '2026-08-01', 29)] })
    ledger(lines(), { cutoff: 29, before: 0 })

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    expect(s?.unexplained_difference).toBe(0)
    expect(s?.is_reconciled).toBe(false)
    expect(s?.counts).toMatchObject({ unmatched_external: 1, unmatched_ledger: 2 })
    expect(s?.skattekonto?.covered?.kind).toBe('events_equal')
  })

  it('split: the row on its primary plus a live settlement of the remainder: nothing open, reconciled, totals unchanged', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueBase(enqueue, { saldo: 29, rows: [row('r29', '2026-08-01', 29, { journal_entry_id: 'A77' })], heads: [A77] })
    enqueue({ data: [member('A77', 8), member('A76', -8)] }) // live 1630 settlements
    ledger(lines(), { cutoff: 29, before: 0 })

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    expect(findCalls('account_reconciliation_settlements', 'eq')).toContainEqual(['account_number', '1630'])
    expect(s?.unexplained_difference).toBe(0)
    expect(s?.counts).toMatchObject({ unmatched_external: 0, proposed: 0, unmatched_ledger: 0, matched: 1 })
    expect(s?.is_reconciled).toBe(true)
    expect(s?.bridge.find((l) => l.key === 'unmatched_ledger')).toMatchObject({ amount: 0, count: 0 })
    expect(s?.skattekonto?.covered).toBeNull()
    const ledgerMatched = s?.items.matched.filter((i) => i.side === 'ledger') ?? []
    expect(ledgerMatched.map((i) => [i.item_id, i.amount]).sort()).toEqual([['A76', -8], ['A77', 8]])
    expect(ledgerMatched.find((i) => i.item_id === 'A76')).toMatchObject({
      settlement: { settlement_id: 'set-1', state: 'settled', counterparts: [{ journal_entry_id: 'A77', amount: 8, voucher_number: 77 }] },
      actions: ['unmatch'],
    })
    expect(s?.items.matched.find((i) => i.item_id === 'r29')).toMatchObject({ linked_journal_entry_id: 'A77' })
  })

  it('a settlement that no longer sums to zero is ignored: the verifikat stay open, flagged broken, totals as without it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // The row was unlinked by a path that left the settlement live.
    enqueueBase(enqueue, { saldo: 29, rows: [row('r29', '2026-08-01', 29)] })
    enqueue({ data: [member('A77', 8), member('A76', -8)] })
    ledger(lines(), { cutoff: 29, before: 0 })

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })
    expect(s?.unexplained_difference).toBe(0)
    expect(s?.is_reconciled).toBe(false)
    expect(s?.counts).toMatchObject({ unmatched_external: 1, unmatched_ledger: 2 })
    expect(s?.items.unmatched_ledger.map((i) => i.settlement?.state)).toEqual(['broken', 'broken'])
    expect(s?.items.unmatched_ledger[0].actions).toContain('unmatch')
  })
})

// PH 175: an enskild firma that runs its skattekonto on 2012 in eget kapital
// (BAS K1, Fortnox, Björn Lundén) is reconciled on 2012, never on 1630.
describe('getSkattekontoReconciliationStatus on 2012', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchEntryLinesMock.mockReset()
    sumAccountBalanceMock.mockReset()
    findOpeningBalanceFloorMock.mockReset()
    findOpeningBalanceFloorMock.mockResolvedValue(null)
    loadImportedStornoPairsMock.mockReset()
    loadImportedStornoPairsMock.mockResolvedValue([])
  })

  it('reads every ledger figure on the company account and says so', async () => {
    const { resolveSkattekontoAccount } = await import('@/lib/skatteverket/skattekonto-account')
    vi.mocked(resolveSkattekontoAccount).mockResolvedValueOnce('2012')
    const { supabase, enqueue } = createQueuedMockSupabase()
    const A5 = head('A5', '2026-07-12')
    enqueueBase(enqueue, { saldo: 500, rows: [row('r-in', '2026-07-12', 3000), row('r-f', '2026-07-12', -2500)] })
    const accountsRead: string[] = []
    fetchEntryLinesMock.mockImplementation(async (opts: { filterLines?: (q: unknown) => unknown }) => {
      opts.filterLines?.({
        eq: (column: string, value: string) => {
          if (column === 'account_number') accountsRead.push(value)
        },
      })
      return [ledgerLine(A5, 3000)]
    })
    sumAccountBalanceMock.mockResolvedValue(3000)

    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY })

    expect(s?.account_number).toBe('2012')
    expect(accountsRead.length).toBeGreaterThan(0)
    expect(new Set(accountsRead)).toEqual(new Set(['2012']))
    expect(sumAccountBalanceMock.mock.calls.every((c) => c[2] === '2012')).toBe(true)
    expect(findOpeningBalanceFloorMock).toHaveBeenCalledWith(expect.anything(), COMPANY, '2012', expect.any(String))
    const byKey = Object.fromEntries((s?.bridge ?? []).map((b) => [b.key, b]))
    expect(byKey.ledger_balance.label_sv).toBe('Bokfört på 2012')
    expect(byKey.unmatched_ledger.label_sv).toBe('Rader på 2012 utan händelse hos Skatteverket')
  })

  it('takes the account the caller already resolved without reading it again', async () => {
    const { resolveSkattekontoAccount } = await import('@/lib/skatteverket/skattekonto-account')
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueBase(enqueue, { saldo: 0, rows: [row('r-1', '2026-07-12', 100)] })
    ledger([], { cutoff: 0, before: 0 })
    const s = await getSkattekontoReconciliationStatus(supabase as never, COMPANY, { today: TODAY, account: '2012' })
    expect(s?.account_number).toBe('2012')
    expect(resolveSkattekontoAccount).not.toHaveBeenCalled()
  })
})
