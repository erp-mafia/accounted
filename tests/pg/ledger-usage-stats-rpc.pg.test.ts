/**
 * pg-real test for get_ledger_usage_stats.
 *
 * The RPC backs the Accounted://ledger/context MCP resource: one jsonb
 * document with windowed account-usage and counterparty-pattern aggregates.
 * Verifies: posted-only filtering, the date window, dominant category/account
 * derivation (19xx contra exclusion), merchant-name normalization, and
 * two-company isolation (a foreign company id yields empty sections).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import {
  seedCompany,
  insertDraftJournalEntry,
} from './fixtures'

async function insertLines(
  journalEntryId: string,
  lines: Array<{ account: string; debit: number; credit: number }>,
): Promise<void> {
  for (const line of lines) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4)`,
      [journalEntryId, line.account, line.debit, line.credit],
    )
  }
}

async function insertBookedTransaction(params: {
  companyId: string
  userId: string
  journalEntryId: string
  merchantName: string
  category: string
  date: string
  amount?: number
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.transactions
       (id, company_id, user_id, currency, amount, date, description,
        journal_entry_id, merchant_name, category)
     VALUES ($1, $2, $3, 'SEK', $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(),
      params.companyId,
      params.userId,
      params.amount ?? -500,
      params.date,
      `Payment ${params.merchantName}`,
      params.journalEntryId,
      params.merchantName,
      params.category,
    ],
  )
}

// Posted entry + lines + a booked transaction pointing at it, in one call.
async function bookMerchant(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  merchantName: string
  category: string
  date: string
  expenseAccount: string
  voucherNumber: number
}): Promise<void> {
  const entryId = await insertDraftJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    entryDate: params.date,
    status: 'posted',
    voucherNumber: params.voucherNumber,
    sourceType: 'bank_transaction',
  })
  await insertLines(entryId, [
    { account: params.expenseAccount, debit: 500, credit: 0 },
    { account: '1930', debit: 0, credit: 500 },
  ])
  await insertBookedTransaction({
    companyId: params.companyId,
    userId: params.userId,
    journalEntryId: entryId,
    merchantName: params.merchantName,
    category: params.category,
    date: params.date,
  })
}

type LedgerStats = {
  account_usage: Array<{
    account_number: string
    account_name: string | null
    postings: number
    last_used: string
  }>
  counterparty_patterns: Array<{
    counterparty: string
    occurrences: number
    last_booked: string
    dominant_category: string | null
    dominant_category_count: number
    dominant_account_number: string | null
  }>
  vat_treatments_used: string[]
  median_booking_lag_days: number | null
}

async function callRpc(companyId: string, fromDate: string): Promise<LedgerStats> {
  const res = await getPool().query(
    `SELECT public.get_ledger_usage_stats($1, $2) AS stats`,
    [companyId, fromDate],
  )
  return res.rows[0].stats as LedgerStats
}

describe('get_ledger_usage_stats', () => {
  let userId: string
  let companyId: string
  let fiscalPeriodId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
    fiscalPeriodId = seeded.fiscalPeriodId

    // 3x Klarna to 6570, 1x Klarna miscategorized, 2x SL to 5810 (one with
    // different casing to exercise normalization), plus a draft that must
    // not count and an old entry outside the window.
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'KLARNA AB', category: 'expense_bank_fees', date: '2026-05-01', expenseAccount: '6570', voucherNumber: 1 })
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'KLARNA AB', category: 'expense_bank_fees', date: '2026-05-15', expenseAccount: '6570', voucherNumber: 2 })
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'Klarna AB', category: 'expense_bank_fees', date: '2026-06-01', expenseAccount: '6570', voucherNumber: 3 })
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'KLARNA AB', category: 'expense_other', date: '2026-06-10', expenseAccount: '6570', voucherNumber: 4 })
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'SL', category: 'expense_travel', date: '2026-06-05', expenseAccount: '5810', voucherNumber: 5 })
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'SL', category: 'expense_travel', date: '2026-06-20', expenseAccount: '5810', voucherNumber: 6 })

    // Draft entry: must not appear in account_usage.
    const draftId = await insertDraftJournalEntry({
      userId, companyId, fiscalPeriodId,
      entryDate: '2026-06-25', status: 'draft', voucherNumber: 0,
    })
    await insertLines(draftId, [
      { account: '9999', debit: 100, credit: 0 },
      { account: '1930', debit: 0, credit: 100 },
    ])

    // Outside the window: must not count.
    await bookMerchant({ userId, companyId, fiscalPeriodId, merchantName: 'OLD VENDOR', category: 'expense_other', date: '2026-01-05', expenseAccount: '4010', voucherNumber: 7 })

    // Invoices carrying VAT treatments: one in-window, one before the window.
    await getPool().query(
      `INSERT INTO public.invoices
         (company_id, user_id, invoice_number, invoice_date, due_date, vat_treatment)
       VALUES ($1, $2, 'INV-1', '2026-06-01', '2026-06-30', 'standard_25'),
              ($1, $2, 'INV-2', '2026-01-02', '2026-01-31', 'reverse_charge_eu')`,
      [companyId, userId],
    )
  })

  it('aggregates posted account usage within the window', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    const byAccount = Object.fromEntries(
      stats.account_usage.map((a) => [a.account_number, a]),
    )

    // 6 posted in-window entries, each with a 1930 line.
    expect(byAccount['1930'].postings).toBe(6)
    expect(byAccount['6570'].postings).toBe(4)
    expect(byAccount['5810'].postings).toBe(2)
    expect(byAccount['5810'].last_used).toBe('2026-06-20')

    // Draft line and out-of-window account are absent.
    expect(byAccount['9999']).toBeUndefined()
    expect(byAccount['4010']).toBeUndefined()
  })

  it('derives counterparty patterns with dominant category and contra account', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    const klarna = stats.counterparty_patterns.find(
      (p) => p.counterparty.toLowerCase() === 'klarna ab',
    )
    expect(klarna).toBeDefined()
    // Casing variants merged under one normalized key.
    expect(klarna!.occurrences).toBe(4)
    expect(klarna!.dominant_category).toBe('expense_bank_fees')
    expect(klarna!.dominant_category_count).toBe(3)
    // 1930 excluded, so the expense side wins.
    expect(klarna!.dominant_account_number).toBe('6570')
    expect(klarna!.last_booked).toBe('2026-06-10')

    const sl = stats.counterparty_patterns.find((p) => p.counterparty === 'SL')
    expect(sl!.occurrences).toBe(2)
    expect(sl!.dominant_account_number).toBe('5810')

    // Out-of-window merchant absent.
    expect(
      stats.counterparty_patterns.find((p) => p.counterparty === 'OLD VENDOR'),
    ).toBeUndefined()
  })

  it('orders counterparties by occurrences descending', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    const occurrences = stats.counterparty_patterns.map((p) => p.occurrences)
    expect(occurrences).toEqual([...occurrences].sort((a, b) => b - a))
  })

  it('reports window-scoped VAT treatments and median booking lag', async () => {
    const stats = await callRpc(companyId, '2026-04-01')
    expect(stats.vat_treatments_used).toEqual(['standard_25'])
    // All fixtures book same-day (entry_date = transaction date).
    expect(stats.median_booking_lag_days).toBe(0)
  })

  it('returns empty sections for a company with no data (isolation)', async () => {
    const other = await seedCompany()
    const stats = await callRpc(other.companyId, '2026-04-01')
    expect(stats.account_usage).toEqual([])
    expect(stats.counterparty_patterns).toEqual([])
    expect(stats.vat_treatments_used).toEqual([])
    expect(stats.median_booking_lag_days).toBeNull()
  })

  it('does not leak data across companies with identical merchants', async () => {
    const other = await seedCompany()
    await bookMerchant({
      userId: other.userId,
      companyId: other.companyId,
      fiscalPeriodId: other.fiscalPeriodId,
      merchantName: 'KLARNA AB',
      category: 'expense_card_fees',
      date: '2026-06-01',
      expenseAccount: '6580',
      voucherNumber: 1,
    })

    const stats = await callRpc(other.companyId, '2026-04-01')
    const klarna = stats.counterparty_patterns.find(
      (p) => p.counterparty.toLowerCase() === 'klarna ab',
    )
    // Only its own single booking; the first company's 4 do not bleed in.
    expect(klarna!.occurrences).toBe(1)
    expect(klarna!.dominant_category).toBe('expense_card_fees')
    expect(klarna!.dominant_account_number).toBe('6580')
  })
})
