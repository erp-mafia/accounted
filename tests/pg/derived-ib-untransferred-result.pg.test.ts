import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from '@/tests/pg/fixtures'
import type { EntityType } from '@/types'

/**
 * Migration 20261024140000: a derived opening balance carries a result that
 * was never moved to equity. A year that ended without a booked resultatavslut
 * is read as if it had been closed: one line on the form's closing account,
 * dated the year's last day. A booked closing makes the line disappear, and an
 * IB verifikat after it that already carries the result does not count it
 * twice.
 *
 * Migration 20261025120000: only an entry dated on its year's first day is an
 * IB verifikat; one tagged as IB on another day is history.
 */

type Row = { account_number: string; debit: string; credit: string }

async function books(entityType: EntityType = 'aktiebolag') {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId, entityType })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const year = async (y: number) =>
    insertFiscalPeriod({ userId, companyId, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31`, name: String(y) })
  const fy2024 = await year(2024)
  const fy2025 = await year(2025)
  const fy2026 = await year(2026)
  const post = (
    fiscalPeriodId: string,
    entryDate: string,
    lines: Array<{ accountNumber: string; debitAmount: number; creditAmount: number; dimensions?: Record<string, string> }>,
    sourceType = 'manual',
  ) => insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, entryDate, sourceType, lines })
  return { userId, companyId, fy2024, fy2025, fy2026, post }
}

const sale = (amount: number, dimensions?: Record<string, string>) => [
  { accountNumber: '1930', debitAmount: amount, creditAmount: 0, dimensions },
  { accountNumber: '3001', debitAmount: 0, creditAmount: amount, dimensions },
]

/**
 * The derived IB as the summary path reads it (a built company), after
 * checking that the line path (the summaries hidden, rolled back) agrees.
 */
async function openingBalance(companyId: string, periodStart: string, dimensions?: Record<string, string>) {
  const read = async (linePath: boolean) => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      if (linePath) {
        await client.query('DELETE FROM public.ledger_account_days_companies WHERE company_id = $1', [companyId])
      }
      const { rows } = dimensions
        ? await client.query<Row>('SELECT * FROM public.compute_prior_opening_balances($1, $2, $3::jsonb)', [
            companyId, periodStart, JSON.stringify(dimensions),
          ])
        : await client.query<Row>('SELECT * FROM public.compute_prior_opening_balances($1, $2)', [companyId, periodStart])
      return rows
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  }
  const summary = await read(false)
  expect(nets(await read(true)), 'line path').toEqual(nets(summary))
  return summary
}

/**
 * A verifikat dated outside its own year, as old imports left them. The date
 * rule (20261024140200) refuses new ones, so the row is seeded with it off,
 * inside one transaction that no other session sees.
 */
async function insertMisdatedEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  entryDate: string
  lines: Array<{ accountNumber: string; debitAmount: number; creditAmount: number }>
}): Promise<void> {
  const client = await getPool().connect()
  const id = randomUUID()
  try {
    await client.query('BEGIN')
    await client.query('ALTER TABLE public.journal_entries DISABLE TRIGGER zz_enforce_entry_date_in_fiscal_period')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Misdated', 'manual', 'draft')`,
      [id, params.userId, params.companyId, params.fiscalPeriodId, params.entryDate],
    )
    for (const line of params.lines) {
      await client.query(
        'INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount) VALUES ($1, $2, $3, $4)',
        [id, line.accountNumber, line.debitAmount, line.creditAmount],
      )
    }
    await client.query("UPDATE public.journal_entries SET status = 'posted' WHERE id = $1", [id])
    // The deferred balance check must fire before the table can be altered again.
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    await client.query('ALTER TABLE public.journal_entries ENABLE TRIGGER zz_enforce_entry_date_in_fiscal_period')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Net (debit - credit) per account, rows that net to zero left out. */
function nets(rows: Row[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) {
    const net = Math.round((Number(r.debit) - Number(r.credit)) * 100) / 100
    if (net !== 0) out[r.account_number] = net
  }
  return out
}

describe('derived opening balance carries an untransferred result', () => {
  it('a profit left on the result accounts opens next year on 2099', async () => {
    const { companyId, fy2025, post } = await books()
    await post(fy2025, '2025-06-01', sale(1000))

    expect(nets(await openingBalance(companyId, '2026-01-01'))).toEqual({ '1930': 1000, '2099': -1000 })
  })

  it('a loss opens as a debit on 2099', async () => {
    const { companyId, fy2025, post } = await books()
    await post(fy2025, '2025-03-01', [
      { accountNumber: '5010', debitAmount: 400, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 400 },
    ])

    expect(nets(await openingBalance(companyId, '2026-01-01'))).toEqual({ '1930': -400, '2099': 400 })
  })

  it('a booked closing leaves nothing to carry (our resultatavslut, or 8999 against 2099)', async () => {
    const closed = await books()
    await closed.post(closed.fy2025, '2025-06-01', sale(1000))
    await closed.post(closed.fy2025, '2025-12-31', [
      { accountNumber: '3001', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '2099', debitAmount: 0, creditAmount: 1000 },
    ], 'year_end')
    expect(nets(await openingBalance(closed.companyId, '2026-01-01'))).toEqual({ '1930': 1000, '2099': -1000 })

    const omforing = await books()
    await omforing.post(omforing.fy2025, '2025-06-01', sale(1000))
    await omforing.post(omforing.fy2025, '2025-12-31', [
      { accountNumber: '8999', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '2099', debitAmount: 0, creditAmount: 1000 },
    ], 'import')
    expect(nets(await openingBalance(omforing.companyId, '2026-01-01'))).toEqual({ '1930': 1000, '2099': -1000 })
  })

  it('carries every unclosed year, and a disposition booked in a later year moves its share', async () => {
    const { companyId, fy2024, fy2025, post } = await books()
    await post(fy2024, '2024-06-01', sale(500))
    // 2025: the stämma disposes of 2024's result, and 2025 earns 1000.
    await post(fy2025, '2025-05-01', [
      { accountNumber: '2099', debitAmount: 500, creditAmount: 0 },
      { accountNumber: '2091', debitAmount: 0, creditAmount: 500 },
    ])
    await post(fy2025, '2025-06-01', sale(1000))

    expect(nets(await openingBalance(companyId, '2025-01-01'))).toEqual({ '1930': 500, '2099': -500 })
    expect(nets(await openingBalance(companyId, '2026-01-01'))).toEqual({ '1930': 1500, '2091': -500, '2099': -1000 })
  })

  it('an IB verifikat after the unclosed year that already carries its result does not count it twice', async () => {
    const { companyId, fy2024, fy2025, post } = await books()
    await post(fy2024, '2024-06-01', sale(500))
    // The source system's IB for 2025: the 2024 result on 2099, no voucher behind it.
    await post(fy2025, '2025-01-01', [
      { accountNumber: '1930', debitAmount: 500, creditAmount: 0 },
      { accountNumber: '2099', debitAmount: 0, creditAmount: 500 },
    ], 'opening_balance')

    expect(nets(await openingBalance(companyId, '2026-01-01'))).toEqual({ '1930': 500, '2099': -500 })
  })

  it('only years that ended before the requested start are carried', async () => {
    const { companyId, fy2025, post } = await books()
    await post(fy2025, '2025-06-01', sale(1000))

    expect(nets(await openingBalance(companyId, '2025-01-01'))).toEqual({})
  })

  it('a line dated before the first year is closed with the first year', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fy2025 = await insertFiscalPeriod({ userId, companyId, periodStart: '2025-01-01', periodEnd: '2025-12-31', name: '2025' })
    await insertFiscalPeriod({ userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31', name: '2026' })
    await insertMisdatedEntry({ userId, companyId, fiscalPeriodId: fy2025, entryDate: '2024-12-20', lines: sale(100) })
    await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId: fy2025, entryDate: '2025-02-01', lines: sale(200) })

    expect(nets(await openingBalance(companyId, '2026-01-01'))).toEqual({ '1930': 300, '2099': -300 })
  })

  it.each([
    ['enskild_firma', '2010'],
    ['ideell_forening', '2069'],
    ['ekonomisk_forening', '2099'],
  ] as const)('%s carries it on %s', async (form, account) => {
    const { companyId, fy2025, post } = await books(form)
    await post(fy2025, '2025-06-01', sale(1000))

    expect(nets(await openingBalance(companyId, '2026-01-01'))).toEqual({ '1930': 1000, [account]: -1000 })
  })

  it("is company level: a project's opening balance and the per-project split are unchanged", async () => {
    const { companyId, fy2025, fy2026, post } = await books()
    await post(fy2025, '2025-06-01', sale(1000, { '6': 'P1' }))

    expect(nets(await openingBalance(companyId, '2026-01-01', { '6': 'P1' }))).toEqual({ '1930': 1000 })
    expect(nets(await openingBalance(companyId, '2026-01-01'))).toEqual({ '1930': 1000, '2099': -1000 })

    const { rows } = await getPool().query<{ result: Array<{ account_number: string; net: number | string }> }>(
      'SELECT public.compute_object_closing_balances($1, $2, $3::text[]) AS result',
      [companyId, fy2026, ['6']],
    )
    expect(rows[0].result.map((r) => [r.account_number, Number(r.net)])).toEqual([['1930', 1000]])
  })

  it('runs for an authenticated member, and a stranger sees nothing', async () => {
    const { userId, companyId, fy2025, post } = await books()
    await post(fy2025, '2025-06-01', sale(1000))

    const own = await withUserContext(userId, async (client) =>
      (await client.query<Row>('SELECT * FROM public.compute_prior_opening_balances($1, $2)', [companyId, '2026-01-01'])).rows,
    )
    expect(nets(own)).toEqual({ '1930': 1000, '2099': -1000 })

    const stranger = await insertAuthUser()
    const foreign = await withUserContext(stranger, async (client) =>
      (await client.query<Row>('SELECT * FROM public.compute_prior_opening_balances($1, $2)', [companyId, '2026-01-01'])).rows,
    )
    expect(foreign).toEqual([])
  })
})

