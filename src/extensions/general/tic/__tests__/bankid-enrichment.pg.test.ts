import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser } from '@/tests/pg/fixtures'

// RLS coverage for `bankid_enrichment` (migration 20260506160000). The table
// holds CompanyRoles fetched via TIC right after BankID auth and is keyed by
// user_id. Reads must be scoped to auth.uid(); writes are service-role only
// (no INSERT/UPDATE policy → RLS denies for authenticated).

async function seedEnrichment(userId: string, roles: unknown[]): Promise<void> {
  await getPool().query(
    `INSERT INTO public.bankid_enrichment (user_id, company_roles, enriched_at_utc)
     VALUES ($1, $2::jsonb, now())`,
    [userId, JSON.stringify(roles)],
  )
}

describe('bankid_enrichment RLS', () => {
  it("lets a user read their own enrichment row", async () => {
    const userA = await insertAuthUser()
    await seedEnrichment(userA, [{ orgNumber: '5560000001', position: 'VD' }])

    await withUserContext(userA, async (client) => {
      const { rows } = await client.query<{ user_id: string }>(
        'SELECT user_id FROM public.bankid_enrichment WHERE user_id = $1',
        [userA],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.user_id).toBe(userA)
    })
  })

  it("hides another user's enrichment row", async () => {
    const userA = await insertAuthUser()
    const userB = await insertAuthUser()
    await seedEnrichment(userA, [{ orgNumber: '5560000001' }])
    await seedEnrichment(userB, [{ orgNumber: '5560000002' }])

    // Querying as userA must not see userB's row even with an explicit filter.
    await withUserContext(userA, async (client) => {
      const { rows } = await client.query(
        'SELECT user_id FROM public.bankid_enrichment WHERE user_id = $1',
        [userB],
      )
      expect(rows).toHaveLength(0)

      // Unfiltered SELECT must return only userA's row.
      const all = await client.query<{ user_id: string }>(
        'SELECT user_id FROM public.bankid_enrichment',
      )
      const seen = new Set(all.rows.map((r) => r.user_id))
      expect(seen.has(userA)).toBe(true)
      expect(seen.has(userB)).toBe(false)
    })
  })

  it('denies INSERT from authenticated role (service-role only)', async () => {
    const userA = await insertAuthUser()

    // The migration grants only SELECT to authenticated; writes go through
    // the service role inside the TIC extension's BankID complete handler.
    await withUserContext(userA, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.bankid_enrichment (user_id, company_roles)
           VALUES ($1, '[]'::jsonb)`,
          [userA],
        ),
      ).rejects.toThrow(/row-level security/i)
    })
  })
})
