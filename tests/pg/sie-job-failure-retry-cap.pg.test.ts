/**
 * pg-real tests for migration 20260928095627_sie_job_failure_retry_cap.
 *
 * record_sie_job_failure always scheduled another attempt, and
 * claim_sie_import_job reclaims any unfinished job whose next_attempt_at has
 * passed, so a job that can never succeed was retried hourly for good (one
 * production import: 152 failures in six days). These tests pin the cap: the
 * backoff below 32 consecutive failures is unchanged, the 32nd failure leaves
 * the job paused with its error and no automatic attempt, and only the user's
 * Fortsätt or Ångra makes it claimable again.
 *
 * Everything runs in one transaction that is rolled back.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool } from '@/tests/pg/setup'

const CAP = 32
const manifest = JSON.stringify({
  input: { filename: 'synthetic.se', options: {}, mappings: [], fiscalYear: { start: '2026-01-01', end: '2026-12-31' } },
  file_storage_path: 'synthetic.se',
})

let client: PoolClient
let company: string
let actor: string
let period: string
let worker: string
let job: string
let accounts: string[]

interface JobRow {
  id: string | null
  job_state: string | null
  job_phase: string | null
  job_attempt: number
  consecutive_failures: number
  next_attempt_at: string | null
  error_message: string | null
}

async function asServiceRole() {
  await client.query(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true)`)
  await client.query(`SELECT set_config('request.jwt.claim.role','service_role',true)`)
  await client.query('SET LOCAL ROLE service_role')
}

async function readJob(): Promise<JobRow & { next_is_infinite: boolean; seconds_until_next: number | null }> {
  const { rows } = await client.query(
    `SELECT id, job_state, job_phase, job_attempt, consecutive_failures, next_attempt_at::text, error_message,
       next_attempt_at = 'infinity'::timestamptz AS next_is_infinite,
       CASE WHEN isfinite(next_attempt_at) THEN extract(epoch FROM next_attempt_at - clock_timestamp())::float END AS seconds_until_next
     FROM public.sie_imports WHERE id = $1`, [job])
  return rows[0]
}

/** The owner of the test database, not the service role, may move the clock of a job. */
async function makeDue() {
  await client.query('RESET ROLE')
  await client.query(`UPDATE public.sie_imports SET next_attempt_at = clock_timestamp() - interval '1 second'
    WHERE id = $1 AND isfinite(next_attempt_at)`, [job])
  await asServiceRole()
}

async function claim(): Promise<JobRow> {
  return (await client.query('SELECT j.* FROM public.claim_sie_import_job($1,$2) j', [worker, job])).rows[0]
}

async function fail(attempt: number, reason = 'SIE journal entry IB is unbalanced') {
  await client.query('SELECT public.record_sie_job_failure($1,$2,$3,$4,$5)', [company, job, worker, attempt, reason])
}

/** Claim when due, then fail: one automatic retry cycle of the worker. */
async function failOnce(reason?: string) {
  await makeDue()
  const claimed = await claim()
  expect(claimed.id).toBe(job)
  await fail(claimed.job_attempt, reason)
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
    [actor, `sie-cap-${actor}@test.invalid`])
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
    [company, actor, period, 'c'.repeat(64), manifest])).rows[0].id
})
afterEach(async () => {
  await client.query('ROLLBACK TO SAVEPOINT scenario')
})

