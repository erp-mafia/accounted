import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { randomUUID } from 'crypto'
import { seedCompany } from './fixtures'

const uniqueOrg = (label: string) => label + '-' + randomUUID()

/**
 * Covers migration 20260908120000_zettle_connections:
 *   1. RLS: members insert and read their own company's connection.
 *   2. One ACTIVE connection per company.
 *   3. One organization actively connected to at most one company.
 *   4. No DELETE policy.
 */

describe('zettle_connections RLS', () => {
  it('a member can insert and read their company connection', async () => {
    const { userId, companyId } = await seedCompany()
    const org = uniqueOrg('member')
    await withUserContext(userId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO public.zettle_connections
           (company_id, user_id, organization_uuid, status)
         VALUES ($1, $2, $3, 'active')
         RETURNING id`,
        [companyId, userId, org],
      )
      expect(inserted.rows).toHaveLength(1)

      const read = await client.query(
        `SELECT status, organization_uuid FROM public.zettle_connections WHERE company_id = $1`,
        [companyId],
      )
      expect(read.rows).toEqual([{ status: 'active', organization_uuid: org }])
    })
  })

  it('a non-member sees nothing and cannot insert for a foreign company', async () => {
    const { userId: ownerId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.zettle_connections (company_id, user_id, organization_uuid, status)
       VALUES ($1, $2, $3, 'active')`,
      [companyId, ownerId, uniqueOrg('foreign')],
    )
    const { userId: outsiderId } = await seedCompany()

    await withUserContext(outsiderId, async (client) => {
      const read = await client.query(
        `SELECT id FROM public.zettle_connections WHERE company_id = $1`,
        [companyId],
      )
      expect(read.rows).toHaveLength(0)

      await expect(
        client.query(
          `INSERT INTO public.zettle_connections (company_id, user_id, organization_uuid, status)
           VALUES ($1, $2, $3, 'pending')`,
          [companyId, outsiderId, uniqueOrg('intruder')],
        ),
      ).rejects.toThrow(/row-level security/i)
    })
  })

  it('only one ACTIVE connection per company is allowed', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.zettle_connections (company_id, user_id, organization_uuid, status)
       VALUES ($1, $2, $3, 'active')`,
      [companyId, userId, uniqueOrg('org-one')],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.zettle_connections (company_id, user_id, organization_uuid, status)
         VALUES ($1, $2, $3, 'active')`,
        [companyId, userId, uniqueOrg('org-two')],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('an organization may be actively connected to at most one company', async () => {
    const { userId: userA, companyId: companyA } = await seedCompany()
    const { userId: userB, companyId: companyB } = await seedCompany()
    const sharedOrg = uniqueOrg('shared')
    await getPool().query(
      `INSERT INTO public.zettle_connections (company_id, user_id, organization_uuid, status)
       VALUES ($1, $2, $3, 'active')`,
      [companyA, userA, sharedOrg],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.zettle_connections (company_id, user_id, organization_uuid, status)
         VALUES ($1, $2, $3, 'active')`,
        [companyB, userB, sharedOrg],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('members cannot DELETE a connection (revoke-only)', async () => {
    const { userId, companyId } = await seedCompany()
    const inserted = await getPool().query(
      `INSERT INTO public.zettle_connections (company_id, user_id, organization_uuid, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [companyId, userId, uniqueOrg('nodelete')],
    )
    const id = inserted.rows[0].id as string
    await withUserContext(userId, async (client) => {
      const deleted = await client.query(
        `DELETE FROM public.zettle_connections WHERE id = $1`,
        [id],
      )
      expect(deleted.rowCount).toBe(0)
    })
    const still = await getPool().query(
      `SELECT status FROM public.zettle_connections WHERE id = $1`,
      [id],
    )
    expect(still.rows[0].status).toBe('active')
  })
})
