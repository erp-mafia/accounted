import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertDraftJournalEntry, insertPostedJournalEntry, insertTransaction, seedCompany } from './fixtures'

type Company = Awaited<ReturnType<typeof seedCompany>>

async function withSessions(run: (report: PoolClient, writer: PoolClient) => Promise<void>) {
  const report = await getPool().connect()
  const writer = await getPool().connect()
  try {
    for (const client of [report, writer]) {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout = '500ms'")
    }
    await run(report, writer)
  } finally {
    await report.query('ROLLBACK')
    await writer.query('ROLLBACK')
    report.release()
    writer.release()
  }
}

async function serviceContext(client: PoolClient) {
  await client.query("SELECT set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)")
  await client.query("SELECT set_config('request.jwt.claim.role', 'service_role', true)")
  await client.query('SET LOCAL ROLE service_role')
}

async function acquireRead(client: PoolClient, company: Company) {
  await serviceContext(client)
  return (await client.query("SELECT acquire_sie_period_read($1, 'report_export') AS token", [company.companyId])).rows[0].token as string
}

async function startImport(client: PoolClient, company: Company) {
  await serviceContext(client)
  return client.query("SELECT j.id FROM start_sie_import_job($1, $2, $3, 'synthetic.se', $4, $5) j", [
    company.companyId, company.userId, company.fiscalPeriodId, 'd'.repeat(64), JSON.stringify({
      input: { fiscalYear: { start: '2026-01-01', end: '2026-12-31' } }, file_storage_path: 'synthetic.se',
    }),
  ])
}

async function draft(company: Company, sourceType: string) {
  const entry = await insertDraftJournalEntry({ ...company, sourceType, voucherSeries: 'L' })
  await getPool().query(`INSERT INTO journal_entry_lines(journal_entry_id, account_number, debit_amount, credit_amount)
    VALUES($1, '1930', 100, 0), ($1, '3001', 0, 100)`, [entry])
  if (sourceType === 'storno') {
    const original = await insertPostedJournalEntry({ ...company, voucherSeries: 'A', voucherNumber: 1 })
    await getPool().query('UPDATE journal_entries SET reverses_id = $1 WHERE id = $2', [original, entry])
  }
  return entry
}

describe('SIE report leases coexist with ordinary bookkeeping', () => {
  it('does not block a native commit allocating its first voucher sequence', async () => {
    const company = await seedCompany()
    const entry = await draft(company, 'manual')
    await withSessions(async (report, writer) => {
      await acquireRead(report, company)
      await expect(writer.query('SELECT * FROM commit_journal_entry($1, $2)', [company.companyId, entry])).resolves.toMatchObject({ rowCount: 1 })
    })
  })

  it.each(['year_end', 'storno'].flatMap(sourceType => [false, true].map(reportFirst => ({ sourceType, reportFirst }))))(
    'allows $sourceType posting with report-first=$reportFirst', async ({ sourceType, reportFirst }) => {
    const company = await seedCompany()
    const entry = await draft(company, sourceType)
    // Isolate the observer lock from the new sequence's foreign-key lock.
    await getPool().query("SELECT next_voucher_number($1, $2, 'L')", [company.companyId, company.fiscalPeriodId])
    const post = (client: PoolClient) => client.query('SELECT * FROM commit_journal_entry($1, $2)', [company.companyId, entry])
    await withSessions(async (report, writer) => {
      if (reportFirst) {
        await acquireRead(report, company)
        await expect(post(writer)).resolves.toMatchObject({ rowCount: 1 })
      } else {
        await post(writer)
        await expect(acquireRead(report, company)).resolves.toEqual(expect.any(String))
      }
    })
  })

  it.each([false, true])('allows an imported bank-anchor edit with report-first=%s', async reportFirst => {
    const company = await seedCompany()
    const entry = await insertPostedJournalEntry({ ...company, sourceType: 'import' })
    const transaction = await insertTransaction({ ...company, amount: 1000, journalEntryId: entry })
    const edit = (client: PoolClient) => client.query("UPDATE transactions SET description = 'Synthetic bank metadata' WHERE id = $1", [transaction])
    await withSessions(async (report, writer) => {
      if (reportFirst) {
        await acquireRead(report, company)
        await expect(edit(writer)).resolves.toMatchObject({ rowCount: 1 })
      } else {
        await edit(writer)
        await expect(acquireRead(report, company)).resolves.toEqual(expect.any(String))
      }
    })
  })

  it('keeps admission excluded for the entire committed report lease', async () => {
    const company = await seedCompany()
    await withSessions(async (report, writer) => {
      const token = await acquireRead(report, company)
      await report.query('COMMIT')
      try {
        await expect(startImport(writer, company)).rejects.toMatchObject({ code: '55000' })
      } finally {
        await report.query('BEGIN')
        await serviceContext(report)
        await report.query('SELECT finish_sie_period_read($1, $2, true)', [company.companyId, token])
        await report.query('COMMIT')
      }
    })
  })

  it('keeps an uncommitted import hold excluded from report acquisition', async () => {
    const company = await seedCompany()
    await withSessions(async (report, writer) => {
      await startImport(writer, company)
      await expect(acquireRead(report, company)).rejects.toMatchObject({ code: '55P03' })
    })
  })

  it('allows unlinked bank-sync writes while a period is exclusively held', async () => {
    const company = await seedCompany()
    await withSessions(async (report, writer) => {
      await startImport(report, company)
      const row = (await writer.query(`INSERT INTO transactions(company_id, user_id, date, amount, description)
        VALUES($1, $2, '2026-06-01', 100, 'Synthetic bank sync') RETURNING id`, [company.companyId, company.userId])).rows[0]
      await expect(writer.query("UPDATE transactions SET description = 'Updated bank metadata' WHERE id = $1", [row.id])).resolves.toMatchObject({ rowCount: 1 })
      await expect(writer.query('DELETE FROM transactions WHERE id = $1', [row.id])).resolves.toMatchObject({ rowCount: 1 })
    })
  })

  it('continues checking both attachment and detachment of a bank pointer', async () => {
    const company = await seedCompany()
    const entry = await insertPostedJournalEntry({ ...company, sourceType: 'import' })
    const linked = await insertTransaction({ ...company, amount: 1000, journalEntryId: entry })
    const unlinked = await insertTransaction({ ...company, amount: 1000 })
    await withSessions(async (report, writer) => {
      await report.query('SELECT id FROM fiscal_periods WHERE id = $1 FOR UPDATE', [company.fiscalPeriodId])
      for (const [transaction, nextEntry] of [[linked, null], [unlinked, entry]]) {
        await writer.query('SAVEPOINT pointer_change')
        await expect(writer.query('UPDATE transactions SET journal_entry_id = $1 WHERE id = $2', [nextEntry, transaction])).rejects.toMatchObject({ code: '55P03' })
        await writer.query('ROLLBACK TO SAVEPOINT pointer_change')
      }
    })
  })
})