describe('record_sie_job_failure retry cap', () => {
  it('keeps backing off below the cap and stops scheduling at the 32nd consecutive failure', async () => {
    for (let failure = 1; failure < CAP; failure++) {
      await failOnce()
      const row = await readJob()
      expect(row.consecutive_failures).toBe(failure)
      expect(row.job_state).toBe(failure >= 3 ? 'paused' : 'reconciling')
      expect(row.next_is_infinite).toBe(false)
      // Unchanged backoff: 15 s doubling per failure, one hour from the ninth.
      const expected = Math.min(3600, 15 * 2 ** Math.min(failure - 1, 8))
      expect(row.seconds_until_next).toBeGreaterThan(expected - 5)
      expect(row.seconds_until_next).toBeLessThanOrEqual(expected)
    }

    await failOnce('SIE journal entry IB is unbalanced (debit 1092065.44, credit 1092065.43)')
    const stopped = await readJob()
    expect(stopped).toMatchObject({
      consecutive_failures: CAP,
      job_state: 'paused',
      next_is_infinite: true,
      // The user still sees why it stopped.
      error_message: 'SIE journal entry IB is unbalanced (debit 1092065.44, credit 1092065.43)',
    })

    // No automatic claim reaches it, however long we wait: neither for this
    // job nor from the cron's sweep.
    await makeDue()
    expect((await claim()).id).toBeNull()
    const sweep = await client.query('SELECT j.id FROM public.claim_sie_import_job($1, NULL) j', [randomUUID()])
    expect(sweep.rows[0].id).not.toBe(job)
    expect(await readJob()).toMatchObject({ consecutive_failures: CAP, next_is_infinite: true })
  })

  it('Fortsätt makes a stopped job claimable again, for one attempt when it fails the same way', async () => {
    for (let failure = 1; failure <= CAP; failure++) await failOnce()
    await makeDue()
    expect((await claim()).id).toBeNull()

    const resumed = (await client.query('SELECT j.* FROM public.resume_sie_import_job($1,$2,$3) j', [company, job, actor])).rows[0]
    expect(resumed.next_attempt_at).toBeNull()
    const claimed = await claim()
    expect(claimed.id).toBe(job)

    await fail(claimed.job_attempt)
    expect(await readJob()).toMatchObject({ consecutive_failures: CAP + 1, job_state: 'paused', next_is_infinite: true })
    await makeDue()
    expect((await claim()).id).toBeNull()
  })

  it('Ångra also makes a stopped job claimable again', async () => {
    for (let failure = 1; failure <= CAP; failure++) await failOnce()
    await makeDue()
    expect((await claim()).id).toBeNull()

    await client.query('SELECT public.request_sie_import_undo($1,$2,$3)', [company, job, actor])
    const claimed = await claim()
    expect(claimed).toMatchObject({ id: job, job_phase: 'undo', job_state: 'undoing' })
  })

  it('counts failures without progress: a committed chunk restores the full retry budget', async () => {
    let attempt = (await claim()).job_attempt
    const payload = [{
      sourceId: 'A1', sourceOrdinal: 0, sieImportId: job, series: 'A', date: '2026-02-01', description: 'Synthetic voucher',
      sourceSeries: 'A', sourceNumber: 1, sourceType: 'import', lines: [
        { account_number: '1930', account_id: accounts[0], debit_amount: 100, credit_amount: 0, dimensions: {} },
        { account_number: '3001', account_id: accounts[1], debit_amount: 0, credit_amount: 100, dimensions: {} },
      ],
    }]
    await client.query('SELECT public.save_sie_import_chunk($1,$2,$3,$4,$5,$6,$7)', [company, job, worker, attempt, 'vouchers', 0, JSON.stringify(payload)])
    await client.query('SELECT public.seal_sie_import_preparation($1,$2,$3,$4,$5,$6)', [company, job, worker, attempt, manifest, 1])
    await fail(attempt)
    for (let failure = 2; failure < CAP; failure++) await failOnce()
    expect((await readJob()).consecutive_failures).toBe(CAP - 1)

    await makeDue()
    attempt = (await claim()).job_attempt
    await client.query('SELECT public.import_sie_chunk($1,$2,$3,$4,$5,$6)', [company, job, worker, attempt, 'vouchers', 0])
    expect((await readJob()).consecutive_failures).toBe(0)

    await fail(attempt)
    const row = await readJob()
    expect(row).toMatchObject({ consecutive_failures: 1, next_is_infinite: false })
    expect(row.seconds_until_next).toBeLessThanOrEqual(15)
  })
})
