import { describe, expect, it } from 'vitest'
import { getClient, getPool, withUserContext } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Covers the 2026-07-09 Supabase-advisor lockdowns:
// - 20260710100000: exchange_rates INSERT is service-role only
// - 20260710101000: duplicate journal_entry_lines(journal_entry_id) index dropped
// - 20260710102000: receipts storage bucket has no anon read/listing policy
describe('db-advisor lockdowns.pg', () => {
  describe('exchange_rates: writes are service-role only', () => {
    it('rejects INSERT from an authenticated user', async () => {
      const { userId } = await seedCompany()
      await withUserContext(userId, async (client) => {
        await expect(
          client.query(
            `INSERT INTO public.exchange_rates (currency, rate_date, rate, observation_date)
             VALUES ('EUR', '2026-01-02', 999.99, '2026-01-02')`,
          ),
        ).rejects.toThrow(/permission denied|row-level security/i)
      })
    })

    it('still lets authenticated users SELECT cached rates', async () => {
      // Seeding through the superuser pool stands in for the service-role
      // writer: both bypass RLS.
      await getPool().query(
        `INSERT INTO public.exchange_rates (currency, rate_date, rate, observation_date)
         VALUES ('EUR', '2026-01-05', 11.42, '2026-01-05')
         ON CONFLICT (currency, rate_date) DO NOTHING`,
      )
      const { userId } = await seedCompany()
      const rows = await withUserContext(userId, async (client) => {
        const res = await client.query<{ rate: string }>(
          `SELECT rate FROM public.exchange_rates
            WHERE currency = 'EUR' AND rate_date = '2026-01-05'`,
        )
        return res.rows
      })
      expect(rows).toHaveLength(1)
      expect(Number(rows[0]!.rate)).toBeCloseTo(11.42)
    })

    it('has no INSERT policy and no INSERT privilege for anon/authenticated', async () => {
      const pol = await getPool().query(
        `SELECT polname FROM pg_policy
          WHERE polrelid = 'public.exchange_rates'::regclass AND polcmd = 'a'`,
      )
      expect(pol.rows).toHaveLength(0)

      const priv = await getPool().query<{ auth_can: boolean; anon_can: boolean }>(
        `SELECT has_table_privilege('authenticated', 'public.exchange_rates', 'INSERT') AS auth_can,
                has_table_privilege('anon', 'public.exchange_rates', 'INSERT') AS anon_can`,
      )
      expect(priv.rows[0]!.auth_can).toBe(false)
      expect(priv.rows[0]!.anon_can).toBe(false)
    })
  })

  describe('journal_entry_lines: duplicate index dropped', () => {
    it('keeps idx_journal_entry_lines_entry_id and not idx_journal_entry_lines_entry', async () => {
      const res = await getPool().query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'journal_entry_lines'
            AND indexname IN ('idx_journal_entry_lines_entry', 'idx_journal_entry_lines_entry_id')`,
      )
      const names = res.rows.map((r) => r.indexname)
      expect(names).toContain('idx_journal_entry_lines_entry_id')
      expect(names).not.toContain('idx_journal_entry_lines_entry')
    })
  })

  describe('receipts storage bucket: anon cannot read or list', () => {
    it('storage.objects has no receipts_public_read policy', async () => {
      const res = await getPool().query(
        `SELECT polname FROM pg_policy
          WHERE polrelid = 'storage.objects'::regclass AND polname = 'receipts_public_read'`,
      )
      expect(res.rows).toHaveLength(0)
    })

    it('anon listing of the receipts bucket returns nothing', async () => {
      await getPool().query(
        `INSERT INTO storage.buckets (id, name, public)
         VALUES ('receipts', 'receipts', true)
         ON CONFLICT (id) DO NOTHING`,
      )
      await getPool().query(
        `INSERT INTO storage.objects (bucket_id, name)
         VALUES ('receipts', 'someone-elses-folder/receipt.jpg')
         ON CONFLICT (bucket_id, name) DO NOTHING`,
      )
      const client = await getClient()
      try {
        await client.query('BEGIN')
        await client.query(`SELECT set_config('request.jwt.claims', '{"role":"anon"}', true)`)
        await client.query('SET LOCAL ROLE anon')
        // Either outcome proves listing is impossible for anon: zero rows via
        // RLS (no anon SELECT policy left), or no table privilege at all.
        try {
          const res = await client.query(
            `SELECT name FROM storage.objects WHERE bucket_id = 'receipts'`,
          )
          expect(res.rows).toHaveLength(0)
        } catch (err) {
          expect(String(err)).toMatch(/permission denied/i)
        }
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
    })
  })
})
