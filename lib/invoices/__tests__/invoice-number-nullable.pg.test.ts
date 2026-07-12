import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

describe('invoices.invoice_number nullable + partial unique index', () => {
  async function insertInvoice(params: {
    userId: string
    companyId: string
    invoiceNumber: string | null
  }): Promise<string> {
    const id = randomUUID()
    const customerId = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name)
       VALUES ($1, $2, $3, 'Test Customer')`,
      [customerId, params.userId, params.companyId],
    )
    await getPool().query(
      `INSERT INTO public.invoices
         (id, user_id, company_id, customer_id, invoice_number,
          invoice_date, due_date, currency, subtotal, vat_amount, total,
          vat_treatment, vat_rate, moms_ruta, status)
       VALUES ($1, $2, $3, $4, $5,
               '2026-04-27', '2026-05-27', 'SEK', 1000, 250, 1250,
               'standard_25', 25, '10', 'draft')`,
      [id, params.userId, params.companyId, customerId, params.invoiceNumber],
    )
    return id
  }

  it('accepts NULL invoice_number for drafts (constraint dropped)', async () => {
    const { userId, companyId } = await seedCompany()

    const id = await insertInvoice({ userId, companyId, invoiceNumber: null })

    const { rows } = await getPool().query<{ invoice_number: string | null }>(
      'SELECT invoice_number FROM public.invoices WHERE id = $1',
      [id],
    )
    expect(rows[0]!.invoice_number).toBeNull()
  })

  it('allows multiple drafts with NULL invoice_number in the same company', async () => {
    const { userId, companyId } = await seedCompany()

    const a = await insertInvoice({ userId, companyId, invoiceNumber: null })
    const b = await insertInvoice({ userId, companyId, invoiceNumber: null })

    expect(a).not.toBe(b)
    const { rows } = await getPool().query(
      'SELECT count(*)::int FROM public.invoices WHERE company_id = $1 AND invoice_number IS NULL',
      [companyId],
    )
    expect(rows[0]!.count).toBe(2)
  })

  it('still rejects duplicate non-NULL numbers within a company', async () => {
    const { userId, companyId } = await seedCompany()

    await insertInvoice({ userId, companyId, invoiceNumber: 'F-2026001' })

    await expect(
      insertInvoice({ userId, companyId, invoiceNumber: 'F-2026001' }),
    ).rejects.toThrow(/idx_invoices_company_invoice_number|duplicate key/i)
  })

  it('lets two different companies use the same invoice number', async () => {
    const a = await seedCompany()
    const b = await seedCompany()

    await insertInvoice({ userId: a.userId, companyId: a.companyId, invoiceNumber: 'F-2026001' })
    await insertInvoice({ userId: b.userId, companyId: b.companyId, invoiceNumber: 'F-2026001' })

    // Scope the count to these two companies: earlier tests in the suite leave
    // 'F-2026001' rows behind in their own companies, and pg-real has no
    // per-test cleanup.
    const { rows } = await getPool().query(
      'SELECT count(*)::int FROM public.invoices WHERE invoice_number = $1 AND company_id = ANY($2::uuid[])',
      ['F-2026001', [a.companyId, b.companyId]],
    )
    expect(rows[0]!.count).toBe(2)
  })
})
