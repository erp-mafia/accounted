import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany, insertDraftJournalEntry } from '@/tests/pg/fixtures'

// Migration 20260831150000_inline_rattelse_opening_balance.sql: inline
// rättelse (BFL 5 kap 5 § track 2) now admits opening-balance verifikat, so
// IB edits in open unlocked years work like Fortnox: the number changes in
// place, no storno, the original lines survive in journal_entry_rattelse_log.
//
// The suite:
//   1. the period's linked IB accepts strike+replace, lines update in place,
//      the period link never moves, a log row is written
//   2. an IB that is NOT the period's current linked entry is refused
//   3. a posted bokslut (year_end) on the period refuses the rättelse
//   4. P&L accounts (class 3-8) are refused in IB replacement lines
//   5. storno / year_end / vat_settlement stay refused (unchanged)
//   6. non-IB entries still accept P&L accounts (guard is IB-scoped)

async function insertPostedIb(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
  voucherNumber?: number
  link?: boolean
  sourceType?: string
}): Promise<{ entryId: string; bankLineId: string; equityLineId: string }> {
  const entryId = await insertDraftJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    sourceType: params.sourceType ?? 'opening_balance',
    status: 'draft',
    voucherNumber: params.voucherNumber ?? 1,
  })
  const { rows: bank } = await getPool().query<{ id: string }>(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount, sort_order, line_description)
     VALUES ($1, '1930', 50000, 0, 1, 'IB 1930')
     RETURNING id`,
    [entryId],
  )
  const { rows: equity } = await getPool().query<{ id: string }>(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount, sort_order, line_description)
     VALUES ($1, '2091', 0, 50000, 2, 'IB 2091')
     RETURNING id`,
    [entryId],
  )
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [entryId])
  if (params.link !== false) {
    await getPool().query(
      `UPDATE public.fiscal_periods
          SET opening_balance_entry_id = $2, opening_balances_set = true
        WHERE id = $1`,
      [params.fiscalPeriodId, entryId],
    )
  }
  return { entryId, bankLineId: bank[0].id, equityLineId: equity[0].id }
}

