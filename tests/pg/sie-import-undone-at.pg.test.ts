/**
 * pg-real tests for 20261109153200_sie_import_undone_at (#200): an undone SIE
 * import reads as undone.
 *   - the undo of a durable import stamps sie_imports.undone_at when its last
 *     chunk ends the job, and not before; the end of a reviewed duplicate
 *     repair is stamped the same way;
 *   - no client write sets or moves undone_at;
 *   - fiscal_year_reset_snapshot refuses a year that holds a completed durable
 *     import (sie_import_in_place) until the import's own undo has run, and
 *     leaves a year with batch entries to retained_import_history.
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
let accounts: string[]

type ResetResult = { ok: boolean; code?: string; eligible?: boolean; blockers?: Array<{ code: string }> }

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

/** Reads as the owner, then hands the scenario back to service_role. */
async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  await client.query('RESET ROLE')
  const result = await fn()
  await asServiceRole()
  return result
}

async function claim(id: string): Promise<number> {
  const { rows } = await client.query('SELECT j.* FROM public.claim_sie_import_job($1,$2) j', [worker, id])
  expect(rows[0].id).toBe(id)
  return rows[0].job_attempt
}

async function undoChunk(id: string, attempt: number): Promise<{ reversed: number; done: boolean }> {
  return (await client.query('SELECT public.undo_sie_import_chunk($1,$2,$3,$4) AS r', [company, id, worker, attempt])).rows[0].r
}

async function jobRow(id: string) {
  return asOwner(async () =>
    (await client.query(
      'SELECT job_state, status, replaced_at, imported_at, undone_at FROM public.sie_imports WHERE id = $1', [id],
    )).rows[0])
}

/** A completed 2024 import; with `vouchers` false, one that wrote no verifikat. */
async function importYear(vouchers = true): Promise<string> {
  const job = (await client.query(`SELECT (public.start_sie_import_job($1,$2,$3,'synthetic-2024.se',$4,$5)).id`,
    [company, actor, period, (vouchers ? 'd' : 'e').repeat(64), manifest()])).rows[0].id
  const attempt = await claim(job)
  if (vouchers) {
    const payload = ['2024-03-04', '2024-06-30'].map((date, ordinal) => ({
      sourceId: `A${ordinal + 1}`, sourceOrdinal: ordinal, sieImportId: job, series: 'A', date,
      description: 'Synthetic voucher', sourceSeries: 'A', sourceNumber: ordinal + 1, sourceType: 'import', lines: [
        { account_number: '1930', account_id: accounts[0], debit_amount: 100, credit_amount: 0, dimensions: {} },
        { account_number: '3001', account_id: accounts[1], debit_amount: 0, credit_amount: 100, dimensions: {} },
      ],
    }))
    await client.query('SELECT public.save_sie_import_chunk($1,$2,$3,$4,$5,$6,$7)',
      [company, job, worker, attempt, 'vouchers', 0, JSON.stringify(payload)])
  }
  await client.query('SELECT public.seal_sie_import_preparation($1,$2,$3,$4,$5,$6)',
    [company, job, worker, attempt, manifest(), vouchers ? 1 : 0])
  if (vouchers) {
    await client.query('SELECT public.import_sie_chunk($1,$2,$3,$4,$5,$6)', [company, job, worker, attempt, 'vouchers', 0])
  }
  await client.query('SELECT public.complete_sie_import_job($1,$2,$3,$4,$5,$6)',
    [company, job, worker, attempt, JSON.stringify({ success: true, journalEntriesCreated: vouchers ? 2 : 0, warnings: [] }), '{}'])
  return job
}

/** Requests the undo and runs it to the end. */
async function undoImport(job: string) {
  await client.query('SELECT public.request_sie_import_undo($1,$2,$3)', [company, job, actor])
  const attempt = await claim(job)
  for (let i = 0; i < 5; i += 1) {
    if ((await undoChunk(job, attempt)).done) return
  }
  throw new Error('undo did not finish')
}

async function eligibility(): Promise<ResetResult> {
  return (await client.query('SELECT public.get_fiscal_year_reset_eligibility($1,$2,$3) AS r', [company, period, actor])).rows[0].r
}

async function reset(): Promise<ResetResult> {
  return (await client.query(`SELECT public.reset_fiscal_year($1,$2,'2024',$3) AS r`, [company, period, actor])).rows[0].r
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
    [actor, `sie-undone-at-${actor}@test.invalid`])
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

