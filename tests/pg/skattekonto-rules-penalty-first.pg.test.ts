import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPool } from '@/tests/pg/setup'

/**
 * Migration 20261027190100: a Skatteverket penalty row names the tax it
 * belongs to ("Förs.avgift moms/arbetsgivardeklaration"), so the penalty seed
 * must sort ahead of the tax seeds, and it must know Skatteverket's
 * abbreviation "Förs.avgift". Before, the moms seed booked the late fee on
 * 2650.
 *
 * The first-match query below is the resolver's own walk
 * (matchSkattekontoRule in extensions/general/skatteverket/lib/
 * skattekonto-booking.ts): active rules by priority then id, a rule matches
 * when any comma-separated lowercase pattern is a substring of the text.
 */

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261027190100_skattekonto_rules_penalty_first.sql'),
  'utf8',
)

async function firstSeedAccount(text: string): Promise<string | null> {
  const res = await getPool().query<{ counter_account: string }>(
    `SELECT r.counter_account
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
  return res.rows[0]?.counter_account ?? null
}

describe('skattekonto_rules.pg: penalty ahead of the tax rules (20261027190100)', () => {
  it('books a late fee named after the moms declaration on 6992, not 2650', async () => {
    expect(await firstSeedAccount('Förs.avgift moms/arbetsgivardeklaration')).toBe('6992')
  })

  it('books a skattetillägg on 6992 whichever tax it names', async () => {
    expect(await firstSeedAccount('Skattetillägg moms jul 2026')).toBe('6992')
    expect(await firstSeedAccount('Skattetillägg arbetsgivaravgift mars 2026')).toBe('6992')
    expect(await firstSeedAccount('Förseningsavgift periodisk sammanställning')).toBe('6992')
  })

  it('leaves the plain tax and payment rows on their own rules', async () => {
    expect(await firstSeedAccount('Moms jul 2026')).toBe('2650')
    expect(await firstSeedAccount('Skönsbeskattning moms sept 2026')).toBe('2650')
    expect(await firstSeedAccount('Arbetsgivaravgift sept 2026')).toBe('2731')
    expect(await firstSeedAccount('Avdragen skatt sept 2026')).toBe('2710')
    expect(await firstSeedAccount('Debiterad preliminärskatt')).toBe('2510')
    expect(await firstSeedAccount('Inbetalning bokförd 260912')).toBe('__PRIMARY_SEK__')
    expect(await firstSeedAccount('Kvittning av utbetalning för rot- och rutarbeten')).toBe('1513')
    expect(await firstSeedAccount('Kostnadsränta')).toBe('8423')
  })

  it('is idempotent: a replay leaves one penalty seed at priority 15', async () => {
    await getPool().query(MIGRATION_SQL)
    const res = await getPool().query<{ priority: number; pattern: string }>(
      `SELECT priority, pattern FROM public.skattekonto_rules
        WHERE company_id IS NULL AND counter_account = '6992'`,
    )
    expect(res.rows).toEqual([{ priority: 15, pattern: 'skattetillägg,förseningsavgift,förs.avgift' }])
  })
})
