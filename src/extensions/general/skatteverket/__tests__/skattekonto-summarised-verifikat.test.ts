/**
 * crm#1043, end to end over the REAL bridge, booking guard and link doors.
 *
 * The fetched Skatteverket history starts mid-year, and the whole year's
 * skattekonto is booked as ONE summarised year-end verifikat dated 31
 * December (one line per counter account against 1630, 1 January to 31
 * December). The books agree with Skatteverket, yet 45 events sit as
 * "missing from the ledger" with an active Bokför, and linking them to the
 * verifikat is refused because the sums differ by the months never fetched.
 *
 * Only the edges are faked: an in-memory database that applies the filters
 * the code sends, the journal engine (no verifikat is really written), and
 * the exact-twin search (covered in skattekonto-match-twins.test.ts; no
 * verifikat here carries any single event). Everything between is the code
 * under test: getSkattekontoReconciliationStatus, matchPairs with the link
 * helpers, bokforSkattekontoTransaction(sBatch), unmatchLink.
 *
 * Every figure is made up.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'

type Row = Record<string, unknown>
type Line = { account_number: string; debit_amount: number; credit_amount: number }

// ── the in-memory database ─────────────────────────────────────────────

const db: Record<string, Row[]> = {}

class FakeQuery {
  private filters: Array<(r: Row) => boolean> = []
  private patch: Row | null = null
  private window: [number, number] | null = null
  constructor(private readonly table: string) {}

  select(): this {
    return this
  }
  update(patch: Row): this {
    this.patch = patch
    return this
  }
  eq(column: string, value: unknown): this {
    this.filters.push((r) => r[column] === value)
    return this
  }
  in(column: string, values: unknown[]): this {
    this.filters.push((r) => values.includes(r[column]))
    return this
  }
  is(column: string, value: unknown): this {
    this.filters.push((r) => (r[column] ?? null) === value)
    return this
  }
  /** Only the rules read uses .or(company or system rule): every seeded rule qualifies. */
  or(): this {
    return this
  }
  order(): this {
    return this
  }
  range(from: number, to: number): this {
    this.window = [from, to]
    return this
  }
  private run(): Row[] {
    const matching = (db[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)))
    if (this.patch) for (const r of matching) Object.assign(r, this.patch)
    return this.window ? matching.slice(this.window[0], this.window[1] + 1) : matching
  }
  maybeSingle() {
    return Promise.resolve({ data: this.run()[0] ?? null, error: null })
  }
  single() {
    const row = this.run()[0]
    return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: 'no rows' } })
  }
  then<T>(resolve: (value: { data: Row[]; error: null }) => T): Promise<T> {
    return Promise.resolve({ data: this.run(), error: null }).then(resolve)
  }
}

const supabase = { from: (table: string) => new FakeQuery(table) } as unknown as SupabaseClient

/** Records the entry filters the code builds, the way PostgREST would apply them. */
function entryFilter(build: (q: unknown) => unknown): (entry: Row) => boolean {
  const tests: Array<(r: Row) => boolean> = []
  const q: Record<string, (column: string, value: unknown) => unknown> = {
    eq: (c, v) => (tests.push((r) => r[c] === v), q),
    in: (c, v) => (tests.push((r) => (v as unknown[]).includes(r[c])), q),
    lt: (c, v) => (tests.push((r) => String(r[c]) < String(v)), q),
    lte: (c, v) => (tests.push((r) => String(r[c]) <= String(v)), q),
    gte: (c, v) => (tests.push((r) => String(r[c]) >= String(v)), q),
  }
  build(q)
  return (entry) => tests.every((t) => t(entry))
}

function linesOn1630(entry: Row): Line[] {
  return ((entry.lines as Line[] | undefined) ?? []).filter((l) => l.account_number === '1630')
}

// ── the faked edges ────────────────────────────────────────────────────

