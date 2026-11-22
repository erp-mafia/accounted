import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Migration 20261120002600: the skattekonto's "Slutlig skatt" settles the
 * year's tax provision (2512) in an aktiebolag and is the owner's eget uttag
 * (2013) in an enskild firma. "Beslut … Debiterad preliminärskatt", the
 * credit that comes with it, keeps the preliminärskatt seed.
 *
 * The first-match query below is the resolver's own walk
 * (matchSkattekontoRule in extensions/general/skatteverket/lib/
 * skattekonto-booking.ts): active rules by priority then id, a rule matches
 * when any comma-separated lowercase pattern is a substring of the text.
 */

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261120002600_skattekonto_rules_slutlig_skatt.sql'),
  'utf8',
)

async function firstSeedMatch(
  text: string,
): Promise<{ counter_account: string; counter_account_ef: string | null; label: string } | null> {
  const res = await getPool().query<{ counter_account: string; counter_account_ef: string | null; label: string }>(
    `SELECT r.counter_account, r.counter_account_ef, r.label
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

describe('skattekonto_rules.pg: slutlig skatt (20261120002600)', () => {
  it('books slutlig skatt against 2512 in an aktiebolag and 2013 in an enskild firma', async () => {
    expect(await firstSeedMatch('Slutlig skatt')).toEqual({
      counter_account: '2512',
      counter_account_ef: '2013',
      label: 'Slutlig skatt',
    })
    expect((await firstSeedMatch('Omräkning slutlig skatt'))?.counter_account).toBe('2512')
  })

  it("leaves the preliminärskatt credit that comes with the beslut on the preliminärskatt seed", async () => {
    const match = await firstSeedMatch('Beslut 20260615 Debiterad preliminärskatt')
    expect(match?.label).toBe('Preliminär skatt')
  })

  it('sends a penalty on the slutlig skatt to the penalty seed first', async () => {
    expect((await firstSeedMatch('Skattetillägg slutlig skatt'))?.counter_account).toBe('6992')
  })

  it('is a system seed every company reads through RLS', async () => {
    const { userId } = await seedCompany()
    const rows = await withUserContext(userId, async (client) => {
      const res = await client.query<{ counter_account: string; priority: number }>(
        `SELECT counter_account, priority FROM public.skattekonto_rules
          WHERE company_id IS NULL AND pattern = 'slutlig skatt'`,
      )
      return res.rows
    })
    expect(rows).toEqual([{ counter_account: '2512', priority: 20 }])
  })

  it('is idempotent: a replay adds no second rule', async () => {
    await getPool().query(MIGRATION_SQL)
    const res = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.skattekonto_rules WHERE company_id IS NULL AND pattern = 'slutlig skatt'`,
    )
    expect(res.rows[0].n).toBe('1')
  })
})
