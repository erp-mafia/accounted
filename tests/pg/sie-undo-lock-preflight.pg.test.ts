/**
 * pg-real tests for migration 20261005193558_sie_undo_lock_preflight (crm#1022).
 *
 * An SIE undo writes each storno on the date of the voucher it reverses, and
 * enforce_company_lock_date refuses every insert on or before the company lock
 * date. request_sie_import_undo did not read that date, so an undo of a year
 * behind it was admitted, failed on its first chunk and paused holding the
 * year. guard_sie_company_lock_date then refused every lock date change while
 * the year was held, the unlock included: resume, undo and unlock all failed.
 *
 * Pinned here: the undo, the resume of an undo and the replacement refuse a
 * locked range before anything is queued, with a sentence that names the range
 * and the way out; the lock date can always be moved back while a year is held
 * (locking more still waits); and an undo that a lock date stopped continues
 * from where it stopped once the user unlocks.
 *
 * Everything runs in one transaction that is rolled back.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool } from '@/tests/pg/setup'

const LOCK_REFUSAL = 'SIE_IMPORT_PERIOD_LOCKED: '

let client: PoolClient
let company: string
let actor: string
let period: string
let worker: string
let job: string
let accounts: string[]

function manifest(filename = 'synthetic-2024.se') {
  return JSON.stringify({
    input: { filename, options: {}, mappings: [], fiscalYear: { start: '2024-01-01', end: '2024-12-31' } },
    file_storage_path: filename,
  })
}

async function asServiceRole() {
  await client.query(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true)`)
  await client.query(`SELECT set_config('request.jwt.claim.role','service_role',true)`)
  await client.query('SET LOCAL ROLE service_role')
}

async function asOwnerRole() {
  await client.query('RESET ROLE')
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

async function setLockDate(date: string | null) {
  await client.query('UPDATE public.company_settings SET bookkeeping_locked_through = $1 WHERE company_id = $2', [date, company])
}

async function readJob() {
  const { rows } = await client.query(
    `SELECT i.job_state, i.job_phase, i.status, p.import_hold
       FROM public.sie_imports i JOIN public.fiscal_periods p ON p.id = i.fiscal_period_id
      WHERE i.id = $1`, [job])
  return rows[0] as { job_state: string; job_phase: string; status: string; import_hold: string | null }
}

async function entries() {
  const { rows } = await client.query(
    `SELECT source_type, status, entry_date::text, reverses_id FROM public.journal_entries
      WHERE company_id = $1 ORDER BY source_type, entry_date`, [company])
  return rows as { source_type: string; status: string; entry_date: string; reverses_id: string | null }[]
}

async function claim(): Promise<number> {
  const { rows } = await client.query('SELECT j.* FROM public.claim_sie_import_job($1,$2) j', [worker, job])
  expect(rows[0].id).toBe(job)
  return rows[0].job_attempt
}

async function undoChunk(attempt: number): Promise<{ reversed: number; done: boolean }> {
  return (await client.query('SELECT public.undo_sie_import_chunk($1,$2,$3,$4) AS r', [company, job, worker, attempt])).rows[0].r
}

/** A completed 2024 import with vouchers on 2024-03-04 and 2024-06-30. */
async function importYear() {
  job = (await client.query(`SELECT (public.start_sie_import_job($1,$2,$3,'synthetic-2024.se',$4,$5)).id`,
    [company, actor, period, 'd'.repeat(64), manifest()])).rows[0].id
  const attempt = await claim()
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
  expect((await readJob()).job_state).toBe('completed')
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
    [actor, `sie-lock-${actor}@test.invalid`])
  await client.query(`INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,'Synthetic SIE AB','aktiebolag',$2)`, [company, actor])
  await client.query(`INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')`, [company, actor])
  await client.query('INSERT INTO company_settings(company_id,user_id) VALUES($1,$2)', [company, actor])
  await client.query(`INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end)
    VALUES($1,$2,$3,'2024','2024-01-01','2024-12-31')`, [period, company, actor])
  accounts = [randomUUID(), randomUUID()]
  for (const [i, number] of ['1930', '3001'].entries()) {
    await client.query(`INSERT INTO chart_of_accounts(id,company_id,user_id,account_number,account_name,account_type,account_class,normal_balance)
      VALUES($1,$2,$3,$4,'Synthetic account',$5,$6,$7)`,
      [accounts[i], company, actor, number, i ? 'revenue' : 'asset', i ? 3 : 1, i ? 'credit' : 'debit'])
  }
  await asServiceRole()
  await importYear()
})
afterEach(async () => {
  await client.query('ROLLBACK TO SAVEPOINT scenario')
})

