import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { loadPacks, packToLibraryRow, sortPacks } from '@/lib/packs/load'
import seeded from './fixtures/seeded-system-templates.json'

/**
 * The pack catalogue must not drift from the seeded templates by ACCIDENT.
 *
 * The fixture is not hand-written: it was read out of a Postgres that had all
 * 548 migrations applied, so it is exactly the JSONB the database holds today.
 * The port was lossless when it landed, which is what makes phase 2b (swapping
 * the seeded rows for the loader) a no-op for existing companies.
 *
 * Templates have since been fixed on purpose. Each deliberate change is listed
 * in INTENTIONAL_DIVERGENCES with its reason, and the list is policed from both
 * sides: a pack NOT listed must still match the seed exactly, and a pack that
 * IS listed must actually differ. So an unnoticed edit fails the build, and a
 * stale entry cannot linger after a template is reverted.
 */

/**
 * Packs that deliberately no longer match what migration 20260413160000 seeds.
 * Every entry is a defect found by the pack validator and fixed with a domain
 * source cited in the commit.
 */
const INTENTIONAL_DIVERGENCES: Record<string, string> = {
  loneutbetalning:
    'Seeded version debited 2710 @0.3 + 2920 @0.12 + 7010 @1.0 against a single 1.0 credit, ' +
    'so it totalled 1.42x the amount and could never post. Rebuilt per the swedish-payroll ' +
    'skill: Debit 7010 gross, Credit 2710 tax, Credit 1930 net. The 2920 semesterlöneskuld ' +
    'line moved out because vacation accrual is its own verifikat (7290/2920).',
  'periodiseringsfond-avsattning-ab':
    'Seeded version used account 2113, i.e. the fund for tax year 2013 under the pre-2020 ' +
    'year-tagged block. Those funds had to be reversed years ago and the account is not in ' +
    'BAS 2026, so the template could not resolve. Now uses 2110 Periodiseringsfonder, which ' +
    'does not rot annually; the legal_note points at the year-tagged 2120-2129 alternative.',
  'periodiseringsfond-aterforing-ab': 'Same 2113 fix as periodiseringsfond-avsattning-ab.',
}

interface SeededTemplate {
  name: string
  description: string
  category: string
  entity_type: string
  lines: Array<Record<string, unknown>>
}

const ROOT = path.resolve(__dirname, '../../..')

/** Compare by value: jsonb does not preserve key order, so neither do we. */
function canonical(t: {
  name: string
  description: string
  category: string
  entity_type: string
  lines: Array<Record<string, unknown>>
}): string {
  return JSON.stringify({
    name: t.name,
    description: t.description,
    category: t.category,
    entity_type: t.entity_type,
    lines: t.lines.map((l) =>
      Object.fromEntries(Object.entries(l).sort(([a], [b]) => a.localeCompare(b))),
    ),
  })
}

describe('pack catalogue is a lossless port of the seeded system templates', () => {
  const { packs, errors } = loadPacks(ROOT)

  it('every pack file parses and passes the schema', () => {
    expect(errors, `pack load errors:\n${errors.map((e) => `${e.file}: ${e.message}`).join('\n')}`).toEqual([])
    expect(packs.length).toBeGreaterThan(0)
  })

  it('reproduces the seeded templates exactly, except where we deliberately fixed one', () => {
    const unchanged = packs.filter((p) => !(p.pack.meta.slug in INTENTIONAL_DIVERGENCES))
    const changedNames = new Set(
      packs
        .filter((p) => p.pack.meta.slug in INTENTIONAL_DIVERGENCES)
        .map((p) => p.pack.meta.name),
    )

    const fromPacks = unchanged.map((p) => canonical(packToLibraryRow(p.pack))).sort()
    const fromDb = (seeded as SeededTemplate[])
      .filter((t) => !changedNames.has(t.name))
      .map(canonical)
      .sort()

    expect(fromPacks).toHaveLength(fromDb.length)
    expect(fromPacks).toEqual(fromDb)
  })

  it('every declared divergence actually diverges, so the list cannot go stale', () => {
    const byName = new Map((seeded as SeededTemplate[]).map((t) => [t.name, canonical(t)]))

    for (const slug of Object.keys(INTENTIONAL_DIVERGENCES)) {
      const pack = packs.find((p) => p.pack.meta.slug === slug)
      expect(pack, `${slug} is in INTENTIONAL_DIVERGENCES but no such pack exists`).toBeDefined()
      const seededForm = byName.get(pack!.pack.meta.name)
      expect(seededForm, `no seeded template named "${pack!.pack.meta.name}"`).toBeDefined()
      expect(
        canonical(packToLibraryRow(pack!.pack)),
        `${slug} is listed as diverging but matches the seed: remove its entry`,
      ).not.toBe(seededForm)
    }
  })

  it('covers all 26 seeded templates, none added and none dropped', () => {
    expect(packs).toHaveLength((seeded as SeededTemplate[]).length)
    expect(packs).toHaveLength(26)
  })

  it('preserves shipped Swedish text verbatim, em dashes included', () => {
    // Five seeded descriptions/names contain an em dash. The repo style rule
    // forbids writing new ones, but a lossless port must not silently rewrite
    // user-visible strings: changing them is a content decision, not a format
    // one. This test pins that so a future cleanup is deliberate.
    const packText = packs.map((p) => `${p.pack.meta.name} ${p.pack.meta.description}`).join('\n')
    const dbText = (seeded as SeededTemplate[]).map((t) => `${t.name} ${t.description}`).join('\n')

    const countEmDash = (s: string) => (s.match(/—/g) ?? []).length
    expect(countEmDash(packText)).toBe(countEmDash(dbText))
    expect(countEmDash(packText)).toBeGreaterThan(0)
  })
})

describe('catalogue invariants', () => {
  const { packs } = loadPacks(ROOT)

  it('has a unique slug per pack, matching its filename', () => {
    const slugs = packs.map((p) => p.pack.meta.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const p of packs) expect(p.fileSlug).toBe(p.pack.meta.slug)
  })

  it('has a unique meta.order, so gallery and docs can never disagree', () => {
    const orders = packs.map((p) => p.pack.meta.order)
    expect(new Set(orders).size).toBe(orders.length)
  })

  it('sorts deterministically by meta.order', () => {
    const ordered = sortPacks(packs).map((p) => p.pack.meta.order)
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b))
  })
})
