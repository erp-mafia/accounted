import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser } from '@/tests/pg/fixtures'

// RLS coverage for `company_formations` (migration 20261120090809). A
// formation draft belongs to one user before any company exists. The owner
// reads it; every write goes through the service role, so an authenticated
// client can neither create nor change a row (payment and company columns
// included).

async function seedFormation(userId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.company_formations (user_id, answers) VALUES ($1, '{"names":["Test AB"]}'::jsonb) RETURNING id`,
    [userId],
  )
  return rows[0]!.id
}

describe('company_formations RLS', () => {
  it('lets the owner read their own formation', async () => {
    const userA = await insertAuthUser()
    const id = await seedFormation(userA)
    await withUserContext(userA, async (client) => {
      const { rows } = await client.query<{ id: string }>('SELECT id FROM public.company_formations')
      expect(rows.map((r) => r.id)).toContain(id)
    })
  })

  it("hides another user's formation", async () => {
    const userA = await insertAuthUser()
    const userB = await insertAuthUser()
    const idB = await seedFormation(userB)
    await withUserContext(userA, async (client) => {
      const { rows } = await client.query('SELECT id FROM public.company_formations WHERE id = $1', [idB])
      expect(rows).toHaveLength(0)
    })
  })

  it('refuses writes from an authenticated client', async () => {
    const userA = await insertAuthUser()
    const id = await seedFormation(userA)
    await withUserContext(userA, async (client) => {
      await expect(
        client.query(`INSERT INTO public.company_formations (user_id) VALUES ($1)`, [userA]),
      ).rejects.toThrow(/permission denied|row-level security/i)
    })
    await withUserContext(userA, async (client) => {
      await expect(
        client.query(`UPDATE public.company_formations SET status = 'paid', paid_at = now() WHERE id = $1`, [id]),
      ).rejects.toThrow(/permission denied|row-level security/i)
    })
  })

  it('keeps a paid formation stamped with its payment time', async () => {
    const userA = await insertAuthUser()
    await expect(
      getPool().query(`INSERT INTO public.company_formations (user_id, status) VALUES ($1, 'paid')`, [userA]),
    ).rejects.toThrow(/company_formations_paid_has_time/)
  })

  it('lets a formation be sent in without a payment (the package is free)', async () => {
    const userA = await insertAuthUser()
    const { rows } = await getPool().query(
      `INSERT INTO public.company_formations (user_id, status, submitted_at, deed_date) VALUES ($1, 'submitted', now(), current_date) RETURNING status`,
      [userA],
    )
    expect(rows[0].status).toBe('submitted')
  })
})
