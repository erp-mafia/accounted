import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember, insertTransaction, seedCompany, setActiveCompany } from '@/tests/pg/fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * bank_transaction_parts: the Bankgirot split of a bank row (migration
 * 20261013200000). Company members read their company's parts and nobody
 * else's; writes follow transactions' own policies (a writing member of the
 * active company, or the service role); a deleted transaction takes its parts
 * with it; a part's position is unique per transaction; a part suggests one
 * kind of invoice.
 */

async function seedPart(companyId: string, transactionId: string, seq: number, amount = 500): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.bank_transaction_parts (company_id, transaction_id, seq, amount, currency, counterparty_name, reference, invoice_numbers)
     VALUES ($1, $2, $3, $4, 'SEK', 'Kund AB', '1001000000017', ARRAY['1001']) RETURNING id`,
    [companyId, transactionId, seq, amount],
  )
  return rows[0]!.id
}

async function seedSplitRow(amount = 1500) {
  const company = await seedCompany()
  const transactionId = await insertTransaction({ ...company, amount, date: '2026-10-12', description: 'Bg-inbetalning' })
  await seedPart(company.companyId, transactionId, 1, 500)
  await seedPart(company.companyId, transactionId, 2, 1000)
  return { ...company, transactionId }
}

const countParts = async (client: Pool | PoolClient, transactionId: string) => {
  const { rows } = await client.query<{ n: string }>(`SELECT count(*) AS n FROM public.bank_transaction_parts WHERE transaction_id = $1`, [transactionId])
  return Number(rows[0]!.n)
}

describe('bank_transaction_parts.pg: who reads and writes the split', () => {
  it('lets a member of the company read its parts and hides them from another company', async () => {
    const { userId, companyId, transactionId } = await seedSplitRow()
    await withUserContext(userId, async (client) => {
      expect(await countParts(client, transactionId)).toBe(2)
      const { rows } = await client.query<{ seq: number; amount: string; counterparty_name: string; invoice_numbers: string[] }>(
        `SELECT seq, amount, counterparty_name, invoice_numbers FROM public.bank_transaction_parts WHERE transaction_id = $1 ORDER BY seq`,
        [transactionId],
      )
      expect(rows.map((r) => [r.seq, Number(r.amount), r.counterparty_name, r.invoice_numbers])).toEqual([
        [1, 500, 'Kund AB', ['1001']],
        [2, 1000, 'Kund AB', ['1001']],
      ])
    })
    const otherOwner = await insertAuthUser()
    const otherCompany = await insertCompany({ createdBy: otherOwner })
    await insertCompanyMember({ companyId: otherCompany, userId: otherOwner, role: 'owner' })
    await withUserContext(otherOwner, async (client) => {
      expect(await countParts(client, transactionId)).toBe(0)
      const all = await client.query<{ n: string }>(`SELECT count(*) AS n FROM public.bank_transaction_parts WHERE company_id = $1`, [companyId])
      expect(Number(all.rows[0]!.n)).toBe(0)
    })
  })

  it('lets a writing member of the active company insert, replace and delete parts; a viewer and another company never', async () => {
    const { userId, companyId, transactionId } = await seedSplitRow()
    await setActiveCompany(userId, companyId)
    await withUserContext(userId, async (client) => {
      const deleted = await client.query(`DELETE FROM public.bank_transaction_parts WHERE transaction_id = $1`, [transactionId])
      expect(deleted.rowCount).toBe(2)
      const inserted = await client.query(
        `INSERT INTO public.bank_transaction_parts (company_id, transaction_id, seq, amount, currency)
         VALUES ($1, $2, 1, 1500, 'SEK') RETURNING id`,
        [companyId, transactionId],
      )
      expect(inserted.rowCount).toBe(1)
      expect(await countParts(client, transactionId)).toBe(1)
    })

    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    await setActiveCompany(viewer, companyId)
    // One context per statement: a refused statement aborts its transaction.
    await withUserContext(viewer, async (client) => {
      expect(await countParts(client, transactionId)).toBe(2)
    })
    await withUserContext(viewer, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.bank_transaction_parts (company_id, transaction_id, seq, amount, currency) VALUES ($1, $2, 3, 1, 'SEK')`,
          [companyId, transactionId],
        ),
      ).rejects.toThrow(/row-level security/i)
    })
    await withUserContext(viewer, async (client) => {
      // RLS hides the rows from the delete: zero rows, no error.
      const deleted = await client.query(`DELETE FROM public.bank_transaction_parts WHERE transaction_id = $1`, [transactionId])
      expect(deleted.rowCount).toBe(0)
    })

    const otherOwner = await insertAuthUser()
    const otherCompany = await insertCompany({ createdBy: otherOwner })
    await insertCompanyMember({ companyId: otherCompany, userId: otherOwner, role: 'owner' })
    await setActiveCompany(otherOwner, otherCompany)
    await withUserContext(otherOwner, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.bank_transaction_parts (company_id, transaction_id, seq, amount, currency) VALUES ($1, $2, 3, 1, 'SEK')`,
          [companyId, transactionId],
        ),
      ).rejects.toThrow(/row-level security/i)
    })
  })

  it('gives the service role the writes the cron sync needs and anon nothing', async () => {
    const { companyId, transactionId } = await seedSplitRow()
    await runAsServiceRole(async (service) => {
      const deleted = await service.query(`DELETE FROM public.bank_transaction_parts WHERE transaction_id = $1`, [transactionId])
      expect(deleted.rowCount).toBe(2)
      const inserted = await service.query(
        `INSERT INTO public.bank_transaction_parts (company_id, transaction_id, seq, amount, currency) VALUES ($1, $2, 1, 1500, 'SEK')`,
        [companyId, transactionId],
      )
      expect(inserted.rowCount).toBe(1)
    })
    expect(await countParts(getPool(), transactionId)).toBe(1)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE anon')
      await expect(client.query(`SELECT id FROM public.bank_transaction_parts`)).rejects.toThrow(/permission denied/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})

describe('bank_transaction_parts.pg: the shape the table enforces', () => {
  it('deletes the parts with their transaction', async () => {
    const { transactionId } = await seedSplitRow()
    expect(await countParts(getPool(), transactionId)).toBe(2)
    await getPool().query(`DELETE FROM public.transactions WHERE id = $1`, [transactionId])
    expect(await countParts(getPool(), transactionId)).toBe(0)
  })

  it('refuses two parts at the same position of one transaction, and takes the same position on another', async () => {
    const { companyId, transactionId, userId } = await seedSplitRow()
    await expect(seedPart(companyId, transactionId, 2)).rejects.toThrow(/duplicate key|unique/i)
    const otherTransaction = await insertTransaction({ companyId, userId, amount: 700, date: '2026-10-12' })
    await expect(seedPart(companyId, otherTransaction, 2, 700)).resolves.toBeTruthy()
  })

  it('refuses a position below 1, an unknown reason, and a part suggesting both kinds of invoice', async () => {
    const { companyId, transactionId } = await seedSplitRow()
    await expect(seedPart(companyId, transactionId, 0)).rejects.toThrow(/check constraint/i)
    await expect(
      getPool().query(
        `INSERT INTO public.bank_transaction_parts (company_id, transaction_id, seq, amount, currency, suggestion_reason) VALUES ($1, $2, 3, 1, 'SEK', 'guess')`,
        [companyId, transactionId],
      ),
    ).rejects.toThrow(/check constraint/i)
    await expect(
      getPool().query(
        `INSERT INTO public.bank_transaction_parts (company_id, transaction_id, seq, amount, currency, suggested_invoice_id, suggested_supplier_invoice_id)
         VALUES ($1, $2, 3, 1, 'SEK', $3, $4)`,
        [companyId, transactionId, randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow(/check constraint|foreign key/i)
  })

  it('stamps updated_at on an update and drops a suggestion whose invoice is deleted', async () => {
    const { companyId, transactionId, userId } = await seedSplitRow()
    const partId = (await getPool().query<{ id: string }>(`SELECT id FROM public.bank_transaction_parts WHERE transaction_id = $1 AND seq = 1`, [transactionId])).rows[0]!.id
    const customerId = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, company_id, user_id, name, customer_type) VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
      [customerId, companyId, userId],
    )
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices (id, company_id, user_id, customer_id, invoice_number, invoice_date, due_date, status, currency, subtotal, vat_amount, total, vat_treatment, paid_amount, remaining_amount)
       VALUES ($1, $2, $3, $4, '1001', '2026-09-12', '2026-10-12', 'sent', 'SEK', 400, 100, 500, 'standard_25', 0, 500)`,
      [invoiceId, companyId, userId, customerId],
    )
    const before = (await getPool().query<{ updated_at: Date }>(`SELECT updated_at FROM public.bank_transaction_parts WHERE id = $1`, [partId])).rows[0]!.updated_at
    await new Promise((resolve) => setTimeout(resolve, 5))
    await getPool().query(
      `UPDATE public.bank_transaction_parts SET suggested_invoice_id = $2, suggestion_reason = 'ocr_exact' WHERE id = $1`,
      [partId, invoiceId],
    )
    const after = (await getPool().query<{ updated_at: Date; suggested_invoice_id: string | null }>(
      `SELECT updated_at, suggested_invoice_id FROM public.bank_transaction_parts WHERE id = $1`, [partId],
    )).rows[0]!
    expect(after.suggested_invoice_id).toBe(invoiceId)
    expect(after.updated_at.getTime()).toBeGreaterThan(before.getTime())
    await getPool().query(`DELETE FROM public.invoices WHERE id = $1`, [invoiceId])
    const orphaned = (await getPool().query<{ suggested_invoice_id: string | null }>(
      `SELECT suggested_invoice_id FROM public.bank_transaction_parts WHERE id = $1`, [partId],
    )).rows[0]!
    expect(orphaned.suggested_invoice_id).toBeNull()
    expect(await countParts(getPool(), transactionId)).toBe(2)
  })
})
