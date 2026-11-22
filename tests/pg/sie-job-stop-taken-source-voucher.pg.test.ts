/**
 * pg-real tests for migration 20261122224500_sie_job_stop_on_taken_source_voucher.
 *
 * A voucher chunk with a voucher whose source series and number a posted
 * imported verifikat of the same fiscal year already holds is refused by
 * journal_import_source_owned_idx, and refused again on every try: nothing
 * a retry changes. The worker used to hand it to record_sie_job_failure,
 * which claimed the job again for up to 32 failures (one import in
 * production, 2026-11-16). These tests pin that the refusal is the same on
 * every try, and stop_sie_import_job: a job that booked nothing fails at once
 * and gives its year back; a job with booked verifikat is paused with no
 * automatic attempt and keeps its year for Ångra; only the worker holding the
 * lease may stop it, and only the service role may call it.
 *
 * Everything runs in one transaction that is rolled back.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool } from '@/tests/pg/setup'

const manifest = JSON.stringify({
  input: { filename: 'synthetic.se', options: {}, mappings: [], fiscalYear: { start: '2026-01-01', end: '2026-12-31' } },
  file_storage_path: 'synthetic.se',
})
const REASON = 'Verifikation A1 i filen har samma serie och nummer som en verifikation som redan är bokförd i räkenskapsåret. Importen har stoppats.'

let client: PoolClient
let company: string
let actor: string
let period: string
let worker: string
let job: string
let accounts: string[]

async function asServiceRole() {
  await client.query(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true)`)
  await client.query(`SELECT set_config('request.jwt.claim.role','service_role',true)`)
  await client.query('SET LOCAL ROLE service_role')
}

/** The owner of the test database, not the service role, may move a job's clock. */
async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  await client.query('RESET ROLE')
  try {
    return await fn()
  } finally {
    await asServiceRole()
  }
}

async function readJob() {
  const { rows } = await client.query(
    `SELECT i.job_state, i.job_phase, i.status, i.job_attempt, i.consecutive_failures, i.error_message, i.worker_id,
       i.next_attempt_at IS NULL AS next_is_null,
       i.next_attempt_at = 'infinity'::timestamptz AS next_is_infinite,
       p.import_hold,
       (SELECT count(*)::int FROM public.journal_entries e WHERE e.import_batch_id = i.id) AS booked
     FROM public.sie_imports i JOIN public.fiscal_periods p ON p.id = i.fiscal_period_id WHERE i.id = $1`, [job])
  return rows[0]
}

/** The rejection of one statement, with the transaction left usable. */
async function refusal(sql: string, params: unknown[]): Promise<{ code?: string; message: string; detail?: string }> {
  await client.query('SAVEPOINT expected_refusal')
  try {
    await client.query(sql, params)
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT expected_refusal')
    return err as { code?: string; message: string; detail?: string }
  }
  await client.query('RELEASE SAVEPOINT expected_refusal')
  throw new Error(`expected a refusal from: ${sql}`)
}

async function claim(): Promise<{ id: string | null; job_attempt: number; job_phase: string; job_state: string }> {
  return (await client.query('SELECT j.* FROM public.claim_sie_import_job($1,$2) j', [worker, job])).rows[0]
}

async function claimed(): Promise<number> {
  const row = await claim()
  expect(row.id).toBe(job)
  return row.job_attempt
}

async function makeDue() {
  await asOwner(() => client.query(`UPDATE public.sie_imports SET next_attempt_at = clock_timestamp() - interval '1 second'
    WHERE id = $1 AND isfinite(next_attempt_at)`, [job]))
}

const voucher = (ordinal: number, series: string, number: number) => ({
  sourceId: `${series}${number}`, sourceOrdinal: ordinal, sieImportId: job, series, date: '2026-02-01', description: 'Synthetic voucher',
  sourceSeries: series, sourceNumber: number, sourceType: 'import', lines: [
    { account_number: '1930', account_id: accounts[0], debit_amount: 100, credit_amount: 0, dimensions: {} },
    { account_number: '3001', account_id: accounts[1], debit_amount: 0, credit_amount: 100, dimensions: {} },
  ],
})

/** The chunks prepared and sealed: the job is in its vouchers phase with nothing booked. */
async function prepare(attempt: number, chunks: Array<ReturnType<typeof voucher>[]>) {
  for (const [n, chunk] of chunks.entries()) {
    await client.query('SELECT public.save_sie_import_chunk($1,$2,$3,$4,$5,$6,$7)', [company, job, worker, attempt, 'vouchers', n, JSON.stringify(chunk)])
  }
  await client.query('SELECT public.seal_sie_import_preparation($1,$2,$3,$4,$5,$6)', [company, job, worker, attempt, manifest, chunks.length])
}

const commitChunk = (attempt: number, chunk: number) =>
  client.query('SELECT public.import_sie_chunk($1,$2,$3,$4,$5,$6)', [company, job, worker, attempt, 'vouchers', chunk])

