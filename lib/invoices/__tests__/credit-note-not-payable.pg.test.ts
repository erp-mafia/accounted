import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'

async function seedCustomerInvoicePair(): Promise<{
  originalInvoiceId: string
  creditNoteId: string
}> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId })

  const customerId = randomUUID()
  const originalInvoiceId = randomUUID()
  const creditNoteId = randomUUID()

  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Test Kund AB', 'swedish_business')`,
    [customerId, userId, companyId],
  )
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
        paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-07-01', '2026-07-31', 'SEK',
             1000, 0, 1000, 'standard_25', 25, 'sent', 0, 1000)`,
    [originalInvoiceId, userId, companyId, customerId, `F-${originalInvoiceId.slice(0, 8)}`],
  )
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
        paid_amount, remaining_amount, credited_invoice_id)
     VALUES ($1, $2, $3, $4, $5, '2026-07-01', '2026-07-31', 'SEK',
             -1000, 0, -1000, 'standard_25', 25, 'sent', 0, -1000, $6)`,
    [creditNoteId, userId, companyId, customerId, `KR-${creditNoteId.slice(0, 8)}`, originalInvoiceId],
  )

  return { originalInvoiceId, creditNoteId }
}

describe('invoices_credit_note_not_paid constraint', () => {
  it.each(['paid', 'partially_paid'])('rejects credit-note status %s', async (status) => {
    const { creditNoteId } = await seedCustomerInvoicePair()

    await expect(
      getPool().query(`UPDATE public.invoices SET status = $1 WHERE id = $2`, [status, creditNoteId]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('allows an ordinary customer invoice to be marked paid', async () => {
    const { originalInvoiceId } = await seedCustomerInvoicePair()

    await expect(
      getPool().query(`UPDATE public.invoices SET status = 'paid' WHERE id = $1`, [originalInvoiceId]),
    ).resolves.toMatchObject({ rowCount: 1 })
  })
})
