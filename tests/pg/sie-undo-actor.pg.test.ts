/**
 * pg-real tests for 20261016005200_sie_undo_actor: the stornos of an SIE undo
 * record WHO asked for it.
 *   - request_sie_import_undo records p_actor_type / p_actor_label on the job
 *     (undo_actor_type / undo_actor_label); undo_sie_import_chunk stamps them
 *     on every storno with commit_method 'migration', and the COMMIT and
 *     REVERSE audit rows name the same actor;
 *   - a replacement undoes the previous import on behalf of the actor sealed
 *     in the new manifest (commit_actor);
 *   - an undo requested without an actor (an older deploy) posts as before:
 *     no actor, commit_method 'migration', audit 'user';
 *   - a reviewed duplicate repair posts its stornos as actor 'system';
 *   - one signature for request_sie_import_undo, grants as before.
 *
 * Everything runs in one transaction that is rolled back.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool } from '@/tests/pg/setup'

let client: PoolClient
let company: string
let actor: string
let period: string
let worker: string
let job: string
let accounts: string[]

function manifest(filename = 'synthetic-2024.se', commitActor?: { type: string; label: string }) {
  return JSON.stringify({
    input: { filename, options: {}, mappings: [], fiscalYear: { start: '2024-01-01', end: '2024-12-31' } },
    file_storage_path: filename,
    ...(commitActor ? { commit_actor: commitActor } : {}),
  })
}

async function asServiceRole() {
  await client.query(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true)`)
  await client.query(`SELECT set_config('request.jwt.claim.role','service_role',true)`)
  await client.query('SET LOCAL ROLE service_role')
}

async function claim(id: string): Promise<number> {
  const { rows } = await client.query('SELECT j.* FROM public.claim_sie_import_job($1,$2) j', [worker, id])
  expect(rows[0].id).toBe(id)
  return rows[0].job_attempt
}

async function undoChunk(id: string, attempt: number): Promise<{ reversed: number; done: boolean }> {
  return (await client.query('SELECT public.undo_sie_import_chunk($1,$2,$3,$4) AS r', [company, id, worker, attempt])).rows[0].r
}

/** A completed 2024 import with two vouchers. */
async function importYear() {
  job = (await client.query(`SELECT (public.start_sie_import_job($1,$2,$3,'synthetic-2024.se',$4,$5)).id`,
    [company, actor, period, 'd'.repeat(64), manifest()])).rows[0].id
  const attempt = await claim(job)
  const payload = ['2024-03-04', '2024-06-30'].map((date, ordinal) => ({
    sourceId: `A${ordinal + 1}`, sourceOrdinal: ordinal, sieImportId: job, series: 'A', date,
    description: 'Synthetic voucher', sourceSeries: 'A', sourceNumber: ordinal + 1, sourceType: 'import', lines: [
      { account_number: '1930', account_id: accounts[0], debit_amount: 100, credit_amount: 0, dimensions: {} },
      { account_number: '3001', account_id: accounts[1], debit_amount: 0, credit_amount: 100, dimensions: {} },
    ],
  }))
  await client.query('SELECT public.save_sie_import_chunk($1,$2,$3,$4,$5,$6,$7)',
    [company, job, worker, attempt, 'vouchers', 0, JSON.stringify(payload)])
  await client.query('SELECT public.seal_sie_import_preparation($1,$2,$3,$4,$5,$6)',
    [company, job, worker, attempt, manifest(), 1])
  await client.query('SELECT public.import_sie_chunk($1,$2,$3,$4,$5,$6)', [company, job, worker, attempt, 'vouchers', 0])
  await client.query('SELECT public.complete_sie_import_job($1,$2,$3,$4,$5,$6)',
    [company, job, worker, attempt, JSON.stringify({ success: true, journalEntriesCreated: 2, warnings: [] }), '{}'])
}