const stop = (attempt: number, reason = REASON) =>
  client.query('SELECT public.stop_sie_import_job($1,$2,$3,$4,$5) AS outcome', [company, job, worker, attempt, reason])

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
    [actor, `sie-stop-${actor}@test.invalid`])
  await client.query(`INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,'Synthetic SIE AB','aktiebolag',$2)`, [company, actor])
  await client.query(`INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')`, [company, actor])
  await client.query(`INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end)
    VALUES($1,$2,$3,'2026','2026-01-01','2026-12-31')`, [period, company, actor])
  accounts = [randomUUID(), randomUUID()]
  for (const [i, number] of ['1930', '3001'].entries()) {
    await client.query(`INSERT INTO chart_of_accounts(id,company_id,user_id,account_number,account_name,account_type,account_class,normal_balance)
      VALUES($1,$2,$3,$4,'Synthetic account',$5,$6,$7)`,
      [accounts[i], company, actor, number, i ? 'revenue' : 'asset', i ? 3 : 1, i ? 'credit' : 'debit'])
  }
  await asServiceRole()
  job = (await client.query(`SELECT (public.start_sie_import_job($1,$2,$3,'synthetic.se',$4,$5)).id`,
    [company, actor, period, 'f'.repeat(64), manifest])).rows[0].id
})
afterEach(async () => {
  await client.query('ROLLBACK TO SAVEPOINT scenario')
})

describe('a voucher whose source series and number the year already holds', () => {
  it('is refused by journal_import_source_owned_idx on every try: no retry can pass it', async () => {
    const attempt = await claimed()
    // Two vouchers of the chunk share source series A and number 1.
    await prepare(attempt, [[voucher(0, 'A', 1), voucher(1, 'A', 1)]])

    for (let tried = 0; tried < 3; tried++) {
      const refused = await refusal('SELECT public.import_sie_chunk($1,$2,$3,$4,$5,$6)', [company, job, worker, attempt, 'vouchers', 0])
      expect(refused.code).toBe('23505')
      expect(refused.message).toBe('duplicate key value violates unique constraint "journal_import_source_owned_idx"')
      // The key names the series and number; the worker's sentence names them to the user.
      expect(refused.detail).toMatch(/=\([0-9a-f-]+, [0-9a-f-]+, A, 1\) already exists\.$/)
    }
    expect(await readJob()).toMatchObject({ job_phase: 'vouchers', booked: 0 })
  })
})

describe('stop_sie_import_job', () => {
  it('fails a job that booked nothing at once and gives its year back', async () => {
    const attempt = await claimed()
    await prepare(attempt, [[voucher(0, 'A', 1), voucher(1, 'A', 1)]])
    await refusal('SELECT public.import_sie_chunk($1,$2,$3,$4,$5,$6)', [company, job, worker, attempt, 'vouchers', 0])

    expect((await stop(attempt)).rows[0].outcome).toBe('failed')
    expect(await readJob()).toMatchObject({
      job_state: 'failed', status: 'failed', consecutive_failures: 1, job_attempt: attempt + 1, worker_id: null,
      next_is_null: true, import_hold: null, booked: 0,
      error_message: `${REASON} Inga verifikationer bokfördes.`,
    })
    // Nothing claims it again.
    expect((await claim()).id).toBeNull()
  })

  it('pauses a job with booked verifikat with no automatic attempt, and keeps its year for Ångra', async () => {
    const attempt = await claimed()
    // The first chunk books A1; the second repeats B5 inside itself.
    await prepare(attempt, [[voucher(0, 'A', 1)], [voucher(1, 'B', 5), voucher(2, 'B', 5)]])
    await commitChunk(attempt, 0)
    const refused = await refusal('SELECT public.import_sie_chunk($1,$2,$3,$4,$5,$6)', [company, job, worker, attempt, 'vouchers', 1])
    expect(refused.code).toBe('23505')

    expect((await stop(attempt)).rows[0].outcome).toBe('paused')
    expect(await readJob()).toMatchObject({
      job_state: 'paused', job_phase: 'vouchers', consecutive_failures: 1, worker_id: null,
      next_is_infinite: true, import_hold: job, booked: 1,
      error_message: `${REASON} Tryck Ångra import för att ta bort det som bokfördes.`,
    })
    await makeDue()
    expect((await claim()).id).toBeNull()

    // Ångra re-arms it, as for any paused job.
    await client.query('SELECT public.request_sie_import_undo($1,$2,$3)', [company, job, actor])
    expect(await claim()).toMatchObject({ id: job, job_phase: 'undo', job_state: 'undoing' })
  })

  it('stops nothing for a worker whose lease or attempt is stale, and needs a reason', async () => {
    const attempt = await claimed()
    expect((await refusal('SELECT public.stop_sie_import_job($1,$2,$3,$4,$5)', [company, job, worker, attempt - 1, REASON])).code).toBe('55000')
    expect((await refusal('SELECT public.stop_sie_import_job($1,$2,$3,$4,$5)', [company, job, randomUUID(), attempt, REASON])).code).toBe('55000')
    expect((await refusal('SELECT public.stop_sie_import_job($1,$2,$3,$4,$5)', [company, job, worker, attempt, '  '])).code).toBe('22023')
    expect(await readJob()).toMatchObject({ job_state: 'preparing', consecutive_failures: 0, import_hold: job })
  })

  it('runs for the service role only', async () => {
    const { rows } = await client.query(`SELECT r AS role,
        has_function_privilege(r, 'public.stop_sie_import_job(uuid,uuid,uuid,integer,text)', 'EXECUTE') AS stop
      FROM unnest(ARRAY['anon','authenticated','service_role']) r ORDER BY r`)
    expect(rows).toEqual([
      { role: 'anon', stop: false },
      { role: 'authenticated', stop: false },
      { role: 'service_role', stop: true },
    ])
  })
})
