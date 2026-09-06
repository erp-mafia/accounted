import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from './fixtures'

// pg-real coverage for 20260906210200_supplier_invoice_bank_entered.sql
// (#2220): the nullable bank_entered_at column and the
// clear_supplier_invoice_bank_entered trigger that drops the mark when a
// payment lands (paid_amount up, or the row reaching 'paid') and leaves it
// alone for every other write: the overdue cron flip, metadata edits, a
// payment reversal, and an UPDATE that writes the column explicitly.

async function insertSupplier(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name, bankgiro)
     VALUES ($1, $2, $3, 'Derome Bygg AB', '5050-1055')`,
    [id, userId, companyId],
  )
  return id
}

async function insertSupplierInvoice(
  companyId: string,
  userId: string,
  supplierId: string,
  overrides: { status?: string; bankEnteredAt?: string | null } = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number,
        supplier_invoice_number, invoice_date, due_date,
        subtotal, vat_amount, total, remaining_amount, status, approved_at,
        bank_entered_at)
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int,
             $5, '2026-06-23', '2026-07-07',
             590, 147.5, 737.5, 737.5, $6, '2026-06-24T08:00:00Z', $7)`,
    [
      id,
      userId,
      companyId,
      supplierId,
      `CD-${id.slice(0, 8)}`,
      overrides.status ?? 'approved',
      overrides.bankEnteredAt === undefined ? '2026-09-06T10:00:00Z' : overrides.bankEnteredAt,
    ],
  )
  return id
}

async function readMark(invoiceId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ bank_entered_at: Date | null }>(
    `SELECT bank_entered_at FROM public.supplier_invoices WHERE id = $1`,
    [invoiceId],
  )
  return rows[0].bank_entered_at ? rows[0].bank_entered_at.toISOString() : null
}

async function seed(overrides: { status?: string; bankEnteredAt?: string | null } = {}) {
  const { userId, companyId } = await seedCompany()
  const supplierId = await insertSupplier(companyId, userId)
  const invoiceId = await insertSupplierInvoice(companyId, userId, supplierId, overrides)
  return { userId, companyId, invoiceId }
}

describe('supplier_invoices.bank_entered_at (#2220)', () => {
  it('defaults to NULL', async () => {
    const { invoiceId } = await seed({ bankEnteredAt: null })
    expect(await readMark(invoiceId)).toBeNull()
  })

  it('is cleared when a full payment lands (paid_amount up, status paid)', async () => {
    const { invoiceId } = await seed()
    // The mark-paid and bank-match routes write exactly these fields.
    await getPool().query(
      `UPDATE public.supplier_invoices
          SET status = 'paid', paid_amount = 737.5, remaining_amount = 0,
              paid_at = now()
        WHERE id = $1`,
      [invoiceId],
    )
    expect(await readMark(invoiceId)).toBeNull()
  })

  it('is cleared when a partial payment lands (paid_amount up, still open)', async () => {
    const { invoiceId } = await seed()
    await getPool().query(
      `UPDATE public.supplier_invoices
          SET status = 'partially_paid', paid_amount = 200, remaining_amount = 537.5
        WHERE id = $1`,
      [invoiceId],
    )
    expect(await readMark(invoiceId)).toBeNull()
  })

  it('is cleared when the row reaches paid even without paid_amount moving', async () => {
    const { invoiceId } = await seed()
    await getPool().query(
      `UPDATE public.supplier_invoices SET status = 'paid' WHERE id = $1`,
      [invoiceId],
    )
    expect(await readMark(invoiceId)).toBeNull()
  })

  it('survives the overdue cron flip and the flip back', async () => {
    const { invoiceId } = await seed()
    await getPool().query(
      `UPDATE public.supplier_invoices SET status = 'overdue' WHERE id = $1`,
      [invoiceId],
    )
    expect(await readMark(invoiceId)).toBe('2026-09-06T10:00:00.000Z')
    await getPool().query(
      `UPDATE public.supplier_invoices SET status = 'approved' WHERE id = $1`,
      [invoiceId],
    )
    expect(await readMark(invoiceId)).toBe('2026-09-06T10:00:00.000Z')
  })

  it('survives a metadata edit that touches neither status nor paid_amount', async () => {
    const { invoiceId } = await seed()
    await getPool().query(
      `UPDATE public.supplier_invoices SET due_date = '2026-07-21', notes = 'x' WHERE id = $1`,
      [invoiceId],
    )
    expect(await readMark(invoiceId)).toBe('2026-09-06T10:00:00.000Z')
  })

  it('is left alone by a payment reversal (paid_amount going down)', async () => {
    // payment-sync's reversal shape. In practice the mark was already consumed
    // by the payment being reversed; the trigger only ever clears on money
    // landing, never on money being taken back, so a re-mark is the user's call.
    const { invoiceId } = await seed({ status: 'partially_paid' })
    await getPool().query(
      `UPDATE public.supplier_invoices SET paid_amount = 200, remaining_amount = 537.5 WHERE id = $1`,
      [invoiceId],
    )
    expect(await readMark(invoiceId)).toBeNull()
    await getPool().query(
      `UPDATE public.supplier_invoices SET bank_entered_at = '2026-09-07T10:00:00Z' WHERE id = $1`,
      [invoiceId],
    )
    await getPool().query(
      `UPDATE public.supplier_invoices
          SET status = 'approved', paid_amount = 0, remaining_amount = 737.5, paid_at = NULL
        WHERE id = $1`,
      [invoiceId],
    )
    expect(await readMark(invoiceId)).toBe('2026-09-07T10:00:00.000Z')
  })

  it('does not override a value written explicitly in the same statement', async () => {
    const { invoiceId } = await seed()
    await getPool().query(
      `UPDATE public.supplier_invoices
          SET status = 'paid', paid_amount = 737.5, remaining_amount = 0,
              bank_entered_at = '2026-09-08T10:00:00Z'
        WHERE id = $1`,
      [invoiceId],
    )
    expect(await readMark(invoiceId)).toBe('2026-09-08T10:00:00.000Z')
  })

  it('is writable by a company member through the existing UPDATE policy', async () => {
    // The mark-as-entered route runs as the user (cookie client, RLS on), so
    // the column must be reachable through supplier_invoices_update.
    const { userId, invoiceId } = await seed({ bankEnteredAt: null })
    const updated = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ bank_entered_at: Date | null }>(
        `UPDATE public.supplier_invoices
            SET bank_entered_at = '2026-09-06T12:00:00Z'
          WHERE id = $1
          RETURNING bank_entered_at`,
        [invoiceId],
      )
      return rows
    })
    expect(updated).toHaveLength(1)
    expect(updated[0].bank_entered_at?.toISOString()).toBe('2026-09-06T12:00:00.000Z')
  })

  it('is invisible to a member of another company', async () => {
    const { invoiceId } = await seed({ bankEnteredAt: null })
    const outsider = await insertAuthUser()
    const { companyId: otherCompanyId } = await seedCompany()
    await insertCompanyMember({ companyId: otherCompanyId, userId: outsider, role: 'owner' })
    const updated = await withUserContext(outsider, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE public.supplier_invoices SET bank_entered_at = now() WHERE id = $1`,
        [invoiceId],
      )
      return rowCount
    })
    expect(updated).toBe(0)
    expect(await readMark(invoiceId)).toBeNull()
  })
})
