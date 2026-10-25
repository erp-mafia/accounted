/**
 * pg-real tests for 20261026003000_retain_sie_undo_reversal (PH 212): an
 * undone SIE import stays undone.
 *   - delete_last_voucher on a storno the batch undo posted is refused, and
 *     nothing changes: the storno stays, its original stays reversed, the
 *     series keeps its number;
 *   - the same holds for the IB-shaped case where the storno is the only one
 *     left in its series (the refusal is about the import, not the position);
 *   - a storno of ONE verifikat of a completed import, reversed by hand,
 *     can still be deleted and restores its original, as before;
 *   - a direct status flip reversed -> posted on an undone batch entry is
 *     refused too, whoever writes it.
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
let job: string
let accounts: string[]

const REFUSAL = /undone SIE import cannot be restored/

function manifest(filename = 'synthetic-2024.se') {
  return JSON.stringify({
    input: { filename, options: {}, mappings: [], fiscalYear: { start: '2024-01-01', end: '2024-12-31' } },
    file_storage_path: filename,
  })
}

async function asServiceRole() {
  await client.query('RESET ROLE')
  await client.query(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true)`)
  await client.query(`SELECT set_config('request.jwt.claim.role','service_role',true)`)
  await client.query('SET LOCAL ROLE service_role')
}

/** The company owner on a browser session, as the voucher DELETE route calls the RPC. */
async function asOwner() {
  await client.query('RESET ROLE')
  await client.query(`SELECT set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: actor, role: 'authenticated' })])
  await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [actor])
  await client.query(`SELECT set_config('request.jwt.claim.role','authenticated',true)`)
  await client.query('SET LOCAL ROLE authenticated')
}

async function claim(id: string): Promise<number> {
  const { rows } = await client.query('SELECT j.* FROM public.claim_sie_import_job($1,$2) j', [worker, id])
  expect(rows[0].id).toBe(id)
  return rows[0].job_attempt
}

async function undoChunk(id: string, attempt: number): Promise<{ reversed: number; done: boolean }> {
  return (await client.query('SELECT public.undo_sie_import_chunk($1,$2,$3,$4) AS r', [company, id, worker, attempt])).rows[0].r
}

/** A completed 2024 import with two vouchers, A1 and A2. */
async function importYear() {
  job = (await client.query(`SELECT (public.start_sie_import_job($1,$2,$3,'synthetic-2024.se',$4,$5)).id`,
    [company, actor, period, 'd'.repeat(64), manifest()])).rows[0].id
  const attempt = await claim(job)
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
}

/** Undo the whole import through the batch storno, as the worker does. */
async function undoImport() {
  await client.query('SELECT public.request_sie_import_undo($1,$2,$3)', [company, job, actor])
  const attempt = await claim(job)
  expect(await undoChunk(job, attempt)).toEqual({ reversed: 2, done: false })
  expect(await undoChunk(job, attempt)).toEqual({ reversed: 0, done: true })
}

/** Every verifikat of the company in series order, read as the superuser. */
async function ledger() {
  await client.query('RESET ROLE')
  const { rows } = await client.query(
    `SELECT voucher_series || voucher_number AS voucher, source_type, status, import_batch_id IS NOT NULL AS batch
       FROM public.journal_entries WHERE company_id = $1 ORDER BY voucher_series, voucher_number`, [company])
  return rows
}

async function entryId(voucherNumber: number): Promise<string> {
  await client.query('RESET ROLE')
  const { rows } = await client.query(
    `SELECT id FROM public.journal_entries WHERE company_id = $1 AND voucher_series = 'A' AND voucher_number = $2`,
    [company, voucherNumber])
  return rows[0].id
}

async function deleteLastVoucher(id: string) {
  await asOwner()
  return client.query('SELECT public.delete_last_voucher($1::uuid, $2::uuid) AS r', [company, id])
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
    [actor, `sie-undo-retained-${actor}@test.invalid`])
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

describe('an undone SIE import stays undone', () => {
  it('refuses delete_last_voucher on the last storno of the batch undo and changes nothing', async () => {
    await importYear()
    await undoImport()
    const before = await ledger()
    expect(before).toEqual([
      { voucher: 'A1', source_type: 'import', status: 'reversed', batch: true },
      { voucher: 'A2', source_type: 'import', status: 'reversed', batch: true },
      { voucher: 'A3', source_type: 'storno', status: 'posted', batch: false },
      { voucher: 'A4', source_type: 'storno', status: 'posted', batch: false },
    ])

    const lastStorno = await entryId(4)
    await client.query('SAVEPOINT refused')
    await expect(deleteLastVoucher(lastStorno)).rejects.toThrow(REFUSAL)
    await client.query('ROLLBACK TO SAVEPOINT refused')

    expect(await ledger()).toEqual(before)
    const { rows } = await client.query(
      `SELECT last_number FROM public.voucher_sequences WHERE company_id = $1 AND fiscal_period_id = $2 AND voucher_series = 'A'`,
      [company, period])
    expect(rows[0].last_number).toBe(4)
    const { rows: job_rows } = await client.query('SELECT job_state FROM public.sie_imports WHERE id = $1', [job])
    expect(job_rows[0].job_state).toBe('undone')
  })

  it('refuses a direct flip of an undone batch entry back to posted, even for the superuser', async () => {
    await importYear()
    await undoImport()
    const original = await entryId(2)
    await client.query('RESET ROLE')
    await client.query('SAVEPOINT refused')
    await client.query(`SELECT set_config('gnubok.allow_delete','true',true)`)
    await expect(client.query(
      `UPDATE public.journal_entries SET status = 'posted', reversed_by_id = NULL WHERE id = $1`, [original],
    )).rejects.toThrow(REFUSAL)
    await client.query('ROLLBACK TO SAVEPOINT refused')
    expect((await ledger()).find((row) => row.voucher === 'A2')).toMatchObject({ status: 'reversed' })
  })

  it('still deletes the storno of one verifikat of a completed import and restores the original', async () => {
    await importYear()
    // One imported verifikat reversed by hand: a posted storno A3 of A2.
    const original = await entryId(2)
    await client.query('RESET ROLE')
    const storno = randomUUID()
    await client.query(
      `INSERT INTO public.journal_entries(id,company_id,user_id,fiscal_period_id,voucher_series,voucher_number,
         entry_date,description,source_type,status,reverses_id)
       VALUES($1,$2,$3,$4,'A',3,'2024-06-30','Makulering: Synthetic voucher','storno','draft',$5)`,
      [storno, company, actor, period, original])
    await client.query(
      `INSERT INTO public.journal_entry_lines(journal_entry_id,account_number,account_id,debit_amount,credit_amount,sort_order)
       VALUES($1,'1930',$2,0,100,0),($1,'3001',$3,100,0,1)`, [storno, accounts[0], accounts[1]])
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [storno])
    await client.query(`UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $1 WHERE id = $2`,
      [storno, original])

    const { rows } = await deleteLastVoucher(storno)
    expect(rows[0].r).toMatchObject({ deleted: true, voucher_series: 'A', voucher_number: 3 })
    expect(await ledger()).toEqual([
      { voucher: 'A1', source_type: 'import', status: 'posted', batch: true },
      { voucher: 'A2', source_type: 'import', status: 'posted', batch: true },
    ])
  })

  it('keeps refusing the imported verifikat themselves (retain_sie_batch_entry, unchanged)', async () => {
    await importYear()
    const last = await entryId(2)
    await client.query('SAVEPOINT refused')
    await expect(deleteLastVoucher(last)).rejects.toThrow(/SIE batch entries cannot be deleted/)
    await client.query('ROLLBACK TO SAVEPOINT refused')
    expect(await ledger()).toHaveLength(2)
  })
})
