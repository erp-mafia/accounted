import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

/**
 * Migration 20260927223000 (#2906): the per-invoice VAT treatment columns.
 * The rules live in resolveInvoiceVatRules; the database only refuses values
 * no code path may write, so a hand-crafted row cannot claim a treatment the
 * booking does not know or a country that is not a code.
 */
describe('invoices.vat_treatment_override / delivery_country', () => {
  async function insertInvoice(params: {
    vatTreatmentOverride?: string | null
    deliveryCountry?: string | null
  }): Promise<string> {
    const { userId, companyId } = await seedCompany()
    const id = randomUUID()
    const customerId = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name)
       VALUES ($1, $2, $3, 'Test Customer')`,
      [customerId, userId, companyId],
    )
    await getPool().query(
      `INSERT INTO public.invoices
         (id, user_id, company_id, customer_id, invoice_number,
          invoice_date, due_date, currency, subtotal, vat_amount, total,
          vat_treatment, vat_rate, moms_ruta, status,
          vat_treatment_override, delivery_country)
       VALUES ($1, $2, $3, $4, NULL,
               '2026-09-27', '2026-10-27', 'SEK', 1000, 0, 1000,
               'export', 0, '36', 'draft', $5, $6)`,
      [id, userId, companyId, customerId, params.vatTreatmentOverride ?? null, params.deliveryCountry ?? null],
    )
    return id
  }

  it('defaults both to NULL, so an invoice written without them books as before', async () => {
    const id = await insertInvoice({})
    const { rows } = await getPool().query<{ vat_treatment_override: string | null; delivery_country: string | null }>(
      'SELECT vat_treatment_override, delivery_country FROM public.invoices WHERE id = $1',
      [id],
    )
    expect(rows[0]).toEqual({ vat_treatment_override: null, delivery_country: null })
  })

  it('accepts the three treatments and an ISO alpha-2 country', async () => {
    for (const treatment of ['standard', 'export', 'reverse_charge']) {
      await expect(insertInvoice({ vatTreatmentOverride: treatment, deliveryCountry: 'NO' })).resolves.toBeTruthy()
    }
  })

  it('refuses a treatment the booking does not know', async () => {
    await expect(insertInvoice({ vatTreatmentOverride: 'standard_25' })).rejects.toThrow(
      /invoices_vat_treatment_override_check/,
    )
    await expect(insertInvoice({ vatTreatmentOverride: 'reverse_charge_domestic' })).rejects.toThrow(
      /invoices_vat_treatment_override_check/,
    )
  })

  it('refuses a delivery country that is not an uppercase alpha-2 code', async () => {
    for (const country of ['no', 'Norway', 'NOR', '']) {
      await expect(insertInvoice({ vatTreatmentOverride: 'export', deliveryCountry: country })).rejects.toThrow(
        /invoices_delivery_country_check/,
      )
    }
  })
})
