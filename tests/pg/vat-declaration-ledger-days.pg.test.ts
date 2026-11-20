/**
 * The momsdeklaration figure and its drill-down read the period through
 * vat_declaration_special_entries and, once the company is built, through
 * ledger_account_days (migration 20261023094030). They must return exactly
 * what the bodies they replace returned: 20261021000500's, loaded from their
 * migration file into pg_temp on one connection and run against the same
 * ledgers.
 *
 * The ledgers hold every class those bodies tell apart:
 *   - both momsredovisning shapes (2650/1650 with a declaration account; a
 *     pure 26xx movement against the skattekonto, with and without 3740) and
 *     their near misses, a tagged vat_settlement, an enskild firma's 2012;
 *   - storno pairs and a rättelse (storno plus correction);
 *   - the opening balance chains: an IB on the period's first day with its
 *     storno and replacement (carried), IBs dated inside a period with
 *     nothing earlier in it (counted) with a 2650 line, their storno and a
 *     rättelse, an IB booking a resultatkonto (an ordinary verifikat), a
 *     year-end roll-forward into a räkenskapsår starting mid-quarter with the
 *     earlier verifikat in the books (carried) and its storno;
 *   - the kontantmetod cut-off and its vändning (left out);
 *   - a posted bokslut (left out) and a reversed one with its storno (kept).
 * Every month, quarter and year and some odd ranges must give the identical
 * JSON, for two account-list shapes (the app's, and a measured list that
 * leaves out declaration accounts), and every page of the drill-down the
 * identical rows: for built companies (ledger_account_days_ready) and for
 * companies the build cron has not reached, as the superuser and as the
 * company's own user under RLS.
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { getClient, getPool } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from './fixtures'
import { markReversed, nextSeq, postStorno, stornoEntry, type CashCompany } from './kontantmetod-carry-fixtures'

const RUTA_ACCOUNTS = ['2611', '2614', '2621', '2641', '2645', '3001', '3308', '3980', '4535']
const NET_ACCOUNTS = ['2650', '1650']
/** What the app passes as p_accounts: the declaration and net accounts, plus a company account. */
const APP_MEASURED = [...RUTA_ACCOUNTS, ...NET_ACCOUNTS, '3041']
/** A measured list without most declaration accounts: shape 1 reads only what is measured. */
const NARROW_MEASURED = ['2611', '2650', '3001', '1930']
const DRILL_ACCOUNT_LISTS: string[][] = [
  ...[...RUTA_ACCOUNTS, ...NET_ACCOUNTS, '3041', '1630', '2012'].map((a) => [a]),
  ['2611', '2621'],
  ['3308', '3001', '3041'],
]

type Line = [account: string, debit: number, credit: number]

function months(fromYear: number, fromMonth: number, count: number): Array<[string, string]> {
  return Array.from({ length: count }, (_, i): [string, string] => {
    const start = new Date(Date.UTC(fromYear, fromMonth - 1 + i, 1))
    const end = new Date(Date.UTC(fromYear, fromMonth + i, 0))
    return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)]
  })
}

const PERIODS: Array<[string, string]> = [
  ...months(2025, 1, 25),
  ...[0, 3, 6, 9, 12, 15, 18, 21, 24].map((offset): [string, string] => {
    const start = new Date(Date.UTC(2025, offset, 1))
    const end = new Date(Date.UTC(2025, offset + 3, 0))
    return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)]
  }),
  ['2025-01-01', '2025-12-31'],
  ['2026-01-01', '2026-12-31'],
  ['2025-05-01', '2026-04-30'],
  ['2026-05-01', '2027-04-30'],
  ['2025-12-15', '2026-01-15'],
  ['2026-01-01', '2026-01-01'],
  ['2026-01-02', '2026-03-31'],
  ['2026-02-10', '2026-02-28'],
  ['2026-02-11', '2026-03-31'],
  ['2026-12-31', '2026-12-31'],
  ['2025-01-01', '2027-12-31'],
]

