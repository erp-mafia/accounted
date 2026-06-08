/**
 * pg-real test for get_account_gl_lines_for_matching
 * (20260610120000_gl_lines_for_matching.sql).
 *
 * This RPC backs the N:1 "lägga på flera" feature: it mirrors get_unlinked_gl_lines
 * but can ALSO surface already-matched vouchers (so a second/third bank
 * transaction can be attached to one verifikat), each carrying how many
 * transactions already point at it.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { insertAuthUser, insertCompany, insertFiscalPeriod, insertTransaction } from './fixtures'

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
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', $2, 0),
            ($1, '2091', 0, $2)`,
    [id, amount],
  )
  return id
}

describe('get_account_gl_lines_for_matching RPC — N:1 candidates', () => {
  it('returns already-matched vouchers (with link count) only when p_include_matched is true', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    })

    // One unmatched voucher, one voucher already settled by TWO transactions
    // (the salary-run-paid-in-two-transfers shape).
    const unmatchedEntry = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-03-15', sourceType: 'bank_transaction', voucherNumber: 1, amount: 1500,
    })
    const matchedEntry = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-03-20', sourceType: 'manual', voucherNumber: 2, amount: 30000,
    })
    await insertTransaction({ companyId, userId, currency: 'SEK', journalEntryId: matchedEntry })
    await insertTransaction({ companyId, userId, currency: 'SEK', journalEntryId: matchedEntry })

    // Default (p_include_matched=false): parity with get_unlinked_gl_lines — only
    // the unmatched voucher, count 0.
    const { rows: unmatchedOnly } = await getPool().query(
      `SELECT journal_entry_id, linked_transaction_count
         FROM public.get_account_gl_lines_for_matching(p_company_id => $1)`,
      [companyId],
    )
    const unmatchedIds = new Set(unmatchedOnly.map((r) => r.journal_entry_id))
    expect(unmatchedIds.has(unmatchedEntry)).toBe(true)
    expect(unmatchedIds.has(matchedEntry)).toBe(false)
    expect(unmatchedOnly.find((r) => r.journal_entry_id === unmatchedEntry).linked_transaction_count).toBe(0)

    // p_include_matched=true: the matched voucher appears too, reporting both links.
    const { rows: withMatched } = await getPool().query(
      `SELECT journal_entry_id, linked_transaction_count
         FROM public.get_account_gl_lines_for_matching(p_company_id => $1, p_include_matched => true)`,
      [companyId],
    )
    const byId = new Map(withMatched.map((r) => [r.journal_entry_id, r.linked_transaction_count]))
    expect(byId.get(unmatchedEntry)).toBe(0)
    expect(byId.get(matchedEntry)).toBe(2)
  })

  it('still excludes opening_balance / storno / correction even with p_include_matched', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    })

    // These book-only / IB vouchers have no bank-feed counterpart and can never
    // be a match target — the include_matched opt-in must not resurrect them.
    await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-01-01', sourceType: 'opening_balance', voucherNumber: 1, amount: 50000,
    })
    await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-05-02', sourceType: 'storno', voucherNumber: 2, amount: 25000,
    })
    await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-05-02', sourceType: 'correction', voucherNumber: 3, amount: 25000,
    })
    const bankEntry = await insertPostedJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-05-03', sourceType: 'bank_transaction', voucherNumber: 4, amount: 1500,
    })

    const { rows } = await getPool().query(
      `SELECT journal_entry_id, source_type
         FROM public.get_account_gl_lines_for_matching(p_company_id => $1, p_include_matched => true)`,
      [companyId],
    )

    const returnedIds = new Set(rows.map((r) => r.journal_entry_id))
    expect(returnedIds.has(bankEntry)).toBe(true)
    expect(rows.find((r) => r.source_type === 'opening_balance')).toBeUndefined()
    expect(rows.find((r) => r.source_type === 'storno')).toBeUndefined()
    expect(rows.find((r) => r.source_type === 'correction')).toBeUndefined()
  })
})
