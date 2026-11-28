import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

/**
 * Migration 20260927223000 (#2906): the per-invoice VAT treatment columns,
 * widened with reverse_charge_domestic by 20261005220322 (crm#1007).
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

  it('accepts reverse_charge_domestic, the construction services treatment (crm#1007)', async () => {
    await expect(insertInvoice({ vatTreatmentOverride: 'reverse_charge_domestic' })).resolves.toBeTruthy()
  })

  it('accepts outside_scope, a räntefaktura without Swedish VAT', async () => {
    await expect(insertInvoice({ vatTreatmentOverride: 'outside_scope' })).resolves.toBeTruthy()
  })

  it('refuses a treatment the booking does not know', async () => {
    await expect(insertInvoice({ vatTreatmentOverride: 'standard_25' })).rejects.toThrow(
      /invoices_vat_treatment_override_check/,
    )
    await expect(insertInvoice({ vatTreatmentOverride: 'domestic' })).rejects.toThrow(
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

/**
 * Migration 20261127160500: a räntefaktura and the invoices it charges. The
 * link is set once by the create service (a compare-and-set where it is
 * NULL); the database guarantees that deleting the draft räntefaktura frees
 * them, and that every other invoice reads as no räntefaktura.
 */
describe('invoices.late_interest_invoice_id / is_late_interest_invoice', () => {
  async function seedInvoices() {
    const { userId, companyId } = await seedCompany()
    const customerId = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Test Customer')`,
      [customerId, userId, companyId],
    )
    const insert = async (fields: { status: string; isLateInterest?: boolean }) => {
      const id = randomUUID()
      await getPool().query(
        `INSERT INTO public.invoices
           (id, user_id, company_id, customer_id, invoice_number,
            invoice_date, due_date, currency, subtotal, vat_amount, total,
            vat_treatment, vat_rate, moms_ruta, status, is_late_interest_invoice)
         VALUES ($1, $2, $3, $4, NULL,
                 '2026-11-27', '2026-12-27', 'SEK', 68.49, 0, 68.49,
                 'outside_scope', 0, NULL, $5, $6)`,
        [id, userId, companyId, customerId, fields.status, fields.isLateInterest ?? false],
      )
      return id
    }
    return { insert }
  }

  it('defaults to no räntefaktura and not being one', async () => {
    const { insert } = await seedInvoices()
    const id = await insert({ status: 'draft' })
    const { rows } = await getPool().query(
      'SELECT late_interest_invoice_id, is_late_interest_invoice FROM public.invoices WHERE id = $1',
      [id],
    )
    expect(rows[0]).toEqual({ late_interest_invoice_id: null, is_late_interest_invoice: false })
  })

  it('claims only where no räntefaktura holds the invoice, and deleting the draft frees it', async () => {
    const { insert } = await seedInvoices()
    const source = await insert({ status: 'draft' })
    const first = await insert({ status: 'draft', isLateInterest: true })
    const second = await insert({ status: 'draft', isLateInterest: true })
    const claim = (draft: string) =>
      getPool().query(
        'UPDATE public.invoices SET late_interest_invoice_id = $1 WHERE id = $2 AND late_interest_invoice_id IS NULL RETURNING id',
        [draft, source],
      )
    expect((await claim(first)).rowCount).toBe(1)
    // A second click finds it taken: it matches nothing and discards its draft.
    expect((await claim(second)).rowCount).toBe(0)

    await getPool().query('DELETE FROM public.invoices WHERE id = $1', [first])
    const { rows } = await getPool().query('SELECT late_interest_invoice_id FROM public.invoices WHERE id = $1', [source])
    expect(rows[0].late_interest_invoice_id).toBeNull()
    expect((await claim(second)).rowCount).toBe(1)
  })

  it('refuses a link to an invoice that does not exist', async () => {
    const { insert } = await seedInvoices()
    const source = await insert({ status: 'draft' })
    await expect(
      getPool().query('UPDATE public.invoices SET late_interest_invoice_id = $1 WHERE id = $2', [randomUUID(), source]),
    ).rejects.toThrow(/late_interest_invoice_id/)
  })
})
