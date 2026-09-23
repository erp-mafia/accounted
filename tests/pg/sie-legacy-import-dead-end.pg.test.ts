/**
 * pg-real tests for issue #2566 and migration
 * 20260920190300_sie_legacy_pending_import_is_not_live.
 *
 * A legacy SIE import (job_state NULL, made before the durable job backbone
 * went live 2026-09-14) whose request died before finalize stayed 'pending'
 * for good. The writer that could finish it is retired, yet two readers took
 * the status at its word and shut both of the user's exits:
 *   - start_sie_import_job (20260911141611) refused every new import into the
 *     year, even after the year was reset to empty;
 *   - company_migration_reset_snapshot (base body 20260818084050) blocked the
 *     whole-company archive with imports_in_progress.
 *
 * Part 1 recreates that world inside one rolled-back transaction (constraint
 * dropped, rows seeded), pins both dead ends, runs the migration file and pins
 * what it changes and what it leaves alone. Part 2 pins the constraint on the
 * committed schema. Part 3 pins the exit a legacy 'failed' import already had.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool, runAsServiceRole } from '@/tests/pg/setup'
import { seedCompany, insertDraftJournalEntry, insertBalancedLines } from '@/tests/pg/fixtures'

const MIGRATION = readFileSync(
  'supabase/migrations/20260920190300_sie_legacy_pending_import_is_not_live.sql',
  'utf8',
)
const ADMISSION_REFUSAL = /requires reviewed replacement or reconciliation/
const manifest = (start = '2026-01-01', end = '2026-12-31') =>
  JSON.stringify({
    input: { filename: 'retry.se', options: {}, mappings: [], fiscalYear: { start, end } },
    file_storage_path: 'retry.se',
  })

type Queryable = Pick<PoolClient, 'query'>

async function insertLegacyImport(
  db: Queryable,
  p: { companyId: string; userId: string; fiscalPeriodId: string | null; status: string; errorMessage?: string },
): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO public.sie_imports
       (id, user_id, company_id, filename, file_hash, sie_type, accounts_count, transactions_count,
        status, fiscal_period_id, fiscal_year_start, fiscal_year_end, error_message)
     VALUES ($1, $2, $3, 'legacy.se', $4, 4, 0, 0, $5, $6, '2026-01-01', '2026-12-31', $7)`,
    [id, p.userId, p.companyId, `legacy-${id}`, p.status, p.fiscalPeriodId, p.errorMessage ?? null],
  )
  return id
}

/** One posted verifikat shaped like the legacy writer's output (no batch identity). */
async function insertLegacyImportedEntry(f: { companyId: string; userId: string; fiscalPeriodId: string }) {
  const entryId = await insertDraftJournalEntry({
    ...f, sourceType: 'import', legacyImport: true, status: 'draft', voucherNumber: 1,
  })
  await insertBalancedLines(entryId, 1000)
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [entryId])
  return entryId
}

