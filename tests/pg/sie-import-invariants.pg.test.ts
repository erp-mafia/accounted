/**
 * pg-real test for the SIE import invariant monitor
 * (20261110094517_sie_import_invariants_paged): the duplicate check, now one
 * page of companies per call, still finds a seeded duplicate imported voucher
 * (also one a batch-owned voucher shares with a legacy one, outside the
 * partial unique index), and the job check still finds an orphaned import
 * batch. What counts as a violation is unchanged: a voucher that is not
 * posted, or the same source number in another fiscal year, is no duplicate.
 *
 * Everything runs in one rollback-only transaction. Other test files share the
 * database, so a page is pinned to the seeded company (the page after its
 * predecessor, one company long) and whole-database counts are compared
 * before and after each seed.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool } from './setup'

interface DuplicatePage {
  companies_checked: number
  last_company_id: string | null
  done: boolean
  duplicate_groups: number
  extra_vouchers: number
  duplicate_samples: Array<Record<string, unknown>>
}

interface JobInvariants {
  missing_holds: number
  stale_holds: number
  paused_jobs: number
  expired_leases: number
  oldest_unresolved: string | null
}

let client: PoolClient

beforeAll(async () => { client = await getPool().connect(); await client.query('BEGIN') })
afterAll(async () => { if (client) { await client.query('ROLLBACK'); client.release() } })
beforeEach(async () => { await client.query('SAVEPOINT scenario') })
afterEach(async () => { await client.query('ROLLBACK TO SAVEPOINT scenario') })

async function seedCompany() {
  const [user, company, period, earlier] = Array.from({ length: 4 }, () => randomUUID())
  await client.query("INSERT INTO auth.users(id,email,instance_id) VALUES($1,$2,'00000000-0000-0000-0000-000000000000')",
    [user, `sie-invariants-${user}@test.invalid`])
  await client.query("INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,'Synthetic invariant company','aktiebolag',$2)", [company, user])
  await client.query("INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')", [company, user])
  await client.query(`INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end)
    VALUES($1,$3,$4,'2026','2026-01-01','2026-12-31'),($2,$3,$4,'2025','2025-01-01','2025-12-31')`, [period, earlier, company, user])
  await client.query(`INSERT INTO chart_of_accounts(company_id,user_id,account_number,account_name,account_type,account_class,normal_balance)
    VALUES($1,$2,'1930','Bank','asset',1,'debit'),($1,$2,'3001','Sales','revenue',3,'credit')`, [company, user])
  return { user, company, period, earlier }
}

type Seeded = Awaited<ReturnType<typeof seedCompany>>

/**
 * An imported voucher with source identity (series A, sourceNumber). Legacy
 * rows predate the durable batch identity: only the provenance guard is
 * disabled for their insert, inside this rollback-only transaction, as in
 * sie-duplicate-repair.pg.test.ts. Every accounting trigger stays active.
 * Postgres refuses ALTER TABLE while an earlier voucher's deferred balance
 * check (check_balance_on_post) is still queued, so the queued checks run
 * first: every voucher before this one is balanced, and each later check runs
 * at the end of its own statement, which is stricter, not looser.
 */
async function importedVoucher(f: Seeded, opts: {
  voucherNumber: number
  sourceNumber: number
  status?: 'posted' | 'draft'
  period?: string
  batch?: string
}) {
  const id = randomUUID()
  const period = opts.period ?? f.period
  const date = period === f.earlier ? '2025-02-01' : '2026-02-01'
  if (!opts.batch) {
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    await client.query('ALTER TABLE journal_entries DISABLE TRIGGER guard_sie_entry_provenance')
  }
  await client.query(`INSERT INTO journal_entries(id,company_id,user_id,fiscal_period_id,voucher_series,voucher_number,
      source_type,source_voucher_series,source_voucher_number,entry_date,description,status,
      import_batch_id,source_ordinal,source_content_hash)
    VALUES($1,$2,$3,$4,'A',$5,'import','A',$6,$7,'Synthetic import','draft',$8,
      CASE WHEN $8::uuid IS NOT NULL THEN $5::integer END,CASE WHEN $8::uuid IS NOT NULL THEN repeat('b',64) END)`,
  [id, f.company, f.user, period, opts.voucherNumber, opts.sourceNumber, date, opts.batch ?? null])
  if (!opts.batch) await client.query('ALTER TABLE journal_entries ENABLE TRIGGER guard_sie_entry_provenance')
  await client.query("INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount) VALUES($1,'1930',100,0),($1,'3001',0,100)", [id])
  if ((opts.status ?? 'posted') === 'posted') await client.query("UPDATE journal_entries SET status='posted' WHERE id=$1", [id])
  return id
}