/** Periods the drill-down is paged through for every account list. */
const DRILL_PERIODS: Array<[string, string]> = [
  ['2026-01-01', '2026-03-31'],
  ['2026-04-01', '2026-06-30'],
  ['2026-10-01', '2026-12-31'],
  ['2026-02-01', '2026-02-28'],
  ['2026-12-01', '2027-01-31'],
  ['2026-01-01', '2026-12-31'],
]

/** The CREATE FUNCTION statement for `name` in a migration, renamed into pg_temp. */
function oldFunction(sql: string, name: string, tempName: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  const bodyEnd = sql.indexOf('$$;', sql.indexOf('AS $$', start)) + 3
  return sql
    .slice(start, bodyEnd)
    .replace(`CREATE OR REPLACE FUNCTION public.${name}(`, `CREATE FUNCTION pg_temp.${tempName}(`)
}

interface Ledger {
  userId: string
  companyId: string
  fiscalPeriodIds: Record<string, string>
}

async function seedLedger(
  entityType: 'aktiebolag' | 'enskild_firma',
  years: Array<{ name: string; start: string; end: string }>,
): Promise<Ledger & {
  post: (year: string, entryDate: string, lines: Line[], sourceType?: string, sourceId?: string | null) => Promise<string>
  company: (year: string) => CashCompany
}> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId, entityType })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const fiscalPeriodIds: Record<string, string> = {}
  for (const year of years) {
    fiscalPeriodIds[year.name] = await insertFiscalPeriod({
      userId, companyId, name: year.name, periodStart: year.start, periodEnd: year.end,
    })
  }
  const post = (year: string, entryDate: string, lines: Line[], sourceType = 'manual', sourceId: string | null = null) =>
    insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId: fiscalPeriodIds[year],
      voucherNumber: nextSeq() % 1_000_000_000,
      entryDate,
      description: `ledger days parity ${entryDate}`,
      sourceType,
      sourceId,
      lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })),
    })
  const company = (year: string): CashCompany => ({
    userId, companyId, fiscalPeriodId: fiscalPeriodIds[year], nextPeriodId: fiscalPeriodIds[year],
  })
  return { userId, companyId, fiscalPeriodIds, post, company }
}

/** correctEntry's writes: the storno, the rättelse (correction_of_id), the original marked reversed. */
async function correctLike(company: CashCompany, entryId: string, lines: Line[], date: string): Promise<void> {
  const stornoId = await postStorno(company, entryId, { date })
  const correctionId = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, correction_of_id, status)
       SELECT $1, e.user_id, e.company_id, $5, $2, 'A', $3,
              'Rättelse: ' || e.description, 'correction', e.id, 'draft'
       FROM public.journal_entries e WHERE e.id = $4`,
      [correctionId, nextSeq() % 1_000_000_000, date, entryId, company.fiscalPeriodId],
    )
    for (const [index, [account, debit, credit]] of lines.entries()) {
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
         VALUES ($1, $2, $3, $4, 'SEK', $5)`,
        [correctionId, account, debit, credit, index],
      )
    }
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [correctionId])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  await markReversed(entryId, stornoId)
}

// One verifikat of each kind; the busy ledgers cycle through them.
const KINDS: Array<{ lines: Line[]; sourceType?: string }> = [
  { lines: [['1930', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]], sourceType: 'invoice_created' },
  { lines: [['2641', 80, 0], ['6110', 320, 0], ['1930', 0, 400]] },
  { lines: [['2645', 25, 0], ['2614', 0, 25], ['4535', 100, 0], ['2440', 0, 100]] },
  { lines: [['1510', 560, 0], ['3041', 0, 500], ['2621', 0, 60]], sourceType: 'invoice_created' },
  { lines: [['1930', 900, 0], ['3308', 0, 900]] },
  // Shape 1: a declaration account and 2650, with a cost line, and 1650.
  { lines: [['2611', 250, 0], ['2641', 0, 80], ['2650', 0, 170]] },
  { lines: [['2611', 100, 0], ['2650', 0, 90], ['6570', 0, 10]] },
  { lines: [['2641', 0, 80], ['1650', 80, 0]] },
  // Shape 2: pure 26xx against the skattekonto, with and without öresavrundning.
  { lines: [['1630', 300, 0], ['2611', 0, 300]] },
  { lines: [['2611', 100.4, 0], ['1630', 0, 100], ['3740', 0, 0.4]] },
  // Near misses that keep counting.
  { lines: [['5410', 400, 0], ['2641', 100, 0], ['1630', 0, 500]] },
  { lines: [['1630', 1000, 0], ['3980', 0, 1000]] },
  { lines: [['2650', 150, 0], ['1630', 0, 150]] },
  { lines: [['1930', 500, 0], ['2650', 0, 500]] },
  // Tagged: left out by its source type.
  { lines: [['2611', 250, 0], ['2650', 0, 250]], sourceType: 'vat_settlement' },
]

