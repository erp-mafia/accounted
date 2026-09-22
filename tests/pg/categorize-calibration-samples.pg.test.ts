import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

// categorize_calibration_samples after 20260922173222: the corpus is anonymous.
// company_id and amount are gone, so there is no tenant scoping left to test.
// What must hold instead: any authenticated user may insert, no tenant can read
// the corpus back (service role only), it stays append-only, and the confidence
// CHECK [0,1] still bites.

/**
 * Insert as a tenant. Deliberately no RETURNING: with no SELECT policy on the
 * table, RETURNING would have to pass a read check that does not exist, and
 * Postgres rejects the whole statement. The route inserts without .select()
 * for the same reason, so this matches production.
 */
async function insertAsTenant(
  client: { query: (q: string, p: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> },
  confidence = 0.9,
) {
  return client.query(
    `INSERT INTO public.categorize_calibration_samples
       (confidence, booked_account, was_correct)
     VALUES ($1, '5410', true)`,
    [confidence],
  )
}

/** Insert with the pool (RLS bypassed), for tests that need the row's id. */
async function insertAsService(confidence = 0.9): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO public.categorize_calibration_samples
       (confidence, booked_account, was_correct)
     VALUES ($1, '5410', true) RETURNING id`,
    [confidence],
  )
  return (rows[0] as { id: string }).id
}

describe('categorize_calibration_samples', () => {
  it('no longer carries company_id or amount', async () => {
    const { rows } = await getPool().query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'categorize_calibration_samples'`,
      [],
    )
    const columns = rows.map((r) => (r as { column_name: string }).column_name)
    expect(columns).not.toContain('company_id')
    expect(columns).not.toContain('amount')
  })

  it('lets any authenticated user insert a sample', async () => {
    const { userId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      const res = await insertAsTenant(client)
      expect(res.rowCount).toBe(1)
    })
  })

  it('refuses to hand the inserted row back (no SELECT policy to satisfy RETURNING)', async () => {
    const { userId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.categorize_calibration_samples
             (confidence, booked_account, was_correct)
           VALUES (0.9, '5410', true) RETURNING id`,
          [],
        ),
      ).rejects.toThrow()
    })
  })

  it('hides the corpus from every tenant (no SELECT policy)', async () => {
    const { userId } = await seedCompany()
    await insertAsService()
    await withUserContext(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM public.categorize_calibration_samples`,
        [],
      )
      expect(rows.length).toBe(0)
    })
  })

  it('is append-only: UPDATE and DELETE affect zero rows', async () => {
    const { userId } = await seedCompany()
    const id = await insertAsService()
    await withUserContext(userId, async (client) => {
      const upd = await client.query(
        `UPDATE public.categorize_calibration_samples SET was_correct = false WHERE id = $1`,
        [id],
      )
      expect(upd.rowCount).toBe(0)
      const del = await client.query(
        `DELETE FROM public.categorize_calibration_samples WHERE id = $1`,
        [id],
      )
      expect(del.rowCount).toBe(0)
    })
  })

  it('enforces the confidence CHECK [0,1]', async () => {
    await expect(
      getPool().query(
        `INSERT INTO public.categorize_calibration_samples (confidence, booked_account, was_correct)
         VALUES (2, '5410', true)`,
        [],
      ),
    ).rejects.toThrow()
  })
})
