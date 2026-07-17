/**
 * pg-real: company_obx_registry unique constraint.
 * Run with: npm run test:pg (requires Docker Postgres).
 */

import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

describe('company_obx_registry', () => {
  it('accepts a registry row and rejects duplicate (company, year, hash)', async () => {
    const { userId, companyId } = await seedCompany()
    const hash = `hash_${companyId.slice(0, 8)}`

    await expect(
      getPool().query(
        `INSERT INTO public.company_obx_registry
           (company_id, user_id, fiscal_year, manifest_hash, origin_system, custody_json)
         VALUES ($1, $2, '2099', $3, 'pg-test', '[]'::jsonb)`,
        [companyId, userId, hash],
      ),
    ).resolves.toBeDefined()

    await expect(
      getPool().query(
        `INSERT INTO public.company_obx_registry
           (company_id, user_id, fiscal_year, manifest_hash, origin_system, custody_json)
         VALUES ($1, $2, '2099', $3, 'pg-test', '[]'::jsonb)`,
        [companyId, userId, hash],
      ),
    ).rejects.toThrow(/duplicate|unique/i)
  })
})