async function asServiceRole<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true)`)
  await client.query(`SELECT set_config('request.jwt.claim.role','service_role',true)`)
  await client.query('SET LOCAL ROLE service_role')
  // No finally: after a refusal the transaction is aborted until the caller
  // rolls back to its savepoint, which also restores the role. A RESET here
  // would fail and replace the refusal the test is asserting on.
  const result = await fn()
  await client.query('RESET ROLE')
  return result
}

async function expectRefused(client: PoolClient, query: () => Promise<unknown>, message: RegExp) {
  await client.query('SAVEPOINT expected_refusal')
  await expect(query()).rejects.toThrow(message)
  await client.query('ROLLBACK TO SAVEPOINT expected_refusal')
}

const archiveBlockers = async (db: Queryable, companyId: string): Promise<string[]> => {
  const { rows } = await db.query<{ result: { blockers?: Array<{ code: string }> } }>(
    `SELECT public.company_migration_reset_snapshot($1::uuid) AS result`,
    [companyId],
  )
  return (rows[0].result.blockers ?? []).map((b) => b.code)
}

describe('migration 20260920190300 on rows that predate it', () => {
  let client: PoolClient
  // Company with the dead end: legacy pending import that wrote one verifikat.
  let stuck: { companyId: string; userId: string; fiscalPeriodId: string }
  let stuckImport: string
  let stuckEntry: string
  let mappedImport: string
  let keptMessageImport: string
  let completedImport: string
  let archivedImport: string
  let durableJob: string

  beforeAll(async () => {
    // Fixtures commit through the pool, so seed everything that does not need
    // the dropped constraint first.
    stuck = await seedCompany()
    stuckEntry = await insertLegacyImportedEntry(stuck)
    const other = await seedCompany()
    const archived = await seedCompany()
    const replacement = await seedCompany()
    const durable = await seedCompany()
    completedImport = await insertLegacyImport(getPool(), { ...other, status: 'completed' })
    durableJob = (
      await runAsServiceRole((c) =>
        c.query<{ id: string }>(`SELECT (public.start_sie_import_job($1,$2,$3,'durable.se',$4,$5)).id`, [
          durable.companyId, durable.userId, durable.fiscalPeriodId, 'c'.repeat(64), manifest(),
        ]),
      )
    ).rows[0].id

    client = await getPool().connect()
    await client.query('BEGIN')
    // Recreate the world before the migration: the state is representable.
    await client.query('ALTER TABLE public.sie_imports DROP CONSTRAINT sie_imports_in_progress_needs_job')
    stuckImport = await insertLegacyImport(client, { ...stuck, status: 'pending' })
    mappedImport = await insertLegacyImport(client, { ...other, fiscalPeriodId: null, status: 'mapped' })
    keptMessageImport = await insertLegacyImport(client, {
      ...other, fiscalPeriodId: null, status: 'pending', errorMessage: 'statement timeout',
    })
    // An archived migration-reset source company: every UPDATE on its rows raises.
    archivedImport = await insertLegacyImport(client, { ...archived, status: 'pending' })
    await client.query(
      `INSERT INTO public.company_migration_resets
         (source_company_id, replacement_company_id, actor_id, reason, confirmation_snapshot, source_counts)
       VALUES ($1, $2, $3, 'pg test: archived migration reset source', '{}'::jsonb, '{}'::jsonb)`,
      [archived.companyId, replacement.companyId, archived.userId],
    )
  })

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  const startImport = () =>
    asServiceRole(client, () =>
      client.query<{ id: string }>(`SELECT (public.start_sie_import_job($1,$2,$3,'retry.se',$4,$5)).id`, [
        stuck.companyId, stuck.userId, stuck.fiscalPeriodId, 'b'.repeat(64), manifest(),
      ]),
    )
  const resetYear = async () =>
    (
      await asServiceRole(client, () =>
        client.query<{ result: { ok: boolean; deleted?: number } }>(
          `SELECT public.reset_fiscal_year($1::uuid, $2::uuid, '2026', $3::uuid) AS result`,
          [stuck.companyId, stuck.fiscalPeriodId, stuck.userId],
        ),
      )
    ).rows[0].result
  const statusOf = async (id: string) =>
    (await client.query<{ status: string; error_message: string | null; job_state: string | null }>(
      `SELECT status, error_message, job_state FROM public.sie_imports WHERE id = $1`, [id],
    )).rows[0]

  it('before: the pending row cannot be undone, and refuses a new import', async () => {
    await expectRefused(client, () => asServiceRole(client, () =>
      client.query('SELECT public.request_sie_import_undo($1,$2,$3)', [stuck.companyId, stuckImport, stuck.userId]),
    ), /SIE execution not found/)
    await expectRefused(client, startImport, ADMISSION_REFUSAL)
  })

  it('before: it reads as an import in progress and blocks the whole-company archive', async () => {
    expect(await archiveBlockers(client, stuck.companyId)).toContain('imports_in_progress')
  })

  it('runs as the migration role, without tripping the archive guard', async () => {
    await client.query(MIGRATION)
  })

  it('closes legacy pending and mapped rows as failed, and says why', async () => {
    expect(await statusOf(stuckImport)).toMatchObject({ status: 'failed', job_state: null })
    expect((await statusOf(stuckImport)).error_message).toMatch(/äldre importflödet/)
    expect((await statusOf(mappedImport)).status).toBe('failed')
  })

  it('keeps an error message the old writer already recorded', async () => {
    expect(await statusOf(keptMessageImport)).toMatchObject({ status: 'failed', error_message: 'statement timeout' })
  })

  it('leaves every other import alone: completed, durable jobs, archived companies', async () => {
    expect((await statusOf(completedImport)).status).toBe('completed')
    // The durable writer itself uses status 'pending' while it runs.
    expect(await statusOf(durableJob)).toMatchObject({ status: 'pending', job_state: 'queued' })
    expect((await statusOf(archivedImport)).status).toBe('pending')
  })

  it('touches no verifikat, and records the change in behandlingshistoriken', async () => {
    const entry = await client.query<{ status: string; lines: string }>(
      `SELECT j.status, (SELECT count(*) FROM public.journal_entry_lines l WHERE l.journal_entry_id = j.id)::text AS lines
         FROM public.journal_entries j WHERE j.id = $1`,
      [stuckEntry],
    )
    expect(entry.rows[0]).toEqual({ status: 'posted', lines: '2' })
    const audit = await client.query<{ old_status: string; new_status: string }>(
      `SELECT old_state->>'status' AS old_status, new_state->>'status' AS new_status
         FROM public.audit_log
        WHERE table_name = 'sie_imports' AND record_id = $1 AND action = 'UPDATE'`,
      [stuckImport],
    )
    expect(audit.rows).toEqual([{ old_status: 'pending', new_status: 'failed' }])
  })

  it('after: the whole-company archive no longer sees an import in progress', async () => {
    expect(await archiveBlockers(client, stuck.companyId)).not.toContain('imports_in_progress')
  })

  it('after: admission still refuses while the old verifikat sit in the year, and admits once the year is reset', async () => {
    await expectRefused(client, startImport, ADMISSION_REFUSAL)
    expect(await resetYear()).toMatchObject({ ok: true, deleted: 1 })
    expect((await startImport()).rows[0].id).toBeTruthy()
  })
})

describe('constraint sie_imports_in_progress_needs_job', () => {
  it.each(['pending', 'mapped'])('refuses a new legacy row claiming %s', async (status) => {
    const f = await seedCompany()
    await expect(insertLegacyImport(getPool(), { ...f, status })).rejects.toMatchObject({
      code: '23514',
      constraint: 'sie_imports_in_progress_needs_job',
    })
  })

  it('refuses moving a legacy row back to pending', async () => {
    const f = await seedCompany()
    const id = await insertLegacyImport(getPool(), { ...f, status: 'failed' })
    await expect(
      getPool().query(`UPDATE public.sie_imports SET status = 'pending' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('still admits a durable job, whose own status is pending while it runs', async () => {
    const f = await seedCompany()
    const started = await runAsServiceRole((c) =>
      c.query<{ status: string; job_state: string }>(
        `SELECT j.status, j.job_state FROM public.start_sie_import_job($1,$2,$3,'ok.se',$4,$5) j`,
        [f.companyId, f.userId, f.fiscalPeriodId, 'd'.repeat(64), manifest()],
      ),
    )
    expect(started.rows[0]).toEqual({ status: 'pending', job_state: 'queued' })
  })

  it.each(['completed', 'failed', 'replaced', 'undone'])('still admits a legacy %s row', async (status) => {
    const f = await seedCompany()
    expect(await insertLegacyImport(getPool(), { ...f, status })).toBeTruthy()
  })
})

