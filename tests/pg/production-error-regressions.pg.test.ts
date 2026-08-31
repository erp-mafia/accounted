import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from './fixtures'

async function insertEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
  entryDate: string
  lines: Array<{ account: string; debit: number; credit: number }>
}): Promise<string> {
  return insertPostedJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    voucherNumber: params.voucherNumber,
    entryDate: params.entryDate,
    description: 'Production regression test',
    sourceType: 'manual',
    lines: params.lines.map((line) => ({
      accountNumber: line.account,
      debitAmount: line.debit,
      creditAmount: line.credit,
    })),
  })
}

async function seedCompany() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  const fiscalPeriodId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
  })
  return { userId, companyId, fiscalPeriodId }
}

describe('production error regressions', () => {
  it('registers PendingOperationApproved in the processing history catalog', async () => {
    const { rows } = await getPool().query(
      `SELECT event_type
       FROM public.processing_event_types
       WHERE event_type = 'PendingOperationApproved'`,
    )

    expect(rows).toEqual([{ event_type: 'PendingOperationApproved' }])
  })

  it('registers the WhatsApp channel question events in the processing history catalog', async () => {
    // appendQuestionHistory() swallows FK failures so the reply to the sender
    // still goes out, so an unregistered type is invisible outside the logs.
    const { rows } = await getPool().query(
      `SELECT event_type
       FROM public.processing_event_types
       WHERE event_type = ANY($1::text[])
       ORDER BY event_type`,
      [['ChannelQuestionAsked', 'ChannelQuestionAnswered', 'ChannelQuestionExpired']],
    )

    expect(rows.map((row) => row.event_type)).toEqual([
      'ChannelQuestionAnswered',
      'ChannelQuestionAsked',
      'ChannelQuestionExpired',
    ])
  })

  it('aggregates period activity and excludes a specified opening entry', async () => {
    const ctx = await seedCompany()
    const openingId = await insertEntry({
      ...ctx,
      voucherNumber: 1,
      entryDate: '2026-01-01',
      lines: [
        { account: '1930', debit: 1_000, credit: 0 },
        { account: '2010', debit: 0, credit: 1_000 },
      ],
    })
    await insertEntry({
      ...ctx,
      voucherNumber: 2,
      entryDate: '2026-03-15',
      lines: [
        { account: '1930', debit: 250, credit: 0 },
        { account: '3001', debit: 0, credit: 250 },
      ],
    })

    const { rows } = await getPool().query(
      `SELECT account_number, debit::text, credit::text
       FROM public.get_account_period_activity($1, $2, $3, $4, $5)`,
      [ctx.companyId, '2026-01-01', '2026-12-31', ['1930', '3001'], openingId],
    )

    expect(rows).toEqual([
      { account_number: '1930', debit: '250', credit: '0' },
      { account_number: '3001', debit: '0', credit: '250' },
    ])
  })

  it('pages VAT source lines with a stable entry and line cursor', async () => {
    const ctx = await seedCompany()
    await insertEntry({
      ...ctx,
      voucherNumber: 1,
      entryDate: '2026-03-01',
      lines: [
        { account: '1930', debit: 125, credit: 0 },
        { account: '2611', debit: 0, credit: 25 },
        { account: '3001', debit: 0, credit: 100 },
      ],
    })
    await insertEntry({
      ...ctx,
      voucherNumber: 2,
      entryDate: '2026-03-02',
      lines: [
        { account: '1930', debit: 250, credit: 0 },
        { account: '2611', debit: 0, credit: 50 },
        { account: '3001', debit: 0, credit: 200 },
      ],
    })

    // p_ruta_accounts / p_net_accounts are the settlement-shape detectors the
    // drill-down gained in 20260828172003 so it drops the same entries as the
    // filed figure. Neither fixture here is settlement-shaped, so paging is
    // unaffected; the equality itself is covered by
    // tests/pg/vat-ruta-drilldown-reconcile.pg.test.ts.
    const first = await getPool().query(
      `SELECT * FROM public.get_vat_ruta_source_lines(
         $1, $2, $3, $4, $5, $6, NULL, NULL, NULL, NULL, 1
       )`,
      [ctx.companyId, '2026-03-01', '2026-03-31', ['2611'], ['2611'], ['2650', '1650']],
    )
    expect(first.rows).toHaveLength(1)
    expect(first.rows[0].voucher_number).toBe(1)

    const second = await getPool().query(
      `SELECT * FROM public.get_vat_ruta_source_lines(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1
       )`,
      [
        ctx.companyId,
        '2026-03-01',
        '2026-03-31',
        ['2611'],
        ['2611'],
        ['2650', '1650'],
        first.rows[0].entry_date,
        first.rows[0].voucher_number,
        first.rows[0].journal_entry_id,
        first.rows[0].line_id,
      ],
    )
    expect(second.rows).toHaveLength(1)
    expect(second.rows[0].voucher_number).toBe(2)
  })

  it('installs the covering indexes used by the timeout fixes', async () => {
    const { rows } = await getPool().query(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN (
           'idx_audit_log_company_created_id',
           'idx_journal_entries_company_posted_date_id'
         )
       ORDER BY indexname`,
    )

    expect(rows.map((row) => row.indexname)).toEqual([
      'idx_audit_log_company_created_id',
      'idx_journal_entries_company_posted_date_id',
    ])
  })
})
