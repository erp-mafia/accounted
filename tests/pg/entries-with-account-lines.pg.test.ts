/**
 * get_entries_with_account_lines (migration 20261023094040): the verifikat of
 * a period with a line on given accounts, with their lines, in one call. The
 * periodisk sammanställning reads its EU sales with it and the
 * reverse-charge basis scan its fiktiv moms.
 *
 * Pinned against a plain query of the definition (every posted/reversed
 * verifikat of the company dated in the period, with the given status, that
 * has a line on the accounts; its lines on them or all of them; ordered by
 * id, the lines by account, sort_order and id), for many periods and account
 * sets, for a built company (the days come from ledger_account_days) and one
 * the build cron has not reached, and scoped by RLS to the caller.
 */
import { beforeAll, describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from './fixtures'
import { nextSeq, stornoEntry, type CashCompany } from './kontantmetod-carry-fixtures'

type Line = [account: string, debit: number, credit: number]

const ACCOUNT_SETS: string[][] = [
  ['3308', '3108', '3107'],
  ['2614', '2624', '2634'],
  ['3308'],
  ['2611'],
  ['1930', '3308'],
  [],
]

const PERIODS: Array<[string, string]> = [
  ['2026-01-01', '2026-01-31'],
  ['2026-02-01', '2026-02-28'],
  ['2026-03-01', '2026-03-31'],
  ['2026-01-01', '2026-03-31'],
  ['2026-04-01', '2026-06-30'],
  ['2026-01-01', '2026-12-31'],
  ['2026-02-14', '2026-02-14'],
  ['2025-12-01', '2026-01-15'],
]

let userId: string
let companyId: string
let otherCompanyId: string
let draftId: string

/** The definition, as a plain query: what the function must return. */
async function expected(company: string, start: string, end: string, accounts: string[], statuses: string[], allLines: boolean) {
  const { rows } = await getPool().query(
    `SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'id', e.id, 'voucher_series', e.voucher_series, 'voucher_number', e.voucher_number,
              'entry_date', e.entry_date, 'description', e.description, 'status', e.status,
              'source_type', e.source_type, 'source_id', e.source_id, 'reverses_id', e.reverses_id,
              'correction_of_id', e.correction_of_id,
              'lines', (
                SELECT jsonb_agg(jsonb_build_object('id', l.id, 'account_number', l.account_number,
                         'debit_amount', l.debit_amount, 'credit_amount', l.credit_amount)
                       ORDER BY l.account_number, l.sort_order, l.id)
                FROM public.journal_entry_lines l
                WHERE l.journal_entry_id = e.id AND ($6 OR l.account_number = ANY ($4))
              )) ORDER BY e.id), '[]'::jsonb)::text AS rows
     FROM public.journal_entries e
     WHERE e.company_id = $1 AND e.status = ANY ($5) AND e.entry_date BETWEEN $2 AND $3
       AND EXISTS (SELECT 1 FROM public.journal_entry_lines a WHERE a.journal_entry_id = e.id AND a.account_number = ANY ($4))`,
    [company, start, end, accounts, statuses, allLines],
  )
  return rows[0].rows as string
}

async function actual(company: string, start: string, end: string, accounts: string[], statuses: string[], allLines: boolean) {
  const { rows } = await getPool().query(
    'SELECT public.get_entries_with_account_lines($1, $2, $3, $4, $5, $6)::text AS rows',
    [company, start, end, accounts, statuses, allLines],
  )
  return rows[0].rows as string
}

async function differing(): Promise<string[]> {
  const found: string[] = []
  for (const [start, end] of PERIODS) {
    for (const accounts of ACCOUNT_SETS) {
      for (const statuses of [['posted', 'reversed'], ['posted'], ['reversed']]) {
        for (const allLines of [false, true]) {
          const want = await expected(companyId, start, end, accounts, statuses, allLines)
          const got = await actual(companyId, start, end, accounts, statuses, allLines)
          if (want !== got) found.push(`${start}..${end} [${accounts}] [${statuses}] ${allLines}`)
        }
      }
    }
  }
  return found
}

beforeAll(async () => {
  userId = await insertAuthUser()
  companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
  const company: CashCompany = { userId, companyId, fiscalPeriodId, nextPeriodId: fiscalPeriodId }
  const post = (entryDate: string, lines: Line[], sourceType = 'manual') =>
    insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId, entryDate, sourceType,
      voucherNumber: nextSeq() % 1_000_000_000,
      description: `account lines ${entryDate}`,
      lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })),
    })

  const kinds: Line[][] = [
    [['1510', 10000, 0], ['3308', 0, 10000]],
    [['1510', 12500, 0], ['3108', 0, 2500], ['3308', 0, 7500], ['3308', 0, 2500]],
    [['1930', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]],
    [['6540', 100, 0], ['2645', 25, 0], ['2614', 0, 25], ['2440', 0, 100]],
    [['4536', 500, 0], ['2645', 60, 0], ['2624', 0, 60], ['2440', 0, 500]],
    [['1510', 300, 0], ['3107', 0, 300]],
  ]
  for (let i = 0; i < 90; i += 1) {
    const id = await post(new Date(Date.UTC(2026, 0, 1 + i * 2)).toISOString().slice(0, 10), kinds[i % kinds.length])
    // Every 7th is annulled two days later: a reversed original and its storno.
    if (i % 7 === 0) await stornoEntry(company, id, { date: new Date(Date.UTC(2026, 0, 3 + i * 2)).toISOString().slice(0, 10) })
  }
  // A draft EU sale never counts.
  const { rows: [draft] } = await getPool().query(
    `INSERT INTO public.journal_entries
       (user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status)
     VALUES ($1, $2, $3, 0, 'A', '2026-02-14', 'draft EU sale', 'manual', 'draft')
     RETURNING id`,
    [userId, companyId, fiscalPeriodId],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
     VALUES ($1, '1510', 999, 0, 0), ($1, '3308', 0, 999, 1)`,
    [draft.id],
  )
  draftId = draft.id

  // Another company's EU sale on the same days.
  const otherUser = await insertAuthUser()
  otherCompanyId = await insertCompany({ createdBy: otherUser })
  await insertCompanyMember({ companyId: otherCompanyId, userId: otherUser, role: 'owner' })
  const otherPeriod = await insertFiscalPeriod({ userId: otherUser, companyId: otherCompanyId })
  await insertPostedJournalEntry({
    userId: otherUser, companyId: otherCompanyId, fiscalPeriodId: otherPeriod, entryDate: '2026-02-14',
    voucherNumber: nextSeq() % 1_000_000_000,
    lines: [{ accountNumber: '1510', debitAmount: 4000, creditAmount: 0 }, { accountNumber: '3308', debitAmount: 0, creditAmount: 4000 }],
  })
}, 300_000)

describe('get_entries_with_account_lines', () => {
  it('returns the definition for every period, account set, status set and line choice, built', async () => {
    const { rows } = await getPool().query('SELECT public.ledger_account_days_ready($1) AS ready', [companyId])
    expect(rows[0].ready).toBe(true)
    expect(await differing()).toEqual([])
    // The fixtures are not empty: the year holds the EU sales and their stornos.
    const year = JSON.parse(await actual(companyId, '2026-01-01', '2026-12-31', ['3308', '3108', '3107'], ['posted', 'reversed'], false))
    expect(year.length).toBeGreaterThan(40)
    expect(year.some((e: { id: string }) => e.id === draftId)).toBe(false)
    expect(year.some((e: { status: string }) => e.status === 'reversed')).toBe(true)
    // A verifikat with two lines on 3308 and one on 3108 keeps all three, by account.
    const split = year.find((e: { lines: unknown[] }) => e.lines.length === 3)
    expect(split.lines.map((l: { account_number: string }) => l.account_number)).toEqual(['3108', '3308', '3308'])
  }, 300_000)

  it('returns the definition before the build cron reaches the company', async () => {
    await getPool().query('DELETE FROM public.ledger_account_days_companies WHERE company_id = $1', [companyId])
    try {
      expect(await differing()).toEqual([])
    } finally {
      await getPool().query(
        'INSERT INTO public.ledger_account_days_companies (company_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [companyId],
      )
    }
  }, 300_000)

  it('is scoped to the caller by RLS', async () => {
    const own = await withUserContext(userId, async (db) => {
      const { rows } = await db.query(
        'SELECT public.get_entries_with_account_lines($1, $2, $3, $4, $5, $6) AS rows',
        [companyId, '2026-02-01', '2026-02-28', ['3308'], ['posted', 'reversed'], true],
      )
      return rows[0].rows as unknown[]
    })
    expect(own.length).toBeGreaterThan(0)
    const others = await withUserContext(userId, async (db) => {
      const { rows } = await db.query(
        'SELECT public.get_entries_with_account_lines($1, $2, $3, $4, $5, $6) AS rows',
        [otherCompanyId, '2026-02-01', '2026-02-28', ['3308'], ['posted', 'reversed'], true],
      )
      return rows[0].rows as unknown[]
    })
    expect(others).toEqual([])
  })

  it('is not executable by anon', async () => {
    const { rows } = await getPool().query(
      `SELECT has_function_privilege('anon', 'public.get_entries_with_account_lines(uuid, date, date, text[], text[], boolean)', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.get_entries_with_account_lines(uuid, date, date, text[], text[], boolean)', 'EXECUTE') AS authenticated`,
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: true })
  })
})
