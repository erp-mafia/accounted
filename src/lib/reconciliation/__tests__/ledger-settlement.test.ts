/**
 * Verifikat settled against each other on a bank account (crm#1074): the
 * policy (settleLedgerEntries, undoLedgerSettlement), the rule that says when
 * a settlement holds (resolveLedgerSettlements) and the three readers that
 * honour it (the bank status and its bridge, the item listing, the matcher).
 *
 * The real functions run against a small in-memory database that applies the
 * filters it is given, so a date window means what it means in production:
 * the point of several tests is which side of a window edge a verifikat is on.
 * The two candidate RPCs are emulated from the same rows (posted, a line on
 * the account, no bank pointer, no opening balance or storno); their SQL is
 * covered against real Postgres in tests/pg/gl-lines-*.pg.test.ts.
 *
 * The fixture is the shape of the ticket: one verifikat that wrongly credits
 * the bank account, and a rättelse booked by hand the month after, with no
 * bank row for either.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server')
vi.mock('@/lib/transactions/inbox-underlag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/inbox-underlag')>()),
  propagateUnderlagForBookedTransaction: vi.fn(),
}))

import { getReconciliationStatus, runReconciliation } from '../bank-reconciliation'
import { listAccountItems } from '../items'
import { settleLedgerEntries, undoLedgerSettlement } from '../ledger-settlement'
import { resolveLedgerSettlements } from '../ledger-settlement-store'
import { ReconciliationPairSchema } from '../schemas'
import { roundOre } from '@/lib/money'

type Row = Record<string, unknown>
interface Db {
  cash_accounts: Row[]
  journal_entries: Row[]
  journal_entry_lines: Row[]
  transactions: Row[]
  transaction_voucher_links: Row[]
  account_reconciliation_settlements: Row[]
  fiscal_periods: Row[]
}

const COMPANY = '0c000000-0000-4000-8000-000000000001'
const OTHER_COMPANY = '0c000000-0000-4000-8000-000000000002'
const USER = '0d000000-0000-4000-8000-000000000001'
const CASH = '0a000000-0000-4000-8000-000000000001'
const CASH_EUR = '0a000000-0000-4000-8000-000000000002'
const KEY = `bank:${CASH}`
const WRONG = '0e000000-0000-4000-8000-000000000001'
const CORRECTION = '0e000000-0000-4000-8000-000000000002'
const OPEN_ITEM = '0e000000-0000-4000-8000-000000000003'
const BOOKED = '0e000000-0000-4000-8000-000000000004'
const BANK_ROW = '0b000000-0000-4000-8000-000000000001'

const MARCH = { from: '2026-03-01', to: '2026-03-31' }
const APRIL = { from: '2026-04-01', to: '2026-04-30' }
const BOTH = { from: '2026-03-01', to: '2026-04-30' }

let seq = 0
function entry(db: Db, id: string, date: string, amountOn1930: number, extra: Row = {}): void {
  seq += 1
  db.journal_entries.push({
    id,
    company_id: COMPANY,
    status: 'posted',
    source_type: 'manual',
    entry_date: date,
    voucher_series: 'A',
    voucher_number: seq,
    description: `Verifikat ${seq}`,
    ...extra,
  })
  const debit = amountOn1930 > 0 ? amountOn1930 : 0
  const credit = amountOn1930 < 0 ? -amountOn1930 : 0
  db.journal_entry_lines.push(
    { id: `${id}-bank`, journal_entry_id: id, account_number: '1930', debit_amount: debit, credit_amount: credit, currency: 'SEK', amount_in_currency: null },
    { id: `${id}-other`, journal_entry_id: id, account_number: '2440', debit_amount: credit, credit_amount: debit, currency: 'SEK', amount_in_currency: null },
  )
}

/**
 * The ticket, plus two things that have nothing to do with it so the bridge
 * has something to keep still: an unrelated verifikat without a bank row
 * (300,00 in March) and a linked bank row whose verifikat books ten kronor
 * less than the bank shows (the only unexplained amount, in March).
 */
