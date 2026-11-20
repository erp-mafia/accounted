import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

/**
 * fortnox_terms_backfill_progress (migration 20261026230300) holds the crm#1245
 * backfill cron's cursor per company and the ids of the cards it changed. Only
 * the cron (service role) reads or writes it: these pin that a member of the
 * company cannot, and that an outcome is one the cron knows.
 */
describe('fortnox_terms_backfill_progress (pg)', () => {
  it('has RLS on with no policies and no grant to members', async () => {
    const { rows: flags } = await getPool().query<{ relrowsecurity: boolean }>(
      `SELECT c.relrowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'fortnox_terms_backfill_progress'`,
    )
    expect(flags[0]!.relrowsecurity).toBe(true)

    const { rows: policies } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'fortnox_terms_backfill_progress'`,
    )
    expect(policies[0]!.n).toBe(0)

    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId })
    await getPool().query(
      `INSERT INTO public.fortnox_terms_backfill_progress (company_id, next_key, filled_customer_ids)
       VALUES ($1, 'customers:1', ARRAY[gen_random_uuid()])`,
      [companyId],
    )

    await withUserContext(userId, async (client) => {
      await expect(client.query('SELECT * FROM public.fortnox_terms_backfill_progress WHERE company_id = $1', [companyId]))
        .rejects.toMatchObject({ code: '42501' })
    })
  })

  it('accepts only the outcomes the cron writes', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await getPool().query(
      `INSERT INTO public.fortnox_terms_backfill_progress (company_id, outcome) VALUES ($1, 'done')`,
      [companyId],
    )
    await expect(getPool().query(
      `UPDATE public.fortnox_terms_backfill_progress SET outcome = 'maybe' WHERE company_id = $1`,
      [companyId],
    )).rejects.toMatchObject({ code: '23514' })
  })

  it('goes with its company', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await getPool().query(
      'INSERT INTO public.fortnox_terms_backfill_progress (company_id) VALUES ($1)',
      [companyId],
    )
    await getPool().query('DELETE FROM public.companies WHERE id = $1', [companyId])
    const { rows } = await getPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.fortnox_terms_backfill_progress WHERE company_id = $1',
      [companyId],
    )
    expect(rows[0]!.n).toBe(0)
  })
})