async function insertChartAccount(companyId: string, userId: string, accountNumber: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
     VALUES ($1, $2, $3, 'Testkonto ' || $3, left($3, 1)::int, 'asset', 'debit')
     ON CONFLICT DO NOTHING`,
    [userId, companyId, accountNumber],
  )
}

async function callStrike(
  companyId: string,
  entryId: string,
  strikeIds: string[],
  newLines: unknown[],
  actor: string,
) {
  return getPool().query<{ result: { struck_count: number; added_count: number; log_id: string } }>(
    `SELECT public.correct_entry_lines_inline($1::uuid, $2::uuid, $3::uuid[], $4::jsonb, $5::uuid) AS result`,
    [companyId, entryId, strikeIds, JSON.stringify(newLines), actor],
  )
}

describe('inline rättelse: opening-balance verifikat', () => {
  it('edits the linked IB in place: lines replaced, link untouched, rättelse logged', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertChartAccount(companyId, userId, '1930')
    await insertChartAccount(companyId, userId, '2091')
    const { entryId, bankLineId } = await insertPostedIb({ companyId, userId, fiscalPeriodId })

    const res = await callStrike(
      companyId,
      entryId,
      [bankLineId],
      [
        { account_number: '1930', debit_amount: 55000, credit_amount: 0, line_description: 'IB 1930' },
        { account_number: '2091', debit_amount: 0, credit_amount: 5000, line_description: 'IB-rättelse 2091' },
      ],
      userId,
    )
    expect(res.rows[0].result.struck_count).toBe(1)
    expect(res.rows[0].result.added_count).toBe(2)
    expect(res.rows[0].result.log_id).toBeTruthy()

    // Same entry id, still posted, still the period's linked IB.
    const { rows: period } = await getPool().query(
      `SELECT opening_balance_entry_id FROM public.fiscal_periods WHERE id = $1`,
      [fiscalPeriodId],
    )
    expect(period[0].opening_balance_entry_id).toBe(entryId)

    const { rows: lines } = await getPool().query(
      `SELECT account_number, debit_amount::numeric, credit_amount::numeric
         FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY sort_order`,
      [entryId],
    )
    expect(lines).toHaveLength(3)
    const net1930 = lines
      .filter((l) => l.account_number === '1930')
      .reduce((s, l) => s + Number(l.debit_amount) - Number(l.credit_amount), 0)
    expect(net1930).toBe(55000)

    const { rows: log } = await getPool().query(
      `SELECT rattelse_type, struck_lines FROM public.journal_entry_rattelse_log WHERE journal_entry_id = $1`,
      [entryId],
    )
    expect(log).toHaveLength(1)
    expect(log[0].rattelse_type).toBe('lines')
    expect(JSON.stringify(log[0].struck_lines)).toContain('1930')
  })

  it('refuses an IB entry that is not the period\'s current linked opening balance', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertChartAccount(companyId, userId, '1930')
    await insertChartAccount(companyId, userId, '2091')
    const { entryId, bankLineId } = await insertPostedIb({
      companyId, userId, fiscalPeriodId, link: false,
    })

    await expect(
      callStrike(companyId, entryId, [bankLineId], [
        { account_number: '1930', debit_amount: 55000, credit_amount: 0 },
        { account_number: '2091', debit_amount: 0, credit_amount: 5000 },
      ], userId),
    ).rejects.toThrow(/inte periodens aktuella/)
  })

  it('refuses when the period carries a posted bokslut', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertChartAccount(companyId, userId, '1930')
    await insertChartAccount(companyId, userId, '2091')
    const { entryId, bankLineId } = await insertPostedIb({ companyId, userId, fiscalPeriodId })

    const yearEndId = await insertDraftJournalEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'year_end', status: 'draft', voucherNumber: 9,
    })
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
       VALUES ($1, '8999', 100, 0, 1), ($1, '2099', 0, 100, 2)`,
      [yearEndId],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [yearEndId])

    await expect(
      callStrike(companyId, entryId, [bankLineId], [
        { account_number: '1930', debit_amount: 55000, credit_amount: 0 },
        { account_number: '2091', debit_amount: 0, credit_amount: 5000 },
      ], userId),
    ).rejects.toThrow(/bokslut/)
  })

  it('refuses P&L accounts in IB replacement lines', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertChartAccount(companyId, userId, '1930')
    await insertChartAccount(companyId, userId, '3001')
    const { entryId, bankLineId } = await insertPostedIb({ companyId, userId, fiscalPeriodId })

    await expect(
      callStrike(companyId, entryId, [bankLineId], [
        { account_number: '3001', debit_amount: 50000, credit_amount: 0 },
      ], userId),
    ).rejects.toThrow(/Resultatkonton/)
  })

  it('still refuses storno / year_end / vat_settlement entries', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertChartAccount(companyId, userId, '1930')
    const { entryId, bankLineId } = await insertPostedIb({
      companyId, userId, fiscalPeriodId, sourceType: 'year_end', link: false, voucherNumber: 4,
    })

    await expect(
      callStrike(companyId, entryId, [bankLineId], [
        { account_number: '1930', debit_amount: 55000, credit_amount: 0 },
      ], userId),
    ).rejects.toThrow(/kan inte rättas radvis/)
  })

  it('keeps allowing P&L accounts on ordinary (non-IB) verifikat', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertChartAccount(companyId, userId, '1930')
    await insertChartAccount(companyId, userId, '5010')
    const entryId = await insertDraftJournalEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'manual', status: 'draft', voucherNumber: 8,
    })
    const { rows: exp } = await getPool().query<{ id: string }>(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
       VALUES ($1, '5010', 1000, 0, 1) RETURNING id`,
      [entryId],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
       VALUES ($1, '1930', 0, 1000, 2)`,
      [entryId],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [entryId])

    const res = await callStrike(companyId, entryId, [exp[0].id], [
      { account_number: '5010', debit_amount: 0, credit_amount: 0, line_description: 'x' },
      { account_number: '5010', debit_amount: 1000, credit_amount: 0, line_description: 'Rättad kostnad' },
    ].filter((l) => l.debit_amount > 0 || l.credit_amount > 0), userId)
    expect(res.rows[0].result.added_count).toBe(1)
  })
})