vi.mock('@/lib/bookkeeping/entry-lines', () => ({
  // Every caller in this flow reads the 1630 lines of the entries its filter selects.
  fetchEntryLines: async (opts: { filterEntries: (q: unknown) => unknown }) => {
    const keep = entryFilter(opts.filterEntries)
    return (db.journal_entries ?? [])
      .filter(keep)
      .flatMap((entry) => linesOn1630(entry).map((l) => ({ ...l, journal_entries: entry })))
  },
}))

vi.mock('@/lib/reconciliation/gl-balance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reconciliation/gl-balance')>()
  return {
    ...actual,
    // The huvudbok figure for 1630 over posted + reversed entries, by the date options.
    sumAccountBalance: async (
      _s: unknown,
      _c: unknown,
      _a: unknown,
      o: { cutoffDate?: string; fromDate?: string; beforeDate?: string } = {},
    ) =>
      (db.journal_entries ?? [])
        .filter((e) => ['posted', 'reversed'].includes(String(e.status)))
        .filter((e) => {
          const d = String(e.entry_date)
          return (!o.cutoffDate || d <= o.cutoffDate) && (!o.fromDate || d >= o.fromDate) && (!o.beforeDate || d < o.beforeDate)
        })
        .flatMap(linesOn1630)
        .reduce((sum, l) => roundOre(sum + l.debit_amount - l.credit_amount), 0),
    // No ingående balans on 1630 in this company.
    findOpeningBalanceFloor: async () => null,
  }
})

vi.mock('@/lib/skatteverket/skattekonto-cancelled-entries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/skatteverket/skattekonto-cancelled-entries')>()
  return { ...actual, loadImportedStornoPairs: async () => [] }
})

vi.mock('../lib/skattekonto-match', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/skattekonto-match')>()
  return {
    ...actual,
    // No verifikat carries any single event exactly: that is the ticket.
    findLedgerTwinCandidates: vi.fn(async (_s: unknown, _c: unknown, probes: Array<{ id: string }>) => new Map(probes.map((p) => [p.id, []]))),
    findLedgerTwinCandidatesForIds: vi.fn(async (_s: unknown, _c: unknown, ids: string[]) => new Map(ids.map((id) => [id, []]))),
  }
})

let nextVoucher = 500
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bookkeeping/engine')>()
  return {
    ...actual,
    findFiscalPeriod: vi.fn(async () => 'fp-2027'),
    // The engine is not under test: a booked row lands in the fake ledger as
    // the posted verifikat the real engine would create.
    createDraftEntry: vi.fn(async (_s: unknown, companyId: string, _u: string, input: { entry_date: string; description: string; lines: Line[] }) => {
      const id = `booked-${nextVoucher}`
      db.journal_entries.push({
        id,
        company_id: companyId,
        status: 'posted',
        voucher_number: nextVoucher++,
        voucher_series: 'A',
        entry_date: input.entry_date,
        description: input.description,
        source_type: 'system',
        reverses_id: null,
        reversed_by_id: null,
        lines: input.lines.map((l) => ({ ...l })),
      })
      return { id }
    }),
    commitEntry: vi.fn(async (_s: unknown, _c: string, _u: string, entryId: string) => {
      const entry = db.journal_entries.find((e) => e.id === entryId)
      return { id: entryId, voucher_number: entry?.voucher_number, voucher_series: entry?.voucher_series }
    }),
  }
})

vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: vi.fn(async () => undefined) } }))

import { createDraftEntry, commitEntry } from '@/lib/bookkeeping/engine'
import { getSkattekontoReconciliationStatus } from '@/lib/reconciliation/skattekonto-reconciliation'
import { matchPairs, unmatchLink } from '@/lib/reconciliation/actions'
import {
  bokforSkattekontoTransaction,
  bokforSkattekontoTransactionsBatch,
  SkattekontoBookingError,
} from '../lib/skattekonto-booking'

// ── the fixture ────────────────────────────────────────────────────────

const COMPANY = 'company-1'
const USER = 'user-1'
const TODAY = '2027-01-20'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const YEAR_END_ID = uuid(900)

