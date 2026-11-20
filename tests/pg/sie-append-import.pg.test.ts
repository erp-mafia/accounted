/**
 * pg-real tests for 20261030131447_sie_append_import: topping up an imported
 * fiscal year with only the file's new vouchers, as its own batch (issue #108).
 *   - sie_append_plan: an identical voucher (same source series and number,
 *     same content) is present, a changed one is a conflict, a voucher with
 *     the same date and lines but no matching number is a possible
 *     duplicate; a source number from another program is not a match; a
 *     series mapped at booking does not make a voucher another one;
 *   - start_sie_append_job: admits an append of the year's completed import,
 *     an identical retry returns the same job, other input is refused, a
 *     running job and a locked year refuse;
 *   - the append's vouchers continue each series after the base import's;
 *   - import_sie_chunk refuses a same-program source-number collision for
 *     an append, not another program's;
 *   - the base cannot be undone or replaced while an append is live; the
 *     append undoes alone, leaving the base posted;
 *   - a non-member cannot read the plan.
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
let base: string
let accounts: Record<'1930' | '3001', string>

const FISCAL_YEAR = { start: '2026-01-01', end: '2026-12-31' }

function entry(o: { ordinal: number; batch: string; series?: string; sourceSeries?: string | null; sourceNumber?: number | null;
  sourceId?: string; date?: string; amount?: number; description?: string }) {
  const amount = o.amount ?? 100
  return {
    sourceId: o.sourceId ?? `${o.sourceSeries ?? ''}${o.sourceNumber ?? ''}`, sourceOrdinal: o.ordinal, sieImportId: o.batch,
    series: o.series ?? o.sourceSeries ?? 'B', date: o.date ?? '2026-03-04', description: o.description ?? 'Synthetic voucher',
    sourceSeries: o.sourceSeries ?? null, sourceNumber: o.sourceNumber ?? null, sourceType: 'import',
    lines: [
      { account_number: '1930', account_id: accounts['1930'], debit_amount: amount, credit_amount: 0, currency: 'SEK',
        line_description: null, sort_order: 0, dimensions: {} },
      { account_number: '3001', account_id: accounts['3001'], debit_amount: 0, credit_amount: amount, currency: 'SEK',
        line_description: null, sort_order: 1, dimensions: {} },
    ],
  }
}

function inputManifest(kind: 'import' | 'append', extra: Record<string, unknown> = {}) {
  return {
    input: { filename: `${kind}.se`, options: kind === 'append' ? { onExistingPeriod: 'append', ...extra } : {},
      mappings: [], fiscalYear: FISCAL_YEAR },
    file_storage_path: `${kind}.se`,
  }
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

/** Prepare, write and complete a started job with one chunk of `payload`. */
async function runJob(id: string, payload: unknown[], manifest: Record<string, unknown>, program: string) {
  const attempt = await claim(id)
  await client.query('SELECT public.save_sie_import_chunk($1,$2,$3,$4,$5,$6,$7)',
    [company, id, worker, attempt, 'vouchers', 0, JSON.stringify(payload)])
  await client.query('SELECT public.seal_sie_import_preparation($1,$2,$3,$4,$5,$6)',
    [company, id, worker, attempt, JSON.stringify(manifest), 1])
  const written = (await client.query('SELECT public.import_sie_chunk($1,$2,$3,$4,$5,$6) AS r',
    [company, id, worker, attempt, 'vouchers', 0])).rows[0].r
  await client.query('SELECT public.complete_sie_import_job($1,$2,$3,$4,$5,$6)', [company, id, worker, attempt,
    JSON.stringify({ success: true, warnings: [] }), JSON.stringify({ sourceSystem: program })])
  return written as { inserted_entries: Array<{ series: string; voucherNumber: number; sourceId: string }> }
}

/** The year's import (Fortnox): A1, A2, and source K1 booked in series A. */
async function importYear() {
  const manifest = inputManifest('import')
  base = (await client.query(`SELECT (public.start_sie_import_job($1,$2,$3,'import.se',$4,$5)).id`,
    [company, actor, period, 'a'.repeat(64), JSON.stringify(manifest)])).rows[0].id
  await runJob(base, [
    entry({ ordinal: 0, batch: base, sourceSeries: 'A', sourceNumber: 1 }),
    entry({ ordinal: 1, batch: base, sourceSeries: 'A', sourceNumber: 2, date: '2026-03-05', amount: 200 }),
    { ...entry({ ordinal: 2, batch: base, sourceSeries: 'K', sourceNumber: 1, date: '2026-03-06', amount: 300 }), series: 'A' },
  ], manifest, 'Fortnox')
}

async function plan(program: string | null, entries: unknown[]) {
  const { rows } = await client.query('SELECT public.sie_append_plan($1,$2,$3,$4) AS p',
    [company, period, program, JSON.stringify(entries)])
  return (rows[0].p as Array<{ sourceOrdinal: number; verdict: string; voucher: string | null }>)
    .map((row) => [row.sourceOrdinal, row.verdict, row.voucher])
}

