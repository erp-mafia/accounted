/**
 * pg-real tests for the rot/rut payout-request schema introduced in
 * 20260703090000_rot_rut_payout_requests.sql.
 *
 * Verifies:
 *   - invoice_items.brf_org_number exists with its length CHECK.
 *   - rot_rut_payout_requests / rot_rut_payout_request_items exist with RLS.
 *   - name/status/deduction_type CHECK constraints.
 *   - enforce_single_active_rot_rut_request: one active begäran per invoice
 *     (cross-request), same-company enforcement, retry allowed after
 *     cancellation/avslag.
 *   - enforce_rot_rut_request_reactivation: a cancelled request cannot be
 *     flipped back to active when its invoice meanwhile joined another
 *     active request.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { insertAuthUser, insertCompany } from './fixtures'

async function seedInvoice(params: {
  userId: string
  companyId: string
  deductionTotal?: number
}): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Test Cust', 'individual')`,
    [customerId, params.userId, params.companyId],
  )
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
      (id, user_id, company_id, customer_id, invoice_date, due_date,
       currency, vat_treatment, vat_rate, deduction_total)
     VALUES ($1, $2, $3, $4, '2026-06-01', '2026-06-30', 'SEK', 'standard_25', 25, $5)`,
    [invoiceId, params.userId, params.companyId, customerId, params.deductionTotal ?? 3000],
  )
  return invoiceId
}

async function insertRequest(params: {
  userId: string
  companyId: string
  status?: string
  name?: string
  type?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.rot_rut_payout_requests
      (id, company_id, user_id, deduction_type, name, status, requested_total, file_name)
     VALUES ($1, $2, $3, $4, $5, $6, 3000, 'rot_2026-07-02.xml')`,
    [
      id,
      params.companyId,
      params.userId,
      params.type ?? 'rot',
      params.name ?? 'ROT 2026-07-02',
      params.status ?? 'generated',
    ],
  )
  return id
}

async function insertItem(requestId: string, invoiceId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.rot_rut_payout_request_items
      (id, request_id, invoice_id, requested_amount)
     VALUES ($1, $2, $3, 3000)`,
    [id, requestId, invoiceId],
  )
  return id
}

describe('rot/rut payout-request schema', () => {
  it('invoice_items.brf_org_number exists and rejects > 12 chars', async () => {
    const cols = await getPool().query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'invoice_items'
          AND column_name = 'brf_org_number'`,
    )
    expect(cols.rows).toHaveLength(1)

    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const invoiceId = await seedInvoice({ userId, companyId })
    await expect(
      getPool().query(
        `INSERT INTO public.invoice_items
           (id, invoice_id, sort_order, description, quantity, unit, unit_price,
            line_total, vat_rate, vat_amount, brf_org_number)
         VALUES ($1, $2, 0, 'X', 1, 'st', 100, 100, 25, 25, '1234567890123')`,
        [randomUUID(), invoiceId],
      ),
    ).rejects.toThrow()
  })

  it('both new tables exist with RLS enabled', async () => {
    const result = await getPool().query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
        WHERE relname IN ('rot_rut_payout_requests', 'rot_rut_payout_request_items')`,
    )
    expect(result.rows).toHaveLength(2)
    for (const row of result.rows) {
      expect(row.relrowsecurity).toBe(true)
    }
  })

  it('rejects invalid status, deduction_type, and name > 16 chars', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })

    await expect(
      insertRequest({ userId, companyId, status: 'weird' }),
    ).rejects.toThrow()
    await expect(
      insertRequest({ userId, companyId, type: 'gront' }),
    ).rejects.toThrow()
    await expect(
      insertRequest({ userId, companyId, name: 'a'.repeat(17) }),
    ).rejects.toThrow()
    await expect(insertRequest({ userId, companyId, name: '' })).rejects.toThrow()
  })

  it('happy path: request + item insert, updated_at trigger fires', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const invoiceId = await seedInvoice({ userId, companyId })
    const requestId = await insertRequest({ userId, companyId })
    await insertItem(requestId, invoiceId)

    const before = await getPool().query<{ updated_at: string }>(
      `SELECT updated_at FROM public.rot_rut_payout_requests WHERE id = $1`,
      [requestId],
    )
    await getPool().query(
      `UPDATE public.rot_rut_payout_requests SET status = 'submitted', submitted_at = now()
        WHERE id = $1`,
      [requestId],
    )
    const after = await getPool().query<{ updated_at: string; status: string }>(
      `SELECT updated_at, status FROM public.rot_rut_payout_requests WHERE id = $1`,
      [requestId],
    )
    expect(after.rows[0].status).toBe('submitted')
    expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before.rows[0].updated_at).getTime(),
    )
  })

  it('blocks the same invoice in two active requests, allows retry after cancel', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const invoiceId = await seedInvoice({ userId, companyId })

    const first = await insertRequest({ userId, companyId })
    await insertItem(first, invoiceId)

    // Second active request with the same invoice → blocked by trigger.
    const second = await insertRequest({ userId, companyId })
    await expect(insertItem(second, invoiceId)).rejects.toThrow(
      /already included in an active/,
    )

    // Cancel the first request → the invoice becomes requestable again.
    await getPool().query(
      `UPDATE public.rot_rut_payout_requests SET status = 'cancelled' WHERE id = $1`,
      [first],
    )
    await expect(insertItem(second, invoiceId)).resolves.toBeTruthy()
  })

  it('allows retry after rejection (avslag)', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const invoiceId = await seedInvoice({ userId, companyId })

    const first = await insertRequest({ userId, companyId, status: 'rejected' })
    await insertItem(first, invoiceId)

    const second = await insertRequest({ userId, companyId })
    await expect(insertItem(second, invoiceId)).resolves.toBeTruthy()
  })

  it('blocks an invoice from another company', async () => {
    const userA = await insertAuthUser()
    const companyA = await insertCompany({ createdBy: userA })
    const userB = await insertAuthUser()
    const companyB = await insertCompany({ createdBy: userB })

    const foreignInvoice = await seedInvoice({ userId: userB, companyId: companyB })
    const requestId = await insertRequest({ userId: userA, companyId: companyA })

    await expect(insertItem(requestId, foreignInvoice)).rejects.toThrow(
      /does not belong to the same company/,
    )
  })

  it('blocks reactivating a cancelled request whose invoice joined another active request', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const invoiceId = await seedInvoice({ userId, companyId })

    const first = await insertRequest({ userId, companyId })
    await insertItem(first, invoiceId)
    await getPool().query(
      `UPDATE public.rot_rut_payout_requests SET status = 'cancelled' WHERE id = $1`,
      [first],
    )

    const second = await insertRequest({ userId, companyId })
    await insertItem(second, invoiceId)

    // Reactivating the first request would put the invoice in two active
    // begäran → blocked.
    await expect(
      getPool().query(
        `UPDATE public.rot_rut_payout_requests SET status = 'generated' WHERE id = $1`,
        [first],
      ),
    ).rejects.toThrow(/Cannot reactivate/)
  })

  it('UNIQUE (request_id, invoice_id) blocks duplicate rows in one request', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const invoiceId = await seedInvoice({ userId, companyId })
    const requestId = await insertRequest({ userId, companyId })

    await insertItem(requestId, invoiceId)
    await expect(insertItem(requestId, invoiceId)).rejects.toThrow()
  })

  it('RESTRICT: an invoice referenced by a request cannot be deleted', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const invoiceId = await seedInvoice({ userId, companyId })
    const requestId = await insertRequest({ userId, companyId })
    await insertItem(requestId, invoiceId)

    await expect(
      getPool().query(`DELETE FROM public.invoices WHERE id = $1`, [invoiceId]),
    ).rejects.toThrow()
  })
})
