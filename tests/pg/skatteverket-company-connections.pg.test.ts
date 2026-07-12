/**
 * pg-real tests for skatteverket_company_connections
 * (20260712092000_skatteverket_company_connections.sql).
 *
 * Verifies:
 *   - table exists with RLS enabled and the expected CHECK constraints
 *   - members can SELECT their own company's connection row
 *   - cross-company SELECT returns nothing
 *   - user sessions cannot INSERT/UPDATE (no policies exist: all writes go
 *     through the service-role client in connection-store.ts)
 *   - UNIQUE (company_id, environment)
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

async function seedConnection(companyId: string, createdBy: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.skatteverket_company_connections
       (id, company_id, environment, org_number, status, lasombud_status, created_by)
     VALUES ($1, $2, 'test', '165560000000', 'partial', 'granted', $3)`,
    [id, companyId, createdBy],
  )
  return id
}

describe('skatteverket_company_connections schema', () => {
  it('exists with RLS enabled', async () => {
    const result = await getPool().query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'skatteverket_company_connections'`,
    )
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].relrowsecurity).toBe(true)
  })

  it('rejects invalid environment / status / grant values', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })

    await expect(
      getPool().query(
        `INSERT INTO public.skatteverket_company_connections
           (company_id, environment, org_number) VALUES ($1, 'staging', 'x')`,
        [companyId],
      ),
    ).rejects.toThrow()

    await expect(
      getPool().query(
        `INSERT INTO public.skatteverket_company_connections
           (company_id, environment, org_number, status) VALUES ($1, 'test', 'x', 'weird')`,
        [companyId],
      ),
    ).rejects.toThrow()

    await expect(
      getPool().query(
        `INSERT INTO public.skatteverket_company_connections
           (company_id, environment, org_number, lasombud_status) VALUES ($1, 'test', 'x', 'maybe')`,
        [companyId],
      ),
    ).rejects.toThrow()
  })

  it('enforces UNIQUE (company_id, environment)', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await seedConnection(companyId, userId)

    await expect(seedConnection(companyId, userId)).rejects.toThrow()

    // A different environment for the same company is fine.
    await getPool().query(
      `INSERT INTO public.skatteverket_company_connections
         (company_id, environment, org_number) VALUES ($1, 'production', '165560000000')`,
      [companyId],
    )
  })

  it('members can SELECT their own company connection; other companies cannot', async () => {
    const owner = await insertAuthUser()
    const outsider = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: owner })
    const otherCompanyId = await insertCompany({ createdBy: outsider })
    await insertCompanyMember({ companyId, userId: owner })
    await insertCompanyMember({ companyId: otherCompanyId, userId: outsider })
    const connectionId = await seedConnection(companyId, owner)

    const ownRows = await withUserContext(owner, async (client) => {
      const res = await client.query(
        `SELECT id FROM public.skatteverket_company_connections WHERE company_id = $1`,
        [companyId],
      )
      return res.rows
    })
    expect(ownRows).toHaveLength(1)
    expect(ownRows[0].id).toBe(connectionId)

    const crossRows = await withUserContext(outsider, async (client) => {
      const res = await client.query(
        `SELECT id FROM public.skatteverket_company_connections WHERE company_id = $1`,
        [companyId],
      )
      return res.rows
    })
    expect(crossRows).toHaveLength(0)
  })

  it('user sessions cannot INSERT or UPDATE (service-role writes only)', async () => {
    const owner = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: owner })
    await insertCompanyMember({ companyId, userId: owner })
    await seedConnection(companyId, owner)

    await expect(
      withUserContext(owner, async (client) => {
        await client.query(
          `INSERT INTO public.skatteverket_company_connections
             (company_id, environment, org_number) VALUES ($1, 'production', 'x')`,
          [companyId],
        )
      }),
    ).rejects.toThrow()

    // UPDATE without a policy silently affects 0 rows under RLS.
    const updated = await withUserContext(owner, async (client) => {
      const res = await client.query(
        `UPDATE public.skatteverket_company_connections
            SET status = 'verified'
          WHERE company_id = $1
          RETURNING id`,
        [companyId],
      )
      return res.rowCount
    })
    expect(updated).toBe(0)
  })
})
