import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getClient, getPool } from './setup'
import { seedCompany } from './fixtures'

// pg-real coverage for migration 20261015120000 (crm#1196): a quote can be
// invoiced in parts. invoices_converted_source_guard replaces the unique
// index idx_invoices_one_live_conversion: a quote may have several live
// converted invoices as long as together they bill at most its net
// (subtotal), a proforma keeps one live conversion, and concurrent
// conversions serialize on the source row.

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
  subtotal: number,
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
             $9, $9 * 0.25, $9 * 1.25, 'standard_25', 25, '10', 'sent')`,
    [
      id,
      userId,
      companyId,
      customerId,
      isQuote ? 'OF-012' : 'P-005',
      documentType,
      isQuote ? '2026-07-01' : null,
      isQuote ? 'accepted' : null,
      subtotal,
    ],
  )
  return id
}

function convertedInvoiceSql(): string {
  return `INSERT INTO public.invoices
            (id, user_id, company_id, customer_id, invoice_number, document_type,
             invoice_date, due_date, currency, subtotal, vat_amount, total,
             vat_treatment, vat_rate, moms_ruta, status, converted_from_id)
          VALUES ($1, $2, $3, $4, NULL, 'invoice',
                  '2026-09-01', '2026-10-01', 'SEK', $5, $5 * 0.25, $5 * 1.25,
                  'standard_25', 25, '10', 'draft', $6)`
}

async function insertConverted(
  companyId: string,
  userId: string,
  customerId: string,
  sourceId: string,
  subtotal: number,
): Promise<string> {
  const id = randomUUID()
  await getPool().query(convertedInvoiceSql(), [id, userId, companyId, customerId, subtotal, sourceId])
  return id
}

describe('quote partial invoicing guard (20261015120000)', () => {
  it('drops the one-live-conversion unique index and keeps the plain lookup index', async () => {
    const { rows } = await getPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'invoices' AND indexdef ILIKE '%converted_from_id%'`,
    )
    const names = rows.map((row) => row.indexname)
    expect(names).not.toContain('idx_invoices_one_live_conversion')
    expect(names).toContain('idx_invoices_converted_from_id')
  })

  it('lets a quote be invoiced in two halves, then refuses a third invoice until a half is cancelled', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    const quoteId = await insertSource(companyId, userId, customerId, 'quote', 25000)

    const first = await insertConverted(companyId, userId, customerId, quoteId, 12500)
    await insertConverted(companyId, userId, customerId, quoteId, 12500)
    await expect(insertConverted(companyId, userId, customerId, quoteId, 1)).rejects.toThrow(
      /INVOICE_QUOTE_ALREADY_INVOICED/,
    )

    // A cancelled part counts for nothing: its half can be invoiced again.
    await getPool().query(`UPDATE public.invoices SET status = 'cancelled' WHERE id = $1`, [first])
    await expect(insertConverted(companyId, userId, customerId, quoteId, 12500)).resolves.toBeTruthy()
  })

  it('refuses a part that would bill more than what remains, to the öre', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    const quoteId = await insertSource(companyId, userId, customerId, 'quote', 100.01)

    await insertConverted(companyId, userId, customerId, quoteId, 30)
    await insertConverted(companyId, userId, customerId, quoteId, 30)
    await expect(insertConverted(companyId, userId, customerId, quoteId, 40.02)).rejects.toThrow(
      /INVOICE_QUOTE_PART_OUT_OF_RANGE/,
    )
    await expect(insertConverted(companyId, userId, customerId, quoteId, 40.01)).resolves.toBeTruthy()

    const { rows } = await getPool().query<{ invoiced: string }>(
      `SELECT sum(subtotal)::text AS invoiced FROM public.invoices WHERE converted_from_id = $1 AND status <> 'cancelled'`,
      [quoteId],
    )
    expect(Number(rows[0].invoiced)).toBe(100.01)
  })

  it('checks a cancelled part that is reopened like a new one', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    const quoteId = await insertSource(companyId, userId, customerId, 'quote', 1000)

    const cancelled = await insertConverted(companyId, userId, customerId, quoteId, 600)
    await getPool().query(`UPDATE public.invoices SET status = 'cancelled' WHERE id = $1`, [cancelled])
    await insertConverted(companyId, userId, customerId, quoteId, 600)

    await expect(
      getPool().query(`UPDATE public.invoices SET status = 'draft' WHERE id = $1`, [cancelled]),
    ).rejects.toThrow(/INVOICE_QUOTE_PART_OUT_OF_RANGE/)
  })

  it('keeps a proforma at one live converted invoice', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    const proformaId = await insertSource(companyId, userId, customerId, 'proforma', 1000)

    const first = await insertConverted(companyId, userId, customerId, proformaId, 500)
    await expect(insertConverted(companyId, userId, customerId, proformaId, 500)).rejects.toThrow(
      /INVOICE_CONVERT_SOURCE_CHANGED/,
    )
    await getPool().query(`UPDATE public.invoices SET status = 'cancelled' WHERE id = $1`, [first])
    await expect(insertConverted(companyId, userId, customerId, proformaId, 1000)).resolves.toBeTruthy()
  })

  it('still locks the quote decision while a part lives, and still refuses a kundorder', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    const quoteId = await insertSource(companyId, userId, customerId, 'quote', 25000)
    await insertConverted(companyId, userId, customerId, quoteId, 12500)

    await expect(
      getPool().query(`UPDATE public.invoices SET quote_status = 'declined' WHERE id = $1`, [quoteId]),
    ).rejects.toThrow(/INVOICE_QUOTE_ALREADY_INVOICED/)
    await expect(
      getPool().query(
        `INSERT INTO public.sales_orders (id, company_id, user_id, customer_id, status, order_date, source_invoice_id)
         VALUES ($1, $2, $3, $4, 'draft', '2026-09-01', $5)`,
        [randomUUID(), companyId, userId, customerId, quoteId],
      ),
    ).rejects.toThrow(/INVOICE_QUOTE_ALREADY_INVOICED/)
  })

  it('serializes two concurrent conversions of the rest so only one lands', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await insertCustomer(companyId, userId)
    const quoteId = await insertSource(companyId, userId, customerId, 'quote', 25000)
    await insertConverted(companyId, userId, customerId, quoteId, 12500)

    const a = await getClient()
    const b = await getClient()
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')
      // A takes the quote row lock and bills the remaining half.
      await a.query(convertedInvoiceSql(), [randomUUID(), userId, companyId, customerId, 12500, quoteId])
      // B, which read the same "12 500 left", queues behind A's lock.
      const bInsert = b.query(convertedInvoiceSql(), [randomUUID(), userId, companyId, customerId, 12500, quoteId])
      const settledEarly = await Promise.race([
        bInsert.then(() => 'settled', () => 'settled'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 300)),
      ])
      expect(settledEarly).toBe('blocked')

      await a.query('COMMIT')
      await expect(bInsert).rejects.toThrow(/INVOICE_QUOTE_ALREADY_INVOICED/)
      await b.query('ROLLBACK')
    } finally {
      a.release()
      b.release()
    }

    const { rows } = await getPool().query<{ n: string; invoiced: string }>(
      `SELECT count(*)::text AS n, sum(subtotal)::text AS invoiced
       FROM public.invoices WHERE converted_from_id = $1 AND status <> 'cancelled'`,
      [quoteId],
    )
    expect(rows[0]).toEqual({ n: '2', invoiced: '25000' })
  })
})
