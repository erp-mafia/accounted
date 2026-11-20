/**
 * pg-real tests for 20260930200100_gron_teknik_deduction_type.sql: the two
 * columns that store the skattereduktion kind accept 'gron_teknik' (crm#209,
 * #3135) and still refuse anything else.
 *
 * Verifies:
 *   - invoice_items.deduction_type accepts gron_teknik, keeps rot, rut and
 *     NULL, and refuses near misses ('gron', 'GRON_TEKNIK') and garbage with
 *     23514 on invoice_items_deduction_type_check.
 *   - rot_rut_payout_requests.deduction_type accepts gron_teknik and refuses
 *     garbage with 23514 on rot_rut_payout_requests_deduction_type_check.
 *   - Exactly one CHECK per table mentions deduction_type and it lists
 *     gron_teknik: a constraint whose name drifted would make the migration's
 *     DROP ... IF EXISTS a silent no-op and leave the old rot/rut CHECK in
 *     force next to the new one.
 *   - enforce_single_active_rot_rut_request is kind-agnostic: a grön teknik
 *     invoice joins a gron_teknik begäran, and a second active begäran for
 *     the same invoice is still refused with 23505.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { insertAuthUser, insertCompany } from './fixtures'

async function seedInvoice(params: { userId: string; companyId: string }): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Test Kund', 'individual')`,
    [customerId, params.userId, params.companyId],
  )
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
      (id, user_id, company_id, customer_id, invoice_date, due_date,
       currency, vat_treatment, vat_rate, deduction_total)
     VALUES ($1, $2, $3, $4, '2026-09-01', '2026-09-30', 'SEK', 'standard_25', 25, 1875)`,
    [invoiceId, params.userId, params.companyId, customerId],
  )
  return invoiceId
}

async function insertItem(
  invoiceId: string,
  deductionType: string | null,
  workType: string | null = null,
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_items
       (id, invoice_id, sort_order, description, quantity, unit, unit_price,
        line_total, vat_rate, vat_amount, deduction_type, deduction_amount,
        labor_hours, work_type, housing_designation)
     VALUES ($1, $2, 0, 'Solpaneler med montage', 1, 'st', 10000, 10000, 25, 2500,
             $3, $4, 8, $5, 'Exempelby 1:1')`,
    [id, invoiceId, deductionType, deductionType ? 1875 : 0, workType],
  )
  return id
}

async function insertRequest(params: {
  userId: string
  companyId: string
  type: string
  status?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.rot_rut_payout_requests
      (id, company_id, user_id, deduction_type, name, status, requested_total, file_name)
     VALUES ($1, $2, $3, $4, 'GT 2026-09-30', $5, 1875, 'gron_teknik_2026-09-30.xml')`,
    [id, params.companyId, params.userId, params.type, params.status ?? 'generated'],
  )
  return id
}

async function insertRequestItem(requestId: string, invoiceId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.rot_rut_payout_request_items
      (id, request_id, invoice_id, requested_amount)
     VALUES ($1, $2, $3, 1875)`,
    [randomUUID(), requestId, invoiceId],
  )
}

async function deductionTypeChecks(table: string): Promise<Array<{ name: string; def: string }>> {
  const result = await getPool().query<{ name: string; def: string }>(
    `SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = $1
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%deduction_type%'`,
    [table],
  )
  return result.rows
}

describe('grön teknik deduction kind (20260930200100)', () => {
  it('invoice_items accepts gron_teknik and keeps rot, rut and NULL', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const invoiceId = await seedInvoice({ userId, companyId })

    const itemId = await insertItem(invoiceId, 'gron_teknik', 'INSTALLATION_SOLCELLER')
    const stored = await getPool().query<{ deduction_type: string; work_type: string; deduction_amount: string }>(
      `SELECT deduction_type, work_type, deduction_amount FROM public.invoice_items WHERE id = $1`,
      [itemId],
    )
    expect(stored.rows[0]).toMatchObject({
      deduction_type: 'gron_teknik',
      work_type: 'INSTALLATION_SOLCELLER',
    })
    expect(Number(stored.rows[0].deduction_amount)).toBe(1875)

    await expect(insertItem(invoiceId, 'rot', 'BYGG')).resolves.toBeTruthy()
    await expect(insertItem(invoiceId, 'rut', 'STAD')).resolves.toBeTruthy()
    await expect(insertItem(invoiceId, null)).resolves.toBeTruthy()
  })

  it('invoice_items still refuses any other kind with 23514 on the named constraint', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const invoiceId = await seedInvoice({ userId, companyId })

    for (const bad of ['gron', 'GRON_TEKNIK', 'invalid']) {
      await expect(insertItem(invoiceId, bad, 'INSTALLATION_SOLCELLER')).rejects.toMatchObject({
        code: '23514',
        constraint: 'invoice_items_deduction_type_check',
      })
    }
  })

  it('rot_rut_payout_requests accepts gron_teknik and refuses garbage with 23514', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })

    await expect(insertRequest({ userId, companyId, type: 'gron_teknik' })).resolves.toBeTruthy()
    await expect(insertRequest({ userId, companyId, type: 'rot' })).resolves.toBeTruthy()
    await expect(insertRequest({ userId, companyId, type: 'gront' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'rot_rut_payout_requests_deduction_type_check',
    })
  })

  it('leaves exactly one deduction_type CHECK per table, and it lists gron_teknik', async () => {
    for (const [table, name] of [
      ['invoice_items', 'invoice_items_deduction_type_check'],
      ['rot_rut_payout_requests', 'rot_rut_payout_requests_deduction_type_check'],
    ] as const) {
      const checks = await deductionTypeChecks(table)
      expect(checks.map((check) => check.name)).toEqual([name])
      expect(checks[0].def).toContain('gron_teknik')
      expect(checks[0].def).toContain('rot')
      expect(checks[0].def).toContain('rut')
    }
  })

  it('the single-active-begäran trigger treats a grön teknik invoice like any other', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const invoiceId = await seedInvoice({ userId, companyId })
    await insertItem(invoiceId, 'gron_teknik', 'INSTALLATION_LADDPUNKT')

    const first = await insertRequest({ userId, companyId, type: 'gron_teknik' })
    await expect(insertRequestItem(first, invoiceId)).resolves.toBeUndefined()

    const second = await insertRequest({ userId, companyId, type: 'gron_teknik' })
    await expect(insertRequestItem(second, invoiceId)).rejects.toMatchObject({ code: '23505' })
  })
})
