/**
 * The candidate lists of bank reconciliation, read the way the matcher reads
 * them (fetchUnlinkedGLLines, fetchGLLinesForMatching), answer exactly what
 * their RPCs answer, and judge each verifikat once (crm#2150).
 *
 * get_unlinked_gl_lines and get_account_gl_lines_for_matching are plpgsql, so
 * PostgREST runs one to the end for every .range() page and cuts 1 000 rows
 * out of the result: a list of n lines cost n/1 000 runs over the whole
 * window, and on the largest company's account a single run took longer than
 * the 8 s statement timeout. The reads now ask each RPC's narrowing once and
 * its predicate on slices of the verifikat it names.
 *
 * The oracle is the read as it was: the RPC itself, paged by .range() in its
 * order. It also keeps the reads and the RPCs one definition: a change to an
 * RPC's body that its two halves do not carry fails here. Everything runs on
 * a real supabase-js client over the pool (postgrest-over-pg.ts), signed in
 * as the company's owner.
 */
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
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  fetchGLLinesForMatching,
  fetchUnlinkedGLLines,
  type GLLineForMatching,
  type UnlinkedGLLine,
} from '@/lib/reconciliation/bank-reconciliation'

/** supabase-js resolves a WebSocket constructor eagerly; nothing here subscribes. */
class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

interface RpcCall {
  fn: string
  args: Record<string, unknown>
}

/**
 * A client signed in as `userId` that records every RPC it is asked for.
 * `unsupported` lists every request the shim could not answer as PostgREST
 * would: a read that left its grammar proves nothing.
 */
function recordingClient(userId: string): { client: SupabaseClient; calls: RpcCall[]; unsupported: string[] } {
  const rest = createPgRest({ role: 'authenticated', userId })
  const calls: RpcCall[] = []
  const client = createClient('http://pg-real.invalid', 'pg-real-anon', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        const rpc = /\/rpc\/([a-z_]+)$/.exec(url.pathname)
        if (rpc) calls.push({ fn: rpc[1], args: JSON.parse(String(init?.body ?? '{}')) })
        return rest.fetch(input, init)
      },
    },
    realtime: { transport: UnusedRealtimeTransport as never },
  })
  return { client, calls, unsupported: rest.unsupported }
}

interface Books {
  userId: string
  companyId: string
  periods: Record<string, string>
  cash1930: string
  cash1940: string
}

async function books(): Promise<Books> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const periods: Record<string, string> = {}
  for (const year of ['2025', '2026']) {
    periods[year] = await insertFiscalPeriod({ userId, companyId, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, name: year })
  }
  const cash1930 = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
  const cash1940 = await insertCashAccount({ companyId, ledgerAccount: '1940' })
  return { userId, companyId, periods, cash1930, cash1940 }
}

/**
 * `count` verifikat of two lines each, posted the way the fixtures post one
 * (draft, lines, posted), in one statement each: on `account` against 3001,
 * spread over both years, and every third paid out. Every tenth is in
 * series B with the day and the number of the series A verifikat before it,
 * so between those two the order falls to line_id.
 */
