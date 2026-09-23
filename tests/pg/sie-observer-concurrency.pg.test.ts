import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertDraftJournalEntry, insertPostedJournalEntry, seedCompany } from './fixtures'

type Company = Awaited<ReturnType<typeof seedCompany>>

async function withConcurrentTransactions(run: (a: PoolClient, b: PoolClient) => Promise<void>) {
  const a = await getPool().connect()
  const b = await getPool().connect()
  try {
    await a.query('BEGIN')
    await b.query('BEGIN')
    // Fail deterministically if an observer unexpectedly waits for another one.
    await a.query("SET LOCAL lock_timeout = '500ms'")
    await b.query("SET LOCAL lock_timeout = '500ms'")
    await run(a, b)
  } finally {
    await a.query('ROLLBACK')
    await b.query('ROLLBACK')
    a.release()
    b.release()
  }
}

async function postYearEnd(client: PoolClient, company: Company, number: number) {
  const id = randomUUID()
  await client.query(`INSERT INTO journal_entries(id, company_id, user_id, fiscal_period_id,
    voucher_series, voucher_number, source_type, entry_date, description, status)
    VALUES($1, $2, $3, $4, 'A', $5, 'year_end', '2026-12-31', 'Synthetic year-end entry', 'draft')`,
  [id, company.companyId, company.userId, company.fiscalPeriodId, number])
  await client.query(`INSERT INTO journal_entry_lines(journal_entry_id, account_number, debit_amount, credit_amount)
    VALUES($1, '1930', 100, 0), ($1, '3001', 0, 100)`, [id])
  await client.query("UPDATE journal_entries SET status = 'posted' WHERE id = $1", [id])
  return id
}

async function startImport(client: PoolClient, company: Company) {
  await client.query("SELECT set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)")
  await client.query('SET LOCAL ROLE service_role')
  return client.query(`SELECT j.id FROM start_sie_import_job($1, $2, $3, 'synthetic.se', $4, $5) j`,
    [company.companyId, company.userId, company.fiscalPeriodId, 'c'.repeat(64), JSON.stringify({
      input: { fiscalYear: { start: '2026-01-01', end: '2026-12-31' } },
      file_storage_path: 'synthetic.se',
    })])
}

describe('SIE hold observers and concurrent ordinary bookkeeping', () => {
  it('posts unrelated year-end vouchers concurrently in the same unheld period', async () => {
    const company = await seedCompany()
    await withConcurrentTransactions(async (a, b) => {
      const first = await postYearEnd(a, company, 11)
      const second = await postYearEnd(b, company, 12)
      expect((await a.query('SELECT status FROM journal_entries WHERE id = $1', [first])).rows[0].status).toBe('posted')
      expect((await b.query('SELECT status FROM journal_entries WHERE id = $1', [second])).rows[0].status).toBe('posted')
    })
  })

  it('allows concurrent line work on separate imported drafts without an execution hold', async () => {
    const company = await seedCompany()
    const first = await insertDraftJournalEntry({ ...company, sourceType: 'import', voucherNumber: 11 })
    const second = await insertDraftJournalEntry({ ...company, sourceType: 'import', voucherNumber: 12 })
    await withConcurrentTransactions(async (a, b) => {
      for (const [client, entry] of [[a, first], [b, second]] as const) {
        await client.query(`INSERT INTO journal_entry_lines(journal_entry_id, account_number, debit_amount, credit_amount)
          VALUES($1, '1930', 100, 0), ($1, '3001', 0, 100)`, [entry])
      }
    })
  })

  it('matches different imported vouchers concurrently in the same unheld period', async () => {
    const company = await seedCompany()
    const first = await insertPostedJournalEntry({ ...company, sourceType: 'import', voucherNumber: 11 })
    const second = await insertPostedJournalEntry({ ...company, sourceType: 'import', voucherNumber: 12 })
    await withConcurrentTransactions(async (a, b) => {
      for (const [client, entry] of [[a, first], [b, second]] as const) {
        await client.query(`INSERT INTO transactions(company_id, user_id, date, amount, description, journal_entry_id)
          VALUES($1, $2, '2026-06-01', 1000, 'Synthetic bank match', $3)`, [company.companyId, company.userId, entry])
      }
    })
  })

  it('excludes admission and ordinary year-end writes in either lock order', async () => {
    const company = await seedCompany()
    await withConcurrentTransactions(async (a, b) => {
      await startImport(a, company)
      // The hold is not committed or visible to B; its row lock must protect it.
      await expect(postYearEnd(b, company, 11)).rejects.toMatchObject({ code: '55P03' })
      await a.query('SAVEPOINT held_write')
      await a.query('RESET ROLE')
      await expect(postYearEnd(a, company, 12)).rejects.toMatchObject({ code: '55000' })
      await a.query('ROLLBACK TO SAVEPOINT held_write')
    })
    await withConcurrentTransactions(async (a, b) => {
      await postYearEnd(b, company, 13)
      await expect(startImport(a, company)).rejects.toMatchObject({ code: '55P03' })
      // Own-transaction period updates can upgrade the observation lock.
      await b.query("UPDATE fiscal_periods SET name = 'Reviewed 2026' WHERE id = $1", [company.fiscalPeriodId])
    })
  })
})