describe('a legacy import left failed with data written already had an exit', () => {
  async function seed() {
    const f = await seedCompany()
    const importId = await insertLegacyImport(getPool(), { ...f, status: 'failed' })
    await insertLegacyImportedEntry(f)
    return { ...f, importId }
  }
  const start = (f: { companyId: string; userId: string; fiscalPeriodId: string }) =>
    runAsServiceRole((c) =>
      c.query<{ id: string }>(`SELECT (public.start_sie_import_job($1,$2,$3,'retry.se',$4,$5)).id`, [
        f.companyId, f.userId, f.fiscalPeriodId, 'e'.repeat(64), manifest(),
      ]),
    )

  it('it cannot be undone: the durable undo does not know a legacy row', async () => {
    const f = await seed()
    await expect(
      runAsServiceRole((c) => c.query('SELECT public.request_sie_import_undo($1,$2,$3)', [f.companyId, f.importId, f.userId])),
    ).rejects.toMatchObject({ code: 'P0002' })
  })

  it('it cannot be re-run while its verifikat sit in the year', async () => {
    const f = await seed()
    await expect(start(f)).rejects.toThrow(ADMISSION_REFUSAL)
  })

  it('resetting the year clears the way: a new import is admitted', async () => {
    const f = await seed()
    const reset = await runAsServiceRole((c) =>
      c.query<{ result: { ok: boolean; deleted?: number } }>(
        `SELECT public.reset_fiscal_year($1::uuid, $2::uuid, '2026', $3::uuid) AS result`,
        [f.companyId, f.fiscalPeriodId, f.userId],
      ),
    )
    expect(reset.rows[0].result).toMatchObject({ ok: true, deleted: 1 })
    // Checked before the new job exists: that one is an import in progress.
    expect(await archiveBlockers(getPool(), f.companyId)).not.toContain('imports_in_progress')
    expect((await start(f)).rows[0].id).toBeTruthy()
  })
})
