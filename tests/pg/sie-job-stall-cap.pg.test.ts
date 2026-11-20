/**
 * pg-real tests for migration 20261109171500_sie_job_stall_cap (accounted#115).
 *
 * record_sie_job_failure counts a step that throws. A run that yields or
 * loses its lease without moving the job on was counted by nothing, so such a
 * job was claimed every minute for good, and a job whose actor can no longer
 * write was skipped by the claim for good, holding its year. These tests pin
 * sweep_stalled_sie_import_jobs: a stall is counted once, with the
 * record_sie_job_failure backoff; a run that moved the job on, or ended in a
 * user's Fortsätt, is not a stall; at the cap, and at once for an actor who
 * can no longer write, a job that booked nothing fails and gives its year
 * back, while a job with booked verifikat is paused and keeps it, for Ångra or
 * an administrator's Fortsätt.
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
const RETRYING = 'Importen kom inte vidare vid senaste försöket och försöker igen automatiskt.'

let client: PoolClient
let company: string
let actor: string
let admin: string
let period: string
let worker: string
let job: string
let accounts: string[]

interface Stalled {
  importId: string
  companyId: string
  outcome: 'retrying' | 'paused' | 'failed'
  reason: 'yielded_without_progress' | 'lease_lapsed' | 'actor_not_member'
  consecutiveFailures: number
  state: string
  phase: string
  holdReleased: boolean
}

async function asServiceRole() {
  await client.query(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true)`)
  await client.query(`SELECT set_config('request.jwt.claim.role','service_role',true)`)
  await client.query('SET LOCAL ROLE service_role')
}

/** The owner of the test database, not the service role, may move a job's clock or counters. */
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
    `SELECT i.job_state, i.job_phase, i.status, i.job_attempt, i.consecutive_failures, i.error_message,
       i.worker_id, i.execution_actor_id, i.claim_mark,
       i.next_attempt_at = 'infinity'::timestamptz AS next_is_infinite,
       CASE WHEN isfinite(i.next_attempt_at) THEN extract(epoch FROM i.next_attempt_at - clock_timestamp())::float END AS seconds_until_next,
       p.import_hold
     FROM public.sie_imports i JOIN public.fiscal_periods p ON p.id = i.fiscal_period_id WHERE i.id = $1`, [job])
  return rows[0]
}

/** The rejection of one statement, with the transaction left usable. */
async function refusal(sql: string, params: unknown[]): Promise<{ code?: string; message: string }> {
  await client.query('SAVEPOINT expected_refusal')
  try {
    await client.query(sql, params)
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT expected_refusal')
    return err as { code?: string; message: string }
  }
  await client.query('RELEASE SAVEPOINT expected_refusal')
  throw new Error(`expected a refusal from: ${sql}`)
}

async function claim(): Promise<{ id: string | null; job_attempt: number; job_phase: string; job_state: string; claim_mark: string | null }> {
  return (await client.query('SELECT j.* FROM public.claim_sie_import_job($1,$2) j', [worker, job])).rows[0]
}

async function claimed(): Promise<number> {
  const row = await claim()
  expect(row.id).toBe(job)
  return row.job_attempt
}

async function yieldJob(attempt: number) {
  await client.query('SELECT public.yield_sie_import_job($1,$2,$3,$4)', [company, job, worker, attempt])
}

async function sweep(): Promise<Stalled[]> {
  const { rows } = await client.query('SELECT r FROM public.sweep_stalled_sie_import_jobs() r')
  return rows.map((row) => row.r as Stalled).filter((row) => row.companyId === company)
}

async function makeDue() {
  await asOwner(() => client.query(`UPDATE public.sie_imports SET next_attempt_at = clock_timestamp() - interval '1 second'
    WHERE id = $1 AND isfinite(next_attempt_at)`, [job]))
}

async function lapseLease() {
  await asOwner(() => client.query(`UPDATE public.sie_imports SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1`, [job]))
}

async function setFailures(count: number) {
  await asOwner(() => client.query('UPDATE public.sie_imports SET consecutive_failures = $2 WHERE id = $1', [job, count]))
}

const voucher = () => [{
  sourceId: 'A1', sourceOrdinal: 0, sieImportId: job, series: 'A', date: '2026-02-01', description: 'Synthetic voucher',
  sourceSeries: 'A', sourceNumber: 1, sourceType: 'import', lines: [
    { account_number: '1930', account_id: accounts[0], debit_amount: 100, credit_amount: 0, dimensions: {} },
    { account_number: '3001', account_id: accounts[1], debit_amount: 0, credit_amount: 100, dimensions: {} },
  ],
}]