function startAppend(hash: string, extra: Record<string, unknown> = {}, program = 'Fortnox') {
  return client.query(`SELECT j.* FROM public.start_sie_append_job($1,$2,$3,'append.se',$4,$5,$6) j`,
    [company, actor, period, hash, JSON.stringify({ ...inputManifest('append', extra), source_program: program }), base])
}

async function refusal(sql: string, values: unknown[]): Promise<string> {
  await client.query('SAVEPOINT refusal')
  try {
    await client.query(sql, values)
    return 'no refusal'
  } catch (error) {
    return (error as Error).message
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT refusal')
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
    [actor, `sie-append-${actor}@test.invalid`])
  await client.query(`INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,'Synthetic Append AB','aktiebolag',$2)`, [company, actor])
  await client.query(`INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')`, [company, actor])
  await client.query(`INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end)
    VALUES($1,$2,$3,'2026','2026-01-01','2026-12-31')`, [period, company, actor])
  accounts = { '1930': randomUUID(), '3001': randomUUID() }
  for (const [i, number] of (['1930', '3001'] as const).entries()) {
    await client.query(`INSERT INTO chart_of_accounts(id,company_id,user_id,account_number,account_name,account_type,account_class,normal_balance)
      VALUES($1,$2,$3,$4,'Synthetic account',$5,$6,$7)`,
      [accounts[number], company, actor, number, i ? 'revenue' : 'asset', i ? 3 : 1, i ? 'credit' : 'debit'])
  }
  await asServiceRole()
  await importYear()
})
afterEach(async () => {
  await client.query('RESET ROLE')
  await client.query('ROLLBACK TO SAVEPOINT scenario')
})

