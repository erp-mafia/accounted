import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool } from './setup'

/**
 * Covers 20261102100600_sie_import_holds_skipped_numbers (crm#1599): a source
 * voucher the import skips (cancelled in the source system) keeps its number.
 * The next booked voucher of its series carries numberGap; the writer holds
 * that many numbers before it, records the held range in
 * voucher_gap_explanations, and leaves numberGap out of source_content_hash.
 *
 * Runs the job protocol the worker runs (start, claim, save chunks, seal,
 * import_sie_chunk) as service_role, inside one transaction that rolls back.
 */
let client: PoolClient
let company: string
let actor: string
let period: string
let worker: string
let job: string
let attempt: number
let accounts: string[]

const manifest = {
  input: { filename: 'synthetic.se', options: {}, mappings: [], fiscalYear: { start: '2024-01-01', end: '2024-12-31' } },
  file_storage_path: 'synthetic.se',
}
const cancelledA10 =
  'SIE-import: källsystemets verifikation A10 (makulerat i källsystemet) bokfördes inte. ' +
  'Numret hålls tomt så att serien följer källsystemets numrering.'

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
  await client.query(
    `INSERT INTO auth.users(id,email,instance_id) VALUES($1,$2,'00000000-0000-0000-0000-000000000000')`,
    [actor, `sie-gap-${actor}@test.invalid`],
  )
  await client.query(
    `INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,'Synthetic SIE AB','aktiebolag',$2)`,
    [company, actor],
  )
  await client.query(`INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')`, [company, actor])
  await client.query(
    `INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end) VALUES($1,$2,$3,'2024','2024-01-01','2024-12-31')`,
    [period, company, actor],
  )
  accounts = [randomUUID(), randomUUID()]
  for (const [i, number] of ['1930', '3001'].entries()) {
    await client.query(
      `INSERT INTO chart_of_accounts(id,company_id,user_id,account_number,account_name,account_type,account_class,normal_balance)
       VALUES($1,$2,$3,$4,'Synthetic account',$5,$6,$7)`,
      [accounts[i], company, actor, number, i ? 'revenue' : 'asset', i ? 3 : 1, i ? 'credit' : 'debit'],
    )
  }
  await client.query(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true)`)
  await client.query(`SELECT set_config('request.jwt.claim.role','service_role',true)`)
  await client.query('SET LOCAL ROLE service_role')
  const started = await client.query(`SELECT j.* FROM start_sie_import_job($1,$2,$3,'synthetic.se',$4,$5) j`, [
    company, actor, period, 'b'.repeat(64), JSON.stringify(manifest),
  ])
  job = started.rows[0].id
  const claimed = await client.query(`SELECT j.* FROM claim_sie_import_job($1,$2) j`, [worker, job])
  attempt = claimed.rows[0].job_attempt
})
afterEach(async () => {
  await client.query('ROLLBACK TO SAVEPOINT scenario')
})

/** Source voucher A<number> at file position `ordinal`, optionally holding numbers before it. */
function voucher(ordinal: number, number: number, numberGap?: { count: number; explanation: string }) {
  return {
    sourceId: `A${number}`, sourceOrdinal: ordinal, sieImportId: job, series: 'A', date: '2024-03-01',
    description: `Synthetic A${number}`, sourceSeries: 'A', sourceNumber: number, sourceType: 'import',
    ...(numberGap ? { numberGap } : {}),
    lines: [
      { account_number: '1930', account_id: accounts[0], debit_amount: 100, credit_amount: 0, dimensions: {} },
      { account_number: '3001', account_id: accounts[1], debit_amount: 0, credit_amount: 100, dimensions: {} },
    ],
  }
}

/** Save each chunk, seal with the job's own manifest, import them in order. */
async function importChunks(chunks: unknown[][]): Promise<void> {
  for (const [no, payload] of chunks.entries()) {
    await client.query('SELECT save_sie_import_chunk($1,$2,$3,$4,$5,$6,$7)', [
      company, job, worker, attempt, 'vouchers', no, JSON.stringify(payload),
    ])
  }
  const { rows } = await client.query('SELECT manifest FROM sie_imports WHERE id = $1', [job])
  await client.query('SELECT seal_sie_import_preparation($1,$2,$3,$4,$5,$6)', [
    company, job, worker, attempt, JSON.stringify(rows[0].manifest), chunks.length,
  ])
  for (const no of chunks.keys()) {
    await client.query('SELECT import_sie_chunk($1,$2,$3,$4,$5,$6)', [company, job, worker, attempt, 'vouchers', no])
  }
}

async function booked() {
  const { rows } = await client.query(
    `SELECT source_voucher_number AS source, voucher_number AS target FROM journal_entries
      WHERE company_id = $1 AND voucher_series = 'A' ORDER BY voucher_number`,
    [company],
  )
  return rows
}

async function explanations() {
  const { rows } = await client.query(
    `SELECT voucher_series, gap_start, gap_end, explanation, user_id = $2 AS by_actor FROM voucher_gap_explanations
      WHERE company_id = $1 ORDER BY gap_start`,
    [company, actor],
  )
  return rows
}

describe('SIE import holds the numbers of skipped source vouchers (pg-real)', () => {
  it('books A11 as A11 when A10 was cancelled in the source, and documents A10 as an explained gap', async () => {
    await importChunks([[voucher(8, 9), voucher(10, 11, { count: 1, explanation: cancelledA10 }), voucher(11, 12)]])

    expect(await booked()).toEqual([
      { source: 9, target: 1 },
      { source: 11, target: 3 },
      { source: 12, target: 4 },
    ])
    expect(await explanations()).toEqual([
      { voucher_series: 'A', gap_start: 2, gap_end: 2, explanation: cancelledA10, by_actor: true },
    ])
    const { rows } = await client.query('SELECT gap_start, gap_end FROM detect_voucher_gaps($1,$2,$3)', [company, period, 'A'])
    expect(rows).toEqual([{ gap_start: 2, gap_end: 2 }])
  })

  it('holds a run of numbers on the first entry of a later chunk', async () => {
    await importChunks([
      [voucher(0, 1), voucher(1, 2)],
      [voucher(5, 6, { count: 3, explanation: 'SIE-import: A3, A4, A5 bokfördes inte.' }), voucher(6, 7)],
    ])

    expect((await booked()).map((r) => r.target)).toEqual([1, 2, 6, 7])
    expect(await explanations()).toMatchObject([{ gap_start: 3, gap_end: 5 }])
    const { rows } = await client.query(
      `SELECT last_number FROM voucher_sequences WHERE company_id = $1 AND fiscal_period_id = $2 AND voucher_series = 'A'`,
      [company, period],
    )
    expect(rows[0].last_number).toBe(7)
  })

  it('leaves numberGap out of source_content_hash', async () => {
    const placed = voucher(10, 11, { count: 1, explanation: cancelledA10 })
    await importChunks([[placed]])

    const { numberGap: _placement, ...content } = placed
    const { rows } = await client.query(
      `SELECT source_content_hash = encode(extensions.digest(($2::jsonb - 'sieImportId' - 'sourceOrdinal')::text,'sha256'),'hex') AS same
         FROM journal_entries WHERE company_id = $1`,
      [company, JSON.stringify(content)],
    )
    expect(rows).toEqual([{ same: true }])
  })

  it('an append plan reads a booked voucher as present whether its stored hash left numberGap out or kept it', async () => {
    const held = { count: 1, explanation: cancelledA10 }
    // A11 through this writer: numberGap left out of the stored hash.
    await importChunks([[voucher(10, 11, held)]])
    // A12 as the previous writer stored it (code live before this
    // migration): every key hashed, numberGap included.
    const previous = voucher(11, 12, held)
    await client.query('RESET ROLE')
    const id = randomUUID()
    await client.query(
      `INSERT INTO journal_entries (id,user_id,company_id,fiscal_period_id,voucher_number,voucher_series,entry_date,description,
         source_type,source_voucher_series,source_voucher_number,status,import_batch_id,source_ordinal,source_content_hash)
       VALUES ($1,$2,$3,$4,10,'A','2024-03-01','Synthetic A12','import','A',12,'draft',$5,11,
         encode(extensions.digest(($6::jsonb - 'sieImportId' - 'sourceOrdinal')::text,'sha256'),'hex'))`,
      [id, actor, company, period, job, JSON.stringify(previous)],
    )
    for (const [i, line] of previous.lines.entries()) {
      await client.query(
        `INSERT INTO journal_entry_lines (journal_entry_id,account_number,account_id,debit_amount,credit_amount,currency,sort_order,dimensions)
         VALUES ($1,$2,$3,$4,$5,'SEK',$6,'{}'::jsonb)`,
        [id, line.account_number, line.account_id, line.debit_amount, line.credit_amount, i],
      )
    }
    await client.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [id])
    await client.query('SET LOCAL ROLE service_role')

    const { rows } = await client.query('SELECT sie_append_plan($1,$2,NULL,$3) AS plan', [
      company, period, JSON.stringify([voucher(10, 11, held), previous]),
    ])
    expect((rows[0].plan as Array<{ verdict: string }>).map((v) => v.verdict)).toEqual(['present', 'present'])
  })

  it('refuses a malformed numberGap before any number is reserved', async () => {
    await client.query('SAVEPOINT malformed')
    await expect(importChunks([[voucher(0, 2, { count: 0, explanation: 'x' })]])).rejects.toThrow(/invalid numberGap/)
    await client.query('ROLLBACK TO SAVEPOINT malformed')
  })
})
