import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { insertDraftJournalEntry, seedCompany } from './fixtures'

type Company = Awaited<ReturnType<typeof seedCompany>>
type Writer = 'line' | 'posting' | 'anchor'

async function fixture() {
  const company = await seedCompany()
  const entry = await insertDraftJournalEntry({ ...company, voucherNumber: 1 })
  await getPool().query(`INSERT INTO journal_entry_lines(journal_entry_id, account_number, debit_amount, credit_amount)
    VALUES ($1, '1930', 100, 0), ($1, '3001', 0, 100)`, [entry])
  return { company, entry }
}

async function write(client: PoolClient, company: Company, entry: string, kind: Writer) {
  if (kind === 'line') return client.query(
    "UPDATE journal_entry_lines SET line_description = 'Observed edit' WHERE journal_entry_id = $1 AND account_number = '1930'", [entry])
  if (kind === 'posting') return client.query("UPDATE journal_entries SET status = 'posted' WHERE id = $1", [entry])
  return client.query(`INSERT INTO transactions(company_id, user_id, date, amount, description, journal_entry_id)
    VALUES ($1, $2, '2026-06-01', 100, 'Synthetic observed match', $3)`, [company.companyId, company.userId, entry])
}

async function pair(run: (a: PoolClient, b: PoolClient) => Promise<void>) {
  const a = await getClient()
  const b = await getClient()
  try {
    await a.query('BEGIN')
    await b.query('BEGIN')
    await a.query("SET LOCAL lock_timeout = '3s'")
    await b.query("SET LOCAL lock_timeout = '3s'")
    await run(a, b)
  } finally {
    await a.query('ROLLBACK')
    await b.query('ROLLBACK')
    a.release()
    b.release()
  }
}

async function waitForBlock(pid: number, blocker: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await getPool().query('SELECT $2::int = ANY(pg_blocking_pids($1)) AS blocked', [pid, blocker])
    if (result.rows[0].blocked) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Expected repair to wait for the history writer')
}

describe('cash history observers retain exclusive repair coordination', () => {
  it.each<Writer>(['line', 'posting', 'anchor'])('refuses %s immediately when repair owns the company', async kind => {
    const { company, entry } = await fixture()
    await pair(async (repair, writer) => {
      await repair.query('SELECT lock_cash_account_company($1)', [company.companyId])
      // The writer already owns its journal row: waiting here would invert
      // the company-first repair protocol.
      await writer.query('SELECT id FROM journal_entries WHERE id = $1 FOR UPDATE', [entry])
      await expect(write(writer, company, entry, kind)).rejects.toMatchObject({ code: 'PT409', message: 'CASH_ACCOUNT_OPERATION_BUSY' })
    })
  })

  it.each<Writer>(['line', 'posting', 'anchor'])('makes repair wait for an existing %s writer', async kind => {
    const { company, entry } = await fixture()
    await pair(async (writer, repair) => {
      await write(writer, company, entry, kind)
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const repairPid = (await repair.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const pending = repair.query('SELECT lock_cash_account_company($1)', [company.companyId])
      void pending.catch(() => {})
      try {
        await waitForBlock(repairPid, writerPid)
      } finally {
        await writer.query('COMMIT')
        await pending
      }
      const status = (await repair.query('SELECT status FROM journal_entries WHERE id = $1', [entry])).rows[0].status
      expect(status).toBe(kind === 'posting' ? 'posted' : 'draft')
    })
  })

  it('allows two bank anchors to observe the same unchanged voucher', async () => {
    const { company, entry } = await fixture()
    await pair(async (a, b) => {
      await write(a, company, entry, 'anchor')
      await write(b, company, entry, 'anchor')
    })
  })
})

describe('shared company observation keeps same-voucher writes coordinated', () => {
  it.each(['line-first', 'anchor-first'] as const)('refuses a conflicting line/anchor operation: %s', async order => {
    const { company, entry } = await fixture()
    await pair(async (a, b) => {
      await write(a, company, entry, order === 'line-first' ? 'line' : 'anchor')
      await expect(write(b, company, entry, order === 'line-first' ? 'anchor' : 'line'))
        .rejects.toMatchObject({ code: 'PT409', message: 'CASH_ACCOUNT_OPERATION_BUSY' })
    })
  })

  it('refuses a line edit while direct posting owns the journal row', async () => {
    const { company, entry } = await fixture()
    await pair(async (a, b) => {
      await write(a, company, entry, 'posting')
      await expect(write(b, company, entry, 'line')).rejects.toMatchObject({ code: 'PT409' })
    })
  })

  it('rechecks the latest balanced lines after waiting for their editor', async () => {
    const { company, entry } = await fixture()
    await pair(async (editor, poster) => {
      await editor.query("UPDATE journal_entry_lines SET account_number = '2999' WHERE journal_entry_id = $1 AND account_number = '1930'", [entry])
      const editorPid = (await editor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const posterPid = (await poster.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const pending = write(poster, company, entry, 'posting')
      void pending.catch(() => {})
      try {
        await waitForBlock(posterPid, editorPid)
      } finally {
        await editor.query('COMMIT')
        await pending
      }
      expect((await poster.query("SELECT account_number FROM journal_entry_lines WHERE journal_entry_id = $1 AND debit_amount > 0", [entry])).rows)
        .toEqual([{ account_number: '2999' }])
    })
  })
})

describe('company observer authorization', () => {
  it.each(['owner', 'admin', 'member'] as const)('allows an active %s to observe its company', async role => {
    const company = await seedCompany()
    await getPool().query('UPDATE company_members SET role = $2 WHERE company_id = $1 AND user_id = $3', [company.companyId, role, company.userId])
    await withUserContext(company.userId, client => client.query('SELECT observe_cash_account_company($1)', [company.companyId]))
  })

  it.each(['viewer', 'other-company'] as const)('denies %s access', async kind => {
    const company = await seedCompany()
    if (kind === 'viewer') await getPool().query("UPDATE company_members SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [company.companyId, company.userId])
    const target = kind === 'other-company' ? (await seedCompany()).companyId : company.companyId
    await expect(withUserContext(company.userId, client => client.query('SELECT observe_cash_account_company($1)', [target])))
      .rejects.toMatchObject({ code: '42501' })
  })

  it('reports a nonexistent company to the backend and grants nothing to anon', async () => {
    await expect(getPool().query('SELECT observe_cash_account_company($1)', [randomUUID()]))
      .rejects.toMatchObject({ code: 'P0002' })
    const { rows } = await getPool().query("SELECT has_function_privilege('anon', 'observe_cash_account_company(uuid)', 'EXECUTE') AS allowed")
    expect(rows).toEqual([{ allowed: false }])
  })
})
