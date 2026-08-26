import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { randomUUID } from 'crypto'
import { seedCompany } from './fixtures'

// Committed (pool) inserts persist across pg-real runs, and the shop_domain
// partial unique index is global: fixed domains would collide with rows left
// by a previous run before the assertion under test is ever reached.
const uniqueShop = (label: string) => label + '-' + randomUUID() + '.myshopify.com'

/**
 * Covers migration 20260808150000_shopify_connections:
 *   1. RLS: members insert and read their own company's connection,
 *      non-members see nothing and cannot insert for a foreign company.
 *   2. One ACTIVE connection per company (partial unique index).
 *   3. One store actively connected to at most one company.
 *   4. No DELETE policy: a member DELETE silently affects zero rows.
 */

describe('shopify_connections RLS', () => {
  it('a member can insert and read their company connection', async () => {
    const { userId, companyId } = await seedCompany()
    const shop = uniqueShop('member')
    await withUserContext(userId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO public.shopify_connections
           (company_id, user_id, shop_domain, status)
         VALUES ($1, $2, $3, 'active')
         RETURNING id`,
        [companyId, userId, shop],
      )
      expect(inserted.rows).toHaveLength(1)

      const read = await client.query(
        `SELECT status, shop_domain FROM public.shopify_connections WHERE company_id = $1`,
        [companyId],
      )
      expect(read.rows).toEqual([{ status: 'active', shop_domain: shop }])
    })
  })

  it('a non-member sees nothing and cannot insert for a foreign company', async () => {
    const { userId: ownerId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.shopify_connections (company_id, user_id, shop_domain, status)
       VALUES ($1, $2, $3, 'active')`,
      [companyId, ownerId, uniqueShop('foreign')],
    )
    const { userId: outsiderId } = await seedCompany() // member of a DIFFERENT company

    await withUserContext(outsiderId, async (client) => {
      const read = await client.query(
        `SELECT id FROM public.shopify_connections WHERE company_id = $1`,
        [companyId],
      )
      expect(read.rows).toHaveLength(0)

      await expect(
        client.query(
          `INSERT INTO public.shopify_connections (company_id, user_id, shop_domain, status)
           VALUES ($1, $2, $3, 'pending')`,
          [companyId, outsiderId, uniqueShop('intruder')],
        ),
      ).rejects.toThrow(/row-level security/i)
    })
  })

  it('only one ACTIVE connection per company is allowed', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.shopify_connections (company_id, user_id, shop_domain, status)
       VALUES ($1, $2, $3, 'active')`,
      [companyId, userId, uniqueShop('shop-one')],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.shopify_connections (company_id, user_id, shop_domain, status)
         VALUES ($1, $2, $3, 'active')`,
        [companyId, userId, uniqueShop('shop-two')],
      ),
    ).rejects.toMatchObject({ code: '23505' }) // unique_violation
  })

  it('a store may be actively connected to at most one company', async () => {
    const { userId: userA, companyId: companyA } = await seedCompany()
    const { userId: userB, companyId: companyB } = await seedCompany()
    const sharedShop = uniqueShop('shared')
    await getPool().query(
      `INSERT INTO public.shopify_connections (company_id, user_id, shop_domain, status)
       VALUES ($1, $2, $3, 'active')`,
      [companyA, userA, sharedShop],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.shopify_connections (company_id, user_id, shop_domain, status)
         VALUES ($1, $2, $3, 'active')`,
        [companyB, userB, sharedShop],
      ),
    ).rejects.toMatchObject({ code: '23505' })

    // A revoked row for the same store is fine (history is kept).
    const revoked = await getPool().query(
      `INSERT INTO public.shopify_connections (company_id, user_id, shop_domain, status)
       VALUES ($1, $2, $3, 'revoked') RETURNING id`,
      [companyB, userB, sharedShop],
    )
    expect(revoked.rows).toHaveLength(1)
  })

  it('members cannot DELETE (no DELETE policy; revoke is a status flip)', async () => {
    const { userId, companyId } = await seedCompany()
    const { rows } = await getPool().query(
      `INSERT INTO public.shopify_connections (company_id, user_id, shop_domain, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [companyId, userId, uniqueShop('keep')],
    )
    await withUserContext(userId, async (client) => {
      const del = await client.query(
        `DELETE FROM public.shopify_connections WHERE id = $1`,
        [rows[0].id],
      )
      expect(del.rowCount).toBe(0)
    })
    const still = await getPool().query(
      `SELECT id FROM public.shopify_connections WHERE id = $1`,
      [rows[0].id],
    )
    expect(still.rows).toHaveLength(1)
  })
})
