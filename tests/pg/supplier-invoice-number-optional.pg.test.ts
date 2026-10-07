import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getClient, getPool } from '@/tests/pg/setup'

/**
 * Covers 20261005225009_supplier_invoice_number_optional (crm#1039):
 *   - supplier_invoice_number takes NULL: a supplier invoice without the
 *     supplier's own number is stored instead of failing with 23502.
 *   - A missing number has one form only: '' and whitespace-only strings are
 *     refused by supplier_invoices_number_not_blank (23514), while a real
 *     number keeps its exact characters.
 *   - Uniqueness of real numbers is unchanged
 *     (idx_supplier_invoices_company_supplier_number): a live duplicate from
 *     the same supplier still collides, number-less invoices never do.
 *   - The provider import RPC stores a number-less supplier invoice (the
 *     crm#1039 records), and keeps naming a reused number
 *     MIGRATION_INVOICE_NUMBER_TAKEN.
 */

let nextArrival = 1

async function insertSupplier(userId: string, companyId: string, name: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.suppliers (user_id, company_id, name) VALUES ($1, $2, $3) RETURNING id`,
    [userId, companyId, name],
  )
  return rows[0]!.id
}

function insertInvoice(params: {
  userId: string
  companyId: string
  supplierId: string
  number: string | null
  status?: string
}) {
  return getPool().query<{ id: string; supplier_invoice_number: string | null }>(
    `INSERT INTO public.supplier_invoices
       (user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, status, total, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-09-01', '2026-09-30', $6, 1250, 1250)
     RETURNING id, supplier_invoice_number`,
    [
      params.userId,
      params.companyId,
      params.supplierId,
      nextArrival++,
      params.number,
      params.status ?? 'registered',
    ],
  )
}

async function failureOf(statement: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await statement
  } catch (err) {
    return err as { code?: string; constraint?: string }
  }
  throw new Error('expected the statement to be refused')
}

describe('supplier_invoices.supplier_invoice_number is optional (crm#1039)', () => {
  it('stores an invoice without the supplier number as NULL', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId, 'Försäkring AB')

    const { rows } = await insertInvoice({ userId, companyId, supplierId, number: null })

    expect(rows[0]!.supplier_invoice_number).toBeNull()
  })

  it('keeps any number of number-less invoices from one supplier apart', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId, 'Försäkring AB')

    await insertInvoice({ userId, companyId, supplierId, number: null })
    await insertInvoice({ userId, companyId, supplierId, number: null })

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM public.supplier_invoices
        WHERE company_id = $1 AND supplier_id = $2 AND supplier_invoice_number IS NULL`,
      [companyId, supplierId],
    )
    expect(Number(rows[0]!.n)).toBe(2)
  })

  it.each([
    ['an empty string', ''],
    ['spaces', '   '],
    ['a tab', '\t'],
    ['a line break', '\n '],
  ])('refuses %s as a number: a missing number is NULL', async (_label, value) => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId, 'Leverantör AB')

    const err = await failureOf(insertInvoice({ userId, companyId, supplierId, number: value }))

    expect(err.code).toBe('23514')
    expect(err.constraint).toBe('supplier_invoices_number_not_blank')
  })

  it('stores a real number exactly as given, surrounding whitespace included', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId, 'Leverantör AB')

    const { rows } = await insertInvoice({ userId, companyId, supplierId, number: ' 4711 ' })

    expect(rows[0]!.supplier_invoice_number).toBe(' 4711 ')
  })

  it('still refuses a live duplicate number from the same supplier', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId, 'Leverantör AB')
    await insertInvoice({ userId, companyId, supplierId, number: '4711' })

    const err = await failureOf(insertInvoice({ userId, companyId, supplierId, number: '4711' }))

    expect(err.code).toBe('23505')
    expect(err.constraint).toBe('idx_supplier_invoices_company_supplier_number')
  })

  it('allows the number from another supplier, and again once the first invoice is credited', async () => {
    const { userId, companyId } = await seedCompany()
    const first = await insertSupplier(userId, companyId, 'Leverantör AB')
    const second = await insertSupplier(userId, companyId, 'Annan leverantör AB')

    await insertInvoice({ userId, companyId, supplierId: first, number: '4711', status: 'credited' })
    await insertInvoice({ userId, companyId, supplierId: first, number: '4711' })
    await insertInvoice({ userId, companyId, supplierId: second, number: '4711' })

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM public.supplier_invoices
        WHERE company_id = $1 AND supplier_invoice_number = '4711'`,
      [companyId],
    )
    expect(Number(rows[0]!.n)).toBe(3)
  })

  it('declares the column nullable and the constraint validated', async () => {
    const { rows } = await getPool().query<{ is_nullable: string; convalidated: boolean }>(
      `SELECT c.is_nullable, k.convalidated
         FROM information_schema.columns c
         JOIN pg_constraint k
           ON k.conrelid = 'public.supplier_invoices'::regclass
          AND k.conname = 'supplier_invoices_number_not_blank'
        WHERE c.table_schema = 'public'
          AND c.table_name = 'supplier_invoices'
          AND c.column_name = 'supplier_invoice_number'`,
    )
    expect(rows).toEqual([{ is_nullable: 'YES', convalidated: true }])
  })
})

describe('provider import of a supplier invoice without a number (crm#1039)', () => {
  it('stores it with a NULL number and keeps naming a reused number', async () => {
    const client = await getClient()
    try {
      const sql = readFileSync(
        fileURLToPath(new URL('./sql/supplier-invoice-number-optional.sql', import.meta.url)),
        'utf8',
      )
      await expect(client.query(sql)).resolves.toBeDefined()
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
