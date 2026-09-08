import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { insertCompany, insertCompanyMember, seedCompany } from './fixtures'

// pg-real coverage for migrations 20260908152555 and 20260908155231 (issue
// #2224, offert -> kundorder): one live kundorder per source document, a
// quote with a live converted invoice cannot get a live order, a quote with
// a live order cannot get a live converted invoice, the quote decision is
// locked while an order lives, the guards run as definer so a non-active
// company is still guarded, and the two conversions serialize on the quote
// row so a concurrent pair cannot both land.

async function insertCustomer(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Testbrand AB', 'swedish_business')`,
    [id, userId, companyId],
  )
  return id
}

async function insertSource(
  companyId: string,
  userId: string,
  customerId: string,
  documentType: 'quote' | 'proforma',
): Promise<string> {
  const id = randomUUID()
  const isQuote = documentType === 'quote'
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, document_type,
        invoice_date, due_date, valid_until, quote_status, currency,
        subtotal, vat_amount, total, vat_treatment, vat_rate, moms_ruta, status)
     VALUES ($1, $2, $3, $4, $5, $6,
             '2026-06-01', '2026-07-01', $7, $8, 'SEK',
             1000, 250, 1250, 'standard_25', 25, '10', 'sent')`,
    [
      id,
      userId,
      companyId,
      customerId,
      isQuote ? 'OF-001' : 'P-001',
      documentType,
      isQuote ? '2026-07-01' : null,
      isQuote ? 'accepted' : null,
    ],
  )
  return id
}

function orderInsertSql(): string {
  return `INSERT INTO public.sales_orders (id, company_id, user_id, customer_id, status, order_date, source_invoice_id)
          VALUES ($1, $2, $3, $4, $5, '2026-09-01', $6)`
}

async function insertOrder(
  companyId: string,
  userId: string,
  customerId: string,
  sourceInvoiceId: string,
  status: 'draft' | 'cancelled' = 'draft',
): Promise<string> {
  const id = randomUUID()
  await getPool().query(orderInsertSql(), [id, companyId, userId, customerId, status, sourceInvoiceId])
  return id
}

function convertedInvoiceSql(): string {
  return `INSERT INTO public.invoices
            (id, user_id, company_id, customer_id, invoice_number, document_type,
             invoice_date, due_date, currency, subtotal, vat_amount, total,
             vat_treatment, vat_rate, moms_ruta, status, converted_from_id)
          VALUES ($1, $2, $3, $4, NULL, 'invoice',
                  '2026-09-01', '2026-10-01', 'SEK', 1000, 250, 1250,
                  'standard_25', 25, '10', $5, $6)`
}

async function insertConvertedInvoice(
  companyId: string,
  userId: string,
  customerId: string,
  convertedFromId: string,
  status: 'draft' | 'cancelled' = 'draft',
): Promise<string> {
  const id = randomUUID()
  await getPool().query(convertedInvoiceSql(), [id, userId, companyId, customerId, status, convertedFromId])
  return id
}

describe('quote source conversion guards (20260908152555)', () => {
  it('allows one live kundorder per source and refuses a second one until the first is cancelled', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    const quoteId = await insertSource(companyId, userId, customerId, 'quote')

    const first = await insertOrder(companyId, userId, customerId, quoteId)
    await expect(insertOrder(companyId, userId, customerId, quoteId)).rejects.toThrow(
      /uq_sales_orders_one_live_per_source/,
    )
    // A cancelled second order is not live and may point at the same source.
    await insertOrder(companyId, userId, customerId, quoteId, 'cancelled')

    await getPool().query(`UPDATE public.sales_orders SET status = 'cancelled' WHERE id = $1`, [first])
    await expect(insertOrder(companyId, userId, customerId, quoteId)).resolves.toBeTruthy()
  })

  it('refuses a live converted invoice while a live kundorder points at the quote, and frees it on cancel', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    const quoteId = await insertSource(companyId, userId, customerId, 'quote')
    const orderId = await insertOrder(companyId, userId, customerId, quoteId)

    await expect(insertConvertedInvoice(companyId, userId, customerId, quoteId)).rejects.toThrow(
      /INVOICE_QUOTE_ALREADY_ORDERED/,
    )
    // A cancelled converted invoice is not live and is allowed.
    await insertConvertedInvoice(companyId, userId, customerId, quoteId, 'cancelled')

    await getPool().query(`UPDATE public.sales_orders SET status = 'cancelled' WHERE id = $1`, [orderId])
    await expect(insertConvertedInvoice(companyId, userId, customerId, quoteId)).resolves.toBeTruthy()
  })

  it('refuses a live kundorder (insert or reopen) while a live invoice was converted from the quote', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    const quoteId = await insertSource(companyId, userId, customerId, 'quote')
    const cancelledOrder = await insertOrder(companyId, userId, customerId, quoteId, 'cancelled')
    const invoiceId = await insertConvertedInvoice(companyId, userId, customerId, quoteId)

    await expect(insertOrder(companyId, userId, customerId, quoteId)).rejects.toThrow(
      /INVOICE_QUOTE_ALREADY_INVOICED/,
    )
    await expect(
      getPool().query(`UPDATE public.sales_orders SET status = 'draft' WHERE id = $1`, [cancelledOrder]),
    ).rejects.toThrow(/INVOICE_QUOTE_ALREADY_INVOICED/)

    await getPool().query(`UPDATE public.invoices SET status = 'cancelled' WHERE id = $1`, [invoiceId])
    await expect(
      getPool().query(`UPDATE public.sales_orders SET status = 'draft' WHERE id = $1`, [cancelledOrder]),
    ).resolves.toBeTruthy()
  })

  it('leaves status changes that do not make a row live alone (confirm, complete, cancel)', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    const quoteId = await insertSource(companyId, userId, customerId, 'quote')
    const orderId = await insertOrder(companyId, userId, customerId, quoteId)
    // A converted invoice that slipped in before the order (cancelled now) must
    // not block the order's own lifecycle.
    await insertConvertedInvoice(companyId, userId, customerId, quoteId, 'cancelled')

    await getPool().query(`UPDATE public.sales_orders SET status = 'confirmed' WHERE id = $1`, [orderId])
    await getPool().query(`UPDATE public.sales_orders SET status = 'cancelled' WHERE id = $1`, [orderId])
    const { rows } = await getPool().query<{ status: string }>(
      'SELECT status FROM public.sales_orders WHERE id = $1',
      [orderId],
    )
    expect(rows[0].status).toBe('cancelled')
  })

  it('does not gate proforma sources: the proforma path serializes on cancelling the proforma', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    const proformaId = await insertSource(companyId, userId, customerId, 'proforma')

    await insertConvertedInvoice(companyId, userId, customerId, proformaId)
    await expect(insertOrder(companyId, userId, customerId, proformaId)).resolves.toBeTruthy()
  })

  it('runs under a member session: the quote row lock passes RLS and the guard raises its own code', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    const quoteId = await insertSource(companyId, userId, customerId, 'quote')

    // No live invoice: a member may create the order from the quote.
    await withUserContext(userId, async (client) => {
      await client.query(orderInsertSql(), [randomUUID(), companyId, userId, customerId, 'draft', quoteId])
    })

    // Live invoice: the refusal is the registry code, not a permission error
    // from the FOR UPDATE lock on the quote row.
    await insertConvertedInvoice(companyId, userId, customerId, quoteId)
    await withUserContext(userId, async (client) => {
      await expect(
        client.query(orderInsertSql(), [randomUUID(), companyId, userId, customerId, 'draft', quoteId]),
      ).rejects.toThrow(/INVOICE_QUOTE_ALREADY_INVOICED/)
    })
  })

  it('locks the quote decision in accepted while a live kundorder exists (20260908155231)', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    const quoteId = await insertSource(companyId, userId, customerId, 'quote')
    const orderId = await insertOrder(companyId, userId, customerId, quoteId)

    await expect(
      getPool().query(`UPDATE public.invoices SET quote_status = 'declined' WHERE id = $1`, [quoteId]),
    ).rejects.toThrow(/INVOICE_QUOTE_ALREADY_ORDERED/)
    await expect(
      getPool().query(`UPDATE public.invoices SET quote_status = 'open' WHERE id = $1`, [quoteId]),
    ).rejects.toThrow(/INVOICE_QUOTE_ALREADY_ORDERED/)
    // Re-affirming accepted (what the conversions write) is not a decision change.
    await getPool().query(`UPDATE public.invoices SET quote_status = 'accepted' WHERE id = $1`, [quoteId])

    await getPool().query(`UPDATE public.sales_orders SET status = 'cancelled' WHERE id = $1`, [orderId])
    await getPool().query(`UPDATE public.invoices SET quote_status = 'declined' WHERE id = $1`, [quoteId])
    const { rows } = await getPool().query<{ quote_status: string }>(
      'SELECT quote_status FROM public.invoices WHERE id = $1',
      [quoteId],
    )
    expect(rows[0].quote_status).toBe('declined')
  })

  it('still guards a non-active company: the row lock runs as definer, not under the caller RLS (20260908155231)', async () => {
    // One user, two companies, active company = A. The sales_orders insert
    // policy admits every membership, but invoices_update (and so a FOR
    // UPDATE under RLS) admits only the active company; without SECURITY
    // DEFINER the guard saw no row for B and let the write through.
    const { userId, companyId: companyA } = await seedCompany()
    const companyB = await insertCompany({ createdBy: userId, name: 'Other AB' })
    await insertCompanyMember({ companyId: companyB, userId, role: 'owner' })
    await getPool().query(
      `INSERT INTO public.user_preferences (user_id, active_company_id) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
      [userId, companyA],
    )
    const customerB = await insertCustomer(companyB, userId)
    const quoteB = await insertSource(companyB, userId, customerB, 'quote')
    await insertConvertedInvoice(companyB, userId, customerB, quoteB)

    await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ active: string }>('SELECT public.current_active_company_id()::text AS active')
      expect(rows[0].active).toBe(companyA)
      await expect(
        client.query(orderInsertSql(), [randomUUID(), companyB, userId, customerB, 'draft', quoteB]),
      ).rejects.toThrow(/INVOICE_QUOTE_ALREADY_INVOICED/)
    })
  })

  it('refuses a source document from another company instead of inspecting it as definer (20260908155231)', async () => {
    const { userId, companyId: companyA } = await seedCompany()
    const { userId: otherUser, companyId: companyB } = await seedCompany()
    const customerA = await insertCustomer(companyA, userId)
    const customerB = await insertCustomer(companyB, otherUser)
    const quoteB = await insertSource(companyB, otherUser, customerB, 'quote')

    await expect(insertOrder(companyA, userId, customerA, quoteB)).rejects.toThrow(
      /SALES_ORDER_SOURCE_COMPANY_MISMATCH/,
    )
    await expect(insertConvertedInvoice(companyA, userId, customerA, quoteB)).rejects.toThrow(
      /INVOICE_CONVERT_SOURCE_COMPANY_MISMATCH/,
    )
    // A cancelled row points nowhere live and is not inspected either way.
    await expect(insertOrder(companyA, userId, customerA, quoteB, 'cancelled')).resolves.toBeTruthy()
  })

  it('serializes a concurrent order + invoice conversion on the quote row so only the first lands', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    const quoteId = await insertSource(companyId, userId, customerId, 'quote')

    const a = await getClient()
    const b = await getClient()
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')
      // A: the order insert takes the quote row lock and sees no invoice.
      await a.query(orderInsertSql(), [randomUUID(), companyId, userId, customerId, 'draft', quoteId])
      // B: the invoice insert queues behind A's lock instead of passing its
      // own (stale) check.
      const bInsert = b.query(convertedInvoiceSql(), [randomUUID(), userId, companyId, customerId, 'draft', quoteId])
      const settledEarly = await Promise.race([
        bInsert.then(() => 'settled', () => 'settled'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 300)),
      ])
      expect(settledEarly).toBe('blocked')

      await a.query('COMMIT')
      await expect(bInsert).rejects.toThrow(/INVOICE_QUOTE_ALREADY_ORDERED/)
      await b.query('ROLLBACK')
    } finally {
      a.release()
      b.release()
    }

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.sales_orders WHERE source_invoice_id = $1 AND status <> 'cancelled'`,
      [quoteId],
    )
    expect(rows[0].n).toBe('1')
  })
})