async function importJob(f: Seeded, period: string, state: 'completed' | 'running') {
  const job = randomUUID()
  await client.query(`INSERT INTO sie_imports(id,company_id,user_id,execution_actor_id,filename,file_hash,status,sie_type,
    fiscal_period_id,job_state,job_phase,job_kind) VALUES($1,$2,$3,$3,'synthetic.se',$4,$5,4,$6,$7,$8,'import')`,
  [job, f.company, f.user, randomUUID(), state === 'completed' ? 'completed' : 'pending', period, state,
    state === 'completed' ? 'finalize' : 'vouchers'])
  return job
}

/** The page of check_sie_import_duplicate_vouchers that holds exactly this company. */
async function pageOf(company: string): Promise<DuplicatePage> {
  const { rows } = await client.query(
    `SELECT check_sie_import_duplicate_vouchers(
       (SELECT id FROM companies WHERE id < $1 ORDER BY id DESC LIMIT 1), 1) AS r`, [company])
  return rows[0].r as DuplicatePage
}

/** Every page in company order, as the cron walks them, summed. */
async function scanAll(pageSize: number) {
  let after: string | null = null
  const total = { pages: 0, companies: 0, groups: 0, extra: 0 }
  for (;;) {
    const { rows } = await client.query('SELECT check_sie_import_duplicate_vouchers($1, $2) AS r', [after, pageSize])
    const page = rows[0].r as DuplicatePage
    total.pages += 1
    total.companies += Number(page.companies_checked)
    total.groups += Number(page.duplicate_groups)
    total.extra += Number(page.extra_vouchers)
    if (page.done) return total
    after = page.last_company_id
  }
}

async function jobInvariants(): Promise<JobInvariants> {
  return (await client.query('SELECT check_sie_import_job_invariants() AS r')).rows[0].r as JobInvariants
}

describe('check_sie_import_duplicate_vouchers', () => {
  it('finds a duplicate imported voucher in its company page', async () => {
    const f = await seedCompany()
    await importedVoucher(f, { voucherNumber: 1, sourceNumber: 7 })
    await importedVoucher(f, { voucherNumber: 2, sourceNumber: 7 })
    await importedVoucher(f, { voucherNumber: 3, sourceNumber: 8 })

    const page = await pageOf(f.company)
    expect(page).toMatchObject({ companies_checked: 1, last_company_id: f.company, duplicate_groups: 1, extra_vouchers: 1 })
    expect(page.duplicate_samples).toEqual([{
      company_id: f.company, fiscal_period_id: f.period, source_voucher_series: 'A', source_voucher_number: 7, n: 2,
    }])
  })

  it('finds it in a scan of every page too: the pages partition the companies', async () => {
    const before = await scanAll(25)
    const f = await seedCompany()
    await importedVoucher(f, { voucherNumber: 1, sourceNumber: 7 })
    await importedVoucher(f, { voucherNumber: 2, sourceNumber: 7 })
    await importedVoucher(f, { voucherNumber: 3, sourceNumber: 7 })

    const after = await scanAll(25)
    const { rows } = await client.query('SELECT count(*)::int AS n FROM companies')
    expect(after.companies).toBe(rows[0].n)
    expect(after.groups).toBe(before.groups + 1)
    expect(after.extra).toBe(before.extra + 2)
  })

  it('counts a duplicate a batch-owned voucher shares with a legacy one', async () => {
    const f = await seedCompany()
    const job = await importJob(f, f.period, 'completed')
    await importedVoucher(f, { voucherNumber: 1, sourceNumber: 7, batch: job })
    await importedVoucher(f, { voucherNumber: 2, sourceNumber: 7 })

    expect(await pageOf(f.company)).toMatchObject({ duplicate_groups: 1, extra_vouchers: 1 })
  })

  it('does not count a copy that is not posted, or the same source number in another fiscal year', async () => {
    const f = await seedCompany()
    await importedVoucher(f, { voucherNumber: 1, sourceNumber: 7 })
    await importedVoucher(f, { voucherNumber: 2, sourceNumber: 7, status: 'draft' })
    await importedVoucher(f, { voucherNumber: 1, sourceNumber: 7, period: f.earlier })

    expect(await pageOf(f.company)).toMatchObject({ companies_checked: 1, duplicate_groups: 0, extra_vouchers: 0, duplicate_samples: [] })
  })

  it('answers done with an empty page past the last company', async () => {
    expect(await client.query("SELECT check_sie_import_duplicate_vouchers('ffffffff-ffff-ffff-ffff-ffffffffffff', 500) AS r")
      .then((r) => r.rows[0].r)).toEqual({
      companies_checked: 0, last_company_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', done: true,
      duplicate_groups: 0, extra_vouchers: 0, duplicate_samples: [],
    })
  })

  it('reads a page from the partial index in group order, without a sort or a hash table', async () => {
    const f = await seedCompany()
    await importedVoucher(f, { voucherNumber: 1, sourceNumber: 7 })
    // A fresh fixture is a handful of rows, where the planner rightly prefers a
    // seq scan or a sort whatever indexes exist. With those paths priced out,
    // the plan names the index only if its predicate covers the page query's
    // filter and its keys give the grouping order.
    for (const knob of ['enable_seqscan', 'enable_bitmapscan', 'enable_sort', 'enable_incremental_sort', 'enable_hashagg']) {
      await client.query(`SET LOCAL ${knob} = off`)
    }
    const { rows } = await client.query(
      `EXPLAIN (FORMAT JSON)
       SELECT company_id,fiscal_period_id,source_voucher_series,source_voucher_number,count(*) n
       FROM public.journal_entries
       WHERE source_type = 'import' AND status = 'posted'
         AND source_voucher_series IS NOT NULL AND source_voucher_number IS NOT NULL
         AND company_id BETWEEN $1 AND $1
       GROUP BY company_id,fiscal_period_id,source_voucher_series,source_voucher_number HAVING count(*) > 1`,
      [f.company],
    )
    const plan = JSON.stringify(rows[0]['QUERY PLAN'])
    expect(plan).toContain('idx_journal_entries_posted_import_source_voucher')
    expect(plan).not.toMatch(/"Node Type":"(Sort|Incremental Sort|Seq Scan)"/)
    expect(plan).not.toContain('"Strategy":"Hashed"')
  })
})

