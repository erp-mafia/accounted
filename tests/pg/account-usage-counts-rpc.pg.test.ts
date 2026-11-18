/**
 * pg-real test for get_account_usage_counts.
 *
 * The RPC backs the kontoplan cleanup flow ("Rensa oanvända konton"): it
 * returns per-account posting counts so the prune endpoint can compute the
 * safe-to-delete set (usage_count absent = never posted). Verifies the
 * aggregation, company scoping, and that draft entries count as usage:
 * a draft line still references the account, so deleting it would orphan
 * the draft.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  seedCompany,
} from './fixtures'

async function insertJournalEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
  status: 'draft' | 'posted'
  lines: Array<{ account: string; debit: number; credit: number }>
}): Promise<string> {
  if (params.status === 'posted') {
    return insertPostedJournalEntry({
      userId: params.userId,
      companyId: params.companyId,
      fiscalPeriodId: params.fiscalPeriodId,
      voucherNumber: params.voucherNumber,
      entryDate: '2026-03-15',
      description: 'Usage test',
      sourceType: 'manual',
      lines: params.lines.map((line) => ({
        accountNumber: line.account,
        debitAmount: line.debit,
        creditAmount: line.credit,
      })),
    })
  }

  const id = randomUUID()
  // Insert directly, bypassing commit_journal_entry's voucher sequencing:
  // fine for a read-side RPC that only aggregates line/account references.
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, 'A', '2026-03-15', 'Usage test', 'manual', $6)`,
    [id, params.userId, params.companyId, params.fiscalPeriodId, params.voucherNumber, params.status],
  )
  for (const line of params.lines) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4)`,
      [id, line.account, line.debit, line.credit],
    )
  }
  return id
}

describe('get_account_usage_counts RPC', () => {
  it('aggregates line counts per account across entries', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId,
      companyId,
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
    })

    // 1930 appears in both entries, 3001/2611 once, 4010 once.
    await insertJournalEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 1, status: 'posted',
      lines: [
        { account: '1930', debit: 1250, credit: 0 },
        { account: '3001', debit: 0, credit: 1000 },
        { account: '2611', debit: 0, credit: 250 },
      ],
    })
    await insertJournalEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 2, status: 'posted',
      lines: [
        { account: '4010', debit: 500, credit: 0 },
        { account: '1930', debit: 0, credit: 500 },
      ],
    })

    const { rows } = await getPool().query(
      `SELECT account_number, usage_count
       FROM public.get_account_usage_counts($1)
       ORDER BY account_number`,
      [companyId],
    )

    const byAccount = new Map<string, string>(
      rows.map((r) => [r.account_number, String(r.usage_count)]),
    )
    expect(byAccount.get('1930')).toBe('2')
    expect(byAccount.get('3001')).toBe('1')
    expect(byAccount.get('2611')).toBe('1')
    expect(byAccount.get('4010')).toBe('1')
    // Never-posted accounts are simply absent - that absence IS the
    // "unused" signal the prune endpoint keys on.
    expect(byAccount.has('5410')).toBe(false)
  })

  it('counts draft entries as usage', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId,
      companyId,
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
    })

    await insertJournalEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 1, status: 'draft',
      lines: [
        { account: '6110', debit: 100, credit: 0 },
        { account: '1930', debit: 0, credit: 100 },
      ],
    })

    const { rows } = await getPool().query(
      `SELECT account_number FROM public.get_account_usage_counts($1)`,
      [companyId],
    )
    const accounts = new Set(rows.map((r) => r.account_number))
    expect(accounts.has('6110')).toBe(true)
    expect(accounts.has('1930')).toBe(true)
  })

  it('scopes counts to the requested company', async () => {
    const userA = await insertAuthUser()
    const userB = await insertAuthUser()
    const companyA = await insertCompany({ createdBy: userA, name: 'A' })
    const companyB = await insertCompany({ createdBy: userB, name: 'B' })
    const fpA = await insertFiscalPeriod({ userId: userA, companyId: companyA })
    const fpB = await insertFiscalPeriod({ userId: userB, companyId: companyB })

    await insertJournalEntry({
      userId: userA, companyId: companyA, fiscalPeriodId: fpA, voucherNumber: 1, status: 'posted',
      lines: [
        { account: '1930', debit: 100, credit: 0 },
        { account: '3001', debit: 0, credit: 100 },
      ],
    })
    await insertJournalEntry({
      userId: userB, companyId: companyB, fiscalPeriodId: fpB, voucherNumber: 1, status: 'posted',
      lines: [
        { account: '5410', debit: 100, credit: 0 },
        { account: '1930', debit: 0, credit: 100 },
      ],
    })

    const { rows: rowsA } = await getPool().query(
      `SELECT account_number, usage_count FROM public.get_account_usage_counts($1)`,
      [companyA],
    )
    const accountsA = new Set(rowsA.map((r) => r.account_number))
    expect(accountsA.has('3001')).toBe(true)
    expect(accountsA.has('5410')).toBe(false)
    // Company B's 1930 line must not inflate A's count.
    expect(String(rowsA.find((r) => r.account_number === '1930')?.usage_count)).toBe('1')
  })

  it('adds the posted lines (from the ledger summaries) and the draft lines on one account, and answers the same from the lines alone', async () => {
    // Posted and reversed verifikat are counted from ledger_account_days, the
    // rest from their lines (seen 2026-11-12: every line of the largest
    // company took 5 s and timed out cold). A company whose summaries are not
    // built keeps the line path; both must give the same counts.
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await insertJournalEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 1, status: 'posted',
      lines: [
        { account: '1930', debit: 300, credit: 0 },
        { account: '3001', debit: 0, credit: 300 },
      ],
    })
    await insertJournalEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 2, status: 'posted',
      lines: [
        { account: '6110', debit: 40, credit: 0 },
        { account: '1930', debit: 0, credit: 40 },
      ],
    })
    await insertJournalEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 3, status: 'draft',
      lines: [
        { account: '6110', debit: 10, credit: 0 },
        { account: '6570', debit: 5, credit: 0 },
        { account: '1930', debit: 0, credit: 15 },
      ],
    })

    const read = async () => {
      const { rows } = await getPool().query<{ account_number: string; usage_count: string }>(
        `SELECT account_number, usage_count FROM public.get_account_usage_counts($1) ORDER BY account_number`,
        [companyId],
      )
      return rows.map((r) => [r.account_number, Number(r.usage_count)])
    }

    const fromSummaries = await read()
    expect(fromSummaries).toEqual([
      ['1930', 3],
      ['3001', 1],
      ['6110', 2],
      ['6570', 1],
    ])

    const { rows: listed } = await getPool().query(`SELECT 1 FROM public.ledger_account_days_companies WHERE company_id = $1`, [companyId])
    expect(listed).toHaveLength(1)
    await getPool().query(`DELETE FROM public.ledger_account_days_companies WHERE company_id = $1`, [companyId])
    try {
      expect(await read()).toEqual(fromSummaries)
    } finally {
      await getPool().query(`INSERT INTO public.ledger_account_days_companies (company_id) VALUES ($1) ON CONFLICT DO NOTHING`, [companyId])
    }
  })

  it('counts for a member and shows a stranger nothing', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await insertJournalEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 1, status: 'posted',
      lines: [
        { account: '1930', debit: 100, credit: 0 },
        { account: '3001', debit: 0, credit: 100 },
      ],
    })
    const sql = `SELECT account_number, usage_count FROM public.get_account_usage_counts($1) ORDER BY account_number`

    const own = await withUserContext(userId, async (client) => (await client.query<{ account_number: string }>(sql, [companyId])).rows)
    expect(own.map((r) => r.account_number)).toEqual(['1930', '3001'])

    const stranger = await insertAuthUser()
    const other = await withUserContext(stranger, async (client) => (await client.query(sql, [companyId])).rows)
    expect(other).toEqual([])
  })

  it('returns no rows for a company without entries', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })

    const { rows } = await getPool().query(
      `SELECT * FROM public.get_account_usage_counts($1)`,
      [companyId],
    )
    expect(rows).toHaveLength(0)
  })
})
