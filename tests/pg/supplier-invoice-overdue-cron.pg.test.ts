import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for update_overdue_supplier_invoices() and its fix in
 * 20260607120000_supplier_invoice_overdue_skip_paid_and_credit_notes.sql.
 *
 * Regression: supplier invoices (and credit notes) with remaining_amount = 0
 * were being flipped to 'overdue' by the daily cron: surfacing in the UI as
 * "Förfallen" with "kvar att betala 0 kr". Credit notes are the systematic
 * case: they are created status='registered', remaining_amount=0,
 * due_date=today, so the cron caught them the next day.
 *
 * Locks in:
 *   - The function still marks a genuinely-unpaid, past-due invoice overdue.
 *   - It NEVER marks a credit note overdue.
 *   - It NEVER marks a fully-paid (remaining ~= 0) invoice overdue.
 *   - Not-yet-due invoices are untouched.
 *   - The one-off backfill corrects rows already mis-flagged.
 *
 * Tests write through the superuser pool (RLS bypassed); the function is
 * SECURITY DEFINER. Dates are pinned far in the past/future so the result is
 * independent of the wall-clock date the suite runs on.
 */

const PAST = '2000-01-01'
const FUTURE = '2999-01-01'

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260607120000_supplier_invoice_overdue_skip_paid_and_credit_notes.sql',
  ),
  'utf8',
)

/**
 * Re-running MIGRATION_SQL also CREATE OR REPLACEs the function with its
 * pre-#1206, flip-only definition, and that replacement outlives the describe
 * block in the shared test database. Keep the current definition on hand so the
 * backfill block can put it back.
 */
const SYMMETRIC_MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260727160000_supplier_invoice_overdue_symmetric.sql'),
  'utf8',
)
const SYMMETRIC_FUNCTION_SQL = SYMMETRIC_MIGRATION_SQL.slice(
  SYMMETRIC_MIGRATION_SQL.indexOf('CREATE OR REPLACE FUNCTION'),
)

async function insertSupplier(userId: string, companyId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Leverantör AB', 'swedish_business', 'SE', 30, 'SEK')`,
    [id, userId, companyId],
  )
  return id
}

