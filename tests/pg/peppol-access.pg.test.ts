import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { seedCompany } from './fixtures'

describe('peppol_access', () => {
  it('is readable by the company members only and never writable by authenticated users', async () => {
    const own = await seedCompany()
    const other = await seedCompany()
    await getPool().query(
      `INSERT INTO public.peppol_access (company_id, status, max_sends, enabled_at, enabled_by)
       VALUES ($1, 'enabled', 25, now(), 'test'), ($2, 'requested', NULL, NULL, NULL)`,
      [own.companyId, other.companyId],
    )

    const visible = await withUserContext(own.userId, async (client) => {
      const { rows } = await client.query(`SELECT company_id, status, max_sends FROM public.peppol_access`)
      return rows
    })
    expect(visible).toEqual([{ company_id: own.companyId, status: 'enabled', max_sends: 25 }])

    await expect(withUserContext(own.userId, (client) =>
      client.query(`UPDATE public.peppol_access SET max_sends = 1000000 WHERE company_id = $1`, [own.companyId]),
    )).rejects.toThrow(/permission denied|row-level security/)
    await expect(withUserContext(other.userId, (client) =>
      client.query(
        `INSERT INTO public.peppol_access (company_id, status, enabled_at) VALUES ($1, 'enabled', now())
         ON CONFLICT (company_id) DO UPDATE SET status = 'enabled', enabled_at = now()`,
        [other.companyId],
      ),
    )).rejects.toThrow(/permission denied|row-level security/)

    const serviceView = await runAsServiceRole(async (client) => {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.peppol_access`)
      return rows[0].n as number
    })
    expect(serviceView).toBeGreaterThanOrEqual(2)
  })

  it('keeps the status shape honest: enabled needs enabled_at, disabled needs disabled_at', async () => {
    const seeded = await seedCompany()
    await expect(getPool().query(
      `INSERT INTO public.peppol_access (company_id, status) VALUES ($1, 'enabled')`, [seeded.companyId],
    )).rejects.toThrow(/peppol_access_status_shape/)
    await expect(getPool().query(
      `INSERT INTO public.peppol_access (company_id, status, disabled_at) VALUES ($1, 'disabled', now())`, [seeded.companyId],
    )).resolves.toBeTruthy()
    await expect(getPool().query(
      `UPDATE public.peppol_access SET max_sends = -1 WHERE company_id = $1`, [seeded.companyId],
    )).rejects.toThrow(/peppol_access_max_sends_check/)
  })
})
