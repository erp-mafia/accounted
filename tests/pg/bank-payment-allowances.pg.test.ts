import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * The monthly cap on bank payments (migration *_bank_payment_allowances.sql):
 * a company reads its own allowance and requests, never another company's,
 * and a browser session can never raise its own cap or write a request
 * directly (the route writes requests as the service role, founders write
 * allowances as the service role).
 */

async function companyWithOwner(): Promise<{ userId: string; companyId: string }> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  return { userId, companyId }
}

async function grantAllowance(companyId: string, monthly: number): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_bank_payment_allowances (company_id, monthly_payments, note) VALUES ($1, $2, 'pg test')`,
    [companyId, monthly],
  )
}

async function insertRequest(companyId: string, userId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.bank_payment_allowance_requests (company_id, requested_by, monthly_payments_wanted, message)
     VALUES ($1, $2, 40, 'Vi betalar många leverantörer') RETURNING id`,
    [companyId, userId],
  )
  return rows[0]!.id
}

describe('bank_payment_allowances.pg: the cap is read by members and raised only by the server', () => {
  it('lets a member read their own company\'s allowance and requests, and nothing of another company', async () => {
    const own = await companyWithOwner()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: own.companyId, userId: member, role: 'member' })
    await grantAllowance(own.companyId, 40)
    await insertRequest(own.companyId, member)

    const other = await companyWithOwner()
    await grantAllowance(other.companyId, 100)
    await insertRequest(other.companyId, other.userId)

    await withUserContext(member, async (client) => {
      const allowances = await client.query<{ company_id: string; monthly_payments: number }>(
        `SELECT company_id, monthly_payments FROM public.company_bank_payment_allowances`,
      )
      expect(allowances.rows).toEqual([{ company_id: own.companyId, monthly_payments: 40 }])
      const requests = await client.query<{ company_id: string }>(`SELECT company_id FROM public.bank_payment_allowance_requests`)
      expect(requests.rows).toEqual([{ company_id: own.companyId }])
    })
  })

  it('refuses every write to the allowance from a browser session, the owner\'s included', async () => {
    const { userId, companyId } = await companyWithOwner()
    await grantAllowance(companyId, 10)
    const fresh = await companyWithOwner()

    await withUserContext(userId, async (client) => {
      await expect(client.query(`UPDATE public.company_bank_payment_allowances SET monthly_payments = 1000 WHERE company_id = $1`, [companyId])).rejects.toThrow(
        /permission denied/i,
      )
    })
    await withUserContext(userId, async (client) => {
      await expect(client.query(`DELETE FROM public.company_bank_payment_allowances WHERE company_id = $1`, [companyId])).rejects.toThrow(/permission denied/i)
    })
    await withUserContext(fresh.userId, async (client) => {
      await expect(
        client.query(`INSERT INTO public.company_bank_payment_allowances (company_id, monthly_payments) VALUES ($1, 1000)`, [fresh.companyId]),
      ).rejects.toThrow(/permission denied/i)
    })
    const { rows } = await getPool().query<{ monthly_payments: number }>(
      `SELECT monthly_payments FROM public.company_bank_payment_allowances WHERE company_id = $1`,
      [companyId],
    )
    expect(rows).toEqual([{ monthly_payments: 10 }])
  })

  it('refuses a request written straight from a browser session, and anon reads nothing', async () => {
    const { userId, companyId } = await companyWithOwner()
    const id = await insertRequest(companyId, userId)
    await withUserContext(userId, async (client) => {
      await expect(
        client.query(`INSERT INTO public.bank_payment_allowance_requests (company_id, requested_by, monthly_payments_wanted) VALUES ($1, $2, 50)`, [
          companyId,
          userId,
        ]),
      ).rejects.toThrow(/permission denied/i)
    })
    await withUserContext(userId, async (client) => {
      await expect(client.query(`UPDATE public.bank_payment_allowance_requests SET handled_at = now() WHERE id = $1`, [id])).rejects.toThrow(/permission denied/i)
    })
    const anon = await getClient()
    try {
      await anon.query('BEGIN')
      await anon.query('SET LOCAL ROLE anon')
      await expect(anon.query(`SELECT company_id FROM public.company_bank_payment_allowances`)).rejects.toThrow(/permission denied/i)
      await anon.query('ROLLBACK')
      await anon.query('BEGIN')
      await anon.query('SET LOCAL ROLE anon')
      await expect(anon.query(`SELECT id FROM public.bank_payment_allowance_requests`)).rejects.toThrow(/permission denied/i)
    } finally {
      await anon.query('ROLLBACK').catch(() => {})
      anon.release()
    }
  })

  it('lets the server raise a cap, record a request and mark it handled, within the shapes', async () => {
    const { userId, companyId } = await companyWithOwner()
    await runAsServiceRole(async (service) => {
      await service.query(
        `INSERT INTO public.company_bank_payment_allowances (company_id, monthly_payments, granted_by) VALUES ($1, 50, $2)
         ON CONFLICT (company_id) DO UPDATE SET monthly_payments = excluded.monthly_payments`,
        [companyId, userId],
      )
      const raised = await service.query<{ monthly_payments: number }>(
        `UPDATE public.company_bank_payment_allowances SET monthly_payments = 60 WHERE company_id = $1 RETURNING monthly_payments`,
        [companyId],
      )
      expect(raised.rows).toEqual([{ monthly_payments: 60 }])
      const request = await service.query<{ id: string }>(
        `INSERT INTO public.bank_payment_allowance_requests (company_id, requested_by, monthly_payments_wanted, message) VALUES ($1, $2, 60, NULL) RETURNING id`,
        [companyId, userId],
      )
      const handled = await service.query(`UPDATE public.bank_payment_allowance_requests SET handled_at = now() WHERE id = $1`, [request.rows[0]!.id])
      expect(handled.rowCount).toBe(1)
    })
    await expect(
      getPool().query(`INSERT INTO public.company_bank_payment_allowances (company_id, monthly_payments) VALUES ($1, -1)`, [(await companyWithOwner()).companyId]),
    ).rejects.toThrow(/check constraint/i)
    await expect(
      getPool().query(`INSERT INTO public.bank_payment_allowance_requests (company_id, monthly_payments_wanted) VALUES ($1, 0)`, [companyId]),
    ).rejects.toThrow(/check constraint/i)
  })
})
