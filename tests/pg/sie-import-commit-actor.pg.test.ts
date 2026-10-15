import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool } from './setup'

/**
 * Covers 20261015235000_sie_import_commit_actor: an SIE import's verifikat
 * record the actor that submitted the import (sealed into the job manifest
 * as commit_actor by submitSIEJob), with commit_method 'migration', and the
 * audit rows name the same actor instead of defaulting to 'user'.
 *
 * Runs the job protocol the worker runs (start, claim, save chunk, seal,
 * import_sie_chunk) as service_role, inside one transaction that rolls back.
 */
let client: PoolClient
let company: string
let actor: string
let period: string
let worker: string
let job: string
let attempt: number
let accounts: string[]

const baseManifest = {
  input: { filename: 'synthetic.se', options: {}, mappings: [], fiscalYear: { start: '2026-01-01', end: '2026-12-31' } },
  file_storage_path: 'synthetic.se',
}
const claudeActor = { type: 'mcp_oauth', label: 'SIE import: Claude (Anthropic)' }

beforeAll(async () => {
  client = await getPool().connect()
  await client.query('BEGIN')
})
afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK')
    client.release()
  }
})
beforeEach(async () => {
  await client.query('SAVEPOINT scenario')
  ;[company, actor, period, worker] = Array.from({ length: 4 }, () => randomUUID())
  await client.query(
    `INSERT INTO auth.users(id,email,instance_id) VALUES($1,$2,'00000000-0000-0000-0000-000000000000')`,
    [actor, `sie-actor-${actor}@test.invalid`],
  )
  await client.query(
    `INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,'Synthetic SIE AB','aktiebolag',$2)`,
    [company, actor],
  )
  await client.query(`INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')`, [company, actor])
  await client.query(
    `INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end) VALUES($1,$2,$3,'2026','2026-01-01','2026-12-31')`,
    [period, company, actor],
  )
  accounts = [randomUUID(), randomUUID()]
  for (const [i, number] of ['1930', '3001'].entries()) {
    await client.query(
      `INSERT INTO chart_of_accounts(id,company_id,user_id,account_number,account_name,account_type,account_class,normal_balance)
       VALUES($1,$2,$3,$4,'Synthetic account',$5,$6,$7)`,
      [accounts[i], company, actor, number, i ? 'revenue' : 'asset', i ? 3 : 1, i ? 'credit' : 'debit'],
    )
  }
  await client.query(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true)`)
  await client.query(`SELECT set_config('request.jwt.claim.role','service_role',true)`)
  await client.query('SET LOCAL ROLE service_role')
})
afterEach(async () => {
  await client.query('ROLLBACK TO SAVEPOINT scenario')
})

async function startJob(manifest: Record<string, unknown>): Promise<Record<string, unknown>> {
  const started = await client.query(`SELECT j.* FROM start_sie_import_job($1,$2,$3,'synthetic.se',$4,$5) j`, [
    company,
    actor,
    period,
    'a'.repeat(64),
    JSON.stringify(manifest),
  ])
  job = started.rows[0].id
  const claimed = await client.query(`SELECT j.* FROM claim_sie_import_job($1,$2) j`, [worker, job])
  attempt = claimed.rows[0].job_attempt
  return started.rows[0].manifest as Record<string, unknown>
}

function voucher(ordinal: number) {
  return {
    sourceId: `A${ordinal + 1}`, sourceOrdinal: ordinal, sieImportId: job, series: 'A', date: '2026-02-01',
    description: 'Synthetic voucher', sourceSeries: 'A', sourceNumber: ordinal + 1, sourceType: 'import',
    lines: [
      { account_number: '1930', account_id: accounts[0], debit_amount: 100, credit_amount: 0, dimensions: {} },
      { account_number: '3001', account_id: accounts[1], debit_amount: 0, credit_amount: 100, dimensions: {} },
    ],
  }
}

/** Save one voucher chunk, seal with the job's own manifest (as the worker does: it spreads job.manifest), import it. */
async function importOneChunk(): Promise<string[]> {
  await client.query('SELECT save_sie_import_chunk($1,$2,$3,$4,$5,$6,$7)', [
    company, job, worker, attempt, 'vouchers', 0, JSON.stringify([voucher(0), voucher(1)]),
  ])
  const { rows } = await client.query('SELECT manifest FROM sie_imports WHERE id = $1', [job])
  await client.query('SELECT seal_sie_import_preparation($1,$2,$3,$4,$5,$6)', [
    company, job, worker, attempt, JSON.stringify(rows[0].manifest), 1,
  ])
  const result = await client.query('SELECT import_sie_chunk($1,$2,$3,$4,$5,$6) result', [
    company, job, worker, attempt, 'vouchers', 0,
  ])
  return (result.rows[0].result.inserted_entries as Array<{ id: string }>).map((e) => e.id)
}

async function stamps(ids: string[]) {
  await client.query('RESET ROLE')
  const entries = await client.query(
    `SELECT status, commit_method, committed_actor_type, committed_actor_label
       FROM journal_entries WHERE id = ANY($1::uuid[]) ORDER BY voucher_number`,
    [ids],
  )
  const audit = await client.query(
    `SELECT actor_type, actor_label FROM audit_log
      WHERE record_id = ANY($1::uuid[]) AND table_name = 'journal_entries' AND action = 'COMMIT'`,
    [ids],
  )
  await client.query('SET LOCAL ROLE service_role')
  return { entries: entries.rows, audit: audit.rows }
}

describe('SIE import commit actor (pg-real)', () => {
  it('start_sie_import_job keeps commit_actor beside the source inputs and still drops anything else', async () => {
    const manifest = await startJob({ ...baseManifest, commit_actor: claudeActor, checkpoint: 'forged' })
    expect(manifest.commit_actor).toEqual(claudeActor)
    expect(manifest).not.toHaveProperty('checkpoint')
  })

  it('stamps every verifikat of the chunk with the submitting actor and commit_method migration', async () => {
    await startJob({ ...baseManifest, commit_actor: claudeActor })
    const ids = await importOneChunk()
    expect(ids).toHaveLength(2)

    const { entries, audit } = await stamps(ids)
    expect(entries).toEqual([
      { status: 'posted', commit_method: 'migration', committed_actor_type: 'mcp_oauth', committed_actor_label: 'SIE import: Claude (Anthropic)' },
      { status: 'posted', commit_method: 'migration', committed_actor_type: 'mcp_oauth', committed_actor_label: 'SIE import: Claude (Anthropic)' },
    ])
    expect(audit).toHaveLength(2)
    for (const row of audit) expect(row).toEqual({ actor_type: 'mcp_oauth', actor_label: 'SIE import: Claude (Anthropic)' })
  })

  it('a job submitted without commit_actor posts as before: no actor, audit user', async () => {
    await startJob(baseManifest)
    const ids = await importOneChunk()

    const { entries, audit } = await stamps(ids)
    for (const entry of entries) {
      expect(entry).toEqual({ status: 'posted', commit_method: 'migration', committed_actor_type: null, committed_actor_label: null })
    }
    for (const row of audit) expect(row).toEqual({ actor_type: 'user', actor_label: null })
  })

  it('drops a commit_actor type outside the CHECK list instead of failing the chunk', async () => {
    await startJob({ ...baseManifest, commit_actor: { type: 'robot', label: 'SIE import: forged' } })
    const ids = await importOneChunk()

    const { entries } = await stamps(ids)
    for (const entry of entries) {
      expect(entry).toMatchObject({ status: 'posted', committed_actor_type: null, committed_actor_label: null })
    }
  })

  it('names the actor on the compact chunk audit row too', async () => {
    await startJob({ ...baseManifest, commit_actor: { type: 'api_key', label: 'SIE import: Byrånyckel' } })
    await client.query('SELECT set_sie_import_audit_mode($1,$2,$3,$4,$5)', [company, job, worker, attempt, 'chunk'])
    await importOneChunk()

    await client.query('RESET ROLE')
    const { rows } = await client.query(
      `SELECT actor_type, actor_label FROM audit_log WHERE company_id = $1 AND table_name = 'sie_import_chunks' AND action = 'COMMIT'`,
      [company],
    )
    await client.query('SET LOCAL ROLE service_role')
    expect(rows).toEqual([{ actor_type: 'api_key', actor_label: 'SIE import: Byrånyckel' }])
  })
})
