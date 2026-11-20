/**
 * pg-real tests for 20261119020000_sie_undo_releases_invoice_links: an undone
 * SIE import releases the invoices booked on its verifikat (crm#2010).
 *   - a plain undo clears invoices.journal_entry_id and the supplier
 *     invoice's registration_journal_entry_id and payment_journal_entry_id
 *     where they name a verifikat the undo reversed, and changes nothing
 *     else on the invoice;
 *   - a replacement (replace_sie_import_job) keeps them: its successor
 *     brings the same verifikat back, and the link moves to the live copy.
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
let invoice: string
let supplierInvoice: string

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

async function claim(id: string): Promise<number> {
  const { rows } = await client.query('SELECT j.* FROM public.claim_sie_import_job($1,$2) j', [worker, id])
  expect(rows[0].id).toBe(id)
  return rows[0].job_attempt
}

async function undoChunk(id: string, attempt: number): Promise<{ reversed: number; done: boolean }> {
  return (await client.query('SELECT public.undo_sie_import_chunk($1,$2,$3,$4) AS r', [company, id, worker, attempt])).rows[0].r
}

/** A completed 2024 import with two vouchers. */
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

/**
 * A customer invoice booked on the import's first verifikat, and a supplier
 * invoice registered on the second and paid on the first, as the migration
 * linker leaves them.
 */
async function linkInvoicesToImport() {
  await client.query('RESET ROLE')
  const { rows } = await client.query(
    `SELECT id FROM public.journal_entries WHERE import_batch_id = $1 ORDER BY source_ordinal`, [job])
  const [first, second] = rows.map((r) => r.id as string)
  const customer = randomUUID()
  const supplier = randomUUID()
  invoice = randomUUID()
  supplierInvoice = randomUUID()
  await client.query(`INSERT INTO customers(id, user_id, company_id, name, customer_type, country)
    VALUES ($1, $2, $3, 'Synthetic customer', 'swedish_business', 'SE')`, [customer, actor, company])
  await client.query(`INSERT INTO invoices(id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
      status, currency, subtotal, vat_amount, total, paid_amount, remaining_amount, vat_treatment, journal_entry_id)
    VALUES ($1, $2, $3, $4, 'SYN-1', '2024-03-04', '2024-04-03', 'sent', 'SEK', 100, 0, 100, 0, 100, 'standard_25', $5)`,
  [invoice, actor, company, customer, first])
  await client.query(`INSERT INTO suppliers(id, user_id, company_id, name, supplier_type, country)
    VALUES ($1, $2, $3, 'Synthetic supplier', 'swedish_business', 'SE')`, [supplier, actor, company])
  await client.query(`INSERT INTO supplier_invoices(id, user_id, company_id, supplier_id, arrival_number,
      supplier_invoice_number, invoice_date, due_date, received_date, status, currency, subtotal, vat_amount, total,
      paid_amount, remaining_amount, vat_treatment, reverse_charge, is_credit_note,
      registration_journal_entry_id, payment_journal_entry_id)
    VALUES ($1, $2, $3, $4, 1, 'SYN-S1', '2024-06-30', '2024-07-30', '2024-06-30', 'paid', 'SEK',
      100, 0, 100, 100, 0, 'standard_25', false, false, $5, $6)`,
  [supplierInvoice, actor, company, supplier, second, first])
  await asServiceRole()
  return { first, second }
}

async function invoiceLinks() {
  await client.query('RESET ROLE')
  const { rows: [inv] } = await client.query(
    'SELECT status, journal_entry_id FROM public.invoices WHERE id = $1', [invoice])
  const { rows: [si] } = await client.query(
    'SELECT status, registration_journal_entry_id, payment_journal_entry_id FROM public.supplier_invoices WHERE id = $1',
    [supplierInvoice])
  await asServiceRole()
  return { invoice: inv, supplierInvoice: si }
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
    [actor, `sie-undo-invoices-${actor}@test.invalid`])
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

describe('SIE import undo: the invoice register follows the storno', () => {
  it('a plain undo releases the invoice and supplier invoice links to the reversed verifikat, and nothing else', async () => {
    await importYear()
    await linkInvoicesToImport()
    await client.query('SELECT public.request_sie_import_undo($1,$2,$3)', [company, job, actor])
    const attempt = await claim(job)
    expect(await undoChunk(job, attempt)).toEqual({ reversed: 2, done: false })

    expect(await invoiceLinks()).toEqual({
      invoice: { status: 'sent', journal_entry_id: null },
      supplierInvoice: { status: 'paid', registration_journal_entry_id: null, payment_journal_entry_id: null },
    })
  })

  it('a replacement keeps the links: its successor brings the verifikat back', async () => {
    await importYear()
    const previous = job
    const { first, second } = await linkInvoicesToImport()
    await client.query('SELECT public.replace_sie_import_job($1,$2,$3,$4,$5,$6,$7)', [
      company, actor, period, 'corrected-2024.se', 'e'.repeat(64), manifest('corrected-2024.se'), previous,
    ])
    const attempt = await claim(previous)
    expect(await undoChunk(previous, attempt)).toEqual({ reversed: 2, done: false })

    expect(await invoiceLinks()).toEqual({
      invoice: { status: 'sent', journal_entry_id: first },
      supplierInvoice: { status: 'paid', registration_journal_entry_id: second, payment_journal_entry_id: first },
    })
  })
})
