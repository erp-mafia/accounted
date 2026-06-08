import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

/**
 * Constraints added by 20260613100000_self_billing_received_invoices.sql:
 *   - invoices_self_billed_numbering: a self-billed row carries the
 *     counterparty's number in external_invoice_number and never an own one.
 *   - invoices_sent_requires_number: loosened so a self-billed row may be 'sent'
 *     with a NULL own invoice_number (its löpnummer is the external number).
 */
describe('self-billing invoice constraints', () => {
  async function insertSelfBilled(params: {
    userId: string
    companyId: string
    status?: string
    invoiceNumber?: string | null
    externalNumber?: string | null
    isSelfBilled?: boolean
  }): Promise<string> {
    const id = randomUUID()
    const customerId = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name)
       VALUES ($1, $2, $3, 'Stora Bolaget AB')`,
      [customerId, params.userId, params.companyId],
    )
    await getPool().query(
      `INSERT INTO public.invoices
         (id, user_id, company_id, customer_id, invoice_number,
          is_self_billed, external_invoice_number, received_date,
          invoice_date, due_date, currency, subtotal, vat_amount, total,
          vat_treatment, vat_rate, moms_ruta, status)
       VALUES ($1, $2, $3, $4, $5,
               $6, $7, '2026-06-02',
               '2026-06-01', '2026-06-30', 'SEK', 10000, 2500, 12500,
               'standard_25', 25, '05', $8)`,
      [
        id,
        params.userId,
        params.companyId,
        customerId,
        params.invoiceNumber ?? null,
        params.isSelfBilled ?? true,
        params.externalNumber ?? null,
        params.status ?? 'sent',
      ],
    )
    return id
  }

  it('accepts a self-billed sale: external number set, own number null, status sent', async () => {
    const { userId, companyId } = await seedCompany()

    const id = await insertSelfBilled({
      userId,
      companyId,
      externalNumber: 'KUND-55012',
      invoiceNumber: null,
      status: 'sent',
    })

    const { rows } = await getPool().query<{ is_self_billed: boolean; external_invoice_number: string }>(
      'SELECT is_self_billed, external_invoice_number FROM public.invoices WHERE id = $1',
      [id],
    )
    expect(rows[0]!.is_self_billed).toBe(true)
    expect(rows[0]!.external_invoice_number).toBe('KUND-55012')
  })

  it('rejects a self-billed row that also carries an own invoice_number', async () => {
    const { userId, companyId } = await seedCompany()

    await expect(
      insertSelfBilled({ userId, companyId, externalNumber: 'KUND-55012', invoiceNumber: 'F-2026001' }),
    ).rejects.toThrow(/invoices_self_billed_numbering/i)
  })

  it('rejects a self-billed row with no external_invoice_number', async () => {
    const { userId, companyId } = await seedCompany()

    await expect(
      insertSelfBilled({ userId, companyId, externalNumber: null, invoiceNumber: null }),
    ).rejects.toThrow(/invoices_self_billed_numbering/i)
  })

  it('still rejects a NON-self-billed sent invoice with a NULL number', async () => {
    const { userId, companyId } = await seedCompany()

    await expect(
      insertSelfBilled({
        userId,
        companyId,
        isSelfBilled: false,
        externalNumber: null,
        invoiceNumber: null,
        status: 'sent',
      }),
    ).rejects.toThrow(/invoices_sent_requires_number/i)
  })
})
