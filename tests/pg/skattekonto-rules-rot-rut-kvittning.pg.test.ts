import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Migration 20261018132300 (crm#1255): the skattekonto's "Kvittning av
 * utbetalning för rot- och rutarbeten" is a rot/rut payout set off on the
 * skattekonto, not a bank movement. The seeded rules must send it to the
 * 1513 receivable ahead of the generic 'utbetalning' rule, and leave every
 * other text where it was.
 *
 * The first-match query below is the resolver's own walk
 * (matchSkattekontoRule in extensions/general/skatteverket/lib/
 * skattekonto-booking.ts): active rules by priority then id, a rule matches
 * when any comma-separated lowercase pattern is a substring of the text.
 */

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261018132300_skattekonto_rules_rot_rut_kvittning.sql'),
  'utf8',
)

async function firstSeedMatch(text: string): Promise<{ counter_account: string; label: string } | null> {
  const res = await getPool().query<{ counter_account: string; label: string }>(
    `SELECT r.counter_account, r.label
       FROM public.skattekonto_rules r
      WHERE r.company_id IS NULL
        AND r.active
        AND EXISTS (
          SELECT 1 FROM unnest(string_to_array(r.pattern, ',')) AS p(part)
           WHERE length(trim(p.part)) > 0
             AND position(lower(trim(p.part)) IN lower($1)) > 0
        )
      ORDER BY r.priority, r.id
      LIMIT 1`,
    [text],
  )
  return res.rows[0] ?? null
}

describe('skattekonto_rules.pg: rot/rut kvittning (20261018132300)', () => {
  it('sends the kvittning to the 1513 receivable, ahead of the generic payout rule', async () => {
    expect(await firstSeedMatch('Kvittning av utbetalning för rot- och rutarbeten')).toEqual({
      counter_account: '1513',
      label: 'Rot/rut-utbetalning kvittad på skattekontot',
    })
  })

  it('keeps an ordinary payout and a returned payout on the primary bank account', async () => {
    expect((await firstSeedMatch('Utbetalning'))?.counter_account).toBe('__PRIMARY_SEK__')
    expect((await firstSeedMatch('Återsänd utbetalning från bank'))?.counter_account).toBe('__PRIMARY_SEK__')
  })

  it("matches nothing for a private buyer's preliminär skattereduktion", async () => {
    expect(await firstSeedMatch('Preliminär skattereduktion för rot/rut/grön teknik')).toBeNull()
  })

  it('leaves the other seeds as they were', async () => {
    expect((await firstSeedMatch('Arbetsgivaravgift sept 2026'))?.counter_account).toBe('2731')
    expect((await firstSeedMatch('Moms jul 2026'))?.counter_account).toBe('2650')
  })

  it('is a system seed every company reads through RLS', async () => {
    const { userId } = await seedCompany()
    const rows = await withUserContext(userId, async (client) => {
      const res = await client.query<{ counter_account: string; priority: number }>(
        `SELECT counter_account, priority FROM public.skattekonto_rules
          WHERE company_id IS NULL AND pattern LIKE 'kvittning av utbetalning för rot%'`,
      )
      return res.rows
    })
    expect(rows).toEqual([{ counter_account: '1513', priority: 5 }])
  })

  it('is idempotent: a replay adds no second rule', async () => {
    await getPool().query(MIGRATION_SQL)
    const res = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.skattekonto_rules
        WHERE company_id IS NULL AND pattern LIKE 'kvittning av utbetalning för rot%'`,
    )
    expect(res.rows[0]?.n).toBe('1')
  })
})
