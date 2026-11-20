import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool } from './setup'

/**
 * Covers 20261016221500_sie_import_admission_refusal (crm#1272): one rule,
 * sie_import_admission_refusal, decides whether start_sie_import_job admits
 * an import, and the preflight reads the same rule.
 *
 * The case behind it: a company imported its first year, booked the next
 * year's ingående balans by hand, then imported that year's vouchers without
 * the file's IB. start_sie_import_job refused any posted opening_balance
 * verifikat in the year as "Existing SIE import", although the import would
 * never book an IB of its own; the preflight, which never ran that test,
 * answered ok.
 *
 * Runs as service_role (and once as the member) inside one transaction that
 * rolls back; every scenario is a savepoint.
 */
let client: PoolClient
let company: string
let actor: string
let year2025: string
let year2026: string

const manifest = (importOpeningBalances: boolean) =>
  JSON.stringify({
    input: {
      filename: 'synthetic.se',
      options: { importOpeningBalances, importTransactions: true },
      mappings: [],
      fiscalYear: { start: '2026-01-01', end: '2026-12-31' },
    },
    file_storage_path: 'synthetic.se',
  })

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
  ;[company, actor, year2025, year2026] = Array.from({ length: 4 }, () => randomUUID())
  await client.query(
    `INSERT INTO auth.users(id,email,instance_id) VALUES($1,$2,'00000000-0000-0000-0000-000000000000')`,
    [actor, `sie-admission-${actor}@test.invalid`],
  )
  await client.query(
    `INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,'Synthetic SIE AB','aktiebolag',$2)`,
    [company, actor],
  )
  await client.query(`INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')`, [company, actor])
  await client.query(
    `INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end)
     VALUES($1,$3,$4,'Räkenskapsår 2025','2025-01-01','2025-12-31'),($2,$3,$4,'Räkenskapsår 2026','2026-01-01','2026-12-31')`,
    [year2025, year2026, company, actor],
  )
})
afterEach(async () => {
  await client.query('RESET ROLE')
  await client.query('ROLLBACK TO SAVEPOINT scenario')
})

/** A posted verifikat, written as the superuser (the engine's own path is not under test here). */
async function post(p: {
  period: string
  date: string
  sourceType: string
  series?: string
  number: number
  batch?: string | null
  lines: Array<[string, number, number]>
}): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO journal_entries(id,company_id,user_id,fiscal_period_id,voucher_number,voucher_series,entry_date,
       description,source_type,status,import_batch_id,source_ordinal,source_content_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7,'Synthetic','${p.sourceType}','draft',$8,
       CASE WHEN $8::uuid IS NOT NULL THEN 0 END,CASE WHEN $8::uuid IS NOT NULL THEN repeat('a',64) END)`,
    [id, company, actor, p.period, p.number, p.series ?? 'A', p.date, p.batch ?? null],
  )
  for (const [i, [account, debit, credit]] of p.lines.entries()) {
    await client.query(
      `INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount,sort_order)
       VALUES($1,$2,$3,$4,$5)`,
      [id, account, debit, credit, i],
    )
  }
  await client.query(`UPDATE journal_entries SET status='posted' WHERE id=$1`, [id])
  return id
}

/** The IB booked by hand for 2026, linked to the year as the opening-balance tool links it. */
async function bookManualIb(): Promise<string> {
  const id = await post({
    period: year2026, date: '2026-01-01', sourceType: 'opening_balance', number: 1,
    lines: [['1930', 5000, 0], ['2081', 0, 5000]],
  })
  await client.query(`UPDATE fiscal_periods SET opening_balance_entry_id=$1, opening_balances_set=true WHERE id=$2`, [id, year2026])
  return id
}

/** The first year's bookkeeping: what makes the 2026 import a continuation (prior_activity). */
async function bookPriorYear(): Promise<void> {
  await post({
    period: year2025, date: '2025-06-01', sourceType: 'manual', number: 1,
    lines: [['1930', 1000, 0], ['3001', 0, 1000]],
  })
}

async function completedImport(fiscalYear: [string, string] | null = null): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status,fiscal_year_start,fiscal_year_end)
     VALUES($1,$2,'earlier.se',md5(gen_random_uuid()::text),4,'completed',$3,$4) RETURNING id`,
    [company, actor, fiscalYear?.[0] ?? null, fiscalYear?.[1] ?? null],
  )
  return rows[0].id
}

