import { describe, it, expect } from 'vitest'
import type { PoolClient } from 'pg'
import { randomUUID } from 'crypto'
import { getClient, getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

/**
 * Covers migration 20260923170000_rename_zettle_store:
 *   1. Renames the active connection and backfills store_label on its Zettle
 *      orders only (other connections and platforms untouched).
 *   2. Returns updated=false when the company has no active connection, and
 *      an outsider updates nothing.
 *   3. Two concurrent renames serialize on the connection row lock, so the
 *      orders always end on the same name as the connection.
 */

async function seedConnection(companyId: string, userId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.zettle_connections (company_id, user_id, organization_uuid, organization_name, status)
     VALUES ($1, $2, $3, 'Zettle', 'active') RETURNING id`,
    [companyId, userId, 'org-' + randomUUID()],
  )
  return rows[0].id
}

async function seedOrder(params: {
  companyId: string
  userId: string
  connectionId: string | null
  platform?: 'zettle' | 'shopify'
}): Promise<string> {
  const ext = 'ext-' + randomUUID()
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.webshop_orders
       (company_id, user_id, platform, store_scope, store_label, connection_id,
        external_id, platform_order_id, order_number, status, order_date, currency, total)
     VALUES ($1, $2, $3, 'scope', 'Zettle', $4, $5, $5, '1', 'completed', current_date, 'SEK', 100)
     RETURNING id`,
    [params.companyId, params.userId, params.platform ?? 'zettle', params.connectionId, ext],
  )
  return rows[0].id
}

async function storeLabel(orderId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ store_label: string | null }>(
    `SELECT store_label FROM public.webshop_orders WHERE id = $1`,
    [orderId],
  )
  return rows[0].store_label
}

/** Open a transaction as `userId` (committed by the caller, unlike withUserContext). */
async function beginAsUser(userId: string): Promise<PoolClient> {
  const client = await getClient()
  await client.query('BEGIN')
  await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ])
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
  await client.query(`SET LOCAL ROLE authenticated`)
  return client
}

describe('rename_zettle_store', () => {
  it('renames the connection and backfills its Zettle orders only', async () => {
    const { userId, companyId } = await seedCompany()
    const connectionId = await seedConnection(companyId, userId)
    const own = await seedOrder({ companyId, userId, connectionId })
    const otherConnection = await seedOrder({ companyId, userId, connectionId: randomUUID() })
    const shopify = await seedOrder({ companyId, userId, connectionId, platform: 'shopify' })

    await withUserContext(userId, async (client) => {
      const { rows } = await client.query(`SELECT public.rename_zettle_store($1, $2) AS r`, [
        companyId,
        'Café Norr',
      ])
      expect(rows[0].r).toEqual({ updated: true, backfilled: true })

      const conn = await client.query(
        `SELECT organization_name FROM public.zettle_connections WHERE id = $1`,
        [connectionId],
      )
      expect(conn.rows[0].organization_name).toBe('Café Norr')
      const labels = await client.query(
        `SELECT id, store_label FROM public.webshop_orders WHERE id = ANY($1)`,
        [[own, otherConnection, shopify]],
      )
      const byId = Object.fromEntries(labels.rows.map((r) => [r.id, r.store_label]))
      expect(byId[own]).toBe('Café Norr')
      expect(byId[otherConnection]).toBe('Zettle')
      expect(byId[shopify]).toBe('Zettle')
    })
  })

  it('returns updated=false without an active connection and for an outsider', async () => {
    const { userId, companyId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      const { rows } = await client.query(`SELECT public.rename_zettle_store($1, $2) AS r`, [
        companyId,
        'Café Norr',
      ])
      expect(rows[0].r).toEqual({ updated: false })
    })

    const { userId: ownerId, companyId: foreignCompany } = await seedCompany()
    const connectionId = await seedConnection(foreignCompany, ownerId)
    const order = await seedOrder({ companyId: foreignCompany, userId: ownerId, connectionId })
    await withUserContext(userId, async (client) => {
      const { rows } = await client.query(`SELECT public.rename_zettle_store($1, $2) AS r`, [
        foreignCompany,
        'Intruder',
      ])
      expect(rows[0].r).toEqual({ updated: false })
    })
    expect(await storeLabel(order)).toBe('Zettle')
  })

  it('serializes concurrent renames so orders end on the connection name', async () => {
    const { userId, companyId } = await seedCompany()
    const connectionId = await seedConnection(companyId, userId)
    const order = await seedOrder({ companyId, userId, connectionId })

    const first = await beginAsUser(userId)
    const second = await beginAsUser(userId)
    try {
      await first.query(`SELECT public.rename_zettle_store($1, 'A')`, [companyId])

      // The second rename must wait on the connection row lock held by the first.
      const pending = second.query(`SELECT public.rename_zettle_store($1, 'B')`, [companyId])
      const raced = await Promise.race([
        pending.then(() => 'done'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 500)),
      ])
      expect(raced).toBe('blocked')

      await first.query('COMMIT')
      await pending
      await second.query('COMMIT')
    } finally {
      await first.query('ROLLBACK').catch(() => {})
      await second.query('ROLLBACK').catch(() => {})
      first.release()
      second.release()
    }

    const conn = await getPool().query(
      `SELECT organization_name FROM public.zettle_connections WHERE id = $1`,
      [connectionId],
    )
    expect(conn.rows[0].organization_name).toBe('B')
    expect(await storeLabel(order)).toBe('B')
  })
})
