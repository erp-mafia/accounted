/**
 * Migrations 20261128013000_customer_invoice_send_way and
 * 20261128013100_validate_customers_invoice_send_way.
 *
 * customers.invoice_send_way (Skickas som) is a nullable column on the
 * customer card: NULL for every customer that existed before it (the
 * company's send order decides), otherwise one of the ways of
 * company_settings.invoice_send_order. customers_invoice_send_way_check
 * refuses anything else for every writer, and is validated after a full
 * replay. Written by a member of the company under RLS like the rest of the
 * card.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

const CONSTRAINT = 'customers_invoice_send_way_check'
const REFUSED = new RegExp(CONSTRAINT)

async function insertCustomer(companyId: string, userId: string, way?: string | null): Promise<string> {
  const id = randomUUID()
  if (way === undefined) {
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
       VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
      [id, userId, companyId],
    )
  } else {
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name, customer_type, invoice_send_way)
       VALUES ($1, $2, $3, 'Kund AB', 'swedish_business', $4)`,
      [id, userId, companyId, way],
    )
  }
  return id
}

async function sendWayOf(customerId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ invoice_send_way: string | null }>(
    `SELECT invoice_send_way FROM public.customers WHERE id = $1`,
    [customerId],
  )
  return rows[0]!.invoice_send_way
}

describe('customers.invoice_send_way', () => {
  it('is validated after a full replay', async () => {
    const { rows } = await getPool().query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint
       WHERE conname = $1 AND conrelid = 'public.customers'::regclass`,
      [CONSTRAINT],
    )
    expect(rows).toEqual([{ convalidated: true }])
  })

  it('is null on a customer written without one', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    expect(await sendWayOf(customerId)).toBeNull()
  })

  it('takes each way of the company send order, and null', async () => {
    const { userId, companyId } = await seedCompany()
    for (const way of ['peppol', 'kivra', 'billo', 'email', null]) {
      const customerId = await insertCustomer(companyId, userId, way)
      expect(await sendWayOf(customerId)).toBe(way)
    }
  })

  it('refuses anything else, on insert and on update', async () => {
    const { userId, companyId } = await seedCompany()
    for (const way of ['manual', 'post', 'Peppol', '']) {
      await expect(insertCustomer(companyId, userId, way)).rejects.toThrow(REFUSED)
    }
    const customerId = await insertCustomer(companyId, userId, 'email')
    await expect(
      getPool().query(`UPDATE public.customers SET invoice_send_way = 'fax' WHERE id = $1`, [customerId]),
    ).rejects.toThrow(REFUSED)
    expect(await sendWayOf(customerId)).toBe('email')
  })

  it('is written by a member of the company under RLS, and not by anyone else', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    const stranger = await seedCompany()

    const own = await withUserContext(userId, (client) =>
      client.query(
        `UPDATE public.customers SET invoice_send_way = 'peppol' WHERE id = $1 RETURNING invoice_send_way`,
        [customerId],
      ),
    )
    expect(own.rows).toEqual([{ invoice_send_way: 'peppol' }])

    const foreign = await withUserContext(stranger.userId, (client) =>
      client.query(`UPDATE public.customers SET invoice_send_way = 'email' WHERE id = $1`, [customerId]),
    )
    expect(foreign.rowCount).toBe(0)
    // withUserContext rolls each transaction back: the member's write was
    // seen (RETURNING above), the stranger's touched no row, and the stored
    // value is still the default.
    expect(await sendWayOf(customerId)).toBeNull()
  })
})
