/**
 * pg-real coverage for 20261023094100_bank_reconciliation_facts.sql:
 *
 *   - the bank status getReconciliationStatus builds on
 *     get_bank_reconciliation_facts keeps the rules the engine applied in JS
 *     over paged rows: the opening-balance floor, ignored rows, posted plus
 *     reversed ledger sums, linked rows counted in the window of their
 *     verifikat, foreign accounts in their own currency, the bank's history;
 *   - the facts' ledger-only lines are get_account_gl_lines_for_matching's
 *     answer, and both candidate RPCs answer what their previous bodies
 *     (20261006121002) answered;
 *   - get_bank_reconciliation_items lists the window the status counts;
 *   - get_unexplained_bank_legs leaves out what explains a verifikat;
 *   - every read answers the same once the company's ledger summaries are
 *     built (ledger_account_entries, ledger_account_days, 20261023093900) as
 *     through the journal itself, after every write the fixtures make;
 *   - no read tells a signed-in user anything about another company;
 *   - 20261123171347_foreign_account_opening_balance.sql: a foreign account
 *     reconciles over an IB booked in kronor, and account_ib_in_currency and
 *     account_currency_balance answer what the IB and the account are in the
 *     account's currency, or null.
 *
 * The engine runs on a real supabase-js client over the pool
 * (postgrest-over-pg.ts), signed in as the company's owner, so RLS, the
 * function grants and the JSON shapes are the production ones.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getPool } from './setup'
import { createPgRest } from './postgrest-over-pg'
import {
  insertAuthUser,
  insertCashAccount,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertTransaction,
} from './fixtures'
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'
import { listAccountItems, type ListItemsOptions } from '@/lib/reconciliation/items'

/** supabase-js resolves a WebSocket constructor eagerly; nothing here subscribes. */
class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

function authenticatedClient(userId: string): SupabaseClient {
  const rest = createPgRest({ role: 'authenticated', userId })
  return createClient('http://pg-real.invalid', 'pg-real-anon', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: rest.fetch },
    realtime: { transport: UnusedRealtimeTransport as never },
  })
}

interface Books {
  userId: string
  companyId: string
  periods: Record<string, string>
  cash: string
  client: SupabaseClient
}

async function books(options: { cashLedger?: string; currency?: string } = {}): Promise<Books> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const periods: Record<string, string> = {}
  for (const year of ['2025', '2026', '2027']) {
    periods[year] = await insertFiscalPeriod({
      userId,
      companyId,
      periodStart: `${year}-01-01`,
      periodEnd: `${year}-12-31`,
      name: year,
    })
  }
  const cash = await insertCashAccount({
    companyId,
    ledgerAccount: options.cashLedger ?? '1930',
    currency: options.currency ?? 'SEK',
    isPrimary: true,
  })
  return { userId, companyId, periods, cash, client: authenticatedClient(userId) }
}

interface LineSpec {
  account: string
  debit?: number
  credit?: number
  currency?: string
  amountInCurrency?: number | null
}

interface VerifikatOptions {
  sourceType?: string
  status?: 'posted' | 'reversed'
}

/**
 * A verifikat posted the way the fixtures post one (draft, lines, posted),
 * with every line it is given. `status: 'reversed'` marks it stornerad after
 * posting, as the storno flow does.
 */
async function verifikat(b: Books, date: string, lines: LineSpec[], options: VerifikatOptions = {}): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const batch =
      options.sourceType === 'import'
        ? (
            await client.query<{ id: string }>(
              `INSERT INTO sie_imports (company_id, user_id, filename, file_hash, sie_type, status)
               VALUES ($1, $2, 'pg-import-fixture.se', md5(gen_random_uuid()::text), 4, 'completed') RETURNING id`,
              [b.companyId, b.userId],
            )
          ).rows[0].id
        : null
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date,
          description, source_type, status, import_batch_id, source_ordinal, source_content_hash)
       VALUES ($1, $2, $3, $4, 0, 'A', $5, $6, $7, 'draft', $8,
               CASE WHEN $8::uuid IS NOT NULL THEN 0 END, CASE WHEN $8::uuid IS NOT NULL THEN repeat('a', 64) END)`,
      [id, b.userId, b.companyId, b.periods[date.slice(0, 4)], date, `Verifikat ${date}`, options.sourceType ?? 'manual', batch],
    )
    for (const [i, l] of lines.entries()) {
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount, currency, amount_in_currency, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, l.account, l.debit ?? 0, l.credit ?? 0, l.currency ?? 'SEK', l.amountInCurrency ?? null, i],
      )
    }
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    if (options.status === 'reversed') {
      await client.query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [id])
    }
    await client.query('COMMIT')
    return id
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** A verifikat that moves the bank account by `amount` (+ in, - out) against 3001. */
function onBank(b: Books, date: string, amount: number, options: VerifikatOptions & { account?: string } = {}) {
  const account = options.account ?? '1930'
  return verifikat(
    b,
    date,
    amount >= 0
      ? [{ account, debit: amount }, { account: '3001', credit: amount }]
      : [{ account, credit: -amount }, { account: '3001', debit: -amount }],
    options,
  )
}

/** A bank row on the company's cash account (or `cash`), optionally pointing at a verifikat. */
function bankRow(
  b: Books,
  date: string,
  amount: number,
  options: { entry?: string; ignored?: boolean; cash?: string | null; currency?: string } = {},
) {
  return insertTransaction({
    companyId: b.companyId,
    userId: b.userId,
    date,
    amount,
    currency: options.currency ?? 'SEK',
    journalEntryId: options.entry ?? null,
    cashAccountId: options.cash === undefined ? b.cash : options.cash,
    isIgnored: options.ignored ?? false,
  })
}

/** A bank row linked to a verifikat through transaction_voucher_links (the 1:N door). */
async function junction(b: Books, transactionId: string, entryId: string, amount: number, role = 'bank_line') {
  await getPool().query(
    `INSERT INTO public.transaction_voucher_links
       (id, user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), b.userId, b.companyId, transactionId, entryId, amount, role],
  )
}