async function insertSupplierInvoice(params: {
  userId: string
  companyId: string
  supplierId: string
  status: string
  dueDate: string
  total: number
  remaining: number
  paidAmount?: number
  isCreditNote?: boolean
  paidAt?: string | null
  approvedAt?: string | null
}): Promise<string> {
  const id = randomUUID()
  const arrivalNumber = (Date.now() % 1_000_000_000) + Math.floor(Math.random() * 100_000)
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency,
        subtotal, vat_amount, total, paid_amount, remaining_amount, paid_at,
        vat_treatment, reverse_charge, is_credit_note, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7, $8, 'SEK',
             $9, 0, $9, $10, $11, $12, 'standard_25', false, $13, $14)`,
    [
      id,
      params.userId,
      params.companyId,
      params.supplierId,
      arrivalNumber,
      `LF-${arrivalNumber}`,
      params.dueDate,
      params.status,
      params.total,
      params.paidAmount ?? 0,
      params.remaining,
      params.paidAt ?? null,
      params.isCreditNote ?? false,
      params.approvedAt ?? null,
    ],
  )
  return id
}

async function statusOf(id: string): Promise<string> {
  const { rows } = await getPool().query(
    'SELECT status FROM public.supplier_invoices WHERE id = $1',
    [id],
  )
  return rows[0].status
}

describe('update_overdue_supplier_invoices()', () => {
  it('marks a genuinely-unpaid, past-due invoice overdue', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId)
    const id = await insertSupplierInvoice({
      userId, companyId, supplierId,
      status: 'approved', dueDate: PAST, total: 1000, remaining: 1000,
    })

    await getPool().query('SELECT public.update_overdue_supplier_invoices()')

    expect(await statusOf(id)).toBe('overdue')
  })

  it('never marks a credit note overdue (remaining 0, status credited)', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId)
    // Mirrors how the credit routes create a credit note since 20260904190000:
    // resting at 'credited' (a reversal is never a payable), fully settled
    // (remaining 0), due today (here: long past).
    const id = await insertSupplierInvoice({
      userId, companyId, supplierId,
      status: 'credited', dueDate: PAST, total: 1000, remaining: 0,
      isCreditNote: true,
    })

    await getPool().query('SELECT public.update_overdue_supplier_invoices()')

    expect(await statusOf(id)).toBe('credited')
  })

  it('never marks a fully-paid (remaining ~0) invoice overdue', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId)
    const id = await insertSupplierInvoice({
      userId, companyId, supplierId,
      status: 'approved', dueDate: PAST, total: 1000, remaining: 0, paidAmount: 1000,
    })

    await getPool().query('SELECT public.update_overdue_supplier_invoices()')

    expect(await statusOf(id)).toBe('approved')
  })

  it('leaves not-yet-due invoices untouched', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId)
    const id = await insertSupplierInvoice({
      userId, companyId, supplierId,
      status: 'approved', dueDate: FUTURE, total: 1000, remaining: 1000,
    })

    await getPool().query('SELECT public.update_overdue_supplier_invoices()')

    expect(await statusOf(id)).toBe('approved')
  })
})

/**
 * Symmetry, added by 20260727160000_supplier_invoice_overdue_symmetric.sql
 * (#1206): before it, the label was one-way. Extending an unbooked invoice's
 * due date left it "Förfallen" forever, which also made it read-only.
 */
describe('update_overdue_supplier_invoices() un-flip', () => {
  it('returns an overdue invoice to registered once the due date is no longer past', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId)
    const id = await insertSupplierInvoice({
      userId, companyId, supplierId,
      status: 'overdue', dueDate: FUTURE, total: 1000, remaining: 1000,
    })

    await getPool().query('SELECT public.update_overdue_supplier_invoices()')

    expect(await statusOf(id)).toBe('registered')
  })

  it('returns it to approved when it had been attested (approved_at set)', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId)
    const id = await insertSupplierInvoice({
      userId, companyId, supplierId,
      status: 'overdue', dueDate: FUTURE, total: 1000, remaining: 1000,
      approvedAt: '2026-01-01T08:00:00Z',
    })

    await getPool().query('SELECT public.update_overdue_supplier_invoices()')

    expect(await statusOf(id)).toBe('approved')
  })

  it('leaves a still-past-due invoice on overdue', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId)
    const id = await insertSupplierInvoice({
      userId, companyId, supplierId,
      status: 'overdue', dueDate: PAST, total: 1000, remaining: 1000,
    })

    await getPool().query('SELECT public.update_overdue_supplier_invoices()')

    expect(await statusOf(id)).toBe('overdue')
  })

  it('does not resurrect a settled invoice: paid stays paid', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId)
    const id = await insertSupplierInvoice({
      userId, companyId, supplierId,
      status: 'paid', dueDate: FUTURE, total: 1000, remaining: 0, paidAmount: 1000,
    })

    await getPool().query('SELECT public.update_overdue_supplier_invoices()')

    expect(await statusOf(id)).toBe('paid')
  })

  it('is a no-op on an overdue row with nothing left to pay (repaired once by 20260607120000)', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId)
    const id = await insertSupplierInvoice({
      userId, companyId, supplierId,
      status: 'overdue', dueDate: FUTURE, total: 1000, remaining: 0, paidAmount: 1000,
    })

    await getPool().query('SELECT public.update_overdue_supplier_invoices()')

    expect(await statusOf(id)).toBe('overdue')
  })
})

describe('overdue backfill (migration 20260607120000)', () => {
  // Replaying the old migration downgrades the function definition; restore the
  // current (symmetric) one so nothing later in the run sees a stale version.
  afterAll(async () => {
    await getPool().query(SYMMETRIC_FUNCTION_SQL)
  })

  it('has nothing left to revert for credit notes: they can no longer reach overdue', async () => {
    // The 20260607120000 backfill moved credit notes wrongly stuck on
    // 'overdue' back to 'registered'. Since 20260904190000 a credit note
    // cannot be in either state: supplier_invoices_credit_note_not_payable
    // refuses the payable lifecycle for credit notes at the row level
    // (tests/pg/supplier-credit-note-not-payable.pg.test.ts), so the
    // scenario this backfill repaired is unreachable.
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId)
    await expect(
      insertSupplierInvoice({
        userId, companyId, supplierId,
        status: 'overdue', dueDate: PAST, total: 1000, remaining: 0, isCreditNote: true,
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'supplier_invoices_credit_note_not_payable' })
  })

  it('marks a fully-paid invoice stuck on overdue as paid (and stamps paid_at)', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId)
    const id = await insertSupplierInvoice({
      userId, companyId, supplierId,
      status: 'overdue', dueDate: PAST, total: 1000, remaining: 0, paidAmount: 1000,
      paidAt: null,
    })

    await getPool().query(MIGRATION_SQL)

    const { rows } = await getPool().query(
      'SELECT status, paid_at FROM public.supplier_invoices WHERE id = $1',
      [id],
    )
    expect(rows[0].status).toBe('paid')
    expect(rows[0].paid_at).not.toBeNull()
  })

  it('leaves a genuinely-overdue unpaid invoice on overdue', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(userId, companyId)
    const id = await insertSupplierInvoice({
      userId, companyId, supplierId,
      status: 'overdue', dueDate: PAST, total: 1000, remaining: 1000,
    })

    await getPool().query(MIGRATION_SQL)

    expect(await statusOf(id)).toBe('overdue')
  })
})