describe('sie_append_plan: one verdict per file voucher', () => {
  const preview = '00000000-0000-0000-0000-000000000000'

  it('skips identical vouchers, refuses a changed one, adds a new one and flags possible duplicates', async () => {
    expect(await plan('Fortnox', [
      entry({ ordinal: 0, batch: preview, sourceSeries: 'A', sourceNumber: 1 }),
      entry({ ordinal: 1, batch: preview, sourceSeries: 'A', sourceNumber: 2, date: '2026-03-05', amount: 250 }),
      // Booked in A by the base, planned in its own series K: still the same voucher.
      entry({ ordinal: 2, batch: preview, sourceSeries: 'K', sourceNumber: 1, date: '2026-03-06', amount: 300 }),
      entry({ ordinal: 3, batch: preview, sourceSeries: 'A', sourceNumber: 3, date: '2026-03-07', amount: 400 }),
      // A 4I voucher without a number, same date and lines as A1.
      entry({ ordinal: 4, batch: preview, sourceId: 'B#5' }),
    ])).toEqual([
      [0, 'present', 'A1'], [1, 'conflict', 'A2'], [2, 'present', 'A3'], [3, 'new', null], [4, 'possible_duplicate', 'A1'],
    ])
  })

  it('matches a source number only within the same program', async () => {
    expect(await plan('Pleo', [
      entry({ ordinal: 0, batch: preview, sourceSeries: 'A', sourceNumber: 2, date: '2026-03-20', amount: 999 }),
    ])).toEqual([[0, 'new', null]])
  })

  it('refuses a caller that is not a member of the company', async () => {
    await client.query('RESET ROLE')
    const stranger = randomUUID()
    await client.query(`SELECT set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ role: 'authenticated', sub: stranger })])
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [stranger])
    await client.query('SET LOCAL ROLE authenticated')
    expect(await refusal('SELECT public.sie_append_plan($1,$2,$3,$4)', [company, period, 'Fortnox', '[]']))
      .toMatch(/not a member/)
  })
})

describe('start_sie_append_job and the append batch', () => {
  it('continues each series after the base import and records its base', async () => {
    const job = (await startAppend('b'.repeat(64))).rows[0]
    expect(job).toMatchObject({ base_import_id: base, job_state: 'queued', supersedes_import_id: null })
    expect(job.manifest).toMatchObject({ source_program: 'Fortnox', prior_activity: true })
    const written = await runJob(job.id, [
      entry({ ordinal: 3, batch: job.id, sourceSeries: 'A', sourceNumber: 3, date: '2026-03-07', amount: 400 }),
      entry({ ordinal: 4, batch: job.id, sourceSeries: 'C', sourceNumber: 1, date: '2026-03-08', amount: 50 }),
    ], { ...inputManifest('append'), source_program: 'Fortnox' }, 'Fortnox')
    expect(written.inserted_entries.map((e) => [e.sourceId, e.series, e.voucherNumber])).toEqual([['A3', 'A', 4], ['C1', 'C', 1]])
  })

  it('returns the same job for an identical retry and refuses other input for the same file', async () => {
    const first = (await startAppend('b'.repeat(64))).rows[0]
    const again = (await startAppend('b'.repeat(64))).rows[0]
    expect(again.id).toBe(first.id)
    expect(await refusal(`SELECT public.start_sie_append_job($1,$2,$3,'append.se',$4,$5,$6)`,
      [company, actor, period, 'b'.repeat(64), JSON.stringify({ ...inputManifest('append', { includePossibleDuplicates: true }),
        source_program: 'Fortnox' }), base])).toMatch(/different mapping or options/)
    const { rows } = await client.query('SELECT count(*)::int AS n FROM public.sie_imports WHERE base_import_id = $1', [base])
    expect(rows[0].n).toBe(1)
  })

  it('refuses a second file while an append is running', async () => {
    await startAppend('b'.repeat(64))
    expect(await refusal(`SELECT public.start_sie_append_job($1,$2,$3,'other.se',$4,$5,$6)`,
      [company, actor, period, 'c'.repeat(64), JSON.stringify({ ...inputManifest('append'), source_program: 'Fortnox' }), base]))
      .toMatch(/unfinished/)
  })

  it('refuses a locked or closed year', async () => {
    await client.query('RESET ROLE')
    await client.query('UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1', [period])
    await asServiceRole()
    expect(await refusal(`SELECT public.start_sie_append_job($1,$2,$3,'append.se',$4,$5,$6)`,
      [company, actor, period, 'b'.repeat(64), JSON.stringify({ ...inputManifest('append'), source_program: 'Fortnox' }), base]))
      .toMatch(/locked or closed/)
  })

  it('refuses an append whose base is itself an append, or is not the year\'s', async () => {
    expect(await refusal(`SELECT public.start_sie_append_job($1,$2,$3,'append.se',$4,$5,$6)`,
      [company, actor, period, 'b'.repeat(64), JSON.stringify({ ...inputManifest('append'), source_program: 'Fortnox' }), randomUUID()]))
      .toMatch(/completed base import/)
  })

  it('the writer refuses a same-program collision with a booked source number', async () => {
    const job = (await startAppend('b'.repeat(64))).rows[0]
    const attempt = await claim(job.id)
    await client.query('SELECT public.save_sie_import_chunk($1,$2,$3,$4,$5,$6,$7)', [company, job.id, worker, attempt,
      'vouchers', 0, JSON.stringify([entry({ ordinal: 0, batch: job.id, sourceSeries: 'A', sourceNumber: 1 })])])
    await client.query('SELECT public.seal_sie_import_preparation($1,$2,$3,$4,$5,$6)', [company, job.id, worker, attempt,
      JSON.stringify({ ...inputManifest('append'), source_program: 'Fortnox' }), 1])
    expect(await refusal('SELECT public.import_sie_chunk($1,$2,$3,$4,$5,$6)', [company, job.id, worker, attempt, 'vouchers', 0]))
      .toMatch(/conflicting voucher A1/)
  })
})

describe('undo: an append undoes alone; its base waits for it', () => {
  async function appendOne() {
    const job = (await startAppend('b'.repeat(64))).rows[0]
    await runJob(job.id, [entry({ ordinal: 3, batch: job.id, sourceSeries: 'A', sourceNumber: 3, date: '2026-03-07', amount: 400 })],
      { ...inputManifest('append'), source_program: 'Fortnox' }, 'Fortnox')
    return job.id as string
  }

  it('refuses to undo or replace the base while an append is live', async () => {
    await appendOne()
    expect(await refusal('SELECT public.request_sie_import_undo($1,$2,$3)', [company, base, actor]))
      .toMatch(/an append batch is live/)
    expect(await refusal('SELECT public.replace_sie_import_job($1,$2,$3,$4,$5,$6,$7)', [company, actor, period,
      'corrected.se', 'e'.repeat(64), JSON.stringify(inputManifest('import')), base])).toMatch(/an append batch is live/)
  })

  it('reverses only the append batch, then lets the base be undone', async () => {
    const appended = await appendOne()
    await client.query('SELECT public.request_sie_import_undo($1,$2,$3)', [company, appended, actor])
    const attempt = await claim(appended)
    let done = false
    for (let i = 0; i < 5 && !done; i++) {
      done = (await client.query('SELECT public.undo_sie_import_chunk($1,$2,$3,$4) AS r', [company, appended, worker, attempt])).rows[0].r.done
    }
    expect(done).toBe(true)
    await client.query('RESET ROLE')
    const { rows } = await client.query(
      `SELECT import_batch_id = $1 AS base, status, count(*)::int AS n FROM public.journal_entries
        WHERE import_batch_id IN ($1,$2) GROUP BY 1, 2 ORDER BY 1, 2`, [base, appended])
    expect(rows).toEqual([{ base: false, status: 'reversed', n: 1 }, { base: true, status: 'posted', n: 3 }])
    await asServiceRole()
    const undone = (await client.query('SELECT j.job_state FROM public.request_sie_import_undo($1,$2,$3) j', [company, base, actor])).rows[0]
    expect(undone.job_state).toBe('undoing')
  })
})
