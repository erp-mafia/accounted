import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'

// Migration 20261027180105: the monthly currency revaluation option.

describe('company_settings.fx_revaluation_monthly', () => {
  it('exists, is NOT NULL and defaults to false, so no company changes on deploy', async () => {
    const res = await getPool().query<{ is_nullable: string; column_default: string | null; data_type: string }>(
      `SELECT is_nullable, column_default, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'company_settings' AND column_name = 'fx_revaluation_monthly'`,
    )
    expect(res.rows).toEqual([{ is_nullable: 'NO', column_default: 'false', data_type: 'boolean' }])
  })
})