describe('SIE undo refuses a locked range before it starts', () => {
  it('names the locked range and the way out when the company lock date covers the stornos', async () => {
    await asOwnerRole()
    await setLockDate('2025-12-31')
    await asServiceRole()

    const err = await refusal('SELECT public.request_sie_import_undo($1,$2,$3)', [company, job, actor])
    expect(err.code).toBe('55000')
    expect(err.message).toBe(LOCK_REFUSAL +
      'Bokföringen är låst t.o.m. 2025-12-31, och ångringen bokför storno med de importerade verifikationernas ' +
      'datum, 2024-03-04 till 2024-06-30. Lås upp till och med 2024-03-04 först: sätt Bokföring låst t.o.m. till ' +
      '2024-03-03 eller tidigare, eller töm fältet, under Inställningar > Bokföring och försök igen. ' +
      'Lås bokföringen igen när ångringen är klar.')

    // Nothing was queued: the import is still complete and holds nothing.
    expect(await readJob()).toMatchObject({ job_state: 'completed', import_hold: null })
    expect((await entries()).map(e => e.status)).toEqual(['posted', 'posted'])
  })

  it('admits the undo when the lock date ends before the first imported voucher', async () => {
    await asOwnerRole()
    await setLockDate('2024-03-03')
    await asServiceRole()

    await client.query('SELECT public.request_sie_import_undo($1,$2,$3)', [company, job, actor])
    expect(await readJob()).toMatchObject({ job_state: 'undoing', job_phase: 'undo', import_hold: job })
    const attempt = await claim()
    expect(await undoChunk(attempt)).toEqual({ reversed: 2, done: false })
    expect(await undoChunk(attempt)).toEqual({ reversed: 0, done: true })
    expect(await readJob()).toMatchObject({ job_state: 'undone', import_hold: null })
  })

  it('names a locked fiscal year and how to unlock it', async () => {
    await asOwnerRole()
    await client.query('UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1', [period])
    await asServiceRole()

    const err = await refusal('SELECT public.request_sie_import_undo($1,$2,$3)', [company, job, actor])
    expect(err.code).toBe('55000')
    expect(err.message).toBe(LOCK_REFUSAL + 'Räkenskapsåret 2024 (2024-01-01 till 2024-12-31) är låst. ' +
      'Lås upp det under Inställningar > Bokföring > Räkenskapsår först och försök igen.')
    expect(await readJob()).toMatchObject({ job_state: 'completed', import_hold: null })
  })

  it('refuses a replacement before reversing anything when the fiscal year is partly locked', async () => {
    await asOwnerRole()
    await setLockDate('2024-01-31')
    await asServiceRole()

    const err = await refusal('SELECT public.replace_sie_import_job($1,$2,$3,$4,$5,$6,$7)',
      [company, actor, period, 'corrected-2024.se', 'e'.repeat(64), manifest('corrected-2024.se'), job])
    expect(err.code).toBe('55000')
    expect(err.message).toBe(LOCK_REFUSAL +
      'Bokföringen är låst t.o.m. 2024-01-31, och ersättningen bokför storno och de nya verifikationerna i ' +
      'räkenskapsåret, 2024-01-01 till 2024-12-31. Lås upp till och med 2024-01-01 först: sätt Bokföring låst ' +
      't.o.m. till 2023-12-31 eller tidigare, eller töm fältet, under Inställningar > Bokföring och försök igen. ' +
      'Lås bokföringen igen när den nya importen är klar.')

    expect(await readJob()).toMatchObject({ job_state: 'completed', import_hold: null })
    const successors = await client.query('SELECT id FROM public.sie_imports WHERE supersedes_import_id = $1', [job])
    expect(successors.rows).toEqual([])
  })

  it('answers the same refusal read-only to a member, and nothing to an outsider', async () => {
    await asOwnerRole()
    await setLockDate('2025-12-31')
    const outsider = randomUUID()
    await client.query(`INSERT INTO auth.users(id,email,instance_id) VALUES($1,$2,'00000000-0000-0000-0000-000000000000')`,
      [outsider, `sie-lock-outsider-${outsider}@test.invalid`])

    const asMember = async (user: string) => {
      await client.query('RESET ROLE')
      await client.query(`SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true),
        set_config('request.jwt.claim.role','authenticated',true)`, [JSON.stringify({ sub: user, role: 'authenticated' }), user])
      await client.query('SET LOCAL ROLE authenticated')
      return (await client.query('SELECT public.sie_undo_lock_refusal($1,$2) AS r', [company, job])).rows[0].r as string | null
    }
    expect(await asMember(actor)).toMatch(/^Bokföringen är låst t\.o\.m\. 2025-12-31, och ångringen bokför storno/)
    expect(await asMember(outsider)).toBeNull()

    await asOwnerRole()
    await setLockDate(null)
    expect(await asMember(actor)).toBeNull()
  })
})