function ticketDb(): Db {
  seq = 0
  const db: Db = {
    cash_accounts: [
      { id: CASH, company_id: COMPANY, ledger_account: '1930', currency: 'SEK', is_primary: true },
      { id: CASH_EUR, company_id: COMPANY, ledger_account: '1932', currency: 'EUR', is_primary: false },
    ],
    journal_entries: [],
    journal_entry_lines: [],
    transactions: [],
    transaction_voucher_links: [],
    account_reconciliation_settlements: [],
    fiscal_periods: [{ company_id: COMPANY, period_start: '2026-01-01' }],
  }
  entry(db, WRONG, '2026-03-18', -1250)
  entry(db, CORRECTION, '2026-04-21', 1250)
  entry(db, OPEN_ITEM, '2026-03-05', 300)
  entry(db, BOOKED, '2026-03-10', 990)
  db.transactions.push({
    id: BANK_ROW,
    company_id: COMPANY,
    date: '2026-03-10',
    description: 'Inbetalning',
    merchant_name: null,
    amount: 1000,
    currency: 'SEK',
    journal_entry_id: BOOKED,
    potential_journal_entry_id: null,
    potential_match_method: null,
    potential_match_confidence: null,
    is_ignored: false,
    is_business: true,
    reconciliation_method: 'manual',
    cash_account_id: CASH,
    reference: null,
  })
  // The bank's history starts before every window below (crm#1221): an
  // ignored row from the year before, outside each window read, so no
  // verifikat here is before the bank's history and every figure is the
  // settlement's alone.
  db.transactions.push({
    ...db.transactions[0],
    id: '0b000000-0000-4000-8000-0000000000ff',
    date: '2025-12-31',
    amount: 1,
    journal_entry_id: null,
    is_ignored: true,
    reconciliation_method: null,
  })
  return db
}

/** What both candidate RPCs return for the rows above: ledger lines no bank row explains. */
function ledgerOnlyLines(db: Db, args: Row): Row[] {
  const out: Row[] = []
  for (const e of db.journal_entries) {
    if (e.company_id !== args.p_company_id || e.status !== 'posted') continue
    if (e.source_type === 'opening_balance' || e.source_type === 'storno') continue
    if (args.p_date_from && (e.entry_date as string) < (args.p_date_from as string)) continue
    if (args.p_date_to && (e.entry_date as string) > (args.p_date_to as string)) continue
    if (db.transactions.some((t) => t.journal_entry_id === e.id && t.company_id === args.p_company_id)) continue
    const lines = db.journal_entry_lines.filter(
      (l) => l.journal_entry_id === e.id && l.account_number === args.p_account_number,
    )
    if (lines.length === 0) continue
    const slices = db.transaction_voucher_links.filter((l) => l.journal_entry_id === e.id)
    let remaining: number | null = null
    if (slices.length > 0) {
      const net = lines.reduce((s, l) => s + Number(l.debit_amount) - Number(l.credit_amount), 0)
      remaining = roundOre(net - slices.reduce((s, l) => s + Number(l.allocated_amount), 0))
      if (Math.abs(remaining) < 0.005) continue
    }
    for (const l of lines) {
      out.push({
        line_id: l.id,
        journal_entry_id: e.id,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        line_description: null,
        entry_date: e.entry_date,
        voucher_number: e.voucher_number,
        voucher_series: e.voucher_series,
        entry_description: e.description,
        source_type: e.source_type,
        remaining_amount: remaining,
        linked_transaction_count: 0,
      })
    }
  }
  return out.sort((a, b) => String(a.entry_date).localeCompare(String(b.entry_date)))
}

