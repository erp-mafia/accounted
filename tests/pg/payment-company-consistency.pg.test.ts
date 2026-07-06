/**
 * pg-real test for the payment company-consistency triggers
 * (20260619130000_payment_company_consistency.sql).
 *
 * invoice_payments and supplier_invoice_payments are the only two child tables
 * carrying BOTH a parent FK and their own company_id. A row whose company_id
 * disagrees with its parent's company_id is a tenant-isolation defect. The
 * BEFORE INSERT/UPDATE triggers make a mismatched pair impossible to persist
 * regardless of how it is written: so these probes go through the superuser
 * pool (which bypasses RLS), proving the trigger fires even for the most
 * privileged writer.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

let arrivalSeq = 0

async function seedCustomerInvoice(params: {
  userId: string
  companyId: string
  total?: number
}): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Test Kund AB', 'swedish_business')`,
    [customerId, params.userId, params.companyId],
  )
  const id = randomUUID()
  const total = params.total ?? 1000
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
        paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-04-01', '2026-05-01', 'SEK',
             $6, 0, $6, 'standard_25', 25, 'sent', 0, $6)`,
    [id, params.userId, params.companyId, customerId, `F-${id.slice(0, 8)}`, total],
  )
  return id
}

async function seedSupplierInvoice(params: {
  userId: string
  companyId: string
  total?: number
}): Promise<string> {
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Leverantör AB', 'swedish_business', 'SE', 30, 'SEK')`,
    [supplierId, params.userId, params.companyId],
  )
  const id = randomUUID()
  const total = params.total ?? 1000
  const arrivalNumber = (Date.now() % 1_000_000) * 1000 + arrivalSeq++
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-04-01', '2026-05-01', '2026-04-01', 'approved', 'SEK',
             $7, 0, $7, 0, $7, 'standard_25', false, false)`,
    [id, params.userId, params.companyId, supplierId, arrivalNumber, `LF-${arrivalNumber}`, total],
  )
  return id
}

const INSERT_INVOICE_PAYMENT = `
  INSERT INTO public.invoice_payments
    (user_id, company_id, invoice_id, payment_date, amount, currency)
  VALUES ($1, $2, $3, '2026-05-05', 100, 'SEK')
  RETURNING id`

const INSERT_SUPPLIER_PAYMENT = `
  INSERT INTO public.supplier_invoice_payments
    (user_id, company_id, supplier_invoice_id, payment_date, amount, currency)
  VALUES ($1, $2, $3, '2026-05-05', 100, 'SEK')
  RETURNING id`

describe('invoice_payments: company-consistency trigger', () => {
  it('accepts a payment whose company_id matches its invoice', async () => {
    const a = await seedCompany()
    const invoiceId = await seedCustomerInvoice({ userId: a.userId, companyId: a.companyId })

    const res = await getPool().query(INSERT_INVOICE_PAYMENT, [a.userId, a.companyId, invoiceId])
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0].id).toBeTruthy()
  })

  it('rejects a payment whose company_id is a different tenant than its invoice', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const invoiceId = await seedCustomerInvoice({ userId: a.userId, companyId: a.companyId })

    // company_id = B but the invoice belongs to A → trigger must raise.
    await expect(
      getPool().query(INSERT_INVOICE_PAYMENT, [b.userId, b.companyId, invoiceId]),
    ).rejects.toThrow(/does not match invoices\.company_id/i)

    // Nothing persisted.
    const rows = await getPool().query(
      `SELECT id FROM public.invoice_payments WHERE invoice_id = $1`,
      [invoiceId],
    )
    expect(rows.rows).toHaveLength(0)
  })

  it('rejects an UPDATE that points company_id at a foreign tenant', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const invoiceId = await seedCustomerInvoice({ userId: a.userId, companyId: a.companyId })
    const ins = await getPool().query(INSERT_INVOICE_PAYMENT, [a.userId, a.companyId, invoiceId])
    const paymentId = ins.rows[0].id as string

    await expect(
      getPool().query(`UPDATE public.invoice_payments SET company_id = $1 WHERE id = $2`, [
        b.companyId,
        paymentId,
      ]),
    ).rejects.toThrow(/does not match invoices\.company_id/i)
  })

  it('rejects rerouting invoice_id to a foreign tenant invoice (UPDATE OF invoice_id path)', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const invoiceA = await seedCustomerInvoice({ userId: a.userId, companyId: a.companyId })
    const invoiceB = await seedCustomerInvoice({ userId: b.userId, companyId: b.companyId })
    const ins = await getPool().query(INSERT_INVOICE_PAYMENT, [a.userId, a.companyId, invoiceA])
    const paymentId = ins.rows[0].id as string

    // company_id stays A; only the parent FK is rerouted to B's invoice:
    // exercises the UPDATE OF invoice_id leg of the trigger column filter.
    await expect(
      getPool().query(`UPDATE public.invoice_payments SET invoice_id = $1 WHERE id = $2`, [
        invoiceB,
        paymentId,
      ]),
    ).rejects.toThrow(/does not match invoices\.company_id/i)
  })
})

describe('supplier_invoice_payments: company-consistency trigger', () => {
  it('accepts a payment whose company_id matches its supplier invoice', async () => {
    const a = await seedCompany()
    const supplierInvoiceId = await seedSupplierInvoice({ userId: a.userId, companyId: a.companyId })

    const res = await getPool().query(INSERT_SUPPLIER_PAYMENT, [a.userId, a.companyId, supplierInvoiceId])
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0].id).toBeTruthy()
  })

  it('rejects a payment whose company_id is a different tenant than its supplier invoice', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const supplierInvoiceId = await seedSupplierInvoice({ userId: a.userId, companyId: a.companyId })

    await expect(
      getPool().query(INSERT_SUPPLIER_PAYMENT, [b.userId, b.companyId, supplierInvoiceId]),
    ).rejects.toThrow(/does not match supplier_invoices\.company_id/i)

    const rows = await getPool().query(
      `SELECT id FROM public.supplier_invoice_payments WHERE supplier_invoice_id = $1`,
      [supplierInvoiceId],
    )
    expect(rows.rows).toHaveLength(0)
  })

  it('rejects an UPDATE that points company_id at a foreign tenant', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const supplierInvoiceId = await seedSupplierInvoice({ userId: a.userId, companyId: a.companyId })
    const ins = await getPool().query(INSERT_SUPPLIER_PAYMENT, [a.userId, a.companyId, supplierInvoiceId])
    const paymentId = ins.rows[0].id as string

    await expect(
      getPool().query(`UPDATE public.supplier_invoice_payments SET company_id = $1 WHERE id = $2`, [
        b.companyId,
        paymentId,
      ]),
    ).rejects.toThrow(/does not match supplier_invoices\.company_id/i)
  })

  it('rejects rerouting supplier_invoice_id to a foreign tenant invoice (UPDATE OF supplier_invoice_id path)', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const siA = await seedSupplierInvoice({ userId: a.userId, companyId: a.companyId })
    const siB = await seedSupplierInvoice({ userId: b.userId, companyId: b.companyId })
    const ins = await getPool().query(INSERT_SUPPLIER_PAYMENT, [a.userId, a.companyId, siA])
    const paymentId = ins.rows[0].id as string

    await expect(
      getPool().query(
        `UPDATE public.supplier_invoice_payments SET supplier_invoice_id = $1 WHERE id = $2`,
        [siB, paymentId],
      ),
    ).rejects.toThrow(/does not match supplier_invoices\.company_id/i)
  })
})
