/**
 * pg-real tests for migration
 * 20260925154203_sie_start_guard_ignores_manual_opening_balance.
 *
 * start_sie_import_job refuses a new import into a year that already carries
 * imported content. Before this migration the entry test read
 * `source_type IN ('import','opening_balance')`, which also matched an opening
 * balance typed in through the Excel importer: that user could never import a
 * SIE file into the year again, and the replacement path was closed too
 * because it needs an undone sie_imports row that never existed.
 *
 * The three cases below are the whole contract: the manual opening balance
 * stops blocking, and both kinds of genuinely imported entry keep blocking.
 * The legacy case matters most: the pre-backbone writer left no batch identity
 * on its vouchers, so a guard written around import_batch_id alone would have
 * reopened the year to a second legacy import.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole } from '@/tests/pg/setup'
import { seedCompany, insertDraftJournalEntry } from '@/tests/pg/fixtures'

const ADMISSION_REFUSAL = /requires reviewed replacement or reconciliation/

type Fixture = { userId: string; companyId: string; fiscalPeriodId: string }

const manifest = () =>
  JSON.stringify({
    input: {
      filename: 'vouchers.se',
      options: {},
      mappings: [],
      fiscalYear: { start: '2026-01-01', end: '2026-12-31' },
    },
    file_storage_path: 'vouchers.se',
  })

const fileHash = () => randomUUID().replace(/-/g, '').repeat(2).slice(0, 64)

/**
 * A posted opening balance carrying an import's batch identity, the way
 * write_sie_job_entries books a #IB voucher.
 *
 * Written by hand rather than through the fixture: importFixtureBatch only
 * attaches a batch to source_type 'import', and the provenance trigger makes
 * the columns immutable afterwards, so the identity has to be there at INSERT.
 * The sie_imports row deliberately carries no fiscal_year_start/end, so the
 * admission check's second EXISTS (which reads sie_imports) cannot fire and
 * the test can only pass or fail on the entry check being changed here.
 */
async function insertImportWrittenOpeningBalance(f: Fixture): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const batchId: string = (
      await client.query(
        `INSERT INTO public.sie_imports(company_id, user_id, filename, file_hash, sie_type, status)
         VALUES ($1, $2, 'provenance-fixture.se', md5(gen_random_uuid()::text), 4, 'completed')
         RETURNING id`,
        [f.companyId, f.userId],
      )
    ).rows[0].id
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status,
          import_batch_id, source_ordinal, source_content_hash)
       VALUES ($1, $2, $3, $4, 1, 'A', '2026-01-01', 'IB ur SIE', 'opening_balance', 'draft',
               $5, 0, repeat('a', 64))`,
      [id, f.userId, f.companyId, f.fiscalPeriodId, batchId],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 1000, 0), ($1, '2081', 0, 1000)`,
      [id],
    )
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    await client.query('COMMIT')
    return id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function startImport(f: Fixture) {
  return runAsServiceRole((c) =>
    c.query<{ id: string }>(
      `SELECT (public.start_sie_import_job($1,$2,$3,'vouchers.se',$4,$5)).id`,
      [f.companyId, f.userId, f.fiscalPeriodId, fileHash(), manifest()],
    ),
  )
}

describe('start_sie_import_job admission with an existing opening balance', () => {
  it('admits an import when the year carries a manually entered opening balance', async () => {
    const f = await seedCompany()
    // The Excel importer's output: opening_balance, posted, no batch identity.
    await insertDraftJournalEntry({
      ...f,
      sourceType: 'opening_balance',
      status: 'posted',
      voucherNumber: 1,
      entryDate: '2026-01-01',
    })

    const started = await startImport(f)

    expect(started.rows[0]?.id).toBeTruthy()
  })

  it('still refuses when the year carries a legacy imported voucher with no batch identity', async () => {
    const f = await seedCompany()
    await insertDraftJournalEntry({
      ...f,
      sourceType: 'import',
      status: 'posted',
      voucherNumber: 1,
      legacyImport: true,
    })

    await expect(startImport(f)).rejects.toThrow(ADMISSION_REFUSAL)
  })

  it('still refuses when the year carries an opening balance written by an import', async () => {
    const f = await seedCompany()
    await insertImportWrittenOpeningBalance(f)

    await expect(startImport(f)).rejects.toThrow(ADMISSION_REFUSAL)
  })
})