/** A supabase-js shaped client over `db`: filters, ranges, inserts and updates really apply. */
function fakeSupabase(db: Db, options: { failTable?: string } = {}) {
  const reads: string[] = []
  class Query implements PromiseLike<{ data: unknown; error: unknown; count: number | null }> {
    private filters: Array<(r: Row) => boolean> = []
    private op: 'select' | 'insert' | 'update' = 'select'
    private payload: Row | Row[] | null = null
    private window: [number, number] | null = null
    private one: 'single' | 'maybe' | null = null
    private sortBy: { column: string; ascending: boolean } | null = null
    constructor(
      private table: string,
      private rows: Row[],
    ) {}
    select() { return this }
    // The first order applies, as the primary key of a real ORDER BY: the
    // bank's history start is the earliest row's date (crm#1221).
    order(column: string, opts?: { ascending?: boolean }) {
      this.sortBy ??= { column, ascending: opts?.ascending !== false }
      return this
    }
    insert(rows: Row | Row[]) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this }
    update(patch: Row) { this.op = 'update'; this.payload = patch; return this }
    eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this }
    neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this }
    is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this }
    not(c: string, _op: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) !== v); return this }
    gte(c: string, v: string) { this.filters.push((r) => String(r[c]) >= v); return this }
    lte(c: string, v: string) { this.filters.push((r) => String(r[c]) <= v); return this }
    gt(c: string, v: string) { this.filters.push((r) => String(r[c]) > v); return this }
    lt(c: string, v: string) { this.filters.push((r) => String(r[c]) < v); return this }
    // Only the cash-account scope uses `or`; one SEK account, so it selects everything.
    or() { return this }
    range(from: number, to: number) { this.window = [from, to]; return this }
    limit(n: number) { this.window = [0, n - 1]; return this }
    single() { this.one = 'single'; return this }
    maybeSingle() { this.one = 'maybe'; return this }
    private run(): { data: unknown; error: unknown; count: number | null } {
      reads.push(this.table)
      if (options.failTable === this.table) return { data: null, error: { message: 'boom' }, count: null }
      if (this.op === 'insert') {
        const incoming = this.payload as Row[]
        if (this.table === 'account_reconciliation_settlements') {
          const clash = incoming.some((n) =>
            this.rows.some(
              (r) =>
                !r.undone_at &&
                r.company_id === n.company_id &&
                r.account_number === n.account_number &&
                r.journal_entry_id === n.journal_entry_id,
            ),
          )
          if (clash) {
            return {
              data: null,
              error: { code: '23505', message: 'duplicate key value violates unique constraint "ux_account_reconciliation_settlements_active"' },
              count: null,
            }
          }
        }
        for (const n of incoming) this.rows.push({ undone_at: null, undone_by: null, settled_at: '2026-10-11T09:00:00Z', ...n })
        return { data: incoming, error: null, count: incoming.length }
      }
      let hit = this.rows.filter((r) => this.filters.every((f) => f(r)))
      if (this.op === 'update') {
        for (const r of hit) Object.assign(r, this.payload)
        return { data: hit, error: null, count: hit.length }
      }
      if (this.sortBy) {
        const { column, ascending } = this.sortBy
        hit = [...hit].sort((a, b) => String(a[column] ?? '').localeCompare(String(b[column] ?? '')) * (ascending ? 1 : -1))
      }
      if (this.window) hit = hit.slice(this.window[0], this.window[1] + 1)
      if (this.one) return { data: hit[0] ?? null, error: null, count: null }
      return { data: hit, error: null, count: hit.length }
    }
    then<A, B>(
      resolve?: ((v: { data: unknown; error: unknown; count: number | null }) => A | PromiseLike<A>) | null,
      reject?: ((reason: unknown) => B | PromiseLike<B>) | null,
    ): PromiseLike<A | B> {
      return Promise.resolve(this.run()).then(resolve, reject)
    }
  }
  const supabase = {
    from: (table: string) => new Query(table, (db as unknown as Record<string, Row[]>)[table] ?? []),
    rpc: (name: string, args: Row) =>
      new Query(
        `rpc:${name}`,
        name === 'get_unlinked_gl_lines' || name === 'get_account_gl_lines_for_matching' ? ledgerOnlyLines(db, args) : [],
      ),
  }
  return { supabase: supabase as never, reads }
}

function settlementRows(db: Db): Row[] {
  return db.account_reconciliation_settlements
}

async function status(db: Db, window: { from: string; to: string }) {
  const { supabase } = fakeSupabase(db)
  return getReconciliationStatus(supabase, COMPANY, window.from, window.to, '1930', 'SEK', CASH, true)
}

async function items(db: Db, window: { from: string; to: string }, bucket?: 'unmatched_ledger' | 'matched') {
  const { supabase } = fakeSupabase(db)
  const result = await listAccountItems(supabase, COMPANY, KEY, { bucket, windowFrom: window.from, windowTo: window.to })
  return result!.items
}

async function settle(db: Db, ids: string[] = [WRONG, CORRECTION], options: { dryRun?: boolean } = {}) {
  const { supabase } = fakeSupabase(db)
  return settleLedgerEntries(supabase, COMPANY, USER, KEY, ids, options)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ReconciliationPairSchema', () => {
  it('accepts verifikat with no outside row only when there are at least two of them', () => {
    expect(ReconciliationPairSchema.safeParse({ journal_entry_ids: [WRONG, CORRECTION] }).success).toBe(true)
    expect(ReconciliationPairSchema.parse({ journal_entry_ids: [WRONG, CORRECTION] }).external_ids).toEqual([])
    expect(ReconciliationPairSchema.safeParse({ external_ids: [], journal_entry_ids: [WRONG, CORRECTION] }).success).toBe(true)

    const single = ReconciliationPairSchema.safeParse({ journal_entry_ids: [WRONG] })
    expect(single.success).toBe(false)
    expect(single.error?.issues[0].path).toEqual(['external_ids'])
    expect(ReconciliationPairSchema.safeParse({ external_ids: [], journal_entry_ids: [WRONG] }).success).toBe(false)
    // The shapes that existed before are untouched.
    expect(ReconciliationPairSchema.safeParse({ external_ids: [BANK_ROW], journal_entry_ids: [WRONG] }).success).toBe(true)
    expect(ReconciliationPairSchema.safeParse({ external_ids: [BANK_ROW], journal_entry_ids: [] }).success).toBe(false)
  })
})

