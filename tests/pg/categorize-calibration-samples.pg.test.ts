import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

// categorize_calibration_samples (20260821100000): RLS via user_company_ids()
// on SELECT + INSERT only (append-only: no UPDATE/DELETE policy), the
// confidence CHECK [0,1], and company scoping on both read and write.

async function insertSample(
  client: { query: (q: string, p: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> },
  companyId: string,
  confidence = 0.9,
) {
  return client.query(
    `INSERT INTO public.categorize_calibration_samples
       (company_id, confidence, booked_account, was_correct)
     VALUES ($1, $2, '5410', true) RETURNING id`,
    [companyId, confidence],
  )
}

describe('categorize_calibration_samples', () => {
  it('lets a member insert and read their own company samples', async () => {
    const { userId, companyId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      await insertSample(client, companyId)
      const { rows } = await client.query(
        `SELECT company_id, was_correct FROM public.categorize_calibration_samples WHERE company_id = $1`,
        [companyId],
      )
      expect(rows.length).toBe(1)
    })
  })

  it('hides another company samples (RLS SELECT)', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await insertSample({ query: (q, p) => getPool().query(q, p) } as never, a.companyId)
    await withUserContext(b.userId, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM public.categorize_calibration_samples WHERE company_id = $1`,
        [a.companyId],
      )
      expect(rows.length).toBe(0)
    })
  })

  it('refuses inserting a sample for another company (RLS WITH CHECK)', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await withUserContext(a.userId, async (client) => {
      await expect(insertSample(client, b.companyId)).rejects.toThrow()
    })
  })

  it('is append-only: UPDATE and DELETE affect zero rows', async () => {
    const { userId, companyId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      const { rows } = await insertSample(client, companyId)
      const id = (rows[0] as { id: string }).id
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
    const { companyId } = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.categorize_calibration_samples (company_id, confidence, booked_account, was_correct)
         VALUES ($1, 2, '5410', true)`,
        [companyId],
      ),
    ).rejects.toThrow()
  })
})
