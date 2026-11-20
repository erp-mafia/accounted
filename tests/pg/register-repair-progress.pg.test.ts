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

  // append_register_repair_changed (20261112192903): the cron records each
  // changed card as it is written, so a run that is ended keeps its trail.
  it('appends changed cards in one statement, creating the row, and leaves the cursor and outcome alone', async () => {
    const { companyId } = await seedCompany()
    const append = 'SELECT public.append_register_repair_changed($1, $2, $3::jsonb)'
    const row = await runAsServiceRole(async (client) => {
      // Before the company has a progress row: the first card creates it.
      await client.query(append, [companyId, 'fortnox', '[{"resource": "customers", "id": "a", "kinds": ["private"], "was": {"customer_type": "swedish_business"}}]'])
      // The cron's own progress write never carries `changed`.
      await client.query(
        `INSERT INTO public.register_repair_progress (company_id, provider, next_key, attempts, counts)
         VALUES ($1, 'fortnox', 'customers:42', 1, '{"private": 1}')
         ON CONFLICT (company_id, provider) DO UPDATE SET next_key = excluded.next_key, attempts = excluded.attempts, counts = excluded.counts`,
        [companyId])
      await client.query(append, [companyId, 'fortnox', '[{"resource": "suppliers", "id": "b", "kinds": ["terms"]}, {"resource": "suppliers", "id": "c", "kinds": ["currency"]}]'])
      const { rows } = await client.query(
        'SELECT next_key, outcome, attempts, counts, changed FROM public.register_repair_progress WHERE company_id = $1 AND provider = $2',
        [companyId, 'fortnox'])
      return rows[0]
    })
    expect(row).toMatchObject({ next_key: 'customers:42', outcome: null, attempts: 1, counts: { private: 1 } })
    expect(row.changed.map((card: { id: string }) => card.id)).toEqual(['a', 'b', 'c'])
    expect(row.changed[0].was).toEqual({ customer_type: 'swedish_business' })
    await getPool().query('DELETE FROM public.register_repair_progress WHERE company_id = $1', [companyId])
  })

  it('refuses anything but an array of cards, and a signed-in user', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(runAsServiceRole((client) => client.query(
      'SELECT public.append_register_repair_changed($1, $2, $3::jsonb)', [companyId, 'fortnox', '{"id": "a"}'])))
      .rejects.toThrow('REGISTER_REPAIR_CARDS_NOT_AN_ARRAY')
    await expect(withUserContext(userId, (client) => client.query(
      'SELECT public.append_register_repair_changed($1, $2, $3::jsonb)', [companyId, 'fortnox', '[]'])))
      .rejects.toMatchObject({ code: '42501' })
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