/**
 * Runs `read` with the company's ledger summaries built (a new company
 * starts built) and not built (the journal), and expects one answer.
 */
async function bothPaths<T>(b: Books, read: () => Promise<T>): Promise<T> {
  expect(await ready(b.companyId)).toBe(true)
  const indexed = await read()
  await getPool().query('DELETE FROM public.ledger_account_days_companies WHERE company_id = $1', [b.companyId])
  try {
    expect(await read()).toEqual(indexed)
  } finally {
    await getPool().query('INSERT INTO public.ledger_account_days_companies (company_id) VALUES ($1)', [b.companyId])
  }
  return indexed
}

async function ready(companyId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ ready: boolean }>('SELECT public.ledger_account_days_ready($1) AS ready', [
    companyId,
  ])
  return rows[0].ready
}

function status(b: Books, dateFrom?: string, dateTo?: string, account = '1930', currency = 'SEK') {
  return bothPaths(b, () => getReconciliationStatus(b.client, b.companyId, dateFrom, dateTo, account, currency, b.cash, true))
}

interface Facts {
  effective_from: string | null
  gl: Record<string, unknown>
  bank: Record<string, unknown>
  read_window_cash_accounts: number | null
  candidates: Array<Record<string, unknown>>
}

async function facts(b: Books, dateFrom: string | null, dateTo: string | null, cash: string | null = b.cash): Promise<Facts> {
  const { data, error } = await b.client.rpc('get_bank_reconciliation_facts', {
    p_company_id: b.companyId,
    p_account_number: '1930',
    p_currency: 'SEK',
    p_cash_account_id: cash,
    p_include_unassigned: true,
    p_date_from: dateFrom,
    p_date_to: dateTo,
  })
  if (error) throw new Error(error.message)
  return data as Facts
}

/** A numeric RPC answer: the figure, or null when the function answered NULL. A failed call throws, so null is never a failure. */
function numericAnswer(answer: { data: unknown; error: { message: string } | null }): number | null {
  if (answer.error) throw new Error(answer.error.message)
  return answer.data === null ? null : Number(answer.data)
}

// ---------------------------------------------------------------------------
// The previous candidate RPC bodies, for the equality checks
// ---------------------------------------------------------------------------

const PREVIOUS_RPCS = readFileSync(
  join(__dirname, '../../supabase/migrations/20261006121002_gl_lines_partially_allocated_remaining.sql'),
  'utf8',
)

/** get_bank_reconciliation_facts before its link anchor became a join (20261025083000). */
const PREVIOUS_FACTS = readFileSync(
  join(__dirname, '../../supabase/migrations/20261023094100_bank_reconciliation_facts.sql'),
  'utf8',
)