describe('an undo that a lock date stopped is never a dead end', () => {
  /**
   * The state production reached before this migration: the lock date was set
   * while nothing was held, then the undo was admitted without reading it.
   * These are the writes the earlier request_sie_import_undo made.
   */
  async function admitUndoBehindLockDate() {
    await asOwnerRole()
    await setLockDate('2025-12-31')
    await client.query('UPDATE public.fiscal_periods SET import_hold = $1 WHERE id = $2', [job, period])
    await client.query(`UPDATE public.sie_imports SET job_state = 'undoing', job_phase = 'undo', job_attempt = job_attempt + 1,
      execution_actor_id = $2, worker_id = NULL, lease_until = NULL, next_attempt_at = NULL, error_message = NULL
      WHERE id = $1`, [job, actor])
    await asServiceRole()
  }

  /** Claim when due, run one undo chunk, record its failure: one worker cycle. */
  async function failedWorkerCycle() {
    await asOwnerRole()
    await client.query(`UPDATE public.sie_imports SET next_attempt_at = clock_timestamp() - interval '1 second'
      WHERE id = $1 AND next_attempt_at IS NOT NULL`, [job])
    await asServiceRole()
    const attempt = await claim()
    const err = await refusal('SELECT public.undo_sie_import_chunk($1,$2,$3,$4)', [company, job, worker, attempt])
    expect(err.message).toMatch(/^Bokföringen är låst t\.o\.m\. 2025-12-31\. Kan inte skapa verifikation med datum 2024-(03-04|06-30)\.$/)
    await client.query('SELECT public.record_sie_job_failure($1,$2,$3,$4,$5)', [company, job, worker, attempt, err.message])
  }

  it('lets the user unlock, then resumes from where it stopped', async () => {
    await admitUndoBehindLockDate()
    for (let i = 0; i < 3; i++) await failedWorkerCycle()
    expect(await readJob()).toMatchObject({ job_state: 'paused', job_phase: 'undo', import_hold: job })

    // Fortsätt while still locked says what to do instead of re-queuing a
    // chunk that must fail again.
    const resumeLocked = await refusal('SELECT public.resume_sie_import_job($1,$2,$3)', [company, job, actor])
    expect(resumeLocked.code).toBe('55000')
    expect(resumeLocked.message).toContain(LOCK_REFUSAL + 'Bokföringen är låst t.o.m. 2025-12-31')
    expect(resumeLocked.message).toContain('Lås upp till och med 2024-03-04 först')
    expect(await readJob()).toMatchObject({ job_state: 'paused' })

    await asOwnerRole()
    // Locking more still waits for the held year...
    const tighten = await refusal('UPDATE public.company_settings SET bookkeeping_locked_through = $1 WHERE company_id = $2',
      ['2026-06-30', company])
    expect(tighten.message).toBe('SIE_IMPORT_HOLD: importen måste slutföras innan bokföringen låses')
    // ...but moving the lock date back is allowed while it is held.
    await setLockDate('2024-03-03')
    await asServiceRole()

    const resumed = (await client.query('SELECT j.* FROM public.resume_sie_import_job($1,$2,$3) j', [company, job, actor])).rows[0]
    expect(resumed).toMatchObject({ job_state: 'undoing', job_phase: 'undo' })
    const attempt = await claim()
    expect(await undoChunk(attempt)).toEqual({ reversed: 2, done: false })
    expect(await undoChunk(attempt)).toEqual({ reversed: 0, done: true })

    expect(await readJob()).toMatchObject({ job_state: 'undone', status: 'replaced', import_hold: null })
    const ledger = await entries()
    expect(ledger.filter(e => e.source_type === 'import').map(e => e.status)).toEqual(['reversed', 'reversed'])
    // Each storno is dated like the voucher it reverses.
    expect(ledger.filter(e => e.source_type === 'storno').map(e => [e.status, e.entry_date]))
      .toEqual([['posted', '2024-03-04'], ['posted', '2024-06-30']])

    // With nothing held, the user can lock the books again.
    await asOwnerRole()
    await setLockDate('2025-12-31')
  })

  it('lets the user remove the lock date while the year is held', async () => {
    await admitUndoBehindLockDate()
    await failedWorkerCycle()
    await asOwnerRole()
    await setLockDate(null)
    const { rows } = await client.query('SELECT bookkeeping_locked_through FROM public.company_settings WHERE company_id = $1', [company])
    expect(rows[0].bookkeeping_locked_through).toBeNull()
  })

  it('still refuses a first lock date while a year is held', async () => {
    await asOwnerRole()
    await client.query('UPDATE public.fiscal_periods SET import_hold = $1 WHERE id = $2', [job, period])
    const err = await refusal('UPDATE public.company_settings SET bookkeeping_locked_through = $1 WHERE company_id = $2',
      ['2023-12-31', company])
    expect(err.message).toBe('SIE_IMPORT_HOLD: importen måste slutföras innan bokföringen låses')
  })
})