/** The stornos posted for `importId`, and the COMMIT / REVERSE audit rows of the undo. */
async function undoStamps(importId: string) {
  await client.query('RESET ROLE')
  const { rows: stornos } = await client.query(
    `SELECT s.id, s.status, s.commit_method, s.committed_actor_type, s.committed_actor_label
       FROM public.journal_entries s JOIN public.journal_entries o ON o.id = s.reverses_id
      WHERE o.import_batch_id = $1 ORDER BY s.voucher_number`, [importId])
  const { rows: originals } = await client.query(
    `SELECT id FROM public.journal_entries WHERE import_batch_id = $1`, [importId])
  const { rows: commits } = await client.query(
    `SELECT actor_type, actor_label FROM public.audit_log
      WHERE table_name = 'journal_entries' AND action = 'COMMIT' AND record_id = ANY($1::uuid[])`,
    [stornos.map((s) => s.id)])
  const { rows: reversals } = await client.query(
    `SELECT actor_type, actor_label FROM public.audit_log
      WHERE table_name = 'journal_entries' AND action = 'REVERSE' AND record_id = ANY($1::uuid[])`,
    [originals.map((o) => o.id)])
  await asServiceRole()
  return {
    stornos: stornos.map(({ id: _id, ...rest }) => rest),
    commits,
    reversals,
  }
}

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
  await client.query(`INSERT INTO auth.users(id,email,instance_id) VALUES($1,$2,'00000000-0000-0000-0000-000000000000')`,
    [actor, `sie-undo-actor-${actor}@test.invalid`])
  await client.query(`INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,'Synthetic SIE AB','aktiebolag',$2)`, [company, actor])
  await client.query(`INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')`, [company, actor])
  await client.query(`INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end)
    VALUES($1,$2,$3,'2024','2024-01-01','2024-12-31')`, [period, company, actor])
  accounts = [randomUUID(), randomUUID()]
  for (const [i, number] of ['1930', '3001'].entries()) {
    await client.query(`INSERT INTO chart_of_accounts(id,company_id,user_id,account_number,account_name,account_type,account_class,normal_balance)
      VALUES($1,$2,$3,$4,'Synthetic account',$5,$6,$7)`,
      [accounts[i], company, actor, number, i ? 'revenue' : 'asset', i ? 3 : 1, i ? 'credit' : 'debit'])
  }
  await asServiceRole()
})
afterEach(async () => {
  await client.query('ROLLBACK TO SAVEPOINT scenario')
})

describe('SIE import undo: the stornos record who asked for the undo', () => {
  it('stamps the requesting actor and commit_method migration on every storno, and on the audit rows', async () => {
    await importYear()
    const { rows } = await client.query(
      `SELECT j.undo_actor_type, j.undo_actor_label FROM public.request_sie_import_undo(
         p_company_id => $1, p_import_id => $2, p_actor => $3,
         p_actor_type => 'api_key', p_actor_label => 'SIE undo: Byrånyckel') j`,
      [company, job, actor])
    expect(rows[0]).toEqual({ undo_actor_type: 'api_key', undo_actor_label: 'SIE undo: Byrånyckel' })

    const attempt = await claim(job)
    expect(await undoChunk(job, attempt)).toEqual({ reversed: 2, done: false })
    expect(await undoChunk(job, attempt)).toEqual({ reversed: 0, done: true })

    const stamps = await undoStamps(job)
    const stamp = { status: 'posted', commit_method: 'migration', committed_actor_type: 'api_key', committed_actor_label: 'SIE undo: Byrånyckel' }
    expect(stamps.stornos).toEqual([stamp, stamp])
    expect(stamps.commits).toEqual([
      { actor_type: 'api_key', actor_label: 'SIE undo: Byrånyckel' },
      { actor_type: 'api_key', actor_label: 'SIE undo: Byrånyckel' },
    ])
    expect(stamps.reversals).toEqual([
      { actor_type: 'api_key', actor_label: 'SIE undo: Byrånyckel' },
      { actor_type: 'api_key', actor_label: 'SIE undo: Byrånyckel' },
    ])
  })

  it('posts as before for an undo requested without an actor: no actor, migration, audit user', async () => {
    await importYear()
    // The three-argument call an older deploy sends.
    await client.query('SELECT public.request_sie_import_undo($1,$2,$3)', [company, job, actor])
    const attempt = await claim(job)
    expect(await undoChunk(job, attempt)).toEqual({ reversed: 2, done: false })

    const stamps = await undoStamps(job)
    for (const storno of stamps.stornos) {
      expect(storno).toEqual({ status: 'posted', commit_method: 'migration', committed_actor_type: null, committed_actor_label: null })
    }
    for (const row of [...stamps.commits, ...stamps.reversals]) expect(row).toEqual({ actor_type: 'user', actor_label: null })
  })

  it('refuses an actor type outside the committed_actor_type list and queues nothing', async () => {
    await importYear()
    await client.query('SAVEPOINT refusal')
    await expect(
      client.query(
        `SELECT public.request_sie_import_undo(p_company_id => $1, p_import_id => $2, p_actor => $3, p_actor_type => 'robot')`,
        [company, job, actor]),
    ).rejects.toThrow(/undo_actor_type_check/)
    await client.query('ROLLBACK TO SAVEPOINT refusal')
    const { rows } = await client.query('SELECT job_state FROM public.sie_imports WHERE id = $1', [job])
    expect(rows[0].job_state).toBe('completed')
  })

  it('a replacement undoes the previous import on behalf of the actor in the new manifest', async () => {
    await importYear()
    const previous = job
    await client.query('SELECT public.replace_sie_import_job($1,$2,$3,$4,$5,$6,$7)', [
      company, actor, period, 'corrected-2024.se', 'e'.repeat(64),
      manifest('corrected-2024.se', { type: 'mcp_oauth', label: 'SIE import: Claude' }), previous,
    ])
    const { rows } = await client.query(
      'SELECT job_state, undo_actor_type, undo_actor_label FROM public.sie_imports WHERE id = $1', [previous])
    expect(rows[0]).toEqual({ job_state: 'undoing', undo_actor_type: 'mcp_oauth', undo_actor_label: 'SIE import: Claude' })

    const attempt = await claim(previous)
    expect(await undoChunk(previous, attempt)).toEqual({ reversed: 2, done: false })
    const stamps = await undoStamps(previous)
    for (const storno of stamps.stornos) {
      expect(storno).toMatchObject({ commit_method: 'migration', committed_actor_type: 'mcp_oauth', committed_actor_label: 'SIE import: Claude' })
    }
  })

  it('a replacement without commit_actor in its manifest records no undo actor, as before', async () => {
    await importYear()
    const previous = job
    await client.query('SELECT public.replace_sie_import_job($1,$2,$3,$4,$5,$6,$7)', [
      company, actor, period, 'corrected-2024.se', 'e'.repeat(64), manifest('corrected-2024.se'), previous,
    ])
    const { rows } = await client.query('SELECT undo_actor_type, undo_actor_label FROM public.sie_imports WHERE id = $1', [previous])
    expect(rows[0]).toEqual({ undo_actor_type: null, undo_actor_label: null })
  })
})