let client: PoolClient
const ledgers: Ledger[] = []

beforeAll(async () => {
  // A: a busy aktiebolag over three calendar years.
  const a = await seedLedger('aktiebolag', [
    { name: '2025', start: '2025-01-01', end: '2025-12-31' },
    { name: '2026', start: '2026-01-01', end: '2026-12-31' },
    { name: '2027', start: '2027-01-01', end: '2027-12-31' },
  ])
  ledgers.push(a)
  for (let i = 0; i < 120; i += 1) {
    const kind = KINDS[i % KINDS.length]
    await a.post('2025', new Date(Date.UTC(2025, 0, 2 + i * 3)).toISOString().slice(0, 10), kind.lines, kind.sourceType)
  }
  const closing2025 = await a.post('2025', '2025-12-31', [['3001', 8000, 0], ['3308', 7200, 0], ['2099', 0, 15200]], 'year_end')
  await getPool().query(`UPDATE public.fiscal_periods SET closing_entry_id = $1 WHERE id = $2`, [closing2025, a.fiscalPeriodIds['2025']])
  // Last year's VAT carried in on the first day, annulled and booked again.
  const carried = await a.post(
    '2026', '2026-01-01',
    [['2641', 500, 0], ['2645', 100, 0], ['2614', 0, 100], ['2650', 0, 300], ['2099', 0, 200]],
    'opening_balance',
  )
  await stornoEntry(a.company('2026'), carried, { date: '2026-01-01' })
  await a.post('2026', '2026-01-01', [['1650', 396, 0], ['2099', 0, 396]], 'opening_balance')
  // Marked as an opening balance in bank reconciliation: an ordinary purchase.
  await a.post('2026', '2026-01-15', [['6540', 100, 0], ['2645', 25, 0], ['2614', 0, 25], ['1930', 0, 100]], 'opening_balance')
  for (let i = 0; i < 360; i += 1) {
    const kind = KINDS[i % KINDS.length]
    const id = await a.post('2026', new Date(Date.UTC(2026, 0, 2 + i)).toISOString().slice(0, 10), kind.lines, kind.sourceType)
    // Every 25th verifikat is annulled the next week: an ordinary storno pair.
    if (i % 25 === 0) await stornoEntry(a.company('2026'), id, { date: new Date(Date.UTC(2026, 0, 9 + i)).toISOString().slice(0, 10) })
  }
  const sale = await a.post('2026', '2026-03-03', [['1930', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]])
  await correctLike(a.company('2026'), sale, [['1930', 1500, 0], ['3001', 0, 1200], ['2611', 0, 300]], '2026-03-20')
  // The 2026 bokslut, booked and then undone: reversed with its storno, both kept.
  const closing2026 = await a.post('2026', '2026-12-31', [['3001', 90000, 0], ['2099', 0, 90000]], 'year_end')
  await getPool().query(`UPDATE public.fiscal_periods SET closing_entry_id = $1 WHERE id = $2`, [closing2026, a.fiscalPeriodIds['2026']])
  await stornoEntry(a.company('2026'), closing2026, { date: '2026-12-31' })
  // The legacy kontantmetod cut-off and its vändning on the next year's first day.
  const cutoffs: Array<[string, string, string, Line[]]> = [
    ['receivable', '2026', '2026-12-31', [['1510', 1250, 0], ['3001', 0, 1000], ['2618', 0, 250]]],
    ['receivable_reversal', '2027', '2027-01-01', [['1510', 0, 1250], ['3001', 1000, 0], ['2618', 250, 0]]],
    ['payable', '2026', '2026-12-31', [['2440', 0, 500], ['2648', 100, 0], ['6110', 400, 0]]],
    ['payable_reversal', '2027', '2027-01-01', [['2440', 500, 0], ['2648', 0, 100], ['6110', 0, 400]]],
  ]
  for (const [kind, year, date, lines] of cutoffs) {
    const id = await a.post(year, date, lines, 'year_end', a.fiscalPeriodIds['2026'])
    await getPool().query(
      `INSERT INTO public.kontantmetod_cutoff_entries (company_id, fiscal_period_id, kind, journal_entry_id)
       VALUES ($1, $2, $3, $4)`,
      [a.companyId, a.fiscalPeriodIds['2026'], kind, id],
    )
  }
  await a.post('2027', '2027-01-12', [['1930', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]], 'invoice_created')
  await a.post('2027', '2027-01-20', [['2611', 250, 0], ['2650', 0, 250]])

  // B: a migration on 10 February: opening balances dated inside the period
  // with nothing of it before them in the books.
  const b = await seedLedger('aktiebolag', [{ name: '2026', start: '2026-01-01', end: '2026-12-31' }])
  ledgers.push(b)
  const counted = await b.post(
    '2026', '2026-02-10',
    [['2641', 40, 0], ['2611', 0, 500], ['2650', 0, 300], ['1930', 760, 0]],
    'opening_balance',
  )
  await stornoEntry(b.company('2026'), counted, { date: '2026-02-10' })
  await b.post('2026', '2026-02-10', [['2641', 40, 0], ['2611', 0, 500], ['1930', 460, 0]], 'opening_balance')
  const corrected = await b.post('2026', '2026-02-10', [['2645', 30, 0], ['2614', 0, 30], ['1650', 0, 0.5], ['2099', 0.5, 0]], 'opening_balance')
  await correctLike(b.company('2026'), corrected, [['2641', 30, 0], ['2099', 0, 30]], '2026-02-10')
  for (let i = 0; i < 70; i += 1) {
    const kind = KINDS[i % KINDS.length]
    await b.post('2026', new Date(Date.UTC(2026, 1, 11 + i * 2)).toISOString().slice(0, 10), kind.lines, kind.sourceType)
  }

  // C: a räkenskapsår starting 1 May; the roll-forward dates its IB inside Q2.
  const c = await seedLedger('aktiebolag', [
    { name: '2025/26', start: '2025-05-01', end: '2026-04-30' },
    { name: '2026/27', start: '2026-05-01', end: '2027-04-30' },
  ])
  ledgers.push(c)
  await c.post('2025/26', '2026-04-15', [['1930', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]])
  await c.post('2025/26', '2026-04-28', [['2611', 250, 0], ['2641', 0, 80], ['2650', 0, 170]])
  const rolled = await c.post('2026/27', '2026-05-01', [['1930', 0, 250], ['2611', 0, 250], ['2099', 500, 0]], 'opening_balance')
  await c.post('2026/27', '2026-06-10', [['1930', 625, 0], ['3001', 0, 500], ['2611', 0, 125]])
  await stornoEntry(c.company('2026/27'), rolled, { date: '2026-05-01' })

  // D: an enskild firma, whose skattekonto shape also reads 2012.
  const d = await seedLedger('enskild_firma', [{ name: '2026', start: '2026-01-01', end: '2026-12-31' }])
  ledgers.push(d)
  const firmKinds: Line[][] = [
    [['2012', 300, 0], ['2611', 0, 300]],
    [['1630', 200, 0], ['2641', 0, 200]],
    [['2012', 100, 0], ['3980', 0, 100]],
    [['2611', 100.4, 0], ['2012', 0, 100], ['3740', 0, 0.4]],
    [['1930', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]],
    [['2641', 50, 0], ['6110', 200, 0], ['2012', 0, 250]],
  ]
  for (let i = 0; i < 60; i += 1) {
    await d.post('2026', new Date(Date.UTC(2026, 0, 3 + i * 6)).toISOString().slice(0, 10), firmKinds[i % firmKinds.length])
  }

  const migration = readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20261021000500_vat_totals_carried_entries_one_shape_pass.sql'),
    'utf8',
  )
  client = await getClient()
  await client.query(oldFunction(migration, 'get_vat_declaration_totals', 'old_vat_totals'))
  await client.query(oldFunction(migration, 'get_vat_ruta_source_lines', 'old_vat_ruta_source_lines'))
}, 600_000)

