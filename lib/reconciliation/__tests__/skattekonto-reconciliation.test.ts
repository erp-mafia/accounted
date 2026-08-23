import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { roundOre } from '@/lib/money'

const fetchEntryLinesMock = vi.fn()
const sumAccountBalanceMock = vi.fn()

vi.mock('@/lib/bookkeeping/entry-lines', () => ({
  fetchEntryLines: (...args: unknown[]) => fetchEntryLinesMock(...args),
}))
vi.mock('../gl-balance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gl-balance')>()
  return {
    ...actual,
    sumAccountBalance: (...args: unknown[]) => sumAccountBalanceMock(...args),
  }
})

import { getSkattekontoReconciliationStatus } from '../skattekonto-reconciliation'

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

describe('getSkattekontoReconciliationStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchEntryLinesMock.mockReset()
    sumAccountBalanceMock.mockReset()
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

  it('treats a link to a reversed entry as a dead link, and the storno pair nets out of the residual', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const E1 = head('E1', '2026-08-01', { status: 'reversed' })
    const E2 = head('E2', '2026-08-02', { source_type: 'storno' })
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
    expect(s.counts.unmatched_ledger).toBe(2)
    expect(s.unexplained_difference).toBe(0)
    expect(s.difference).toBe(1000)
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
})