describe('check_sie_import_job_invariants', () => {
  it('finds an orphaned import batch: a fiscal year held by a finished job, and an unfinished job its year does not hold', async () => {
    const before = await jobInvariants()
    const f = await seedCompany()
    const finished = await importJob(f, f.period, 'completed')
    await client.query('UPDATE fiscal_periods SET import_hold=$2 WHERE id=$1', [f.period, finished])
    await importJob(f, f.earlier, 'running')

    const after = await jobInvariants()
    expect(Number(after.stale_holds)).toBe(Number(before.stale_holds) + 1)
    expect(Number(after.missing_holds)).toBe(Number(before.missing_holds) + 1)
  })

  it('does not count a running job that holds its fiscal year', async () => {
    const before = await jobInvariants()
    const f = await seedCompany()
    const running = await importJob(f, f.period, 'running')
    await client.query('UPDATE fiscal_periods SET import_hold=$2 WHERE id=$1', [f.period, running])

    const after = await jobInvariants()
    expect(Number(after.stale_holds)).toBe(Number(before.stale_holds))
    expect(Number(after.missing_holds)).toBe(Number(before.missing_holds))
  })
})

describe('SIE import invariant functions', () => {
  it('are callable by the service role only, and the single-statement check is gone', async () => {
    const { rows } = await client.query(
      `SELECT fn, has_function_privilege('anon', fn, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', fn, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', fn, 'EXECUTE') AS service_role
       FROM unnest(ARRAY['public.check_sie_import_duplicate_vouchers(uuid,integer)',
                         'public.check_sie_import_job_invariants()']) AS fn ORDER BY fn`,
    )
    expect(rows).toEqual([
      { fn: 'public.check_sie_import_duplicate_vouchers(uuid,integer)', anon: false, authenticated: false, service_role: true },
      { fn: 'public.check_sie_import_job_invariants()', anon: false, authenticated: false, service_role: true },
    ])
    expect((await client.query("SELECT to_regprocedure('public.check_sie_import_invariants()') AS f")).rows[0].f).toBeNull()
  })

  it('runs as the service role', async () => {
    await seedCompany()
    await client.query('SET LOCAL ROLE service_role')
    const page = (await client.query("SELECT check_sie_import_duplicate_vouchers(NULL, 1) AS r")).rows[0].r as DuplicatePage
    expect(page.companies_checked).toBe(1)
    expect(Object.keys(await jobInvariants()).sort()).toEqual(
      ['expired_leases', 'missing_holds', 'oldest_unresolved', 'paused_jobs', 'stale_holds'])
  })
})