afterAll(async () => {
  if (!client) return
  await client.query('DROP FUNCTION IF EXISTS pg_temp.old_vat_totals(uuid, date, date, text[], text[], text[])')
  await client.query(
    'DROP FUNCTION IF EXISTS pg_temp.old_vat_ruta_source_lines(uuid, date, date, text[], text[], text[], date, integer, uuid, uuid, integer)',
  )
  client.release()
})

/** Every (ledger, period, account list) whose figure differs, and how many shaped / counted entries were seen. */
async function compareFigures(db: PoolClient, measuredLists: string[][]) {
  const differing: string[] = []
  let shaped = 0
  let countedOpeningBalances = 0
  for (const ledger of ledgers) {
    for (const [start, end] of PERIODS) {
      for (const measured of measuredLists) {
        const args = [ledger.companyId, start, end, measured, RUTA_ACCOUNTS, NET_ACCOUNTS]
        const { rows: [now] } = await db.query('SELECT public.get_vat_declaration_totals($1,$2,$3,$4,$5,$6)::text AS payload', args)
        const { rows: [before] } = await db.query('SELECT pg_temp.old_vat_totals($1,$2,$3,$4,$5,$6)::text AS payload', args)
        if (now.payload !== before.payload) differing.push(`${ledger.companyId} ${start}..${end} ${measured.length}`)
        const parsed = JSON.parse(now.payload)
        shaped += parsed.settlement_shaped_entries.length
        countedOpeningBalances += parsed.counted_opening_balances.length
      }
    }
  }
  return { differing, shaped, countedOpeningBalances }
}