describe('reviewed SIE duplicate repair: the platform posts the stornos', () => {
  it('stamps actor system, label SIE duplicate repair and commit_method migration', async () => {
    await client.query('RESET ROLE')
    const keep = randomUUID()
    const reverse = randomUUID()
    // Rows predating the provenance guard, as tests/pg/sie-duplicate-repair.pg.test.ts seeds them.
    await client.query('ALTER TABLE journal_entries DISABLE TRIGGER guard_sie_entry_provenance')
    for (const [index, id] of [keep, reverse].entries()) {
      await client.query(`INSERT INTO journal_entries(id,company_id,user_id,fiscal_period_id,voucher_series,voucher_number,source_type,
          source_voucher_series,source_voucher_number,entry_date,description,status)
        VALUES($1,$2,$3,$4,'A',$5,'import','A',1,'2024-02-01','Legacy duplicate','draft')`, [id, company, actor, period, index + 1])
      await client.query(`INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount)
        VALUES($1,'1930',100,0),($1,'3001',0,100)`, [id])
    }
    await client.query('ALTER TABLE journal_entries ENABLE TRIGGER guard_sie_entry_provenance')
    await client.query(`UPDATE journal_entries SET status='posted' WHERE id=ANY($1)`, [[keep, reverse]])
    await client.query(`INSERT INTO voucher_sequences(company_id,user_id,fiscal_period_id,voucher_series,last_number)
      VALUES($1,$2,$3,'A',2)`, [company, actor, period])
    const hash = (await client.query('SELECT sie_repair_content_hash($1) hash', [keep])).rows[0].hash
    await asServiceRole()

    const staged = (await client.query('SELECT j.* FROM stage_sie_duplicate_repair($1,$2,$3,$4,$5) j', [
      company, actor, period, 'f'.repeat(64),
      JSON.stringify([{ keepId: keep, reverseId: reverse, contentHash: hash, keepLinks: [], reverseLinks: [] }]),
    ])).rows[0]
    const attempt = await claim(staged.id)
    const result = (await client.query('SELECT undo_sie_duplicate_repair_chunk($1,$2,$3,$4) r', [company, staged.id, worker, attempt])).rows[0].r
    expect(result).toEqual({ reversed: 1, done: false })

    await client.query('RESET ROLE')
    const { rows: stornos } = await client.query(
      `SELECT id, status, commit_method, committed_actor_type, committed_actor_label FROM journal_entries WHERE reverses_id = $1`, [reverse])
    const { rows: audit } = await client.query(
      `SELECT action, actor_type, actor_label FROM audit_log
        WHERE table_name = 'journal_entries'
          AND ((action = 'COMMIT' AND record_id = $1) OR (action = 'REVERSE' AND record_id = $2))
        ORDER BY action`,
      [stornos[0].id, reverse])
    await asServiceRole()
    expect(stornos.map(({ id: _id, ...rest }) => rest)).toEqual([
      { status: 'posted', commit_method: 'migration', committed_actor_type: 'system', committed_actor_label: 'SIE duplicate repair' },
    ])
    expect(audit).toEqual([
      { action: 'COMMIT', actor_type: 'system', actor_label: 'SIE duplicate repair' },
      { action: 'REVERSE', actor_type: 'system', actor_label: 'SIE duplicate repair' },
    ])
  })
})

describe('request_sie_import_undo signature and grants', () => {
  it('has one signature, executable by authenticated and service_role only', async () => {
    await client.query('RESET ROLE')
    const { rows } = await client.query(
      `SELECT p.oid::regprocedure::text AS sig,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_exec
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'request_sie_import_undo'`)
    await asServiceRole()
    expect(rows).toEqual([{
      sig: 'request_sie_import_undo(uuid,uuid,uuid,text,text)',
      anon: false,
      authenticated: true,
      service_role: true,
      public_exec: false,
    }])
  })
})