// Bank reconciliation's "Märk som IB" re-tagged mid-year verifikat as
// opening_balance until 20261006121003 closed that door.
describe("derived opening balance reads an IB verifikat only on its year's first day", () => {
  it('a loan repayment marked as IB mid-year still reaches next year', async () => {
    const { companyId, fy2025, post } = await books()
    await post(fy2025, '2025-01-01', [
      { accountNumber: '1930', debitAmount: 500, creditAmount: 0 },
      { accountNumber: '2840', debitAmount: 0, creditAmount: 500 },
    ], 'opening_balance')
    await post(fy2025, '2025-03-10', [
      { accountNumber: '2840', debitAmount: 210, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 210 },
    ], 'opening_balance')

    expect(nets(await openingBalance(companyId, '2026-01-01'))).toEqual({ '1930': 290, '2840': -290 })
  })

  it("a bank fee marked as IB mid-year counts in that year's result", async () => {
    const { companyId, fy2025, post } = await books()
    await post(fy2025, '2025-01-01', [
      { accountNumber: '1930', debitAmount: 500, creditAmount: 0 },
      { accountNumber: '2081', debitAmount: 0, creditAmount: 500 },
    ], 'opening_balance')
    await post(fy2025, '2025-04-01', [
      { accountNumber: '6570', debitAmount: 100, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 100 },
    ], 'opening_balance')

    expect(nets(await openingBalance(companyId, '2026-01-01'))).toEqual({ '1930': 400, '2081': -500, '2099': 100 })
  })
})