/** Every drill-down page that differs, paging 7 rows at a time from the old body's cursor. */
async function compareDrillDowns(db: PoolClient) {
  const differing: string[] = []
  let rowsSeen = 0
  for (const ledger of ledgers) {
    for (const [start, end] of DRILL_PERIODS) {
      for (const accounts of DRILL_ACCOUNT_LISTS) {
        let cursor: [string | null, number | null, string | null, string | null] = [null, null, null, null]
        for (let page = 0; page < 200; page += 1) {
          const args = [ledger.companyId, start, end, accounts, RUTA_ACCOUNTS, NET_ACCOUNTS, ...cursor, 7]
          const { rows: now } = await db.query(
            'SELECT r.*, r.entry_date::text AS day FROM public.get_vat_ruta_source_lines($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) r', args,
          )
          const { rows: before } = await db.query(
            'SELECT r.*, r.entry_date::text AS day FROM pg_temp.old_vat_ruta_source_lines($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) r', args,
          )
          if (JSON.stringify(now) !== JSON.stringify(before)) {
            differing.push(`${ledger.companyId} ${start}..${end} ${accounts.join(',')} page ${page}`)
          }
          rowsSeen += before.length
          if (before.length < 7) break
          const last = before[before.length - 1]
          cursor = [last.day, last.voucher_number, last.journal_entry_id, last.line_id]
        }
      }
    }
  }
  return { differing, rowsSeen }
}

/** Runs `fn` on the pg_temp connection as the ledger's own user, under RLS. */
async function asUser<T>(ledger: Ledger, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN')
  try {
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: ledger.userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ledger.userId])
    await client.query('SET LOCAL ROLE authenticated')
    return await fn()
  } finally {
    await client.query('ROLLBACK')
  }
}

