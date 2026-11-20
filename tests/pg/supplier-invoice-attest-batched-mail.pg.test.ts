import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * The batched attest mail's tables (crm#1569, migration
 * 20261102114000_supplier_invoice_attest_batched_mail): token credentials
 * and the jobs' send log, for the service role only.
 */

const hashOf = (seed: string) => createHash('sha256').update(seed).digest('hex')

async function seedInvoice(companyId: string, userId: string): Promise<string> {
  const supplierId = randomUUID()
  await getPool().query(`INSERT INTO public.suppliers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Möbelfirman AB')`, [supplierId, userId, companyId])
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date, subtotal, vat_amount, total)
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int, $5, '2026-10-01', '2026-10-31', 8000, 2000, 10000)`,
    [id, userId, companyId, supplierId, `F-${id.slice(0, 8)}`],
  )
  return id
}

async function asAnon(sql: string) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE anon')
    return await client.query(sql)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

describe('supplier_invoice_attest_batches.pg: batched link credentials for the service role only', () => {
  it('keeps the links away from every session and anon, defaults to 7 days, and takes only a hash, a known kind and 1 to 200 invoices', async () => {
    const { userId, companyId } = await seedCompany()
    const first = await seedInvoice(companyId, userId)
    const second = await seedInvoice(companyId, userId)
    const insert = (kind: string, invoiceIds: string[], hash = hashOf(randomUUID())) =>
      getPool().query<{ id: string }>(
        `INSERT INTO public.supplier_invoice_attest_batches (company_id, attester_user_id, kind, invoice_ids, token_hash)
         VALUES ($1, $2, $3, $4::uuid[], $5) RETURNING id`,
        [companyId, userId, kind, invoiceIds, hash],
      )
    const id = (await insert('request', [first, second])).rows[0]!.id
    await expect(insert('reminder', [first])).resolves.toBeTruthy()

    const { rows } = await getPool().query<{ days: string; send_attempts: number; free: boolean }>(
      `SELECT extract(epoch FROM (expires_at - created_at)) / 86400 AS days, send_attempts, send_lease_until = '-infinity' AS free
         FROM public.supplier_invoice_attest_batches WHERE id = $1`,
      [id],
    )
    expect(Math.round(Number(rows[0]!.days))).toBe(7)
    expect(rows[0]!.send_attempts).toBe(1)
    // No run holds it: '-infinity', so "free" is one comparison, never a null check.
    expect(rows[0]!.free).toBe(true)
    await expect(getPool().query(`UPDATE public.supplier_invoice_attest_batches SET send_lease_until = NULL WHERE id = $1`, [id])).rejects.toThrow(/null value/i)

    // A retry takes the row in one conditional update: a fresh token and a lease, only while it is unsent,
    // unretired, free (no live lease) and still at the try this run read. A second run reading the same try gets nothing.
    const retry = (batchId: string, attempts: number) =>
      getPool().query(
        `UPDATE public.supplier_invoice_attest_batches
            SET token_hash = $3, send_attempts = $2 + 1, send_lease_until = now() + interval '15 minutes'
          WHERE id = $1 AND send_attempts = $2 AND mail_sent_at IS NULL AND consumed_at IS NULL
            AND send_lease_until < now()
          RETURNING id`,
        [batchId, attempts, hashOf(randomUUID())],
      )
    const unsent = (await insert('reminder', [second])).rows[0]!.id
    expect((await retry(unsent, 1)).rowCount).toBe(1)
    expect((await retry(unsent, 1)).rowCount).toBe(0)
    // Leased: even at the right try, nobody else takes it until the lease lapses.
    expect((await retry(unsent, 2)).rowCount).toBe(0)
    await getPool().query(`UPDATE public.supplier_invoice_attest_batches SET send_lease_until = now() - interval '1 minute' WHERE id = $1`, [unsent])
    expect((await retry(unsent, 2)).rowCount).toBe(1)
    // A sent mail is never tried again.
    await getPool().query(`UPDATE public.supplier_invoice_attest_batches SET mail_sent_at = now(), send_lease_until = '-infinity' WHERE id = $1`, [unsent])
    expect((await retry(unsent, 3)).rowCount).toBe(0)
    // Six tries at most.
    await expect(
      getPool().query(`UPDATE public.supplier_invoice_attest_batches SET send_attempts = 7 WHERE id = $1`, [unsent]),
    ).rejects.toThrow(/check constraint/i)

    await expect(insert('request', [first], 'clear-token')).rejects.toThrow(/check constraint/i)
    await expect(insert('nudge', [first])).rejects.toThrow(/check constraint/i)
    await expect(insert('request', [])).rejects.toThrow(/check constraint/i)
    const hash = hashOf(randomUUID())
    await insert('request', [first], hash)
    await expect(insert('request', [second], hash)).rejects.toThrow(/duplicate key|unique/i)

    await withUserContext(userId, async (client) => {
      await expect(client.query(`SELECT id FROM public.supplier_invoice_attest_batches`)).rejects.toThrow(/permission denied/i)
    })
    await expect(asAnon(`SELECT id FROM public.supplier_invoice_attest_batches`)).rejects.toThrow(/permission denied/i)
    await runAsServiceRole(async (service) => {
      const read = await service.query(`SELECT id FROM public.supplier_invoice_attest_batches WHERE company_id = $1`, [companyId])
      expect(read.rowCount).toBe(4)
    })
  })
})

describe('supplier_invoice_attest_mail_state.pg: what the jobs sent, for the service role only', () => {
  it('holds one row per invoice, queued now and asked for nothing yet, away from every session and anon', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await seedInvoice(companyId, userId)
    await getPool().query(`INSERT INTO public.supplier_invoice_attest_mail_state (supplier_invoice_id, company_id) VALUES ($1, $2)`, [invoiceId, companyId])
    // A second registration event keeps the first row (the queue's upsert does nothing).
    await expect(
      getPool().query(`INSERT INTO public.supplier_invoice_attest_mail_state (supplier_invoice_id, company_id) VALUES ($1, $2)`, [invoiceId, companyId]),
    ).rejects.toThrow(/duplicate key|unique/i)
    await getPool().query(
      `INSERT INTO public.supplier_invoice_attest_mail_state (supplier_invoice_id, company_id) VALUES ($1, $2) ON CONFLICT (supplier_invoice_id) DO NOTHING`,
      [invoiceId, companyId],
    )
    const { rows } = await getPool().query<{ queued: boolean; asked_at: string | null }>(
      `SELECT queued_at > now() - interval '1 minute' AS queued, asked_at FROM public.supplier_invoice_attest_mail_state WHERE supplier_invoice_id = $1`,
      [invoiceId],
    )
    expect(rows).toEqual([{ queued: true, asked_at: null }])

    // The jobs' claim: only the first run marks the row.
    const claim = () =>
      getPool().query(`UPDATE public.supplier_invoice_attest_mail_state SET asked_at = now() WHERE supplier_invoice_id = $1 AND asked_at IS NULL RETURNING supplier_invoice_id`, [invoiceId])
    expect((await claim()).rowCount).toBe(1)
    expect((await claim()).rowCount).toBe(0)

    await withUserContext(userId, async (client) => {
      await expect(client.query(`SELECT supplier_invoice_id FROM public.supplier_invoice_attest_mail_state`)).rejects.toThrow(/permission denied/i)
    })
    await expect(asAnon(`SELECT supplier_invoice_id FROM public.supplier_invoice_attest_mail_state`)).rejects.toThrow(/permission denied/i)
    await runAsServiceRole(async (service) => {
      const read = await service.query(`SELECT supplier_invoice_id FROM public.supplier_invoice_attest_mail_state WHERE company_id = $1`, [companyId])
      expect(read.rowCount).toBe(1)
    })
  })
})