describe('settleLedgerEntries', () => {
  it('settles the wrong verifikat against the rättelse booked a month later, recording who and the amounts', async () => {
    const db = ticketDb()
    const result = await settle(db)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.settlement.account_number).toBe('1930')
    expect(result.settlement.entries).toEqual([
      { journal_entry_id: WRONG, voucher_series: 'A', voucher_number: 1, entry_date: '2026-03-18', amount: -1250 },
      { journal_entry_id: CORRECTION, voucher_series: 'A', voucher_number: 2, entry_date: '2026-04-21', amount: 1250 },
    ])
    const rows = settlementRows(db)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.settlement_id))).toEqual(new Set([result.settlement.settlement_id]))
    expect(rows.map((r) => [r.journal_entry_id, r.amount, r.settled_by, r.account_number, r.company_id])).toEqual([
      [WRONG, -1250, USER, '1930', COMPANY],
      [CORRECTION, 1250, USER, '1930', COMPANY],
    ])
  })

  it('writes nothing to the verifikat or their lines', async () => {
    const db = ticketDb()
    const before = JSON.stringify([db.journal_entries, db.journal_entry_lines, db.transactions])
    await settle(db)
    expect(JSON.stringify([db.journal_entries, db.journal_entry_lines, db.transactions])).toBe(before)
  })

  it('previews without writing on a dry run', async () => {
    const db = ticketDb()
    const result = await settle(db, [WRONG, CORRECTION], { dryRun: true })
    expect(result).toMatchObject({ ok: true, settlement: { settlement_id: null, account_number: '1930' } })
    expect(settlementRows(db)).toHaveLength(0)
  })

  it('settles three verifikat that net to zero together', async () => {
    const db = ticketDb()
    const half = '0e000000-0000-4000-8000-000000000010'
    const otherHalf = '0e000000-0000-4000-8000-000000000011'
    db.journal_entries = db.journal_entries.filter((e) => e.id !== CORRECTION)
    db.journal_entry_lines = db.journal_entry_lines.filter((l) => l.journal_entry_id !== CORRECTION)
    entry(db, half, '2026-04-02', 1000)
    entry(db, otherHalf, '2026-05-02', 250)
    const result = await settle(db, [WRONG, half, otherHalf])
    expect(result.ok).toBe(true)
    expect(settlementRows(db)).toHaveLength(3)
  })

  it('takes a partly allocated verifikat at what its bank slices leave open', async () => {
    const db = ticketDb()
    // A 1:N slice of another bank row already explains 250 of the 1250 the
    // rättelse puts back, so 1000 is what the list shows for it.
    db.transaction_voucher_links.push({ journal_entry_id: CORRECTION, transaction_id: 'other-row', allocated_amount: 250, role: 'bank_line' })
    expect(await settle(db)).toMatchObject({ ok: false, code: 'PAIR_NOT_CLOSED' })

    const rest = '0e000000-0000-4000-8000-000000000012'
    entry(db, rest, '2026-04-22', 250)
    const result = await settle(db, [WRONG, CORRECTION, rest])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.settlement.entries.map((e) => e.amount)).toEqual([-1250, 1000, 250])
  })

  describe('refuses', () => {
    it('fewer than two different verifikat', async () => {
      const db = ticketDb()
      expect(await settle(db, [WRONG])).toMatchObject({ ok: false, code: 'UNSUPPORTED_PAIR_SHAPE' })
      expect(await settle(db, [WRONG, WRONG])).toMatchObject({ ok: false, code: 'UNSUPPORTED_PAIR_SHAPE' })
    })

    it('an account that is not a SEK bank account, or not the company\'s', async () => {
      const db = ticketDb()
      const { supabase } = fakeSupabase(db)
      expect(await settleLedgerEntries(supabase, COMPANY, USER, 'skattekonto', [WRONG, CORRECTION])).toMatchObject({
        ok: false,
        code: 'UNSUPPORTED_PAIR_SHAPE',
      })
      expect(await settleLedgerEntries(supabase, COMPANY, USER, 'manual:1510', [WRONG, CORRECTION])).toMatchObject({
        ok: false,
        code: 'UNSUPPORTED_PAIR_SHAPE',
      })
      const eur = await settleLedgerEntries(supabase, COMPANY, USER, `bank:${CASH_EUR}`, [WRONG, CORRECTION])
      expect(eur).toMatchObject({ ok: false, code: 'UNSUPPORTED_PAIR_SHAPE' })
      if (!eur.ok) expect(eur.message).toMatch(/SEK/)
      expect(
        await settleLedgerEntries(supabase, COMPANY, USER, 'bank:0a000000-0000-4000-8000-0000000000ff', [WRONG, CORRECTION]),
      ).toMatchObject({ ok: false, code: 'NOT_FOUND' })
      expect(settlementRows(db)).toHaveLength(0)
    })

    it('a verifikat that does not exist, or belongs to another company', async () => {
      const db = ticketDb()
      const foreign = '0e000000-0000-4000-8000-0000000000aa'
      entry(db, foreign, '2026-04-21', 1250, { company_id: OTHER_COMPANY })
      expect(await settle(db, [WRONG, '0e000000-0000-4000-8000-0000000000bb'])).toMatchObject({ ok: false, code: 'ENTRY_NOT_FOUND' })
      expect(await settle(db, [WRONG, foreign])).toMatchObject({ ok: false, code: 'ENTRY_NOT_FOUND' })
      expect(settlementRows(db)).toHaveLength(0)
    })

    it('a makulerat verifikat and a draft', async () => {
      const db = ticketDb()
      db.journal_entries.find((e) => e.id === CORRECTION)!.status = 'reversed'
      expect(await settle(db)).toMatchObject({ ok: false, code: 'ENTRY_REVERSED' })
      db.journal_entries.find((e) => e.id === CORRECTION)!.status = 'draft'
      expect(await settle(db)).toMatchObject({ ok: false, code: 'ENTRY_NOT_FOUND' })
    })

    it('a verifikat that already has a bank row', async () => {
      const db = ticketDb()
      // BOOKED is linked to the bank row: it is not something the bank lacks.
      entry(db, '0e000000-0000-4000-8000-000000000020', '2026-03-11', -990)
      const result = await settle(db, [BOOKED, '0e000000-0000-4000-8000-000000000020'])
      expect(result).toMatchObject({ ok: false, code: 'ENTRY_NOT_OPEN' })
      if (!result.ok) expect(result.message).toMatch(/bankrad/)
    })

    it('a verifikat with no line on the account, an opening balance and a storno', async () => {
      const db = ticketDb()
      db.journal_entry_lines = db.journal_entry_lines.filter((l) => l.id !== `${CORRECTION}-bank`)
      expect(await settle(db)).toMatchObject({ ok: false, code: 'ENTRY_NOT_OPEN' })

      for (const sourceType of ['opening_balance', 'storno']) {
        const fresh = ticketDb()
        fresh.journal_entries.find((e) => e.id === CORRECTION)!.source_type = sourceType
        expect(await settle(fresh)).toMatchObject({ ok: false, code: 'ENTRY_NOT_OPEN' })
      }
    })

    it('verifikat that do not net to exactly zero, down to one öre', async () => {
      const db = ticketDb()
      const line = db.journal_entry_lines.find((l) => l.id === `${CORRECTION}-bank`)!
      line.debit_amount = 1249.99
      const result = await settle(db)
      expect(result).toMatchObject({ ok: false, code: 'PAIR_NOT_CLOSED' })
      if (!result.ok) expect(result.message).toMatch(/0,01/)
      // Two unrelated verifikat of different amounts never pair.
      expect(await settle(ticketDb(), [WRONG, OPEN_ITEM])).toMatchObject({ ok: false, code: 'PAIR_NOT_CLOSED' })
      expect(settlementRows(db)).toHaveLength(0)
    })

    it('a verifikat that is already settled, and a lost race on the write', async () => {
      const db = ticketDb()
      expect((await settle(db)).ok).toBe(true)
      const again = await settle(db)
      expect(again).toMatchObject({ ok: false, code: 'ALREADY_SETTLED' })
      expect(settlementRows(db)).toHaveLength(2)

      // Someone else's settlement lands between this caller's checks and its
      // insert: the unique index answers, and nothing is half-written.
      const raced = ticketDb()
      const { supabase } = fakeSupabase(raced)
      const realFrom = (supabase as unknown as { from: (t: string) => { insert: (rows: Row[]) => unknown } }).from
      let injected = false
      ;(supabase as unknown as { from: (t: string) => unknown }).from = (table: string) => {
        const query = realFrom(table)
        if (table === 'account_reconciliation_settlements') {
          const insert = query.insert.bind(query)
          query.insert = (rows: Row[]) => {
            if (!injected) {
              injected = true
              raced.account_reconciliation_settlements.push({
                settlement_id: 'theirs',
                company_id: COMPANY,
                account_number: '1930',
                journal_entry_id: WRONG,
                amount: -1250,
                settled_by: USER,
                undone_at: null,
              })
            }
            return insert(rows)
          }
        }
        return query
      }
      expect(await settleLedgerEntries(supabase, COMPANY, USER, KEY, [WRONG, CORRECTION])).toMatchObject({
        ok: false,
        code: 'LINK_RACE',
      })
      expect(raced.account_reconciliation_settlements).toHaveLength(1)
    })
  })
})

