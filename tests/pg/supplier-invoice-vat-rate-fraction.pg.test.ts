import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getPool } from './setup'

async function seedSupplierInvoice(): Promise<{
  invoiceId: string
  userId: string
  companyId: string
}> {
  const { userId, companyId } = await seedCompany()
  const supplierId = randomUUID()
  const invoiceId = randomUUID()

  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name)
     VALUES ($1, $2, $3, 'Testleverantör AB')`,
    [supplierId, userId, companyId],
  )
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number,
        supplier_invoice_number, invoice_date, due_date,
        subtotal, vat_amount, total)
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int,
             $5, '2026-08-01', '2026-08-31', 1000, 250, 1250)`,
    [invoiceId, userId, companyId, supplierId, `VAT-${invoiceId.slice(0, 8)}`],
  )

  return { invoiceId, userId, companyId }
}

async function insertItem(invoiceId: string, vatRate: number): Promise<void> {
  await getPool().query(
    `INSERT INTO public.supplier_invoice_items
       (supplier_invoice_id, description, account_number, line_total,
        vat_rate, vat_amount)
     VALUES ($1, 'Kontorsmaterial', '5410', 1000, $2, 250)`,
    [invoiceId, vatRate],
  )
}

describe('supplier_invoice_items VAT-rate fraction constraint', () => {
  it('exists as NOT VALID so legacy rows do not block deployment', async () => {
    const result = await getPool().query<{ convalidated: boolean }>(
      `SELECT convalidated
         FROM pg_constraint
        WHERE conname = 'supplier_invoice_items_vat_rate_fraction'
          AND conrelid = 'public.supplier_invoice_items'::regclass`,
    )

    expect(result.rows).toEqual([{ convalidated: false }])
  })

  it('accepts a decimal-fraction VAT rate', async () => {
    const { invoiceId } = await seedSupplierInvoice()

    await expect(insertItem(invoiceId, 0.25)).resolves.toBeUndefined()
  })

  it('rejects a percent-shaped VAT rate on a new row', async () => {
    const { invoiceId } = await seedSupplierInvoice()

    await expect(insertItem(invoiceId, 25)).rejects.toMatchObject({ code: '23514' })
  })
})