async function bulkVerifikat(b: Books, account: string, count: number): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `CREATE TEMP TABLE plan ON COMMIT DROP AS
       SELECT gen_random_uuid() AS id, g,
              ('2025-01-01'::date + ((g * 37) % 700)) AS d,
              'A'::text AS series, 0 AS voucher,
              (100 + (g % 250))::numeric + 0.25 AS amount,
              g % 3 = 0 AS out
       FROM generate_series(1, $1::int) g`,
      [count],
    )
    await client.query(
      `UPDATE plan p SET voucher = n.v
       FROM (SELECT g, row_number() OVER (PARTITION BY extract(year FROM d) ORDER BY d, g)::int AS v
             FROM plan WHERE g % 10 <> 0) n
       WHERE p.g = n.g`,
    )
    await client.query(
      `UPDATE plan p SET series = 'B', d = a.d, voucher = a.voucher
       FROM plan a WHERE p.g % 10 = 0 AND a.g = p.g - 1`,
    )
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status)
       SELECT p.id, $1, $2, CASE WHEN p.d < '2026-01-01' THEN $3::uuid ELSE $4::uuid END,
              p.voucher, p.series, p.d, 'Betalning ' || p.g, 'manual', 'draft'
       FROM plan p`,
      [b.userId, b.companyId, b.periods['2025'], b.periods['2026']],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       SELECT p.id, $1, CASE WHEN p.out THEN 0 ELSE p.amount END, CASE WHEN p.out THEN p.amount ELSE 0 END, 'SEK', 0 FROM plan p
       UNION ALL
       SELECT p.id, '3001', CASE WHEN p.out THEN p.amount ELSE 0 END, CASE WHEN p.out THEN 0 ELSE p.amount END, 'SEK', 1 FROM plan p`,
      [account],
    )
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE company_id = $1 AND status = 'draft'`, [b.companyId])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

interface LineSpec {
  account: string
  debit?: number
  credit?: number
}

/** One verifikat with every line it is given; `reverses` makes it the storno of that one. */
async function verifikat(
  b: Books,
  date: string,
  lines: LineSpec[],
  options: { sourceType?: string; reverses?: string } = {},
): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status, reverses_id)
       VALUES ($1, $2, $3, $4, 0, 'A', $5, $6, $7, 'draft', $8)`,
      [id, b.userId, b.companyId, b.periods[date.slice(0, 4)], date, `Verifikat ${date}`, options.sourceType ?? 'manual', options.reverses ?? null],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       SELECT $1, l.account, l.debit, l.credit, 'SEK', l.n - 1
       FROM unnest($2::text[], $3::numeric[], $4::numeric[]) WITH ORDINALITY AS l(account, debit, credit, n)`,
      [id, lines.map((l) => l.account), lines.map((l) => l.debit ?? 0), lines.map((l) => l.credit ?? 0)],
    )
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    if (options.reverses) {
      await client.query(`UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $1 WHERE id = $2`, [id, options.reverses])
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

/** A bank row on a cash account, optionally booking a verifikat. */
function bankRow(b: Books, cash: string, date: string, amount: number, entry: string | null = null) {
  return insertTransaction({ companyId: b.companyId, userId: b.userId, date, amount, cashAccountId: cash, journalEntryId: entry })
}

/** A bank row that pays `amount` of a verifikat through transaction_voucher_links (the 1:N door). */
async function slice(b: Books, entry: string, date: string, amount: number) {
  const row = await bankRow(b, b.cash1930, date, amount)
  await getPool().query(
    `INSERT INTO public.transaction_voucher_links (id, user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
     VALUES ($1, $2, $3, $4, $5, $6, 'bank_line')`,
    [randomUUID(), b.userId, b.companyId, row, entry, amount],
  )
}

/**
 * The books every case reads: 1 150 ordinary verifikat on 1930 (more than one
 * 1 000-row page, three slices), one verifikat with 1 100 lines on it (a
 * slice past a page), and the shapes the predicates judge.
 */
async function seed(): Promise<Books> {
  const b = await books()
  await bulkVerifikat(b, '1930', 1150)
  await verifikat(b, '2026-04-30', [
    ...Array.from({ length: 1100 }, () => ({ account: '1930', debit: 1 })),
    { account: '3001', credit: 1100 },
  ])
  // An ingående balans, never a candidate, and one so labelled mid-year, an ordinary verifikat.
  await verifikat(b, '2026-01-01', [{ account: '1930', debit: 5000 }, { account: '2099', credit: 5000 }], { sourceType: 'opening_balance' })
  await verifikat(b, '2026-02-10', [{ account: '1930', credit: 300 }, { account: '6570', debit: 300 }], { sourceType: 'opening_balance' })
  // A storno pair: neither the stornerad original nor its storno.
  const original = await verifikat(b, '2026-03-01', [{ account: '1930', credit: 450 }, { account: '6110', debit: 450 }])
  await verifikat(b, '2026-03-02', [{ account: '1930', debit: 450 }, { account: '6110', credit: 450 }], { sourceType: 'storno', reverses: original })
  // A verifikat a bank row books: out of the unlinked list.
  const booked = await verifikat(b, '2026-03-05', [{ account: '1930', credit: 820 }, { account: '6110', debit: 820 }])
  await bankRow(b, b.cash1930, '2026-03-05', -820, booked)
  // 1:N slices: paid in part (listed with its remainder), paid in full (only with include_matched).
  const partly = await verifikat(b, '2026-03-10', [{ account: '1930', debit: 1000 }, { account: '3001', credit: 1000 }])
  await slice(b, partly, '2026-03-10', 400)
  const fully = await verifikat(b, '2026-03-11', [{ account: '1930', debit: 600 }, { account: '3001', credit: 600 }])
  await slice(b, fully, '2026-03-11', 250)
  await slice(b, fully, '2026-03-12', 350)
  // An own-account transfer whose 1940 leg a 1940 row books: still open on 1930.
  const transfer = await verifikat(b, '2026-03-15', [{ account: '1930', credit: 2000 }, { account: '1940', debit: 2000 }])
  await bankRow(b, b.cash1940, '2026-03-15', 2000, transfer)
  return b
}

/** The read as it was before crm#2150: the whole RPC, paged by .range(). */
function pagedRpc(client: SupabaseClient, fn: string, args: Record<string, unknown>) {
  return fetchAllRows<Record<string, unknown>>(({ from, to }) =>
    client.rpc(fn, args).order('entry_date').order('voucher_number').order('line_id').range(from, to),
  )
}

const WINDOWS: Array<[string | undefined, string | undefined]> = [
  [undefined, undefined],
  ['2026-01-01', '2026-12-31'],
  ['2025-06-01', undefined],
]

describe('the bank reconciliation candidate lists (crm#2150)', () => {
  it('answer what their RPCs answer, line for line and in their order', async () => {
    const b = await seed()
    const { client, unsupported } = recordingClient(b.userId)

    for (const account of ['1930', '1940']) {
      for (const [from, to] of WINDOWS) {
        const window = { p_company_id: b.companyId, p_account_number: account, p_date_from: from ?? null, p_date_to: to ?? null }
        const label = `${account} ${from ?? '-'}..${to ?? '-'}`

        const unlinked: UnlinkedGLLine[] = await fetchUnlinkedGLLines(client, b.companyId, account, from, to)
        expect(unlinked, `unlinked ${label}`).toEqual(await pagedRpc(client, 'get_unlinked_gl_lines', window))

        for (const includeMatched of [false, true]) {
          const matching: GLLineForMatching[] = await fetchGLLinesForMatching(client, b.companyId, account, from, to, includeMatched)
          const before = (await pagedRpc(client, 'get_account_gl_lines_for_matching', { ...window, p_include_matched: includeMatched })).map(
            (line) => ({ ...line, linked_transaction_count: Number(line.linked_transaction_count) || 0 }),
          )
          expect(matching, `matching ${label} include_matched=${includeMatched}`).toEqual(before)
        }
      }
    }

    // The lists are the ones the seed means: past a page, verifikat of two
    // series on one day with one number, every shape judged.
    const all = await fetchUnlinkedGLLines(client, b.companyId, '1930')
    expect(all.length).toBeGreaterThan(2000)
    const ties = all.filter(
      (line, i) => i > 0 && line.entry_date === all[i - 1].entry_date && line.voucher_number === all[i - 1].voucher_number
        && line.voucher_series !== all[i - 1].voucher_series,
    )
    expect(ties.length).toBeGreaterThan(50)
    const seeded = (lines: UnlinkedGLLine[], date: string) =>
      lines.filter((line) => line.entry_date === date && line.entry_description === `Verifikat ${date}`)
    expect(seeded(all, '2026-04-30')).toHaveLength(1100)
    expect(seeded(all, '2026-01-01')).toEqual([])
    expect(seeded(all, '2026-02-10').map((line) => line.source_type)).toEqual(['opening_balance'])
    expect([...seeded(all, '2026-03-01'), ...seeded(all, '2026-03-02'), ...seeded(all, '2026-03-05')]).toEqual([])
    expect(seeded(all, '2026-03-10').map((line) => Number(line.remaining_amount))).toEqual([600])
    expect([...seeded(all, '2026-03-11'), ...seeded(all, '2026-03-15')]).toEqual([])
    const withMatched = await fetchGLLinesForMatching(client, b.companyId, '1930', undefined, undefined, true)
    expect(seeded(withMatched, '2026-03-11').map((line) => (line as GLLineForMatching).linked_transaction_count)).toEqual([2])
    const open = await fetchGLLinesForMatching(client, b.companyId, '1930')
    expect(seeded(open, '2026-03-15').map((line) => line.credit_amount)).toEqual([2000])
    expect(unsupported).toEqual([])
  }, 120_000)

  it('compute the window once and judge each verifikat once, never a page of the whole RPC', async () => {
    const b = await seed()
    const { client, calls, unsupported } = recordingClient(b.userId)

    const unlinked = await fetchUnlinkedGLLines(client, b.companyId, '1930')
    const unlinkedCalls = calls.splice(0)
    const matching = await fetchGLLinesForMatching(client, b.companyId, '1930', undefined, undefined, true)
    const matchingCalls = calls.splice(0)

    for (const [read, readCalls, narrowing, predicate, whole, args] of [
      [unlinked, unlinkedCalls, 'bank_account_unlinked_entries', 'bank_account_unlinked_lines', 'get_unlinked_gl_lines', {}],
      [matching, matchingCalls, 'bank_account_candidate_entries', 'bank_account_candidate_lines', 'get_account_gl_lines_for_matching', { p_include_matched: true }],
    ] as const) {
      expect(read.length).toBeGreaterThan(2000)
      // The whole window is computed once, by the narrowing, and never paged.
      expect(readCalls.filter((c) => c.fn === whole)).toEqual([])
      expect(readCalls.filter((c) => c.fn === narrowing)).toHaveLength(1)
      // Each verifikat the narrowing names is handed to the predicate in one
      // slice, of at most 500. Only the slice that holds the verifikat with
      // 1 100 lines on the account is asked again, for its second page.
      const { data: named } = await client.rpc(narrowing, {
        p_company_id: b.companyId, p_account_number: '1930', p_date_from: null, p_date_to: null, ...args,
      })
      const slices = readCalls.filter((c) => c.fn === predicate).map((c) => c.args.p_entry_ids as string[])
      const distinct = [...new Map(slices.map((ids) => [ids.join(), ids])).values()]
      expect(distinct.flat().sort()).toEqual([...(named as string[])].sort())
      expect(slices).toHaveLength(distinct.length + 1)
      expect(Math.max(...distinct.map((ids) => ids.length))).toBeLessThanOrEqual(500)
    }
    expect(unsupported).toEqual([])
  }, 120_000)

  it('tell a signed-in user of another company nothing', async () => {
    const b = await seed()
    const stranger = await insertAuthUser()
    const elsewhere = await insertCompany({ createdBy: stranger })
    await insertCompanyMember({ companyId: elsewhere, userId: stranger, role: 'owner' })
    const { client, calls, unsupported } = recordingClient(stranger)

    expect(await fetchUnlinkedGLLines(client, b.companyId, '1930')).toEqual([])
    expect(await fetchGLLinesForMatching(client, b.companyId, '1930', undefined, undefined, true)).toEqual([])
    expect(calls.map((c) => c.fn)).toEqual(['bank_account_unlinked_entries', 'bank_account_candidate_entries'])
    // Nothing because the narrowing names nothing, not because a read failed:
    // the matching read answers [] on a failure too.
    const window = { p_company_id: b.companyId, p_account_number: '1930', p_date_from: null, p_date_to: null }
    expect(await client.rpc('bank_account_unlinked_entries', window)).toMatchObject({ data: [], error: null })
    expect(await client.rpc('bank_account_candidate_entries', { ...window, p_include_matched: true })).toMatchObject({ data: [], error: null })
    expect(unsupported).toEqual([])
  }, 120_000)
})