describe('undoLedgerSettlement', () => {
  it('stamps who and when, and the verifikat come back to the ledger-only list', async () => {
    const db = ticketDb()
    const settled = await settle(db)
    if (!settled.ok) throw new Error('fixture')
    expect((await items(db, BOTH, 'unmatched_ledger')).map((i) => i.item_id)).toEqual([OPEN_ITEM])

    const { supabase } = fakeSupabase(db)
    const undone = await undoLedgerSettlement(supabase, COMPANY, USER, KEY, settled.settlement.settlement_id!)
    expect(undone).toEqual({ settlement_id: settled.settlement.settlement_id, journal_entry_ids: [WRONG, CORRECTION] })
    expect(settlementRows(db).every((r) => r.undone_by === USER && typeof r.undone_at === 'string')).toBe(true)

    expect((await items(db, BOTH, 'unmatched_ledger')).map((i) => i.item_id).sort()).toEqual([WRONG, CORRECTION, OPEN_ITEM].sort())
    expect((await status(db, BOTH)).unmatched_gl_line_count).toBe(3)
    // Free to be settled again.
    expect((await settle(db)).ok).toBe(true)
  })

  it('returns null for an id that is no live settlement on the account', async () => {
    const db = ticketDb()
    const settled = await settle(db)
    if (!settled.ok) throw new Error('fixture')
    const { supabase } = fakeSupabase(db)
    expect(await undoLedgerSettlement(supabase, COMPANY, USER, KEY, '0f000000-0000-4000-8000-000000000001')).toBeNull()
    expect(await undoLedgerSettlement(supabase, COMPANY, USER, 'skattekonto', settled.settlement.settlement_id!)).toBeNull()
    expect(await undoLedgerSettlement(supabase, OTHER_COMPANY, USER, KEY, settled.settlement.settlement_id!)).toBeNull()
    await undoLedgerSettlement(supabase, COMPANY, USER, KEY, settled.settlement.settlement_id!)
    // Already undone: nothing left to stamp.
    expect(await undoLedgerSettlement(supabase, COMPANY, USER, KEY, settled.settlement.settlement_id!)).toBeNull()
  })
})

