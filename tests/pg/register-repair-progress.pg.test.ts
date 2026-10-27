import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { seedCompany } from './fixtures'

/**
 * register_repair_progress (crm#1436): the repair cron, as the service role,
 * keeps one row per company and provider; no signed-in user reaches it, the
 * company's own owner included.
 */

describe('register_repair_progress', () => {
  it('keeps one row per company and provider for the service role', async () => {
    const { companyId } = await seedCompany()
    const upsert = `INSERT INTO public.register_repair_progress (company_id, provider, outcome, counts, changed)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (company_id, provider) DO UPDATE SET outcome = excluded.outcome, counts = excluded.counts, changed = excluded.changed`
    const rows = await runAsServiceRole(async (client) => {
      await client.query(upsert, [companyId, 'fortnox', null, '{}', '[]'])
      await client.query(upsert, [companyId, 'fortnox', 'done', '{"private": 1}', '[{"resource": "customers", "id": "x", "kinds": ["private"]}]'])
      await client.query(upsert, [companyId, 'visma', 'no_consent', '{}', '[]'])
      const { rows } = await client.query('SELECT provider, outcome, counts FROM public.register_repair_progress WHERE company_id = $1 ORDER BY provider', [companyId])
      return rows
    })
    expect(rows).toEqual([
      { provider: 'fortnox', outcome: 'done', counts: { private: 1 } },
      { provider: 'visma', outcome: 'no_consent', counts: {} },
    ])
    await getPool().query('DELETE FROM public.register_repair_progress WHERE company_id = $1', [companyId])
  })

  it('takes only the providers and outcomes the repair knows', async () => {
    const { companyId } = await seedCompany()
    await expect(runAsServiceRole((client) => client.query(
      `INSERT INTO public.register_repair_progress (company_id, provider) VALUES ($1, 'briox')`, [companyId])))
      .rejects.toMatchObject({ code: '23514' })
  })

  it('is out of reach for a signed-in user', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(withUserContext(userId, (client) =>
      client.query('SELECT * FROM public.register_repair_progress WHERE company_id = $1', [companyId])))
      .rejects.toMatchObject({ code: '42501' })
  })
})
