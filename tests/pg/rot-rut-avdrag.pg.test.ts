/**
 * pg-real tests for the ROT/RUT-avdrag schema introduced in
 * 20260526121700_rot_rut_avdrag.sql.
 *
 * Verifies:
 *   - The new columns exist on invoice_items and invoices.
 *   - CHECK constraints behave (deduction_type only 'rot'|'rut'|null,
 *     deduction_amount >= 0, deduction_total >= 0).
 *   - Indexes were created.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { insertAuthUser, insertCompany } from './fixtures'

describe('ROT/RUT-avdrag schema', () => {
  it('invoice_items has the new deduction columns', async () => {
    const result = await getPool().query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'invoice_items'
          AND column_name IN (
            'deduction_type', 'deduction_amount', 'labor_hours',
            'work_type', 'housing_designation', 'apartment_number'
          )`,
    )
    const found = new Set(result.rows.map((r) => r.column_name))
    expect(found.has('deduction_type')).toBe(true)
    expect(found.has('deduction_amount')).toBe(true)
    expect(found.has('labor_hours')).toBe(true)
    expect(found.has('work_type')).toBe(true)
    expect(found.has('housing_designation')).toBe(true)
    expect(found.has('apartment_number')).toBe(true)
  })

  it('invoices has the new deduction columns', async () => {
    const result = await getPool().query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'invoices'
          AND column_name IN (
            'deduction_total',
            'deduction_personnummer_encrypted',
            'deduction_personnummer_last4'
          )`,
    )
    const found = new Set(result.rows.map((r) => r.column_name))
    expect(found.has('deduction_total')).toBe(true)
    expect(found.has('deduction_personnummer_encrypted')).toBe(true)
    expect(found.has('deduction_personnummer_last4')).toBe(true)
  })

  it('deduction_type CHECK rejects values other than rot/rut/null', async () => {
    // Seed company + customer + draft invoice + insert an invoice item with
    // a bogus deduction_type. The CHECK should reject.
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const customerId = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
       VALUES ($1, $2, $3, 'Test Cust', 'individual')`,
      [customerId, userId, companyId],
    )
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices
        (id, user_id, company_id, customer_id, invoice_date, due_date,
         currency, vat_treatment, vat_rate)
       VALUES ($1, $2, $3, $4, '2026-05-01', '2026-05-31', 'SEK', 'standard_25', 25)`,
      [invoiceId, userId, companyId, customerId],
    )

    await expect(
      getPool().query(
        `INSERT INTO public.invoice_items
           (id, invoice_id, sort_order, description, quantity, unit, unit_price,
            line_total, vat_rate, vat_amount, deduction_type)
         VALUES ($1, $2, 0, 'X', 1, 'st', 100, 100, 25, 25, 'invalid')`,
        [randomUUID(), invoiceId],
      ),
    ).rejects.toThrow()
  })

  it('deduction_amount CHECK rejects negative values', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const customerId = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
       VALUES ($1, $2, $3, 'Test Cust', 'individual')`,
      [customerId, userId, companyId],
    )
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices
        (id, user_id, company_id, customer_id, invoice_date, due_date,
         currency, vat_treatment, vat_rate)
       VALUES ($1, $2, $3, $4, '2026-05-01', '2026-05-31', 'SEK', 'standard_25', 25)`,
      [invoiceId, userId, companyId, customerId],
    )

    await expect(
      getPool().query(
        `INSERT INTO public.invoice_items
           (id, invoice_id, sort_order, description, quantity, unit, unit_price,
            line_total, vat_rate, vat_amount, deduction_amount)
         VALUES ($1, $2, 0, 'X', 1, 'st', 100, 100, 25, 25, -100)`,
        [randomUUID(), invoiceId],
      ),
    ).rejects.toThrow()
  })

  it('valid ROT row inserts cleanly with full deduction shape', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const customerId = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
       VALUES ($1, $2, $3, 'Test Cust', 'individual')`,
      [customerId, userId, companyId],
    )
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices
        (id, user_id, company_id, customer_id, invoice_date, due_date,
         currency, vat_treatment, vat_rate,
         deduction_total, deduction_personnummer_last4)
       VALUES ($1, $2, $3, $4, '2026-05-01', '2026-05-31', 'SEK', 'standard_25', 25,
               3000, '1234')`,
      [invoiceId, userId, companyId, customerId],
    )

    const itemId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoice_items
         (id, invoice_id, sort_order, description, quantity, unit, unit_price,
          line_total, vat_rate, vat_amount,
          deduction_type, deduction_amount, labor_hours, work_type,
          housing_designation, apartment_number)
       VALUES ($1, $2, 0, 'Snickeri', 1, 'st', 10000, 10000, 25, 2500,
               'rot', 3000, 25, 'BYGG', 'Stockholm 1:23', '0301')`,
      [itemId, invoiceId],
    )

    const result = await getPool().query<{
      deduction_type: string
      deduction_amount: string
      work_type: string
      housing_designation: string
    }>(
      `SELECT deduction_type, deduction_amount, work_type, housing_designation
         FROM public.invoice_items WHERE id = $1`,
      [itemId],
    )
    expect(result.rows[0].deduction_type).toBe('rot')
    expect(Number(result.rows[0].deduction_amount)).toBe(3000)
    expect(result.rows[0].work_type).toBe('BYGG')
    expect(result.rows[0].housing_designation).toBe('Stockholm 1:23')
  })

  it('idx_invoice_items_deduction_type exists', async () => {
    const result = await getPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'invoice_items'
          AND indexname = 'idx_invoice_items_deduction_type'`,
    )
    expect(result.rows).toHaveLength(1)
  })

  it('idx_invoices_deduction_total exists', async () => {
    const result = await getPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'invoices'
          AND indexname = 'idx_invoices_deduction_total'`,
    )
    expect(result.rows).toHaveLength(1)
  })
})
