/**
 * Märkning through a kundorder, over a real PostgREST: the Märkning an
 * offert carries reaches the order it becomes and the invoice that order
 * produces, and an order without one leaves the invoice to the customer
 * card's. The services are the ones the app and the agent's commit run;
 * every value is read back from the database, so a column PostgREST does not
 * know, or a key a service drops on the way, fails here where a mocked
 * client answers cheerfully.
 */
import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { convertToSalesOrder } from '@/lib/sales-orders/convert-to-sales-order'
import { createInvoiceFromSalesOrder } from '@/lib/sales-orders/create-invoice-from-order'
import { transitionSalesOrder } from '@/lib/sales-orders/transitions'
import { createSalesOrder } from '@/lib/sales-orders/write'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { createToolPgClient } from './client'

const CARD_MARKING = 'KST-9'

describe('Märkning from offert through kundorder to faktura', () => {
  const supabase = createToolPgClient()
  let companyId: string
  let userId: string

  beforeAll(async () => {
    const seed = await seedCompany()
    companyId = seed.companyId
    userId = seed.userId
  })

  async function insertCustomer(cardMarking: string | null): Promise<string> {
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name, customer_type, invoice_marking)
       VALUES ($1, $2, $3, 'Kund AB', 'swedish_business', $4)`,
      [id, userId, companyId, cardMarking],
    )
    return id
  }

  async function insertQuote(customerId: string, marking: string | null): Promise<string> {
    const id = randomUUID()
    const pool = getPool()
    await pool.query(
      `INSERT INTO public.invoices
         (id, user_id, company_id, customer_id, invoice_number, document_type, invoice_date, due_date,
          valid_until, quote_status, currency, subtotal, vat_amount, total, vat_treatment, vat_rate,
          moms_ruta, status, invoice_marking)
       VALUES ($1, $2, $3, $4, $5, 'quote', '2026-09-01', '2026-09-30', '2026-09-30', 'open', 'SEK',
               1000, 250, 1250, 'standard_25', 25, '10', 'sent', $6)`,
      [id, userId, companyId, customerId, `OF-${id.slice(0, 8)}`, marking],
    )
    await pool.query(
      `INSERT INTO public.invoice_items
         (id, invoice_id, sort_order, description, quantity, unit, unit_price, line_total, vat_rate, vat_amount)
       VALUES ($1, $2, 0, 'Konsulttimmar', 10, 'tim', 100, 1000, 25, 250)`,
      [randomUUID(), id],
    )
    return id
  }

  /** Confirms the order, invoices what remains and reads the invoice's Märkning from the database. */
  async function markingOfInvoiceFrom(orderId: string): Promise<string | null> {
    const confirmed = await transitionSalesOrder(supabase, { companyId, orderId, action: 'confirm' })
    if (!confirmed.ok) throw new Error(`confirm failed: ${JSON.stringify(confirmed)}`)
    const invoiced = await createInvoiceFromSalesOrder(supabase, { companyId, userId, orderId, input: {} })
    if (!invoiced.ok) throw new Error(`invoice failed: ${JSON.stringify(invoiced)}`)
    const { rows } = await getPool().query<{ invoice_marking: string | null; sales_order_id: string }>(
      'SELECT invoice_marking, sales_order_id FROM public.invoices WHERE id = $1',
      [invoiced.invoice.id],
    )
    expect(rows[0].sales_order_id).toBe(orderId)
    return rows[0].invoice_marking
  }

  async function storedOrderMarking(orderId: string): Promise<string | null> {
    const { rows } = await getPool().query<{ invoice_marking: string | null }>(
      'SELECT invoice_marking FROM public.sales_orders WHERE id = $1',
      [orderId],
    )
    return rows[0].invoice_marking
  }

  it("keeps the offert's Märkning on the order and on the invoice the order produces", async () => {
    const quoteId = await insertQuote(await insertCustomer(CARD_MARKING), 'PO-4711')

    const converted = await convertToSalesOrder(supabase, { companyId, userId, invoiceId: quoteId })
    if (!converted.ok) throw new Error(`convert failed: ${JSON.stringify(converted)}`)

    expect(await storedOrderMarking(converted.order.id)).toBe('PO-4711')
    expect(await markingOfInvoiceFrom(converted.order.id)).toBe('PO-4711')
  })

  it("gives the invoice the customer card's Märkning when the offert had none", async () => {
    const quoteId = await insertQuote(await insertCustomer(CARD_MARKING), null)

    const converted = await convertToSalesOrder(supabase, { companyId, userId, invoiceId: quoteId })
    if (!converted.ok) throw new Error(`convert failed: ${JSON.stringify(converted)}`)

    expect(await storedOrderMarking(converted.order.id)).toBeNull()
    expect(await markingOfInvoiceFrom(converted.order.id)).toBe(CARD_MARKING)
  })

  it("gives the invoice the Märkning stated on a new order over the card's", async () => {
    const customerId = await insertCustomer(CARD_MARKING)

    const created = await createSalesOrder(supabase, {
      companyId,
      userId,
      input: {
        customer_id: customerId,
        invoice_marking: 'PO-5000',
        items: [{ description: 'Konsulttimmar', quantity: 2, unit: 'tim', unit_price: 100, vat_rate: 25 }],
      },
    })
    if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created)}`)

    expect(created.order.invoice_marking).toBe('PO-5000')
    expect(await markingOfInvoiceFrom(created.order.id)).toBe('PO-5000')
  })
})