/** A previous body of `name`, as a pg_temp function for this session. */
function previousFunction(name: string, source = PREVIOUS_RPCS): string {
  const header = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`)
  const match = header.exec(source)
  if (!match) throw new Error(`${name} not found in its previous migration`)
  const end = source.indexOf('$$;', source.indexOf('AS $$', match.index)) + 3
  return source.slice(match.index, end).replace(header, `CREATE FUNCTION pg_temp.previous_${name}(`)
}

/** Both candidate RPCs, now and before, over one window: the same rows. */
async function expectCandidateRpcsUnchanged(b: Books, from: string | null, to: string | null) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(previousFunction('get_unlinked_gl_lines'))
    await client.query(previousFunction('get_account_gl_lines_for_matching'))
    for (const [fn, extra] of [
      ['get_unlinked_gl_lines', ''],
      ['get_account_gl_lines_for_matching', ', false'],
      ['get_account_gl_lines_for_matching', ', true'],
    ] as const) {
      const sql = (schema: string, name: string) =>
        `SELECT * FROM ${schema}.${name}($1, '1930', $2::date, $3::date${extra}) ORDER BY line_id`
      const now = await client.query(sql('public', fn), [b.companyId, from, to])
      const before = await client.query(sql('pg_temp', `previous_${fn}`), [b.companyId, from, to])
      expect(now.rows, `${fn}${extra}`).toEqual(before.rows)
      expect(now.rows.length).toBeGreaterThan(0)
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

/**
 * get_bank_reconciliation_facts now and before 20261025083000, scoped to the
 * cash account and unscoped, over each window, with the ledger summaries built
 * and not: the same answer.
 */
async function expectFactsUnchanged(b: Books, windows: Array<[string | null, string | null]>) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(previousFunction('get_bank_reconciliation_facts', PREVIOUS_FACTS))
    for (const indexed of [true, false]) {
      if (!indexed) {
        await client.query('DELETE FROM public.ledger_account_days_companies WHERE company_id = $1', [b.companyId])
      }
      for (const cash of [b.cash, null]) {
        for (const [from, to] of windows) {
          const sql = (fn: string) =>
            `SELECT ${fn}($1, '1930', 'SEK', $2::uuid, true, $3::date, $4::date) AS facts`
          const args = [b.companyId, cash, from, to]
          const now = await client.query(sql('public.get_bank_reconciliation_facts'), args)
          const before = await client.query(sql('pg_temp.previous_get_bank_reconciliation_facts'), args)
          expect(now.rows[0].facts, `${indexed ? 'indexed' : 'journal'} ${cash ? 'scoped' : 'unscoped'} ${from}..${to}`).toEqual(
            before.rows[0].facts,
          )
        }
      }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

// ===========================================================================
// The bank status
// ===========================================================================

describe('getReconciliationStatus over get_bank_reconciliation_facts', () => {
  it('floors a full-history window at the IB date so a prior period cannot count the IB (issue #751)', async () => {
    const b = await books()
    // The prior year's movements net to exactly the IB of the new one.
    const prior = await onBank(b, '2025-03-31', 6000)
    await onBank(b, '2025-09-30', 4000)
    await onBank(b, '2026-01-01', 10000, { sourceType: 'opening_balance' })
    const deposit = await onBank(b, '2026-02-15', 5000)
    await bankRow(b, '2025-03-31', 6000, { entry: prior })
    await bankRow(b, '2026-02-15', 5000, { entry: deposit })

    expect(await status(b)).toMatchObject({
      gl_1930_balance: 15000,
      gl_1930_opening_balance: 10000,
      gl_1930_period_movement: 5000,
      bank_transaction_total: 5000,
      difference: 0,
      is_reconciled: true,
    })
    // A dateFrom before the IB is raised to it.
    expect(await status(b, '2025-01-01')).toMatchObject({
      gl_1930_opening_balance: 10000,
      gl_1930_period_movement: 5000,
      bank_transaction_total: 5000,
      difference: 0,
    })
    // A window after the IB reconciles on its own movements.
    expect(await status(b, '2026-02-01', '2026-03-31')).toMatchObject({
      gl_1930_opening_balance: 0,
      gl_1930_period_movement: 5000,
      bank_transaction_total: 5000,
      difference: 0,
    })
    await expectCandidateRpcsUnchanged(b, null, null)
  })

  it('does not count a stornerad opening balance as the IB, nor floor the window at one', async () => {
    const b = await books()
    await onBank(b, '2026-01-01', 25000, { sourceType: 'opening_balance', status: 'reversed' })
    await onBank(b, '2026-01-01', -25000, { sourceType: 'storno' })
    await onBank(b, '2026-01-01', 100000, { sourceType: 'opening_balance' })
    const received = await onBank(b, '2026-01-15', 5000)
    await bankRow(b, '2026-01-15', 5000, { entry: received })
    // A stray stornerad IB dated mid-period must not raise the floor.
    await onBank(b, '2026-02-01', 400, { sourceType: 'opening_balance', status: 'reversed' })
    await onBank(b, '2026-02-01', -400, { sourceType: 'storno' })
    const february = await onBank(b, '2026-02-10', 2000)
    await bankRow(b, '2026-02-10', 2000, { entry: february })

    expect(await status(b, '2026-01-01')).toMatchObject({
      gl_1930_balance: 107000,
      gl_1930_opening_balance: 100000,
      gl_1930_period_movement: 7000,
      gl_1930_correction_adjustment: -25400,
      bank_transaction_total: 7000,
      difference: 0,
    })
  })

  it('keeps ignored rows out of the bank total and the match counts, and surfaces them', async () => {
    const b = await books()
    const booked = await onBank(b, '2026-03-05', 8730)
    await bankRow(b, '2026-03-05', 8730, { entry: booked })
    await bankRow(b, '2026-03-05', 8730, { ignored: true })
    await bankRow(b, '2026-03-06', 500)
    // An ignored row linked through transaction_voucher_links is still not matched.
    const other = await onBank(b, '2026-03-07', 700)
    await junction(b, await bankRow(b, '2026-03-07', 700, { ignored: true }), other, 700)

    expect(await status(b, '2026-01-01', '2026-12-31')).toMatchObject({
      bank_transaction_total: 9230,
      bank_transaction_count: 2,
      ignored_transaction_count: 2,
      ignored_transaction_total: 9430,
      gl_1930_period_movement: 9430,
      matched_count: 1,
      unmatched_transaction_count: 1,
      unmatched_transaction_total: 500,
      is_reconciled: false,
    })
  })

  it('sums posted and reversed lines like the balance sheet, so a corrected receipt reconciles', async () => {
    const b = await books()
    await onBank(b, '2026-04-10', 24000, { status: 'reversed' })
    await onBank(b, '2026-04-11', -24000, { sourceType: 'storno' })
    const correction = await onBank(b, '2026-04-11', 25000, { sourceType: 'correction' })
    await bankRow(b, '2026-04-10', 25000, { entry: correction })
    expect(await status(b, '2026-01-01', '2026-12-31')).toMatchObject({
      gl_1930_balance: 25000,
      gl_1930_correction_adjustment: 1000,
      gl_1930_period_movement: 25000,
      bank_transaction_total: 25000,
      difference: 0,
    })

    // A row that still points at the stornerad original nets the same.
    const legacy = await books()
    const original = await onBank(legacy, '2026-04-10', 25000)
    await bankRow(legacy, '2026-04-10', 25000, { entry: original })
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [original])
    await onBank(legacy, '2026-04-11', -25000, { sourceType: 'storno' })
    await onBank(legacy, '2026-04-11', 25000, { sourceType: 'correction' })
    expect(await status(legacy, '2026-01-01', '2026-12-31')).toMatchObject({
      bank_transaction_total: 25000,
      gl_1930_period_movement: 25000,
      difference: 0,
    })
  })

  it('counts a linked bank row in the window of its verifikat, either way across the edge', async () => {
    const b = await books()
    // A deposit dated before the window, booked inside it.
    const inside = await onBank(b, '2026-03-02', 25000)
    await bankRow(b, '2026-02-20', 25000, { entry: inside })
    // A payment booked before the window that cleared the bank inside it.
    const before = await onBank(b, '2026-02-27', -800)
    await bankRow(b, '2026-03-02', -800, { entry: before })
    const plain = await onBank(b, '2026-03-05', -5000)
    await bankRow(b, '2026-03-05', -5000, { entry: plain })
    // Linked only through transaction_voucher_links, dated before the window.
    const viaJunction = await onBank(b, '2026-03-09', 300)
    await junction(b, await bankRow(b, '2026-02-25', 300), viaJunction, 300)

    expect(await status(b, '2026-03-01', '2026-12-31')).toMatchObject({
      bank_transaction_total: 20300,
      bank_transaction_count: 3,
      gl_1930_period_movement: 20300,
      difference: 0,
      matched_count: 3,
      unexplained_difference: 0,
    })
    expect(await status(b, '2026-02-01', '2026-02-28')).toMatchObject({
      bank_transaction_total: -800,
      gl_1930_period_movement: -800,
      difference: 0,
    })
    await expectFactsUnchanged(b, [
      [null, null],
      ['2026-02-01', '2026-02-28'],
      ['2026-03-01', '2026-12-31'],
    ])
  })

  it('counts a row linked to several verifikat on the latest of them, its pointer among them', async () => {
    const b = await books()
    // Two links, the later verifikat in March: the row counts in March.
    const february = await onBank(b, '2026-02-25', 300)
    const march = await onBank(b, '2026-03-03', 200)
    const split = await bankRow(b, '2026-02-20', 500)
    await junction(b, split, february, 300)
    await junction(b, split, march, 200)
    // A pointer in March and a link in April: the later one.
    const pointed = await onBank(b, '2026-03-12', 400)
    const april = await onBank(b, '2026-04-02', 100)
    await junction(b, await bankRow(b, '2026-03-10', 500, { entry: pointed }), april, 100)

    const bankIn = async (from: string, to: string) => (await bothPaths(b, () => facts(b, from, to))).bank
    expect(await bankIn('2026-02-01', '2026-02-28')).toMatchObject({ count: 0, total: 0 })
    expect(await bankIn('2026-03-01', '2026-03-31')).toMatchObject({ count: 1, total: 500, matched_count: 1 })
    expect(await bankIn('2026-04-01', '2026-04-30')).toMatchObject({ count: 1, total: 500, matched_count: 1 })
    await expectFactsUnchanged(b, [
      [null, null],
      ['2026-01-01', '2026-12-31'],
      ['2026-02-01', '2026-02-28'],
      ['2026-03-01', '2026-03-31'],
      ['2026-04-01', '2026-04-30'],
      ['2026-05-01', null],
      [null, '2026-03-31'],
    ])
  })

  it('counts a row whose link books nothing as open, on its own date', async () => {
    const b = await books()
    // A clearing link books no bank amount, wherever its verifikat sits.
    const elsewhere = await verifikat(b, '2026-04-20', [
      { account: '1910', debit: 50 },
      { account: '3001', credit: 50 },
    ])
    await junction(b, await bankRow(b, '2026-03-15', 50), elsewhere, 50, 'clearing')
    // A stornerad verifikat books nothing.
    const reversed = await onBank(b, '2026-05-05', 70, { status: 'reversed' })
    await junction(b, await bankRow(b, '2026-04-28', 70), reversed, 70)

    const bankIn = async (from: string, to: string) => (await bothPaths(b, () => facts(b, from, to))).bank
    expect(await bankIn('2026-03-01', '2026-03-31')).toMatchObject({ count: 1, total: 50, matched_count: 0, unmatched_count: 1 })
    expect(await bankIn('2026-04-01', '2026-04-30')).toMatchObject({ count: 1, total: 70, matched_count: 0, unmatched_count: 1 })
    expect(await bankIn('2026-05-01', '2026-05-31')).toMatchObject({ count: 0, total: 0 })
  })

  it('still drops an unlinked row dated before the opening balance floor', async () => {
    const b = await books()
    await onBank(b, '2026-01-01', 1000, { sourceType: 'opening_balance' })
    const deposit = await onBank(b, '2026-01-05', 25000)
    await bankRow(b, '2025-12-17', 25000, { entry: deposit })
    await bankRow(b, '2025-12-10', 999)

    expect(await status(b)).toMatchObject({
      gl_1930_opening_balance: 1000,
      bank_transaction_total: 25000,
      bank_transaction_count: 1,
      unmatched_transaction_count: 0,
      difference: 0,
    })
  })

  it('splits the difference into the work lists, the open remainder of a partial slice included', async () => {
    const b = await books()
    const matched = await onBank(b, '2026-03-01', 1000)
    await bankRow(b, '2026-03-01', 1000, { entry: matched })
    await bankRow(b, '2026-03-02', 500)
    await onBank(b, '2026-03-03', -300)
    // One payment of -500 over two verifikat: 100 of the first's 300 and all of the second's 400.
    const part = await onBank(b, '2026-08-05', -300)
    const full = await onBank(b, '2026-08-05', -400)
    await onBank(b, '2026-08-05', 200)
    const split = await bankRow(b, '2026-08-05', -500)
    await junction(b, split, part, -100)
    await junction(b, split, full, -400)

    expect(await status(b, '2026-01-01', '2026-12-31')).toMatchObject({
      bank_transaction_total: 1000,
      gl_1930_period_movement: 200,
      difference: 800,
      unmatched_transaction_total: 500,
      // -300 open on its own, -200 left of the partial slice, +200 the credit.
      unmatched_gl_line_count: 3,
      unmatched_gl_line_total: -300,
      unexplained_difference: 0,
      is_reconciled: false,
    })
    await expectCandidateRpcsUnchanged(b, '2026-01-01', '2026-12-31')

    const f = await facts(b, '2026-01-01', '2026-12-31')
    const { data: rpc, error } = await b.client.rpc('get_account_gl_lines_for_matching', {
      p_company_id: b.companyId,
      p_account_number: '1930',
      p_date_from: f.effective_from,
      p_date_to: '2026-12-31',
      p_include_matched: false,
    })
    expect(error).toBeNull()
    const byLine = (rows: Array<Record<string, unknown>>) =>
      [...rows].sort((x, y) => String(x.line_id).localeCompare(String(y.line_id)))
    expect(byLine(f.candidates)).toEqual(byLine(rpc as Array<Record<string, unknown>>))
    expect(f.candidates).toHaveLength(3)
  })

  it('reconciles a EUR account in EUR and says when its lines cannot be expressed in it', async () => {
    const b = await books({ cashLedger: '1932', currency: 'EUR' })
    const paid = await verifikat(b, '2026-03-05', [
      { account: '1932', debit: 1150, currency: 'EUR', amountInCurrency: 100 },
      { account: '3001', credit: 1150 },
    ])
    await bankRow(b, '2026-03-05', 100, { entry: paid, currency: 'EUR' })
    expect(await status(b, '2026-01-01', '2026-12-31', '1932', 'EUR')).toMatchObject({
      currency: 'EUR',
      gl_1930_period_movement: 100,
      bank_transaction_total: 100,
      difference: 0,
      is_reconciled: true,
      not_reconcilable_reason: null,
    })

    // A line with only a SEK figure on the EUR account: nothing to convert with.
    await verifikat(b, '2026-03-06', [
      { account: '1932', debit: 1150 },
      { account: '3001', credit: 1150 },
    ])
    expect(await status(b, '2026-01-01', '2026-12-31', '1932', 'EUR')).toMatchObject({
      unconvertible_gl_line_count: 1,
      not_reconcilable_reason: 'gl_lines_missing_currency_amount',
      unmatched_gl_line_total: null,
      is_reconciled: false,
    })
  })

  it('reads a SEK account on its SEK figures when its lines carry a foreign label', async () => {
    const b = await books()
    const paid = await verifikat(b, '2026-03-05', [
      { account: '1930', credit: 1150, currency: 'EUR', amountInCurrency: 100 },
      { account: '2440', debit: 1150 },
    ])
    await bankRow(b, '2026-03-05', -1150, { entry: paid })
    expect(await status(b, '2026-01-01', '2026-12-31')).toMatchObject({
      gl_1930_period_movement: -1150,
      difference: 0,
      unconvertible_gl_line_count: 0,
      is_reconciled: true,
    })
  })

  // 20261123171347: year-end, SIE import and set_opening_balances post the IB
  // in kronor, so its line on a foreign account carries no amount in the
  // account's currency. The comparison is over the movement after the IB and
  // never used that line; the IB's own amount is what stood the day before.

  /** A EUR account booked in EUR through 2025 (300 in, 100 out), each row linked. */
  async function eurBooks2025(): Promise<Books> {
    const b = await books({ cashLedger: '1932', currency: 'EUR' })
    const deposit = await verifikat(b, '2025-06-10', [
      { account: '1932', debit: 3300, currency: 'EUR', amountInCurrency: 300 },
      { account: '3001', credit: 3300 },
    ])
    const payment = await verifikat(b, '2025-09-12', [
      { account: '1932', credit: 1100, currency: 'EUR', amountInCurrency: 100 },
      { account: '3001', debit: 1100 },
    ])
    await bankRow(b, '2025-06-10', 300, { entry: deposit, currency: 'EUR' })
    await bankRow(b, '2025-09-12', -100, { entry: payment, currency: 'EUR' })
    return b
  }

  /** The IB as year-end posts it: the account's kronor, no amount in EUR. */
  function kronorOpeningBalance(b: Books, date: string, kronor: number) {
    return verifikat(b, date, [{ account: '1932', debit: kronor }, { account: '3001', credit: kronor }], {
      sourceType: 'opening_balance',
    })
  }

  /** `eur` in on the account, booked in EUR and linked to its bank row. */
  async function eurDeposit(b: Books, date: string, eur: number) {
    const entry = await verifikat(b, date, [
      { account: '1932', debit: eur * 11.5, currency: 'EUR', amountInCurrency: eur },
      { account: '3001', credit: eur * 11.5 },
    ])
    await bankRow(b, date, eur, { entry, currency: 'EUR' })
  }

  /** account_currency_balance on the EUR account: the figure, or null for unknown. A failed read throws. */
  async function currencyBalance(b: Books, through: string): Promise<number | null> {
    return numericAnswer(
      await b.client.rpc('account_currency_balance', {
        p_company_id: b.companyId,
        p_account_number: '1932',
        p_currency: 'EUR',
        p_through: through,
      }),
    )
  }

  it('reconciles a EUR account over a year start whose IB is booked in kronor', async () => {
    const b = await eurBooks2025()
    await kronorOpeningBalance(b, '2026-01-01', 2200)
    await eurDeposit(b, '2026-03-05', 100)

    expect(await status(b, '2026-01-01', '2026-12-31', '1932', 'EUR')).toMatchObject({
      currency: 'EUR',
      // What stood on the account on 2025-12-31, by the lines that say EUR.
      gl_1930_opening_balance: 200,
      gl_1930_balance: 300,
      gl_1930_period_movement: 100,
      bank_transaction_total: 100,
      difference: 0,
      unconvertible_gl_line_count: 0,
      not_reconcilable_reason: null,
      is_reconciled: true,
    })
    expect(await currencyBalance(b, '2026-06-30')).toBe(300)
  })

  it('reads through every kronor IB back to the lines that say the currency', async () => {
    const b = await eurBooks2025()
    await kronorOpeningBalance(b, '2026-01-01', 2200)
    await eurDeposit(b, '2026-03-05', 100)
    await kronorOpeningBalance(b, '2027-01-01', 3350)
    await eurDeposit(b, '2027-02-01', 40)

    expect(await status(b, '2027-01-01', '2027-12-31', '1932', 'EUR')).toMatchObject({
      gl_1930_opening_balance: 300,
      gl_1930_balance: 340,
      gl_1930_period_movement: 40,
      difference: 0,
      not_reconcilable_reason: null,
      is_reconciled: true,
    })
  })

  it('takes an IB that states its amount in the currency as booked', async () => {
    const b = await eurBooks2025()
    await verifikat(
      b,
      '2026-01-01',
      [
        { account: '1932', debit: 2900, currency: 'EUR', amountInCurrency: 250 },
        { account: '3001', credit: 2900 },
      ],
      { sourceType: 'opening_balance' },
    )
    await eurDeposit(b, '2026-03-05', 100)

    expect(await status(b, '2026-01-01', '2026-12-31', '1932', 'EUR')).toMatchObject({
      gl_1930_opening_balance: 250,
      gl_1930_balance: 350,
      gl_1930_period_movement: 100,
      is_reconciled: true,
    })
    expect(await currencyBalance(b, '2026-06-30')).toBe(350)
  })

  it('compares the movement and reports no balance when the lines before the IB carry no currency', async () => {
    const b = await books({ cashLedger: '1932', currency: 'EUR' })
    // History that came in kronor only, as an SIE file gives it.
    await verifikat(b, '2025-06-10', [{ account: '1932', debit: 3300 }, { account: '3001', credit: 3300 }])
    await kronorOpeningBalance(b, '2026-01-01', 3300)
    await eurDeposit(b, '2026-03-05', 100)

    expect(await status(b, '2026-01-01', '2026-12-31', '1932', 'EUR')).toMatchObject({
      gl_1930_opening_balance: null,
      gl_1930_balance: null,
      gl_1930_period_movement: 100,
      bank_transaction_total: 100,
      difference: 0,
      unconvertible_gl_line_count: 0,
      not_reconcilable_reason: null,
      is_reconciled: true,
    })
    expect(await currencyBalance(b, '2026-06-30')).toBeNull()
    // The year that holds the kronor-only line itself still cannot be compared.
    expect(await status(b, '2025-01-01', '2025-12-31', '1932', 'EUR')).toMatchObject({
      unconvertible_gl_line_count: 1,
      not_reconcilable_reason: 'gl_lines_missing_currency_amount',
      is_reconciled: false,
    })
  })

  it('reports no balance for an IB that brings in what the ledger never held', async () => {
    // An import's first year, or set_opening_balances: the IB is the first
    // thing on the account, so nothing says what it is in EUR. Not 0.
    const first = await books({ cashLedger: '1932', currency: 'EUR' })
    await kronorOpeningBalance(first, '2026-01-01', 3300)
    await eurDeposit(first, '2026-03-05', 100)
    expect(await status(first, '2026-01-01', '2026-12-31', '1932', 'EUR')).toMatchObject({
      gl_1930_opening_balance: null,
      gl_1930_balance: null,
      gl_1930_period_movement: 100,
      difference: 0,
      not_reconcilable_reason: null,
      is_reconciled: true,
    })
    expect(await currencyBalance(first, '2026-06-30')).toBeNull()

    // Nor an IB that states other kronor than the lines before it hold
    // (2 200 kr, 200 EUR): it does not restate them.
    const other = await eurBooks2025()
    await kronorOpeningBalance(other, '2026-01-01', 5000)
    expect(await status(other, '2026-01-01', '2026-12-31', '1932', 'EUR')).toMatchObject({
      gl_1930_opening_balance: null,
      gl_1930_balance: null,
      not_reconcilable_reason: null,
    })
    expect(await currencyBalance(other, '2026-06-30')).toBeNull()
    expect(await currencyBalance(other, '2025-12-31')).toBe(200)
  })

  it('still counts a kronor-only line after the IB as one the comparison lacks', async () => {
    const b = await eurBooks2025()
    await kronorOpeningBalance(b, '2026-01-01', 2200)
    await verifikat(b, '2026-03-06', [{ account: '1932', debit: 1150 }, { account: '3001', credit: 1150 }])

    expect(await status(b, '2026-01-01', '2026-12-31', '1932', 'EUR')).toMatchObject({
      gl_1930_opening_balance: 200,
      unconvertible_gl_line_count: 1,
      not_reconcilable_reason: 'gl_lines_missing_currency_amount',
      is_reconciled: false,
    })
    expect(await currencyBalance(b, '2026-06-30')).toBeNull()
  })

  it('answers a SEK account its balance in kronor, floored at the IB', async () => {
    const b = await books()
    await onBank(b, '2025-05-01', 700)
    await onBank(b, '2026-01-01', 700, { sourceType: 'opening_balance' })
    await onBank(b, '2026-02-01', -200)
    const kronor = numericAnswer(
      await b.client.rpc('account_currency_balance', {
        p_company_id: b.companyId,
        p_account_number: '1930',
        p_currency: 'SEK',
        p_through: '2026-12-31',
      }),
    )
    expect(kronor).toBe(500)
  })

  it('starts the comparison at the bank history and compares the saldo there (crm#1221)', async () => {
    const b = await books()
    await onBank(b, '2026-01-01', 10000, { sourceType: 'opening_balance' })
    await onBank(b, '2026-03-10', 5000, { sourceType: 'import' })
    await onBank(b, '2026-05-20', -2000, { sourceType: 'import' })
    const first = await onBank(b, '2026-07-20', 1000)
    const second = await onBank(b, '2026-08-05', -300)
    await bankRow(b, '2026-07-20', 1000, { entry: first })
    await bankRow(b, '2026-08-05', -300, { entry: second })
    const later = await onBank(b, '2026-10-02', 50)
    await bankRow(b, '2026-10-02', 50, { entry: later })
    await getPool().query(
      `UPDATE public.cash_accounts SET balance = 13750, balance_updated_at = '2026-10-15T05:00:00Z' WHERE id = $1`,
      [b.cash],
    )

    expect(await status(b)).toMatchObject({
      history_start: '2026-07-20',
      before_history_count: 2,
      before_history_total: 3000,
      gl_1930_period_movement: 750,
      bank_transaction_total: 750,
      difference: 0,
      ledger_balance_before_start: 13000,
      saldo_at_start: 13000,
      opening_difference: 0,
    })
    // A window ending before the balance day still reads the rows up to it.
    expect(await status(b, undefined, '2026-09-30')).toMatchObject({
      gl_1930_period_movement: 700,
      bank_transaction_total: 700,
      saldo_at_start: 13000,
      difference: 0,
    })
  })

  it('tells an unscoped read how many cash accounts its rows spread over', async () => {
    const b = await books()
    const savings = await insertCashAccount({ companyId: b.companyId, ledgerAccount: '1931' })
    await bankRow(b, '2026-03-01', 100)
    await bankRow(b, '2026-03-02', 200, { cash: savings })
    expect((await facts(b, '2026-01-01', '2026-12-31', null)).read_window_cash_accounts).toBe(2)
    expect((await facts(b, '2026-01-01', '2026-12-31')).read_window_cash_accounts).toBeNull()
  })

  it('answers nothing about a company to a user who is not a member', async () => {
    const b = await books()
    const deposit = await onBank(b, '2026-03-01', 100)
    await bankRow(b, '2026-03-01', 100, { entry: deposit })
    await onBank(b, '2026-03-02', -40)
    const outsider = { ...b, client: authenticatedClient(await insertAuthUser()) }

    const f = await facts(outsider, '2026-01-01', '2026-12-31')
    expect(f.gl).toMatchObject({ balance: 0 })
    expect(f.bank).toMatchObject({ count: 0, total: 0, history_start: null })
    expect(f.candidates).toEqual([])
    for (const [fn, args, owned] of [
      ['bank_account_unlinked_entries', {}, 1],
      ['bank_account_candidate_entries', { p_include_matched: true }, 2],
    ] as const) {
      const call = (client: SupabaseClient) =>
        client.rpc(fn, { p_company_id: b.companyId, p_account_number: '1930', p_date_from: null, p_date_to: null, ...args })
      expect((await call(b.client)).data, `${fn} as the owner`).toHaveLength(owned)
      expect((await call(outsider.client)).data, `${fn} as an outsider`).toEqual([])
    }
    const legs = await outsider.client.rpc('get_unexplained_bank_legs', {
      p_company_id: b.companyId,
      p_account_number: '1930',
      p_low: '2026-01-01',
      p_high: '2026-12-31',
      p_own_transaction_ids: [],
    })
    expect(legs.data).toEqual([])
    const balance = (client: SupabaseClient) =>
      client.rpc('account_currency_balance', {
        p_company_id: b.companyId,
        p_account_number: '1930',
        p_currency: 'SEK',
        p_through: '2026-12-31',
      })
    expect(numericAnswer(await balance(b.client)), 'account_currency_balance as the owner').toBe(60)
    expect(numericAnswer(await balance(outsider.client)), 'account_currency_balance as an outsider').toBe(0)
    await onBank(b, '2027-01-01', 60, { sourceType: 'opening_balance' })
    const ib = (client: SupabaseClient) =>
      client.rpc('account_ib_in_currency', {
        p_company_id: b.companyId,
        p_account_number: '1930',
        p_currency: 'SEK',
        p_floor: '2027-01-01',
      })
    expect(numericAnswer(await ib(b.client)), 'account_ib_in_currency as the owner').toBe(60)
    expect(numericAnswer(await ib(outsider.client)), 'account_ib_in_currency as an outsider').toBe(0)
  })
})

// ===========================================================================
// The bank rows of one account
// ===========================================================================

describe('listAccountItems over get_bank_reconciliation_items', () => {
  function items(b: Books, options: ListItemsOptions) {
    return bothPaths(b, () => listAccountItems(b.client, b.companyId, `bank:${b.cash}`, { today: '2026-12-31', ...options }))
  }

  it('buckets the window as the status counts it and pages the matched rows from the read', async () => {
    const b = await books()
    const booked = await onBank(b, '2026-03-03', -31200)
    const bookedRow = await bankRow(b, '2026-03-03', -31200, { entry: booked })
    const inside = await onBank(b, '2026-03-02', 25000)
    const pulledIn = await bankRow(b, '2026-02-20', 25000, { entry: inside })
    const before = await onBank(b, '2026-02-27', -800)
    const pushedOut = await bankRow(b, '2026-03-02', -800, { entry: before })
    const ignored = await bankRow(b, '2026-03-04', -10, { ignored: true })
    const open = await bankRow(b, '2026-03-05', -1046)
    const splitA = await onBank(b, '2026-03-06', -200)
    const splitB = await onBank(b, '2026-03-06', -300)
    const split = await bankRow(b, '2026-03-06', -500)
    await junction(b, split, splitA, -200)
    await junction(b, split, splitB, -300)
    const lonely = await onBank(b, '2026-03-07', -45)

    const window = { windowFrom: '2026-03-01', windowTo: '2026-12-31' }
    const all = await items(b, { ...window, limit: 200 })
    const listed = all!.items.map((i) => [i.item_id, i.bucket])
    expect(listed).toEqual(
      expect.arrayContaining([
        [open, 'unmatched_external'],
        [lonely, 'unmatched_ledger'],
        [ignored, 'ignored'],
        [bookedRow, 'matched'],
        [pulledIn, 'matched'],
        [split, 'matched'],
      ]),
    )
    // The payment booked before the window is counted there, not here.
    expect(listed.some(([id]) => id === pushedOut)).toBe(false)
    expect(all!.total_count).toBe(listed.length)
    expect(all!.items.find((i) => i.item_id === pulledIn)).toMatchObject({
      linked_journal_entry_id: inside,
      linked_entry: { entry_date: '2026-03-02' },
    })

    // Paging reads the same rows, in the same order.
    const page = await items(b, { ...window, limit: 2, offset: 3 })
    expect(page!.items.map((i) => i.item_id)).toEqual(all!.items.slice(3, 5).map((i) => i.item_id))
    expect(page).toMatchObject({ total_count: all!.total_count, has_more: all!.total_count > 5 })
    const matched = all!.items.filter((i) => i.bucket === 'matched').map((i) => i.item_id)
    const matchedPage = await items(b, { ...window, bucket: 'matched', limit: 1, offset: 1 })
    expect(matchedPage!.items.map((i) => i.item_id)).toEqual(matched.slice(1, 2))
    expect(matchedPage).toMatchObject({ total_count: matched.length, has_more: true, next_offset: 2 })
  })

  it('lists the verifikat from before the bank history on their own', async () => {
    const b = await books()
    const imported = await onBank(b, '2026-03-10', 5000, { sourceType: 'import' })
    const yearStart = await onBank(b, '2026-01-01', 10000)
    const first = await onBank(b, '2026-07-20', 1000)
    await bankRow(b, '2026-07-20', 1000, { entry: first })

    const before = await items(b, { bucket: 'before_history', windowFrom: '2026-01-01', windowTo: '2026-12-31' })
    expect(before!.items.map((i) => i.item_id).sort()).toEqual([imported, yearStart].sort())
    expect(before!.before_history).toEqual({ count: 2, total: 15000, history_start: '2026-07-20' })
    expect(before!.items.find((i) => i.item_id === yearStart)).toMatchObject({ ib_eligible: true })
    expect(before!.items.find((i) => i.item_id === imported)).toMatchObject({ ib_eligible: false })
  })
})

// ===========================================================================
// The covering-set legs
// ===========================================================================

describe('get_unexplained_bank_legs', () => {
  function legs(b: Books, account: string | null, own: string[] = []) {
    return bothPaths(b, async () => {
      const { data, error } = await b.client.rpc('get_unexplained_bank_legs', {
        p_company_id: b.companyId,
        p_account_number: account,
        p_low: '2026-07-01',
        p_high: '2026-07-31',
        p_own_transaction_ids: own,
      })
      if (error) throw new Error(error.message)
      return (data as Array<{ journal_entry_id: string; account_number: string }>)
        .map((r) => `${r.journal_entry_id} ${r.account_number}`)
        .sort()
    })
  }

  it('leaves out scaffolding and every verifikat something else already explains', async () => {
    const b = await books()
    const open = await onBank(b, '2026-07-10', 62500)
    const pointed = await onBank(b, '2026-07-11', 25750)
    await bankRow(b, '2026-07-11', 25750, { entry: pointed })
    const own = await onBank(b, '2026-07-12', 100)
    const ownRow = await bankRow(b, '2026-07-12', 100, { entry: own })
    const linked = await onBank(b, '2026-07-13', 300)
    await junction(b, await bankRow(b, '2026-07-13', 300), linked, 300)
    await onBank(b, '2026-07-14', -500, { sourceType: 'storno' })
    await onBank(b, '2026-07-14', 500, { sourceType: 'correction' })
    await onBank(b, '2026-07-01', 900, { sourceType: 'opening_balance' })
    await onBank(b, '2026-08-01', 10)
    const transfer = await verifikat(b, '2026-07-15', [
      { account: '1930', credit: 40 },
      { account: '1940', debit: 40 },
    ])

    // The searched row's own pointer does not explain its verifikat.
    expect(await legs(b, '1930', [ownRow])).toEqual([`${open} 1930`, `${own} 1930`, `${transfer} 1930`].sort())
    // Without an account the bank range 1910-1949 is read, on the journal.
    expect(await legs(b, null)).toEqual([`${open} 1930`, `${transfer} 1930`, `${transfer} 1940`].sort())
  })
})
