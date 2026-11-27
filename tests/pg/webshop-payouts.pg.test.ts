import { describe, it, expect } from 'vitest'
import { randomUUID } from 'crypto'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

/**
 * Covers 20261127184217_webshop_payouts: a payment provider's payout, stored
 * by the upload with the service role and read by the company's members. The
 * bank row's booking claims and settles it as the service role too, so a
 * member writes nothing: no member insert, update or delete. One payout per
 * provider key and company; a payout pays something out; its parts are a list.
 */

async function insertPayout(companyId: string, userId: string, over: { externalId?: string; amount?: number; lines?: string } = {}) {
  return getPool().query(
    `INSERT INTO public.webshop_payouts
       (company_id, user_id, platform, store_scope, external_id, reference, payout_date, currency, amount, lines)
     VALUES ($1, $2, 'kustom', 'M100', $3, 'PAY123', '2026-11-19', 'SEK', $4, $5::jsonb)
     RETURNING id`,
    [
      companyId,
      userId,
      over.externalId ?? `kustom_M100_payout_${randomUUID()}`,
      over.amount ?? 934.37,
      over.lines ?? '[{"kind":"sale","amount":950},{"kind":"fee","amount":-15.63}]',
    ],
  )
}

describe('webshop_payouts', () => {
  it('a member reads the company\'s payouts and writes none of them', async () => {
    const { userId, companyId } = await seedCompany()
    const { rows } = await insertPayout(companyId, userId)
    const id = rows[0].id as string

    await withUserContext(userId, async (client) => {
      const read = await client.query(`SELECT amount::text AS amount, reference FROM public.webshop_payouts WHERE id = $1`, [id])
      expect(read.rows).toEqual([{ amount: '934.37', reference: 'PAY123' }])

      // Only SELECT is granted: each write fails before RLS is asked. Each
      // runs in a savepoint, so the transaction goes on after the refusal.
      for (const write of [
        `UPDATE public.webshop_payouts SET journal_entry_id = NULL, transaction_id = NULL WHERE id = '${id}'`,
        `DELETE FROM public.webshop_payouts WHERE id = '${id}'`,
      ]) {
        await client.query('SAVEPOINT w')
        await expect(client.query(write)).rejects.toMatchObject({ code: '42501' })
        await client.query('ROLLBACK TO SAVEPOINT w')
      }
      await expect(
        client.query(
          `INSERT INTO public.webshop_payouts (company_id, platform, store_scope, external_id, payout_date, currency, amount)
           VALUES ($1, 'kustom', 'M100', 'x', '2026-11-19', 'SEK', 1)`,
          [companyId],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })
  })

  it('a member of another company sees nothing', async () => {
    const owner = await seedCompany()
    const { rows } = await insertPayout(owner.companyId, owner.userId)
    const outsider = await seedCompany()
    await withUserContext(outsider.userId, async (client) => {
      const read = await client.query(`SELECT id FROM public.webshop_payouts WHERE id = $1`, [rows[0].id])
      expect(read.rows).toEqual([])
    })
  })

  it('keeps one payout per provider key in a company, and refuses a payout of nothing or parts that are no list', async () => {
    const { userId, companyId } = await seedCompany()
    const key = `kustom_M100_payout_${randomUUID()}`
    await insertPayout(companyId, userId, { externalId: key })
    await expect(insertPayout(companyId, userId, { externalId: key })).rejects.toMatchObject({ code: '23505' })
    await expect(insertPayout(companyId, userId, { amount: 0 })).rejects.toMatchObject({ code: '23514' })
    await expect(insertPayout(companyId, userId, { lines: '{"kind":"sale"}' })).rejects.toMatchObject({ code: '23514' })
  })
})
