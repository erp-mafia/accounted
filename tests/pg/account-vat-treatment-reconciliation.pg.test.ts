import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'

const migration = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
  .replaceAll('public.chart_of_accounts', 'pg_temp.vat_constraint_probe')
const legacy = migration('20260815150300_enforce_class_aware_account_vat_treatment.sql')
const repair = migration('20260914144843_reconcile_account_vat_treatment_oss.sql')
const current = migration('20260822093000_account_vat_treatment_oss.sql')

describe('account VAT constraint reconciliation', () => {
  it.each([['pre-OSS', legacy], ['current', current]])('repairs %s schema and preserves class restrictions', async (_, initial) => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      // Replay the real migration on an isolated table: historical DDL must
      // never temporarily downgrade another staging company's live chart.
      await client.query('CREATE TEMP TABLE vat_constraint_probe (account_class integer, default_vat_treatment text) ON COMMIT DROP')
      await client.query(initial)
      const constraint = () => client.query("SELECT oid, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'pg_temp.vat_constraint_probe'::regclass AND conname = 'chart_of_accounts_default_vat_treatment_check'")
      const original = await constraint()
      await client.query(repair)
      if (initial === current) expect((await constraint()).rows).toEqual(original.rows)
      await client.query("INSERT INTO vat_constraint_probe VALUES (3, 'oss'), (3, 'standard_25'), (4, 'reverse_charge_eu_goods'), (7, NULL)")
      for (const [accountClass, treatment] of [[4, 'oss'], [1, 'oss'], [4, 'standard_25'], [3, 'unknown']]) {
        await client.query('SAVEPOINT invalid_treatment')
        await expect(client.query('INSERT INTO vat_constraint_probe VALUES ($1, $2)', [accountClass, treatment]))
          .rejects.toMatchObject({ code: '23514', constraint: 'chart_of_accounts_default_vat_treatment_check' })
        await client.query('ROLLBACK TO SAVEPOINT invalid_treatment')
      }
      const before = await constraint()
      await client.query(repair)
      expect((await constraint()).rows).toEqual(before.rows)
      expect((await client.query('SELECT count(*)::integer AS count FROM vat_constraint_probe')).rows[0].count).toBe(4)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})