// One line per counter account against 1630: payments in, F-skatt, moms, AGI, interest.
const YEAR_END_LINES: Line[] = [
  { account_number: '1630', debit_amount: 600000, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 600000 },
  { account_number: '1630', debit_amount: 0, credit_amount: 240000 },
  { account_number: '2510', debit_amount: 240000, credit_amount: 0 },
  { account_number: '1630', debit_amount: 0, credit_amount: 191500.5 },
  { account_number: '2650', debit_amount: 191500.5, credit_amount: 0 },
  { account_number: '1630', debit_amount: 0, credit_amount: 130400 },
  { account_number: '2710', debit_amount: 130400, credit_amount: 0 },
  { account_number: '1630', debit_amount: 0, credit_amount: 212.25 },
  { account_number: '8423', debit_amount: 212.25, credit_amount: 0 },
]
const YEAR_NET = 37887.25

// 45 events, 2 April to 28 December: five a month. January to March are in
// the verifikat but were never fetched.
const EVENTS: Array<{ id: string; date: string; text: string; amount: number }> = []
for (let month = 4; month <= 12; month++) {
  const mm = String(month).padStart(2, '0')
  const days = month === 4 ? ['02', '12', '14', '20', '26'] : ['03', '12', '14', '20', '28']
  const kinds: Array<[string, number]> = [
    ['Inbetalning bokförd', 50000],
    ['Debiterad preliminärskatt', -20000],
    ['Moms', -15958.25],
    ['Arbetsgivaravgift', -10866.5],
    ['Kostnadsränta', -17.75 - month],
  ]
  kinds.forEach(([text, amount], i) =>
    EVENTS.push({ id: uuid(month * 10 + i), date: `2026-${mm}-${days[i]}`, text, amount }),
  )
}
const EVENT_IDS = EVENTS.map((e) => e.id)
const EVENTS_TOTAL = EVENTS.reduce((sum, e) => roundOre(sum + e.amount), 0)
/** What the verifikat holds beyond the fetched events: January to March. */
const BEFORE_HISTORY = roundOre(YEAR_NET - EVENTS_TOTAL)

function skvRow(e: { id: string; date: string; text: string; amount: number }): Row {
  return {
    id: e.id,
    company_id: COMPANY,
    transaktionsdatum: e.date,
    forfallodatum: null,
    transaktionstext: e.text,
    belopp_skatteverket: e.amount,
    status: 'booked',
    journal_entry_id: null,
    suggested_journal_entry_id: null,
    suggested_at: null,
    is_ignored: false,
    transaktionsidentitet: `skv-${e.id.slice(-4)}`,
  }
}

function setSaldo(saldo: number) {
  db.extension_data = [
    {
      company_id: COMPANY,
      extension_id: 'skatteverket',
      key: 'skattekonto_balance_snapshot',
      value: { saldo: { saldoSkatteverket: saldo }, fetchedAt: Date.UTC(2027, 0, 20, 4, 0, 0) },
    },
  ]
}

function seed() {
  for (const key of Object.keys(db)) delete db[key]
  nextVoucher = 500
  // The books agree with Skatteverket: the saldo is what 1630 says.
  setSaldo(YEAR_NET)
  db.skattekonto_transactions = EVENTS.map(skvRow)
  db.journal_entries = [
    {
      id: YEAR_END_ID,
      company_id: COMPANY,
      status: 'posted',
      voucher_number: 1,
      voucher_series: 'B',
      entry_date: '2026-12-31',
      description: 'Skattekonto 2026',
      source_type: 'import',
      reverses_id: null,
      reversed_by_id: null,
      lines: YEAR_END_LINES.map((l) => ({ ...l })),
    },
  ]
  db.company_settings = [{ company_id: COMPANY, entity_type: 'aktiebolag', employer_registered: null, pays_salaries: null }]
  db.skattekonto_rules = [
    {
      id: 'sys-8', company_id: null, priority: 30, pattern: 'kostnadsränta', amount_min: null, amount_max: null,
      company_type: 'all', counter_account: '8423', counter_account_ef: null, label: 'Kostnadsränta skattekonto',
      active: true, requires_employer: false,
    },
    {
      id: 'sys-9', company_id: null, priority: 30, pattern: 'intäktsränta', amount_min: null, amount_max: null,
      company_type: 'all', counter_account: '8314', counter_account_ef: null, label: 'Intäktsränta skattekonto',
      active: true, requires_employer: false,
    },
  ]
}

