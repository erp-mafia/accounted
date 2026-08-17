/**
 * pg-real tests for 20260817191708_invoices_remaining_amount_guard.sql.
 *
 * remaining_amount is NOT NULL DEFAULT 0, and every payment surface reads it
 * as the customer's open balance. The BEFORE INSERT trigger derives it for a
 * fresh unpaid real invoice that arrives with NULL/0, so a writer that omits
 * the column can no longer make an unpaid invoice look settled.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { insertAuthUser, insertCompany } from './fixtures'

let userId: string
let companyId: string
let customerId: string

async function insertInvoice(cols: Record<string, unknown>): Promise<{ remaining_amount: number }> {
  const id = randomUUID()
  const base: Record<string, unknown> = {
    id,
    user_id: userId,
    company_id: companyId,
    customer_id: customerId,
    invoice_date: '2026-06-01',
    due_date: '2026-06-30',
    currency: 'SEK',
    vat_treatment: 'standard_25',
    vat_rate: 25,
    subtotal: 8000,
    vat_amount: 2000,
    total: 10000,
    // invoices_sent_requires_number: anything past draft carries a number.
    invoice_number: cols.status === 'draft' ? null : `T-${id.slice(0, 8)}`,
    ...cols,
  }
  const keys = Object.keys(base)
  await getPool().query(
    `INSERT INTO public.invoices (${keys.join(', ')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
    keys.map((k) => base[k]),
  )
  const { rows } = await getPool().query(
    `SELECT remaining_amount::float8 AS remaining_amount FROM public.invoices WHERE id = $1`,
    [id],
  )
  return rows[0]
}

beforeAll(async () => {
  userId = await insertAuthUser()
  companyId = await insertCompany({ createdBy: userId })
  customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Guard Cust', 'swedish_business')`,
    [customerId, userId, companyId],
  )
})

describe('invoices_derive_remaining_amount (BEFORE INSERT)', () => {
  it('trigger exists on invoices', async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'invoices' AND t.tgname = 'invoices_derive_remaining_amount' AND NOT t.tgisinternal`,
    )
    expect(rows).toHaveLength(1)
  })

  it('an unpaid invoice inserted without remaining_amount gets its total', async () => {
    const row = await insertInvoice({ status: 'sent' })
    expect(row.remaining_amount).toBe(10000)
  })

  it('an explicit remaining_amount is respected', async () => {
    const row = await insertInvoice({ status: 'sent', remaining_amount: 4321.5 })
    expect(row.remaining_amount).toBe(4321.5)
  })

  it('prior payments and the ROT/RUT share (1513) are excluded from what the customer owes', async () => {
    const row = await insertInvoice({ status: 'sent', paid_amount: 1000, deduction_total: 3000 })
    expect(row.remaining_amount).toBe(6000)
  })

  it('drafts derive too (buildInvoiceWriteData semantics), overdue as well', async () => {
    expect((await insertInvoice({ status: 'draft' })).remaining_amount).toBe(10000)
    expect((await insertInvoice({ status: 'overdue' })).remaining_amount).toBe(10000)
  })

  it('paid, cancelled and credited invoices keep 0', async () => {
    expect((await insertInvoice({ status: 'paid', paid_amount: 10000 })).remaining_amount).toBe(0)
    expect((await insertInvoice({ status: 'cancelled' })).remaining_amount).toBe(0)
  })

  it('credit notes and non-invoice documents keep 0', async () => {
    const originalId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_date, due_date, currency,
         vat_treatment, vat_rate, subtotal, vat_amount, total, status, invoice_number)
       VALUES ($1, $2, $3, $4, '2026-06-01', '2026-06-30', 'SEK', 'standard_25', 25, 8000, 2000, 10000, 'sent', $5)`,
      [originalId, userId, companyId, customerId, `T-${originalId.slice(0, 8)}`],
    )
    const credit = await insertInvoice({
      status: 'sent',
      credited_invoice_id: originalId,
      subtotal: -8000,
      vat_amount: -2000,
      total: -10000,
    })
    expect(credit.remaining_amount).toBe(0)
    expect((await insertInvoice({ status: 'sent', document_type: 'proforma' })).remaining_amount).toBe(0)
  })

  it('never goes negative when paid_amount exceeds total on insert', async () => {
    const row = await insertInvoice({ status: 'sent', paid_amount: 12000 })
    expect(row.remaining_amount).toBe(0)
  })
})