describe('the momsdeklaration through ledger_account_days (20261023094030)', () => {
  it('reads built companies from ledger_account_days', async () => {
    const { rows } = await getPool().query(
      'SELECT bool_and(public.ledger_account_days_ready(id)) AS ready FROM unnest($1::uuid[]) id',
      [ledgers.map((l) => l.companyId)],
    )
    expect(rows[0].ready).toBe(true)
  })

  it('returns the identical figure for every period and both account lists', async () => {
    const { differing, shaped, countedOpeningBalances } = await compareFigures(client, [APP_MEASURED, NARROW_MEASURED])
    expect(differing).toEqual([])
    // The ledgers really exercise the shapes and the counted opening balances.
    expect(shaped).toBeGreaterThan(500)
    expect(countedOpeningBalances).toBeGreaterThan(0)
  }, 600_000)

  it('lists the identical drill-down rows on every page', async () => {
    const { differing, rowsSeen } = await compareDrillDowns(client)
    expect(differing).toEqual([])
    expect(rowsSeen).toBeGreaterThan(1000)
  }, 600_000)

  it('returns the identical figure and drill-down to the company\'s own user under RLS', async () => {
    for (const ledger of ledgers) {
      const differing = await asUser(ledger, async () => {
        const found: string[] = []
        for (const [start, end] of PERIODS) {
          const args = [ledger.companyId, start, end, APP_MEASURED, RUTA_ACCOUNTS, NET_ACCOUNTS]
          const { rows: [now] } = await client.query('SELECT public.get_vat_declaration_totals($1,$2,$3,$4,$5,$6)::text AS payload', args)
          const { rows: [before] } = await client.query('SELECT pg_temp.old_vat_totals($1,$2,$3,$4,$5,$6)::text AS payload', args)
          if (now.payload !== before.payload) found.push(`${start}..${end}`)
        }
        for (const [start, end] of DRILL_PERIODS) {
          for (const accounts of DRILL_ACCOUNT_LISTS) {
            const args = [ledger.companyId, start, end, accounts, RUTA_ACCOUNTS, NET_ACCOUNTS]
            const { rows: now } = await client.query(
              'SELECT * FROM public.get_vat_ruta_source_lines($1,$2,$3,$4,$5,$6, NULL, NULL, NULL, NULL, 501)', args,
            )
            const { rows: before } = await client.query(
              'SELECT * FROM pg_temp.old_vat_ruta_source_lines($1,$2,$3,$4,$5,$6, NULL, NULL, NULL, NULL, 501)', args,
            )
            if (JSON.stringify(now) !== JSON.stringify(before)) found.push(`${start}..${end} ${accounts.join(',')}`)
          }
        }
        return found
      })
      expect(differing).toEqual([])
    }
  }, 600_000)

  it('another company\'s user sees nothing of the ledger, as before', async () => {
    const outsider = await insertAuthUser()
    const otherCompany = await insertCompany({ createdBy: outsider })
    await insertCompanyMember({ companyId: otherCompany, userId: outsider, role: 'owner' })
    const [ledger] = ledgers
    const [now, before] = await asUser({ ...ledger, userId: outsider }, async () => {
      const args = [ledger.companyId, '2026-01-01', '2026-12-31', APP_MEASURED, RUTA_ACCOUNTS, NET_ACCOUNTS]
      const { rows: [n] } = await client.query('SELECT public.get_vat_declaration_totals($1,$2,$3,$4,$5,$6) AS payload', args)
      const { rows: [b] } = await client.query('SELECT pg_temp.old_vat_totals($1,$2,$3,$4,$5,$6) AS payload', args)
      return [n.payload, b.payload]
    })
    expect(now).toEqual({ totals: [], settlement_shaped_entries: [], source_type_counts: {}, counted_opening_balances: [] })
    expect(now).toEqual(before)
  })

  it('returns the identical figure and drill-down before the build cron reaches the company', async () => {
    const ids = ledgers.map((l) => l.companyId)
    await getPool().query('DELETE FROM public.ledger_account_days_companies WHERE company_id = ANY($1::uuid[])', [ids])
    try {
      const { rows } = await getPool().query(
        'SELECT bool_or(public.ledger_account_days_ready(id)) AS ready FROM unnest($1::uuid[]) id', [ids],
      )
      expect(rows[0].ready).toBe(false)
      const figures = await compareFigures(client, [APP_MEASURED, NARROW_MEASURED])
      expect(figures.differing).toEqual([])
      expect(figures.shaped).toBeGreaterThan(500)
      const drillDowns = await compareDrillDowns(client)
      expect(drillDowns.differing).toEqual([])
    } finally {
      await getPool().query(
        'INSERT INTO public.ledger_account_days_companies (company_id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING',
        [ids],
      )
    }
  }, 600_000)
})