describe('sie_imports.undone_at: when an undo ended the job', () => {
  it('is stamped when the last undo chunk ends the job, and not before', async () => {
    const job = await importYear()
    expect((await jobRow(job)).undone_at).toBeNull()

    await client.query('SELECT public.request_sie_import_undo($1,$2,$3)', [company, job, actor])
    expect(await jobRow(job)).toMatchObject({ job_state: 'undoing', status: 'completed', undone_at: null })

    const attempt = await claim(job)
    expect(await undoChunk(job, attempt)).toEqual({ reversed: 2, done: false })
    expect((await jobRow(job)).undone_at).toBeNull()

    expect(await undoChunk(job, attempt)).toEqual({ reversed: 0, done: true })
    const row = await jobRow(job)
    // status and replaced_at say nothing about the time; undone_at does.
    expect(row).toMatchObject({ job_state: 'undone', status: 'replaced', replaced_at: null })
    expect(row.undone_at).toBeInstanceOf(Date)
    expect(row.undone_at.getTime()).toBeGreaterThanOrEqual(row.imported_at.getTime())
  })

  it('is never set or moved by a client write', async () => {
    const job = await importYear()
    await undoImport(job)
    const stamped = (await jobRow(job)).undone_at
    expect(stamped).toBeInstanceOf(Date)

    // A job row: every client write is refused (guard_sie_execution_metadata).
    await client.query('SAVEPOINT client_write')
    await expect(client.query('UPDATE public.sie_imports SET undone_at = NULL WHERE id = $1', [job]))
      .rejects.toThrow(/authorized RPC/)
    await client.query('ROLLBACK TO SAVEPOINT client_write')
    expect((await jobRow(job)).undone_at).toEqual(stamped)

    // A legacy row: the write goes through, undone_at does not.
    const legacy = randomUUID()
    await client.query(
      `INSERT INTO public.sie_imports
         (id, user_id, company_id, filename, file_hash, sie_type, status, fiscal_period_id, undone_at)
       VALUES ($1, $2, $3, 'legacy.se', $4, 4, 'completed', $5, '2024-05-01T00:00:00Z')`,
      [legacy, actor, company, `legacy-${legacy}`, period])
    expect((await jobRow(legacy)).undone_at).toBeNull()
    await client.query(`UPDATE public.sie_imports SET undone_at = now(), error_message = 'x' WHERE id = $1`, [legacy])
    expect((await jobRow(legacy)).undone_at).toBeNull()
  })

  it('stamps the end of a reviewed duplicate repair', async () => {
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
    const chunk = () => client.query('SELECT undo_sie_duplicate_repair_chunk($1,$2,$3,$4) r', [company, staged.id, worker, attempt])
    expect((await chunk()).rows[0].r).toEqual({ reversed: 1, done: false })
    expect((await jobRow(staged.id)).undone_at).toBeNull()
    expect((await chunk()).rows[0].r).toEqual({ reversed: 0, done: true })
    expect(await jobRow(staged.id)).toMatchObject({ job_state: 'undone', status: 'replaced' })
    expect((await jobRow(staged.id)).undone_at).toBeInstanceOf(Date)
  })
})

describe('fiscal-year reset: a year whose SIE import is in place', () => {
  it('is refused until the import is undone, then resets without writing the job row', async () => {
    const job = await importYear(false)

    const before = await eligibility()
    expect(before.eligible).toBe(false)
    expect(before.blockers).toContainEqual({ code: 'sie_import_in_place' })
    expect(before.blockers).not.toContainEqual({ code: 'retained_import_history' })
    expect(await reset()).toMatchObject({ ok: false, code: 'FISCAL_YEAR_RESET_INELIGIBLE' })
    expect(await jobRow(job)).toMatchObject({ job_state: 'completed', status: 'completed' })

    await undoImport(job)
    const after = await eligibility()
    expect(after.blockers ?? []).not.toContainEqual({ code: 'sie_import_in_place' })
    expect(after.eligible).toBe(true)

    expect(await reset()).toMatchObject({ ok: true })
    // The reset flips status on completed legacy rows only; the job keeps its own record.
    expect(await jobRow(job)).toMatchObject({ job_state: 'undone', status: 'replaced' })
  })

  it('leaves a year that holds batch entries to retained_import_history', async () => {
    await importYear()
    const result = await eligibility()
    expect(result.eligible).toBe(false)
    expect(result.blockers).toContainEqual({ code: 'retained_import_history' })
    expect(result.blockers).not.toContainEqual({ code: 'sie_import_in_place' })
  })
})