async function bridge() {
  const status = await getSkattekontoReconciliationStatus(supabase, COMPANY, { today: TODAY })
  if (!status) throw new Error('expected a status')
  return status
}

const linkedCount = () => db.skattekonto_transactions.filter((r) => r.journal_entry_id === YEAR_END_ID).length

describe('the whole year booked as one summarised verifikat (crm#1043)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seed()
  })

  it('1. the ticket as reported: balance agrees, 0 unexplained, 45 events on one side and the verifikat on the other', async () => {
    const s = await bridge()
    expect(EVENTS).toHaveLength(45)
    expect(s.external_balance).toBe(YEAR_NET)
    expect(s.ledger_balance).toBe(YEAR_NET)
    expect(s.difference).toBe(0)
    expect(s.unexplained_difference).toBe(0)
    expect(s.skattekonto?.history_start).toBe('2026-04-02')
    expect(s.counts).toMatchObject({ unmatched_external: 45, unmatched_ledger: 1, matched: 0, proposed: 0 })
    expect(s.items.unmatched_ledger[0]).toMatchObject({ item_id: YEAR_END_ID, amount: YEAR_NET })
    // The bridge explains it exactly: the 45 events plus the opening difference are the verifikat's net on 1630.
    expect(s.skattekonto?.opening_difference).toBe(BEFORE_HISTORY)
    expect(roundOre(EVENTS_TOTAL + BEFORE_HISTORY)).toBe(YEAR_NET)
    // And it now says so: every one of the 45 is already in the ledger.
    expect(s.skattekonto?.covered).toMatchObject({
      through_date: '2026-12-31',
      kind: 'ledger_agrees',
      event_count: 45,
      journal_entry_ids: [YEAR_END_ID],
    })
    expect(s.items.unmatched_external.every((i) => i.covered_by_ledger === true)).toBe(true)
  })

  it('2. "Bokför 45 händelser" books nothing: every row is refused with the verifikat that already holds it', async () => {
    const result = await bokforSkattekontoTransactionsBatch(supabase, COMPANY, USER, EVENT_IDS)

    expect(result.summary).toEqual({ total: 45, succeeded: 0, failed: 45 })
    expect(result.results.every((r) => r.error_code === 'LEDGER_COVER_EXISTS')).toBe(true)
    expect(result.results[0].error_message).toContain('Konto 1630 stämmer redan med Skatteverket per 2026-12-31')
    expect(result.results[0].error_message).toContain('B1 (2026-12-31)')
    expect(result.results[0].error_message).toContain('Koppla händelserna till verifikatet i stället för att bokföra dem en gång till')
    expect(result.results[0].ledger_cover).toMatchObject({ event_count: 45, entry_count: 1 })
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()
    expect(vi.mocked(commitEntry)).not.toHaveBeenCalled()
    // Nothing moved: the ledger and every row are as they were.
    expect(db.journal_entries).toHaveLength(1)
    expect(linkedCount()).toBe(0)
    expect((await bridge()).ledger_balance).toBe(YEAR_NET)
  })

  it('3. the per-row "Bokför" is refused the same way, and only the explicit override books it', async () => {
    const err = await bokforSkattekontoTransaction(supabase, COMPANY, USER, EVENTS[4].id).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SkattekontoBookingError)
    expect((err as SkattekontoBookingError).code).toBe('LEDGER_COVER_EXISTS')
    expect((err as SkattekontoBookingError).ledgerCover?.entries[0].journal_entry_id).toBe(YEAR_END_ID)
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()

    // The override exists, and shows what it does: 1630 no longer agrees.
    const kostnadsranta = EVENTS[4]
    await bokforSkattekontoTransaction(supabase, COMPANY, USER, kostnadsranta.id, undefined, { allowDuplicate: true })
    expect(vi.mocked(createDraftEntry)).toHaveBeenCalledTimes(1)
    const after = await bridge()
    expect(after.ledger_balance).toBe(roundOre(YEAR_NET + kostnadsranta.amount))
    expect(after.difference).toBe(roundOre(-kostnadsranta.amount))
  })

  it('4. linking the 45 events to the verifikat: refused as before without the flag, linked with it, and the bridge stays honest', async () => {
    const before = await bridge()
    const pair = { external_ids: EVENT_IDS, journal_entry_ids: [YEAR_END_ID] }

    // The ticket's refusal, now naming the way through.
    const refused = await matchPairs(supabase, COMPANY, USER, 'skattekonto', { pairs: [pair] })
    expect(refused?.applied).toEqual([])
    expect(refused?.skipped[0]).toMatchObject({ code: 'PAIR_NOT_CLOSED' })
    expect(refused?.skipped[0].message).toContain('Verifikatets rader på 1630 motsvarar inte summan av de valda händelserna.')
    expect(refused?.skipped[0].message).toContain('allow_remainder')
    expect(linkedCount()).toBe(0)

    // The preview shows the remainder before anything is written.
    const preview = await matchPairs(
      supabase,
      COMPANY,
      USER,
      'skattekonto',
      { pairs: [{ ...pair, allow_remainder: true }] },
      { dryRun: true },
    )
    expect(preview?.skipped).toEqual([])
    expect(preview?.applied).toHaveLength(45)
    expect(preview?.applied.every((a) => a.via === 'partial' && a.remainder_amount === BEFORE_HISTORY)).toBe(true)
    expect(linkedCount()).toBe(0)

    // The link itself.
    const linked = await matchPairs(supabase, COMPANY, USER, 'skattekonto', { pairs: [{ ...pair, allow_remainder: true }] })
    expect(linked?.skipped).toEqual([])
    expect(linked?.applied).toHaveLength(45)
    expect(linked?.applied.every((a) => a.via === 'partial' && a.remainder_amount === BEFORE_HISTORY)).toBe(true)
    expect(linkedCount()).toBe(45)
    // Only the rows' pointer changed: the verifikat is untouched and nothing was booked.
    expect(db.journal_entries).toHaveLength(1)
    expect(db.journal_entries[0].lines).toEqual(YEAR_END_LINES)
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()

    const after = await bridge()
    // Unexplained is unchanged: what left the Skatteverket side left the ledger side.
    expect(after.unexplained_difference).toBe(before.unexplained_difference)
    expect(after.unexplained_difference).toBe(0)
    expect(after.difference).toBe(before.difference)
    expect(after.ledger_balance).toBe(before.ledger_balance)
    expect(after.skattekonto?.opening_difference).toBe(before.skattekonto?.opening_difference)
    expect(after.counts).toMatchObject({ unmatched_external: 0, proposed: 0, unmatched_ledger: 1, matched: 45 })
    // The verifikat keeps what the events do not explain, and that is the
    // opening difference, same sign: the months before the fetched history.
    const [remainder] = after.items.unmatched_ledger
    expect(remainder).toMatchObject({
      item_id: YEAR_END_ID,
      amount: BEFORE_HISTORY,
      partially_linked: { entry_amount: YEAR_NET, linked_amount: EVENTS_TOTAL, linked_count: 45 },
    })
    expect(remainder.amount).toBe(after.skattekonto?.opening_difference)
    expect(after.skattekonto?.covered).toBeNull()
    expect(after.items.unmatched_external).toEqual([])
  })

  it('5. after the link, a new event that really is unbooked books exactly as before', async () => {
    await matchPairs(supabase, COMPANY, USER, 'skattekonto', {
      pairs: [{ external_ids: EVENT_IDS, journal_entry_ids: [YEAR_END_ID], allow_remainder: true }],
    })
    // Skatteverket posts an intäktsränta in January: the saldo moves, the ledger has not.
    const fresh = { id: uuid(999), date: '2027-01-12', text: 'Intäktsränta', amount: 12 }
    db.skattekonto_transactions.push(skvRow(fresh))
    setSaldo(roundOre(YEAR_NET + fresh.amount))

    const open = await bridge()
    expect(open.difference).toBe(12)
    expect(open.unexplained_difference).toBe(0)
    expect(open.skattekonto?.covered).toBeNull()
    expect(open.items.unmatched_external.map((i) => [i.item_id, i.covered_by_ledger])).toEqual([[fresh.id, undefined]])

    const result = await bokforSkattekontoTransactionsBatch(supabase, COMPANY, USER, [fresh.id])
    expect(result.summary).toEqual({ total: 1, succeeded: 1, failed: 0 })

    const closed = await bridge()
    expect(closed.difference).toBe(0)
    expect(closed.unexplained_difference).toBe(0)
    expect(closed.counts).toMatchObject({ unmatched_external: 0, matched: 46, unmatched_ledger: 1 })
    expect(closed.items.unmatched_ledger[0].amount).toBe(BEFORE_HISTORY)
  })

  it('6. unlinking restores everything: the bridge is back to the first picture, the cover included', async () => {
    const before = await bridge()
    await matchPairs(supabase, COMPANY, USER, 'skattekonto', {
      pairs: [{ external_ids: EVENT_IDS, journal_entry_ids: [YEAR_END_ID], allow_remainder: true }],
    })
    for (const id of EVENT_IDS) await unmatchLink(supabase, COMPANY, USER, 'skattekonto', id)

    expect(linkedCount()).toBe(0)
    const after = await bridge()
    expect(after.counts).toEqual(before.counts)
    expect(after.bridge).toEqual(before.bridge)
    expect(after.unexplained_difference).toBe(before.unexplained_difference)
    expect(after.skattekonto).toEqual(before.skattekonto)
    expect(after.items.unmatched_ledger).toEqual(before.items.unmatched_ledger)
    expect(after.cover).toEqual(before.cover)
  })

  it('7. linking part of the events first: both sides move together, and the rest are still refused for booking', async () => {
    const first = EVENT_IDS.slice(0, 20)
    const rest = EVENT_IDS.slice(20)
    const firstTotal = EVENTS.slice(0, 20).reduce((sum, e) => roundOre(sum + e.amount), 0)
    const linked = await matchPairs(supabase, COMPANY, USER, 'skattekonto', {
      pairs: [{ external_ids: first, journal_entry_ids: [YEAR_END_ID], allow_remainder: true }],
    })
    expect(linked?.applied).toHaveLength(20)

    const s = await bridge()
    expect(s.unexplained_difference).toBe(0)
    expect(s.counts).toMatchObject({ unmatched_external: 25, matched: 20, unmatched_ledger: 1 })
    expect(s.items.unmatched_ledger[0].amount).toBe(roundOre(YEAR_NET - firstTotal))

    const result = await bokforSkattekontoTransactionsBatch(supabase, COMPANY, USER, rest)
    expect(result.summary).toEqual({ total: 25, succeeded: 0, failed: 25 })
    expect(result.results.every((r) => r.error_code === 'LEDGER_COVER_EXISTS')).toBe(true)

    // The second pair joins the rows already linked: the remainder ends where it should.
    const second = await matchPairs(supabase, COMPANY, USER, 'skattekonto', {
      pairs: [{ external_ids: rest, journal_entry_ids: [YEAR_END_ID], allow_remainder: true }],
    })
    expect(second?.applied).toHaveLength(25)
    expect(second?.applied[0].remainder_amount).toBe(BEFORE_HISTORY)
    expect((await bridge()).items.unmatched_ledger[0].amount).toBe(BEFORE_HISTORY)
  })
})
