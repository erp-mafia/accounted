import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * Priced usage asked for (migration 20261102204343_usage_requests_bank_accounts.sql):
 * members read their own company's requests and write none (the server
 * stores them as the service role), the new kinds bank_account and
 * ai_document are accepted where kinds are, and a byrå client's statement
 * can be manual.
 */

async function insertRequest(companyId: string, kind = 'signing'): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(`INSERT INTO public.usage_requests (company_id, kind) VALUES ($1, $2) RETURNING id`, [
    companyId,
    kind,
  ])
  return rows[0]!.id
}

describe('usage_requests (pg)', () => {
  it('lets members read their own company only, and write nothing', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: member, role: 'member' })
    const idA = await insertRequest(a.companyId)
    await insertRequest(b.companyId)

    await withUserContext(member, async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM public.usage_requests`)
      expect(rows.map((r) => r.id)).toEqual([idA])
    })
    await withUserContext(member, async (client) => {
      await expect(client.query(`INSERT INTO public.usage_requests (company_id, kind) VALUES ($1, 'signing')`, [a.companyId])).rejects.toThrow(
        /permission denied/,
      )
    })
    await withUserContext(member, async (client) => {
      await expect(client.query(`UPDATE public.usage_requests SET handled_at = now() WHERE id = $1`, [idA])).rejects.toThrow(/permission denied/)
    })
  })

  it('refuses an unknown kind and an answer before the question', async () => {
    const a = await seedCompany()
    await expect(insertRequest(a.companyId, 'fax')).rejects.toThrow(/check/)
    await expect(
      getPool().query(`INSERT INTO public.usage_requests (company_id, kind, created_at, handled_at) VALUES ($1, 'signing', now(), now() - interval '1 day')`, [
        a.companyId,
      ]),
    ).rejects.toThrow(/check/)
  })
})

describe('usage kinds and the manual status (pg)', () => {
  it('takes bank_account and ai_document as kinds, and manual as a statement status', async () => {
    const a = await seedCompany()
    await getPool().query(
      `INSERT INTO public.usage_consents (company_id, kind, unit_price_ore, included) VALUES ($1, 'bank_account', 2000, 2)`,
      [a.companyId],
    )
    await insertRequest(a.companyId, 'bank_account')
    await getPool().query(
      `INSERT INTO public.usage_statements (company_id, period, kind, used, included, billable, unit_price_ore, amount_ore, status, reason)
       VALUES ($1, '2026-11', 'bank_account', 4, 2, 2, 2000, 4000, 'manual', 'byra_agreement'),
              ($1, '2026-11', 'ai_document', 31, 25, 0, NULL, 0, 'preview', 'no_price')`,
      [a.companyId],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.usage_statements (company_id, period, kind, used, billable, amount_ore, status) VALUES ($1, '2026-12', 'signing', 1, 0, 0, 'invoiced')`,
        [a.companyId],
      ),
    ).rejects.toThrow(/usage_statements_status_check/)
  })
})