describe('the bank bridge does not move when verifikat are settled', () => {
  const kept = (s: Awaited<ReturnType<typeof getReconciliationStatus>>) => ({
    bank_transaction_total: s.bank_transaction_total,
    gl_1930_balance: s.gl_1930_balance,
    gl_1930_period_movement: s.gl_1930_period_movement,
    difference: s.difference,
    unexplained_difference: s.unexplained_difference,
    is_reconciled: s.is_reconciled,
    matched_count: s.matched_count,
    unmatched_transaction_count: s.unmatched_transaction_count,
    unmatched_transaction_total: s.unmatched_transaction_total,
  })

  it('both verifikat in the window: they leave the list together and every figure stays', async () => {
    const db = ticketDb()
    const before = await status(db, BOTH)
    expect(before.unmatched_gl_line_count).toBe(3)
    expect(before.unmatched_gl_line_total).toBe(300)
    expect(before.unexplained_difference).toBe(10)

    await settle(db)
    const after = await status(db, BOTH)
    expect(kept(after)).toEqual(kept(before))
    expect(after.unmatched_gl_line_count).toBe(1)
    expect(after.unmatched_gl_line_total).toBe(300)
    // They net to zero inside the window, so nothing needs carrying.
    expect(after.settled_gl_entry_count).toBe(0)
    expect(after.settled_gl_line_total).toBe(0)
  })

  it('only the wrong verifikat in the window: it leaves the list and its amount moves to its own line', async () => {
    const db = ticketDb()
    const before = await status(db, MARCH)
    expect(before.unmatched_gl_line_count).toBe(2)
    expect(before.unmatched_gl_line_total).toBe(-950)
    expect(before.difference).toBe(960)
    expect(before.unexplained_difference).toBe(10)

    await settle(db)
    const after = await status(db, MARCH)
    expect(kept(after)).toEqual(kept(before))
    expect(after.unmatched_gl_line_count).toBe(1)
    expect(after.unmatched_gl_line_total).toBe(300)
    expect(after.settled_gl_entry_count).toBe(1)
    expect(after.settled_gl_line_total).toBe(-1250)
    // The identity the bridge is built on, with the new term.
    expect(after.difference - after.unmatched_transaction_total + after.unmatched_gl_line_total! + after.settled_gl_line_total).toBe(
      after.unexplained_difference,
    )
  })

  it('only the rättelse in the window: the same, mirrored', async () => {
    const db = ticketDb()
    const before = await status(db, APRIL)
    expect(before.unmatched_gl_line_count).toBe(1)
    expect(before.unmatched_gl_line_total).toBe(1250)
    expect(before.unexplained_difference).toBe(0)

    await settle(db)
    const after = await status(db, APRIL)
    expect(kept(after)).toEqual(kept(before))
    expect(after.unmatched_gl_line_count).toBe(0)
    expect(after.unmatched_gl_line_total).toBe(0)
    expect(after.settled_gl_entry_count).toBe(1)
    expect(after.settled_gl_line_total).toBe(1250)
  })

  it('a settlement that no longer holds hides nothing: a bank row turns up for the wrong verifikat', async () => {
    const db = ticketDb()
    await settle(db)
    const settledView = await status(db, BOTH)
    expect(settledView.unmatched_gl_line_count).toBe(1)

    // Whatever door links it, the readers notice: the rättelse is a claim the
    // bank does not show again.
    db.transactions.push({ ...db.transactions[0], id: '0b000000-0000-4000-8000-000000000002', date: '2026-03-18', amount: -1250, journal_entry_id: WRONG })
    const broken = await status(db, BOTH)
    expect(broken.unmatched_gl_line_count).toBe(2)
    expect(broken.unmatched_gl_line_total).toBe(1550)
    expect(broken.settled_gl_entry_count).toBe(0)
    expect(broken.settled_gl_line_total).toBe(0)

    const april = await status(db, APRIL)
    expect(april.unmatched_gl_line_count).toBe(1)
    expect(april.settled_gl_entry_count).toBe(0)
  })

  it('a settlement whose amounts no longer net to zero hides nothing either', async () => {
    const db = ticketDb()
    await settle(db)
    // An inline rättelse changes the bank line of one of them.
    db.journal_entry_lines.find((l) => l.id === `${CORRECTION}-bank`)!.debit_amount = 1200
    const after = await status(db, BOTH)
    expect(after.unmatched_gl_line_count).toBe(3)
    expect(after.settled_gl_entry_count).toBe(0)
  })

  it('a makulerat verifikat breaks its settlement: the other one is back in the list', async () => {
    const db = ticketDb()
    await settle(db)
    db.journal_entries.find((e) => e.id === CORRECTION)!.status = 'reversed'
    const march = await status(db, MARCH)
    expect(march.unmatched_gl_line_count).toBe(2)
    expect(march.settled_gl_entry_count).toBe(0)
  })
})

