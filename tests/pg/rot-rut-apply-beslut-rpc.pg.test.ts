/**
 * pg-real tests for apply_rot_rut_beslut (20260712112000).
 *
 * The RPC records a Skatteverket beslut atomically: every
 * rot_rut_payout_request_items.decided_amount update plus the
 * rot_rut_payout_requests header update (decided_total, decided_at,
 * skv_referensnummer, status) run in one transaction. Any missing row
 * raises, rolling the whole beslut back.
 *
 * Verifies:
 *   - happy path: all items and the header are updated in one call.
 *   - rollback: one missing item id leaves BOTH the valid items and the
 *     header untouched.
 *   - a missing request id raises.
 *   - SECURITY INVOKER: RLS hides another company's request, so a foreign
 *     caller gets the not-found raise instead of a write.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

const SKV_REF = '20260000185-01'

async function seedInvoice(userId: string, companyId: string): Promise<string> {
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
       currency, vat_treatment, vat_rate, deduction_total)
     VALUES ($1, $2, $3, $4, '2026-06-01', '2026-06-30', 'SEK', 'standard_25', 25, 3000)`,
    [invoiceId, userId, companyId, customerId],
  )
  return invoiceId
}

async function seedRequestWithItems(params: {
  userId: string
  companyId: string
  itemCount?: number
}): Promise<{ requestId: string; itemIds: string[] }> {
  const requestId = randomUUID()
  await getPool().query(
    `INSERT INTO public.rot_rut_payout_requests
      (id, company_id, user_id, deduction_type, name, status, requested_total, file_name)
     VALUES ($1, $2, $3, 'rot', 'ROT 2026-07-02', 'submitted', 3000, 'rot_2026-07-02.xml')`,
    [requestId, params.companyId, params.userId],
  )
  const itemIds: string[] = []
  for (let i = 0; i < (params.itemCount ?? 2); i++) {
    const invoiceId = await seedInvoice(params.userId, params.companyId)
    const itemId = randomUUID()
    await getPool().query(
      `INSERT INTO public.rot_rut_payout_request_items
        (id, request_id, invoice_id, requested_amount)
       VALUES ($1, $2, $3, 1500)`,
      [itemId, requestId, invoiceId],
    )
    itemIds.push(itemId)
  }
  return { requestId, itemIds }
}

function callRpc(params: {
  requestId: string
  items: Array<{ item_id: string; decided_amount: number }>
  decidedTotal: number
  status?: string
}) {
  return getPool().query(
    `SELECT public.apply_rot_rut_beslut($1, $2::jsonb, $3, $4, $5)`,
    [
      params.requestId,
      JSON.stringify(params.items),
      params.decidedTotal,
      SKV_REF,
      params.status ?? 'submitted',
    ],
  )
}

describe('apply_rot_rut_beslut RPC', () => {
  it('applies item decided amounts and the request header in one call', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const { requestId, itemIds } = await seedRequestWithItems({ userId, companyId })

    await callRpc({
      requestId,
      items: [
        { item_id: itemIds[0], decided_amount: 1200 },
        { item_id: itemIds[1], decided_amount: 800 },
      ],
      decidedTotal: 2000,
    })

    const items = await getPool().query<{ id: string; decided_amount: string }>(
      `SELECT id, decided_amount FROM public.rot_rut_payout_request_items
        WHERE request_id = $1 ORDER BY decided_amount DESC`,
      [requestId],
    )
    expect(items.rows.map((r) => Number(r.decided_amount))).toEqual([1200, 800])

    const header = await getPool().query<{
      decided_total: string
      decided_at: string | null
      skv_referensnummer: string | null
      status: string
    }>(
      `SELECT decided_total, decided_at, skv_referensnummer, status
         FROM public.rot_rut_payout_requests WHERE id = $1`,
      [requestId],
    )
    expect(Number(header.rows[0].decided_total)).toBe(2000)
    expect(header.rows[0].decided_at).not.toBeNull()
    expect(header.rows[0].skv_referensnummer).toBe(SKV_REF)
    expect(header.rows[0].status).toBe('submitted')
  })

  it('rolls back everything when one item id does not exist', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const { requestId, itemIds } = await seedRequestWithItems({ userId, companyId })

    await expect(
      callRpc({
        requestId,
        items: [
          { item_id: itemIds[0], decided_amount: 1200 },
          { item_id: randomUUID(), decided_amount: 800 },
        ],
        decidedTotal: 2000,
      }),
    ).rejects.toThrow(/not found on request/)

    // The first (valid) item update must have rolled back with the rest.
    const items = await getPool().query<{ decided_amount: string | null }>(
      `SELECT decided_amount FROM public.rot_rut_payout_request_items
        WHERE request_id = $1`,
      [requestId],
    )
    expect(items.rows.every((r) => r.decided_amount === null)).toBe(true)

    const header = await getPool().query<{
      decided_total: string | null
      decided_at: string | null
      skv_referensnummer: string | null
      status: string
    }>(
      `SELECT decided_total, decided_at, skv_referensnummer, status
         FROM public.rot_rut_payout_requests WHERE id = $1`,
      [requestId],
    )
    expect(header.rows[0].decided_total).toBeNull()
    expect(header.rows[0].decided_at).toBeNull()
    expect(header.rows[0].skv_referensnummer).toBeNull()
    expect(header.rows[0].status).toBe('submitted')
  })

  it('raises when the request id does not exist', async () => {
    await expect(
      callRpc({ requestId: randomUUID(), items: [], decidedTotal: 0, status: 'rejected' }),
    ).rejects.toThrow(/request .* not found/)
  })

  it('rejects a non-array p_items payload', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const { requestId } = await seedRequestWithItems({ userId, companyId, itemCount: 1 })

    await expect(
      getPool().query(
        `SELECT public.apply_rot_rut_beslut($1, $2::jsonb, $3, $4, $5)`,
        [requestId, JSON.stringify({ item_id: 'x' }), 0, SKV_REF, 'submitted'],
      ),
    ).rejects.toThrow(/must be a jsonb array/)
  })

  it('SECURITY INVOKER: RLS hides another company from the caller', async () => {
    const owner = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: owner })
    await insertCompanyMember({ companyId, userId: owner })
    const { requestId, itemIds } = await seedRequestWithItems({ userId: owner, companyId })

    const outsider = await insertAuthUser()
    const outsiderCompany = await insertCompany({ createdBy: outsider })
    await insertCompanyMember({ companyId: outsiderCompany, userId: outsider })

    // The outsider cannot see the request's items through RLS, so the item
    // update hits zero rows and the RPC raises instead of writing.
    await expect(
      withUserContext(outsider, (client) =>
        client.query(`SELECT public.apply_rot_rut_beslut($1, $2::jsonb, $3, $4, $5)`, [
          requestId,
          JSON.stringify([{ item_id: itemIds[0], decided_amount: 1200 }]),
          1200,
          SKV_REF,
          'submitted',
        ]),
      ),
    ).rejects.toThrow(/not found/)

    // The member CAN apply it through the same RLS path.
    await withUserContext(owner, (client) =>
      client.query(`SELECT public.apply_rot_rut_beslut($1, $2::jsonb, $3, $4, $5)`, [
        requestId,
        JSON.stringify([
          { item_id: itemIds[0], decided_amount: 700 },
          { item_id: itemIds[1], decided_amount: 500 },
        ]),
        1200,
        SKV_REF,
        'submitted',
      ]),
    )
  })
})
