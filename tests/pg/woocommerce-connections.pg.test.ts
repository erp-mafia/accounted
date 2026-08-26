import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { randomUUID } from 'crypto'
import { seedCompany } from './fixtures'

// Committed (pool) inserts persist across pg-real runs, and the store_url
// partial unique index is global: fixed URLs would collide with rows left by
// a previous run before the assertion under test is ever reached.
const uniqueStore = (label: string) => 'https://' + label + '-' + randomUUID() + '.example.se'

/**
 * Covers migration 20260806170000_woocommerce_connections:
 *   1. RLS: members insert and read their own company's connection,
 *      non-members see nothing and cannot insert for a foreign company.
 *   2. Multiple ACTIVE connections per company (multi-store: the
 *      one-active-per-company index was dropped in 20260811073422).
 *   3. One store actively connected to at most one company.
 *   4. No DELETE policy: a member DELETE silently affects zero rows.
 */

describe('woocommerce_connections RLS', () => {
  it('a member can insert and read their company connection', async () => {
    const { userId, companyId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO public.woocommerce_connections
           (company_id, user_id, store_url, status, oauth_state)
         VALUES ($1, $2, 'https://shop.example.se', 'pending', gen_random_uuid())
         RETURNING id`,
        [companyId, userId],
      )
      expect(inserted.rows).toHaveLength(1)

      const read = await client.query(
        `SELECT status, store_url FROM public.woocommerce_connections WHERE company_id = $1`,
        [companyId],
      )
      expect(read.rows).toEqual([
        { status: 'pending', store_url: 'https://shop.example.se' },
      ])
    })
  })

  it('a non-member sees nothing and cannot insert for a foreign company', async () => {
    const { userId: ownerId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.woocommerce_connections (company_id, user_id, store_url, status)
       VALUES ($1, $2, $3, 'active')`,
      [companyId, ownerId, uniqueStore('foreign')],
    )
    const { userId: outsiderId } = await seedCompany() // member of a DIFFERENT company

    await withUserContext(outsiderId, async (client) => {
      const read = await client.query(
        `SELECT id FROM public.woocommerce_connections WHERE company_id = $1`,
        [companyId],
      )
      expect(read.rows).toHaveLength(0)

      await expect(
        client.query(
          `INSERT INTO public.woocommerce_connections (company_id, user_id, store_url, status)
           VALUES ($1, $2, 'https://intruder.example.se', 'pending')`,
          [companyId, outsiderId],
        ),
      ).rejects.toThrow(/row-level security/i)
    })
  })

  it('a company may hold several ACTIVE connections (multi-store)', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.woocommerce_connections (company_id, user_id, store_url, status)
       VALUES ($1, $2, $3, 'active')`,
      [companyId, userId, uniqueStore('store-one')],
    )
    const second = await getPool().query(
      `INSERT INTO public.woocommerce_connections (company_id, user_id, store_url, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [companyId, userId, uniqueStore('store-two')],
    )
    expect(second.rows).toHaveLength(1)
  })

  it('a store may be actively connected to at most one company', async () => {
    const { userId: userA, companyId: companyA } = await seedCompany()
    const { userId: userB, companyId: companyB } = await seedCompany()
    const sharedUrl = uniqueStore('shared')
    await getPool().query(
      `INSERT INTO public.woocommerce_connections (company_id, user_id, store_url, status)
       VALUES ($1, $2, $3, 'active')`,
      [companyA, userA, sharedUrl],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.woocommerce_connections (company_id, user_id, store_url, status)
         VALUES ($1, $2, $3, 'active')`,
        [companyB, userB, sharedUrl],
      ),
    ).rejects.toMatchObject({ code: '23505' })

    // A revoked row for the same store is fine (history is kept).
    const revoked = await getPool().query(
      `INSERT INTO public.woocommerce_connections (company_id, user_id, store_url, status)
       VALUES ($1, $2, $3, 'revoked') RETURNING id`,
      [companyB, userB, sharedUrl],
    )
    expect(revoked.rows).toHaveLength(1)
  })

  it('members cannot DELETE (no DELETE policy; revoke is a status flip)', async () => {
    const { userId, companyId } = await seedCompany()
    const { rows } = await getPool().query(
      `INSERT INTO public.woocommerce_connections (company_id, user_id, store_url, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [companyId, userId, uniqueStore('keep')],
    )
    await withUserContext(userId, async (client) => {
      const del = await client.query(
        `DELETE FROM public.woocommerce_connections WHERE id = $1`,
        [rows[0].id],
      )
      expect(del.rowCount).toBe(0)
    })
    const still = await getPool().query(
      `SELECT id FROM public.woocommerce_connections WHERE id = $1`,
      [rows[0].id],
    )
    expect(still.rows).toHaveLength(1)
  })
})
