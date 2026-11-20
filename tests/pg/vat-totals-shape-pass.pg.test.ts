/**
 * The momsredovisning shapes read in one pass give the same figure as the
 * correlated subqueries they replace (crm#1331, migration 20261021000500).
 *
 * The old bodies (20261015030000, the latest before this change) are loaded
 * from their migration file into pg_temp on one connection and run against
 * the same ledger as the live functions: a year of verifikat covering every
 * shape and every near miss (a business verifikat on the skattekonto, a
 * bidrag received on it, 2650 paid from it, a settlement with a cost line,
 * öresavrundning, a tagged settlement, an ordinary storno pair). No opening
 * balance is seeded: those changed on purpose (crm#1333,
 * tests/pg/vat-totals-carried-entries.pg.test.ts). Every month, every quarter
 * and the year must come back as identical JSON, and the drill-down as the
 * identical rows, account by account.
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { PoolClient } from 'pg'
import { getClient } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from './fixtures'
import { nextSeq, stornoEntry, type CashCompany } from './kontantmetod-carry-fixtures'

const RUTA_ACCOUNTS = ['2611', '2614', '2641', '2645', '3001', '3980']
const NET_ACCOUNTS = ['2650', '1650']
const ALL_ACCOUNTS = [...RUTA_ACCOUNTS, ...NET_ACCOUNTS]

type Line = [account: string, debit: number, credit: number]

// One verifikat of each kind; the seed cycles through them over the year.
const KINDS: Array<{ lines: Line[]; sourceType?: string }> = [
  { lines: [['1930', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]], sourceType: 'invoice_created' },
  { lines: [['2641', 80, 0], ['6110', 320, 0], ['1930', 0, 400]] },
  { lines: [['2645', 25, 0], ['2614', 0, 25], ['4535', 100, 0], ['2440', 0, 100]] },
  // Shape 1: a declaration account and 2650, plus one with a cost line, plus 1650.
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
  // Tagged: left out by source type, never listed as shaped.
  { lines: [['2611', 250, 0], ['2650', 0, 250]], sourceType: 'vat_settlement' },
]

const PERIODS: Array<[string, string]> = [
  ...Array.from({ length: 12 }, (_, i): [string, string] => {
    const month = String(i + 1).padStart(2, '0')
    const last = new Date(Date.UTC(2026, i + 1, 0)).getUTCDate()
    return [`2026-${month}-01`, `2026-${month}-${last}`]
  }),
  ['2026-01-01', '2026-03-31'],
  ['2026-04-01', '2026-06-30'],
  ['2026-07-01', '2026-09-30'],
  ['2026-10-01', '2026-12-31'],
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

let client: PoolClient
let companyId: string

beforeAll(async () => {
  const userId = await insertAuthUser()
  companyId = await insertCompany({ createdBy: userId })
  const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
  const company: CashCompany = { userId, companyId, fiscalPeriodId, nextPeriodId: fiscalPeriodId }

  for (let i = 0; i < 360; i += 1) {
    const kind = KINDS[i % KINDS.length]
    const day = new Date(Date.UTC(2026, 0, 1 + i))
    const id = await insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      voucherNumber: nextSeq() % 1_000_000_000,
      entryDate: day.toISOString().slice(0, 10),
      description: `shape pass ${i}`,
      sourceType: kind.sourceType ?? 'manual',
      lines: kind.lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })),
    })
    // Every 25th verifikat is annulled the next week: an ordinary storno pair.
    if (i % 25 === 0) {
      await stornoEntry(company, id, { date: new Date(Date.UTC(2026, 0, 8 + i)).toISOString().slice(0, 10) })
    }
  }

  const migration = readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20261015030000_company_skattekonto_account.sql'),
    'utf8',
  )
  client = await getClient()
  await client.query(oldFunction(migration, 'get_vat_declaration_totals', 'old_vat_totals'))
  await client.query(oldFunction(migration, 'get_vat_ruta_source_lines', 'old_vat_ruta_source_lines'))
}, 120_000)

afterAll(async () => {
  if (!client) return
  await client.query('DROP FUNCTION IF EXISTS pg_temp.old_vat_totals(uuid, date, date, text[], text[], text[])')
  await client.query(
    'DROP FUNCTION IF EXISTS pg_temp.old_vat_ruta_source_lines(uuid, date, date, text[], text[], text[], date, integer, uuid, uuid, integer)',
  )
  client.release()
})

describe('the shapes in one pass (crm#1331)', () => {
  it('returns the identical figure for every month, quarter and the year', async () => {
    const differing: string[] = []
    let shaped = 0
    for (const [start, end] of PERIODS) {
      const args = [companyId, start, end, ALL_ACCOUNTS, RUTA_ACCOUNTS, NET_ACCOUNTS]
      const { rows: [now] } = await client.query(
        'SELECT public.get_vat_declaration_totals($1,$2,$3,$4,$5,$6) AS payload', args,
      )
      const { rows: [before] } = await client.query('SELECT pg_temp.old_vat_totals($1,$2,$3,$4,$5,$6) AS payload', args)
      // The old payload's three keys, unchanged; counted_opening_balances is
      // the one added key, empty here (no opening balance is seeded).
      const { counted_opening_balances: counted, ...figureNow } = now.payload
      if (JSON.stringify(figureNow) !== JSON.stringify(before.payload)) differing.push(`${start}..${end}`)
      if (JSON.stringify(counted) !== '[]') differing.push(`${start}..${end} counted_opening_balances`)
      shaped += now.payload.settlement_shaped_entries.length
    }
    expect(differing).toEqual([])
    // The fixture really exercises both shapes (5 of the 12 kinds are shaped).
    expect(shaped).toBeGreaterThan(100)
  }, 120_000)

  it('lists the identical drill-down rows, account by account', async () => {
    const differing: string[] = []
    for (const [start, end] of [PERIODS[12], PERIODS[16]]) {
      for (const account of ALL_ACCOUNTS) {
        const args = [companyId, start, end, [account], RUTA_ACCOUNTS, NET_ACCOUNTS]
        const { rows: now } = await client.query(
          'SELECT * FROM public.get_vat_ruta_source_lines($1,$2,$3,$4,$5,$6, NULL, NULL, NULL, NULL, 501)', args,
        )
        const { rows: before } = await client.query(
          'SELECT * FROM pg_temp.old_vat_ruta_source_lines($1,$2,$3,$4,$5,$6, NULL, NULL, NULL, NULL, 501)', args,
        )
        if (JSON.stringify(now) !== JSON.stringify(before)) differing.push(`${start}..${end} ${account}`)
      }
    }
    expect(differing).toEqual([])
  }, 120_000)
})