/** One voucher chunk prepared and sealed: the job is in its vouchers phase with nothing booked. */
async function prepareOneChunk(attempt: number) {
  await client.query('SELECT public.save_sie_import_chunk($1,$2,$3,$4,$5,$6,$7)', [company, job, worker, attempt, 'vouchers', 0, JSON.stringify(voucher())])
  await client.query('SELECT public.seal_sie_import_preparation($1,$2,$3,$4,$5,$6)', [company, job, worker, attempt, manifest, 1])
}

/** The voucher booked: the job is in finalize with a posted verifikat of its batch. */
async function bookOneVoucher() {
  const attempt = await claimed()
  await prepareOneChunk(attempt)
  await client.query('SELECT public.import_sie_chunk($1,$2,$3,$4,$5,$6)', [company, job, worker, attempt, 'vouchers', 0])
  await yieldJob(attempt)
  const row = await readJob()
  expect(row).toMatchObject({ job_phase: 'finalize', consecutive_failures: 0 })
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
  ;[company, actor, admin, period, worker] = Array.from({ length: 5 }, () => randomUUID())
  for (const user of [actor, admin]) {
    await client.query(`INSERT INTO auth.users(id,email,instance_id) VALUES($1,$2,'00000000-0000-0000-0000-000000000000')`,
      [user, `sie-stall-${user}@test.invalid`])
  }
  await client.query(`INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,'Synthetic SIE AB','aktiebolag',$2)`, [company, actor])
  await client.query(`INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin')`, [company, actor, admin])
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
    [company, actor, period, 'e'.repeat(64), manifest])).rows[0].id
})
afterEach(async () => {
  await client.query('ROLLBACK TO SAVEPOINT scenario')
})

describe('sweep_stalled_sie_import_jobs: stalls', () => {
  it('counts a yield without progress once, with the record_sie_job_failure backoff', async () => {
    // A job never claimed has no mark: nothing to judge.
    expect(await sweep()).toEqual([])

    const attempt = await claimed()
    expect((await readJob()).claim_mark).toMatch(new RegExp(`@${attempt}$`))
    await yieldJob(attempt)

    expect(await sweep()).toEqual([expect.objectContaining({
      importId: job, outcome: 'retrying', reason: 'yielded_without_progress', consecutiveFailures: 1, holdReleased: false,
    })])
    const row = await readJob()
    expect(row).toMatchObject({
      consecutive_failures: 1, job_state: 'reconciling', job_attempt: attempt + 1, worker_id: null,
      error_message: RETRYING, next_is_infinite: false, import_hold: job,
    })
    expect(row.seconds_until_next).toBeGreaterThan(10)
    expect(row.seconds_until_next).toBeLessThanOrEqual(15)

    // Counted once: neither the backoff nor, once due, the old mark brings it back.
    expect(await sweep()).toEqual([])
    await makeDue()
    expect(await sweep()).toEqual([])

    // The next stalled claim spends the next failure, as a thrown step would.
    await yieldJob(await claimed())
    expect(await sweep()).toEqual([expect.objectContaining({ consecutiveFailures: 2 })])
    expect((await readJob()).seconds_until_next).toBeLessThanOrEqual(30)
  })

  it('is not a stall when the run moved the job on', async () => {
    const attempt = await claimed()
    await client.query('SELECT public.save_sie_import_chunk($1,$2,$3,$4,$5,$6,$7)', [company, job, worker, attempt, 'vouchers', 0, JSON.stringify(voucher())])
    await yieldJob(attempt)
    expect(await sweep()).toEqual([])
    expect((await readJob()).consecutive_failures).toBe(0)
  })

  it('is not a stall when the user pressed Fortsätt after the run', async () => {
    await yieldJob(await claimed())
    await client.query('SELECT public.resume_sie_import_job($1,$2,$3)', [company, job, actor])
    expect(await sweep()).toEqual([])
    expect((await readJob()).consecutive_failures).toBe(0)
  })

  it('leaves a job with a live lease alone, and counts and fences out a run whose lease lapsed', async () => {
    const attempt = await claimed()
    expect(await sweep()).toEqual([])

    await lapseLease()
    expect(await sweep()).toEqual([expect.objectContaining({ importId: job, outcome: 'retrying', reason: 'lease_lapsed' })])
    expect(await readJob()).toMatchObject({ consecutive_failures: 1, worker_id: null, job_attempt: attempt + 1 })

    // The worker that lost the lease can write nothing more for this run.
    const stale = await refusal('SELECT public.yield_sie_import_job($1,$2,$3,$4)', [company, job, worker, attempt])
    expect(stale.code).toBe('55000')
  })

  it('at the cap, fails a job that booked nothing and gives its year back', async () => {
    // Prepared and sealed, its first voucher chunk not yet committed.
    const first = await claimed()
    await prepareOneChunk(first)
    await yieldJob(first)
    expect(await sweep()).toEqual([])
    await setFailures(CAP - 1)

    await yieldJob(await claimed())
    expect(await sweep()).toEqual([expect.objectContaining({
      importId: job, outcome: 'failed', reason: 'yielded_without_progress', state: 'failed', phase: 'vouchers',
      consecutiveFailures: CAP, holdReleased: true,
    })])
    expect(await readJob()).toMatchObject({
      job_state: 'failed', status: 'failed', consecutive_failures: CAP, worker_id: null, import_hold: null,
      error_message: 'Importen kom inte vidare efter upprepade försök och har avbrutits. Inga verifikationer bokfördes. Starta en ny import.',
    })
    expect((await claim()).id).toBeNull()
  })

  it('at the cap, pauses a job with booked verifikat and keeps its year until Ångra', async () => {
    await bookOneVoucher()
    await setFailures(CAP - 1)

    await yieldJob(await claimed())
    expect(await sweep()).toEqual([expect.objectContaining({
      importId: job, outcome: 'paused', reason: 'yielded_without_progress', phase: 'finalize', holdReleased: false,
    })])
    expect(await readJob()).toMatchObject({
      job_state: 'paused', consecutive_failures: CAP, next_is_infinite: true, import_hold: job,
      error_message: 'Importen kom inte vidare efter upprepade försök och har pausats. Tryck Fortsätt för ett nytt försök eller Ångra import.',
    })
    await makeDue()
    expect((await claim()).id).toBeNull()
    expect(await sweep()).toEqual([])

    await client.query('SELECT public.request_sie_import_undo($1,$2,$3)', [company, job, actor])
    expect(await claim()).toMatchObject({ id: job, job_phase: 'undo', job_state: 'undoing' })
  })
})

