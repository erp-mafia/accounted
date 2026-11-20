/**
 * Migration 20261015203000_customer_invoice_reference (crm#1200).
 *
 * customers.invoice_reference (Fakturareferens) is a plain nullable column on
 * the customer card: NULL for every customer that existed before it, written
 * by a member of the company under RLS like the rest of the card, and never
 * read back by an issued invoice. The app copies it into
 * invoices.your_reference when a new invoice is written, so a later change to
 * the card leaves the invoice's Er referens as it was issued.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

async function insertCustomer(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [id, userId, companyId],
  )
  return id
}

describe('customers.invoice_reference', () => {
  it('is null on a customer written without one', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    const { rows } = await getPool().query<{ invoice_reference: string | null }>(
      `SELECT invoice_reference FROM public.customers WHERE id = $1`,
      [customerId],
    )
    expect(rows[0].invoice_reference).toBeNull()
  })

  it('is written by a member of the company under RLS, and not by anyone else', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    const stranger = await seedCompany()

    const own = await withUserContext(userId, (client) =>
      client.query(
        `UPDATE public.customers SET invoice_reference = 'KST 4410' WHERE id = $1 RETURNING invoice_reference`,
        [customerId],
      ),
    )
    expect(own.rows).toEqual([{ invoice_reference: 'KST 4410' }])

    const foreign = await withUserContext(stranger.userId, (client) =>
      client.query(`UPDATE public.customers SET invoice_reference = 'X' WHERE id = $1`, [customerId]),
    )
    expect(foreign.rowCount).toBe(0)
  })

  it('leaves an issued invoice\'s Er referens alone when the card changes', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    await getPool().query(`UPDATE public.customers SET invoice_reference = 'KST 4410' WHERE id = $1`, [customerId])
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
         status, currency, subtotal, vat_amount, total, paid_amount, remaining_amount, vat_treatment, your_reference)
       VALUES ($1, $2, $3, $4, $5, '2026-10-01', '2026-10-31', 'sent', 'SEK', 1000, 250, 1250, 0, 1250, 'standard', 'KST 4410')`,
      [invoiceId, userId, companyId, customerId, `F-${invoiceId.slice(0, 8)}`],
    )

    await getPool().query(`UPDATE public.customers SET invoice_reference = 'KST 5520' WHERE id = $1`, [customerId])

    const { rows } = await getPool().query<{ your_reference: string | null }>(
      `SELECT your_reference FROM public.invoices WHERE id = $1`,
      [invoiceId],
    )
    expect(rows[0].your_reference).toBe('KST 4410')
  })
})