describe('listAccountItems with settled verifikat', () => {
  it('moves them from unmatched_ledger to matched, each naming the other', async () => {
    const db = ticketDb()
    const settled = await settle(db)
    if (!settled.ok) throw new Error('fixture')

    expect((await items(db, BOTH, 'unmatched_ledger')).map((i) => i.item_id)).toEqual([OPEN_ITEM])

    const matched = (await items(db, BOTH, 'matched')).filter((i) => i.side === 'ledger')
    expect(matched.map((i) => i.item_id)).toEqual([WRONG, CORRECTION])
    expect(matched[0]).toMatchObject({
      item_type: 'journal_entry',
      bucket: 'matched',
      amount: -1250,
      date: '2026-03-18',
      actions: ['unmatch'],
      settlement: {
        settlement_id: settled.settlement.settlement_id,
        state: 'settled',
        settled_by: USER,
        counterparts: [{ journal_entry_id: CORRECTION, voucher_series: 'A', voucher_number: 2, entry_date: '2026-04-21', amount: 1250 }],
      },
    })
    // The bank row that was matched all along is still there.
    expect((await items(db, BOTH, 'matched')).filter((i) => i.side === 'external').map((i) => i.item_id)).toEqual([BANK_ROW])
  })

  it('shows the wrong verifikat as matched in its own month, naming the rättelse dated outside it', async () => {
    const db = ticketDb()
    await settle(db)
    expect((await items(db, MARCH, 'unmatched_ledger')).map((i) => i.item_id)).toEqual([OPEN_ITEM])
    const matched = (await items(db, MARCH)).filter((i) => i.side === 'ledger' && i.bucket === 'matched')
    expect(matched.map((i) => i.item_id)).toEqual([WRONG])
    expect(matched[0].settlement?.counterparts).toEqual([
      { journal_entry_id: CORRECTION, voucher_series: 'A', voucher_number: 2, entry_date: '2026-04-21', amount: 1250 },
    ])
    expect(await items(db, APRIL, 'unmatched_ledger')).toEqual([])
  })

  it('keeps a verifikat whose settlement broke in unmatched_ledger, flagged, with the undo among its actions', async () => {
    const db = ticketDb()
    const settled = await settle(db)
    if (!settled.ok) throw new Error('fixture')
    db.transactions.push({ ...db.transactions[0], id: '0b000000-0000-4000-8000-000000000002', date: '2026-03-18', amount: -1250, journal_entry_id: WRONG })

    const ledger = await items(db, BOTH, 'unmatched_ledger')
    const correction = ledger.find((i) => i.item_id === CORRECTION)!
    expect(correction.settlement).toMatchObject({ settlement_id: settled.settlement.settlement_id, state: 'broken' })
    expect(correction.actions).toEqual(['match', 'review', 'unmatch'])
    expect(ledger.find((i) => i.item_id === OPEN_ITEM)!.settlement).toBeUndefined()
    expect((await items(db, BOTH, 'matched')).filter((i) => i.side === 'ledger')).toEqual([])
  })

  it('lists nothing extra, and reads no candidate list, for an account without settlements', async () => {
    const db = ticketDb()
    const { supabase, reads } = fakeSupabase(db)
    const result = await listAccountItems(supabase, COMPANY, KEY, { bucket: 'matched', windowFrom: BOTH.from, windowTo: BOTH.to })
    expect(result!.items.map((i) => i.item_id)).toEqual([BANK_ROW])
    expect(reads.filter((r) => r.startsWith('rpc:'))).toEqual([])
  })
})