describe('sweep_stalled_sie_import_jobs: an actor who can no longer write', () => {
  it('fails a job that booked nothing with the reason, at once, and gives its year back', async () => {
    await asOwner(() => client.query(`UPDATE company_members SET role = 'viewer' WHERE company_id = $1 AND user_id = $2`, [company, actor]))
    // The claim skips it, as before; the sweep no longer lets that go unseen.
    expect((await claim()).id).toBeNull()

    expect(await sweep()).toEqual([expect.objectContaining({
      importId: job, outcome: 'failed', reason: 'actor_not_member', consecutiveFailures: 1, holdReleased: true,
    })])
    expect(await readJob()).toMatchObject({
      job_state: 'failed', status: 'failed', import_hold: null,
      error_message: 'Personen som startade importen har inte längre skrivbehörighet i företaget. Inga verifikationer bokfördes. Starta en ny import.',
    })
    expect(await sweep()).toEqual([])
  })

  it('pauses a job with booked verifikat for an administrator, whose Fortsätt takes it over', async () => {
    await bookOneVoucher()
    await asOwner(() => client.query('DELETE FROM company_members WHERE company_id = $1 AND user_id = $2', [company, actor]))

    expect(await sweep()).toEqual([expect.objectContaining({
      importId: job, outcome: 'paused', reason: 'actor_not_member', holdReleased: false,
    })])
    expect(await readJob()).toMatchObject({
      job_state: 'paused', next_is_infinite: true, import_hold: job,
      error_message: 'Personen som startade importen har inte längre skrivbehörighet i företaget. En ägare eller administratör kan trycka Fortsätt eller Ångra import.',
    })
    await makeDue()
    expect((await claim()).id).toBeNull()

    await client.query('SELECT public.resume_sie_import_job($1,$2,$3)', [company, job, admin])
    expect((await readJob()).execution_actor_id).toBe(admin)
    expect(await claim()).toMatchObject({ id: job, job_phase: 'finalize' })
    expect(await sweep()).toEqual([])
  })
})

describe('sweep_stalled_sie_import_jobs: grants', () => {
  it('runs for the service role only, and its progress helper for no API role', async () => {
    const { rows } = await client.query(`SELECT r AS role,
        has_function_privilege(r, 'public.sweep_stalled_sie_import_jobs()', 'EXECUTE') AS sweep,
        has_function_privilege(r, 'public.sie_job_progress(public.sie_imports)', 'EXECUTE') AS progress
      FROM unnest(ARRAY['anon','authenticated','service_role']) r ORDER BY r`)
    expect(rows).toEqual([
      { role: 'anon', sweep: false, progress: false },
      { role: 'authenticated', sweep: false, progress: false },
      { role: 'service_role', sweep: true, progress: false },
    ])
  })
})
