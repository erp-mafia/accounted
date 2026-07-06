/**
 * pg-real test for get_unlinked_gl_lines.
 *
 * Verifies the RPC excludes opening_balance vouchers from the unmatched-1930
 * set, while preserving the existing behavior for posted bank-import vouchers,
 * date-range filtering, and company scoping. The RPC was renamed from
 * get_unlinked_1930_lines in 20260519120000_get_unlinked_gl_lines.sql; the
 * default p_account_number of '1930' keeps these assertions valid.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { insertAuthUser, insertCompany, insertFiscalPeriod } from './fixtures'

async function insertPostedJournalEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  entryDate: string
  sourceType: 'opening_balance' | 'manual' | 'bank_transaction' | 'import' | 'storno' | 'correction'
  voucherNumber: number
  amount?: number
}): Promise<string> {
  const id = randomUUID()
  const amount = params.amount ?? 1000
  // Insert as posted directly. This bypasses commit_journal_entry's voucher
  // sequencing; that's fine for testing the read-side RPC, which only cares
  // about (account_number, status, source_type, date_range, link presence).
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, 'A', $6, $7, $8, 'posted')`,
    [
      id,
      params.userId,
      params.companyId,
      params.fiscalPeriodId,
      params.voucherNumber,
      params.entryDate,
      `Test ${params.sourceType}`,
      params.sourceType,
    ],
  )
  // Balanced pair on 1930 + 2091 (balanserad vinst/förlust, the realistic
  // carried-forward counterpart for an IB on a bank account; harmless for the
  // other source_types where the test only cares about the 1930 side).
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', $2, 0),
            ($1, '2091', 0, $2)`,
    [id, amount],
  )
  return id
}

describe('get_unlinked_gl_lines RPC: opening_balance exclusion', () => {
  it('excludes opening_balance vouchers from the unmatched-1930 set', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId,
      companyId,
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
    })

    // Three vouchers on 1930, all posted, none linked to a transaction:
    //   IB voucher (source_type='opening_balance')   : should be EXCLUDED
    //   Bank import voucher                          : should be RETURNED
    //   Manual voucher                               : should be RETURNED
    await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-01-01',
      sourceType: 'opening_balance',
      voucherNumber: 1,
      amount: 50000,
    })
    const bankEntryId = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-03-15',
      sourceType: 'bank_transaction',
      voucherNumber: 2,
      amount: 1500,
    })
    const manualEntryId = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-04-20',
      sourceType: 'manual',
      voucherNumber: 3,
      amount: 200,
    })

    const { rows } = await getPool().query(
      `SELECT journal_entry_id, source_type FROM public.get_unlinked_gl_lines($1)`,
      [companyId],
    )

    const returnedIds = new Set(rows.map((r) => r.journal_entry_id))
    expect(returnedIds.has(bankEntryId)).toBe(true)
    expect(returnedIds.has(manualEntryId)).toBe(true)
    // IB voucher should NOT be returned regardless of company/date scope.
    expect(rows.find((r) => r.source_type === 'opening_balance')).toBeUndefined()
  })

  it('excludes storno and correction vouchers from the unmatched-1930 set', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId,
      companyId,
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
    })

    // A storno and a correction voucher on 1930 (the products of the correctEntry
    // flow), plus a normal bank voucher. Stornos/corrections are book-only
    // reversals with no bank-feed counterpart: they must be EXCLUDED so a
    // reconciled period doesn't show them as omatchade verifikationer.
    await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-05-02', sourceType: 'storno', voucherNumber: 20, amount: 25000,
    })
    await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-05-02', sourceType: 'correction', voucherNumber: 21, amount: 25000,
    })
    const bankEntryId = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-05-03', sourceType: 'bank_transaction', voucherNumber: 22, amount: 1500,
    })

    const { rows } = await getPool().query(
      `SELECT journal_entry_id, source_type FROM public.get_unlinked_gl_lines($1)`,
      [companyId],
    )

    const returnedIds = new Set(rows.map((r) => r.journal_entry_id))
    expect(returnedIds.has(bankEntryId)).toBe(true)
    expect(rows.find((r) => r.source_type === 'storno')).toBeUndefined()
    expect(rows.find((r) => r.source_type === 'correction')).toBeUndefined()
  })

  it('still applies date_from / date_to filtering', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId,
      companyId,
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
    })

    await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-02-01',
      sourceType: 'bank_transaction',
      voucherNumber: 10,
    })
    await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-08-01',
      sourceType: 'bank_transaction',
      voucherNumber: 11,
    })

    // Window covers only the second voucher. Use named notation so we don't have
    // to repeat the '1930' default just to reach the date params.
    const { rows } = await getPool().query(
      `SELECT entry_date FROM public.get_unlinked_gl_lines(
         p_company_id => $1, p_date_from => $2, p_date_to => $3
       ) ORDER BY entry_date`,
      [companyId, '2026-07-01', '2026-12-31'],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].entry_date.toISOString().slice(0, 10)).toBe('2026-08-01')
  })

  it('scopes to the requested company only', async () => {
    const userA = await insertAuthUser()
    const userB = await insertAuthUser()
    const companyA = await insertCompany({ createdBy: userA, name: 'A' })
    const companyB = await insertCompany({ createdBy: userB, name: 'B' })
    const fpA = await insertFiscalPeriod({ userId: userA, companyId: companyA })
    const fpB = await insertFiscalPeriod({ userId: userB, companyId: companyB })

    await insertPostedJournalEntry({
      userId: userA, companyId: companyA, fiscalPeriodId: fpA,
      entryDate: '2026-03-01', sourceType: 'bank_transaction', voucherNumber: 1,
    })
    await insertPostedJournalEntry({
      userId: userB, companyId: companyB, fiscalPeriodId: fpB,
      entryDate: '2026-03-01', sourceType: 'bank_transaction', voucherNumber: 1,
    })

    const { rows: rowsA } = await getPool().query(
      `SELECT 1 FROM public.get_unlinked_gl_lines($1)`,
      [companyA],
    )
    const { rows: rowsB } = await getPool().query(
      `SELECT 1 FROM public.get_unlinked_gl_lines($1)`,
      [companyB],
    )
    expect(rowsA).toHaveLength(1)
    expect(rowsB).toHaveLength(1)
  })
})