describe('the bank matcher leaves settled verifikat alone', () => {
  it('proposes the wrong verifikat for a bank row of the same amount only until it is settled', async () => {
    const db = ticketDb()
    db.transactions.push({ ...db.transactions[0], id: '0b000000-0000-4000-8000-000000000003', date: '2026-03-18', amount: -1250, journal_entry_id: null })
    const run = async () => {
      const { supabase } = fakeSupabase(db)
      const result = await runReconciliation(supabase, COMPANY, USER, {
        dateFrom: MARCH.from,
        dateTo: MARCH.to,
        dryRun: true,
        accountNumber: '1930',
        cashAccountId: CASH,
      })
      return result.matches.map((m) => m.glLine.journal_entry_id)
    }
    expect(await run()).toEqual([WRONG])
    await settle(db)
    expect(await run()).toEqual([])
  })
})

describe('resolveLedgerSettlements', () => {
  const window = new Map<string, number | null>([[WRONG, -1250], [CORRECTION, 1250]])

  it('makes no read for an empty window', async () => {
    const db = ticketDb()
    const { supabase, reads } = fakeSupabase(db)
    const resolved = await resolveLedgerSettlements(supabase, COMPANY, '1930', new Map(), async () => new Map())
    expect(resolved.settled.size).toBe(0)
    expect(reads).toEqual([])
  })

  it('reads the span only when the window cuts a settlement', async () => {
    const db = ticketDb()
    await settle(db)
    const whole = fakeSupabase(db)
    const span = vi.fn(async () => new Map<string, number | null>())
    const both = await resolveLedgerSettlements(whole.supabase, COMPANY, '1930', window, span)
    expect([...both.settled.keys()]).toEqual([WRONG, CORRECTION])
    expect([...both.settled.values()].map((e) => e.outside_window)).toEqual([false, false])
    expect(span).not.toHaveBeenCalled()
    expect(whole.reads).toEqual(['account_reconciliation_settlements'])

    const cut = fakeSupabase(db)
    const spanCut = vi.fn(async () => window)
    const one = await resolveLedgerSettlements(cut.supabase, COMPANY, '1930', new Map([[WRONG, -1250]]), spanCut)
    expect(spanCut).toHaveBeenCalledWith('2026-03-18', '2026-04-21')
    expect(one.settled.get(WRONG)).toMatchObject({ amount: -1250, outside_window: true })
  })

  it('settles nothing when the read fails: every verifikat stays listed', async () => {
    const db = ticketDb()
    await settle(db)
    const { supabase } = fakeSupabase(db, { failTable: 'account_reconciliation_settlements' })
    const resolved = await resolveLedgerSettlements(supabase, COMPANY, '1930', window, async () => window)
    expect(resolved.settled.size).toBe(0)
    expect(resolved.broken.size).toBe(0)

    const failing = fakeSupabase(db, { failTable: 'account_reconciliation_settlements' })
    const s = await getReconciliationStatus(failing.supabase, COMPANY, BOTH.from, BOTH.to, '1930', 'SEK', CASH, true)
    expect(s.unmatched_gl_line_count).toBe(3)
    expect(s.unexplained_difference).toBe(10)
  })
})