async function asServiceRole(): Promise<void> {
  await client.query(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true)`)
  await client.query(`SELECT set_config('request.jwt.claim.role','service_role',true)`)
  await client.query('SET LOCAL ROLE service_role')
}

async function start(importOpeningBalances: boolean): Promise<Record<string, unknown>> {
  await asServiceRole()
  const { rows } = await client.query(`SELECT j.* FROM start_sie_import_job($1,$2,$3,'synthetic.se',$4,$5) j`, [
    company, actor, year2026, 'b'.repeat(64), manifest(importOpeningBalances),
  ])
  return rows[0]
}

/** The refusal start_sie_import_job raises, or null when it admitted the import. */
async function startRefusal(importOpeningBalances: boolean): Promise<string | null> {
  await client.query('SAVEPOINT attempt')
  try {
    await start(importOpeningBalances)
    await client.query('RELEASE SAVEPOINT attempt')
    return null
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT attempt')
    return (error as Error).message
  }
}

async function rule(importOpeningBalances: boolean, periodId: string | null = year2026,
  range: [string, string] = ['2026-01-01', '2026-12-31']): Promise<Record<string, unknown> | null> {
  const { rows } = await client.query(
    `SELECT sie_import_admission_refusal($1,$2,$3,$4,NULL,$5) AS refusal`,
    [company, periodId, range[0], range[1], importOpeningBalances],
  )
  return rows[0].refusal
}

describe('a year with an ingående balans booked by hand (crm#1272)', () => {
  it('admits the year\'s vouchers on top of it when the import brings no IB', async () => {
    const ib = await bookManualIb()
    await asServiceRole()
    expect(await rule(false)).toBeNull()
    const job = await start(false)
    expect(job.job_state).toBe('queued')
    expect((job.manifest as Record<string, unknown>).prior_activity).toBe(false)
    await client.query('RESET ROLE')
    // Nothing posted was touched.
    const { rows } = await client.query(`SELECT status FROM journal_entries WHERE id=$1`, [ib])
    expect(rows[0].status).toBe('posted')
  })

  it('refuses an import that would book the file\'s IB on top of it, naming the verifikat', async () => {
    const ib = await bookManualIb()
    const refusal = await startRefusal(true)
    expect(refusal).toMatch(/^SIE_IMPORT_PERIOD_HAS_OPENING_BALANCE: Räkenskapsåret 2026-01-01 till 2026-12-31 har redan en bokförd ingående balans \(verifikation A1, 2026-01-01\)/)
    expect(refusal).toContain('Importera filen utan ingående balanser')
    // The preflight reads the same rule and gets the same answer.
    expect(await rule(true)).toMatchObject({ reason: 'opening_balance', entry_id: ib, voucher: 'A1', entry_date: '2026-01-01' })
  })

  it('admits a continuation import whatever its IB option: the job never books the file\'s IB then', async () => {
    await bookPriorYear()
    await bookManualIb()
    await asServiceRole()
    expect(await rule(true)).toBeNull()
    const job = await start(true)
    expect((job.manifest as Record<string, unknown>).prior_activity).toBe(true)
  })

  it('answers the member through RLS exactly as the import\'s own call', async () => {
    await bookManualIb()
    await client.query(
      `INSERT INTO user_preferences(user_id,active_company_id) VALUES($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET active_company_id=EXCLUDED.active_company_id`,
      [actor, company],
    )
    await client.query(`SELECT set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: actor, role: 'authenticated' })])
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [actor])
    await client.query('SET LOCAL ROLE authenticated')
    expect(await rule(true)).toMatchObject({ reason: 'opening_balance', voucher: 'A1' })
    expect(await rule(false)).toBeNull()
  })
})

describe('what still refuses as an existing import', () => {
  it('an earlier import\'s verifikat in the year, whatever the IB option', async () => {
    const earlier = await completedImport()
    await post({
      period: year2026, date: '2026-02-01', sourceType: 'import', number: 1, batch: earlier,
      lines: [['1930', 100, 0], ['3001', 0, 100]],
    })
    expect(await startRefusal(false)).toBe('Existing SIE import requires reviewed replacement or reconciliation')
    expect(await rule(false)).toEqual({ reason: 'existing_import', import_id: earlier })
  })

  it('an IB verifikat an import booked', async () => {
    const earlier = await completedImport()
    await post({
      period: year2026, date: '2026-01-01', sourceType: 'opening_balance', number: 1, batch: earlier,
      lines: [['1930', 5000, 0], ['2081', 0, 5000]],
    })
    expect(await startRefusal(false)).toBe('Existing SIE import requires reviewed replacement or reconciliation')
  })

  it('an import record whose year overlaps, also for a year the import would create', async () => {
    const earlier = await completedImport(['2026-01-01', '2026-12-31'])
    expect(await startRefusal(false)).toBe('Existing SIE import requires reviewed replacement or reconciliation')
    expect(await rule(false, null)).toEqual({ reason: 'existing_import', import_id: earlier })
    expect(await rule(false, null, ['2027-01-01', '2027-12-31'])).toBeNull()
  })

  it('another import of the company that is not finished', async () => {
    const { rows } = await client.query(
      `INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status,job_state,job_phase,fiscal_period_id)
       VALUES($1,$2,'running.se',md5(gen_random_uuid()::text),4,'pending','running','vouchers',$3) RETURNING id`,
      [company, actor, year2025],
    )
    expect(await startRefusal(false)).toBe('SIE import is unfinished: resume or undo it')
    expect(await rule(false)).toEqual({ reason: 'unfinished_import', import_id: rows[0].id })
  })
})
