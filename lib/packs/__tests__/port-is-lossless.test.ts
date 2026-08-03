import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { loadPacks, packToLibraryRow, sortPacks } from '@/lib/packs/load'
import seeded from './fixtures/seeded-system-templates.json'

/**
 * The port out of migration 20260413160000 must be LOSSLESS.
 *
 * The fixture is not hand-written: it was read out of a Postgres that had all
 * 548 migrations applied, so it is exactly the JSONB the database holds today.
 * If `packs/*.yaml` reproduces it byte for byte, then swapping the seeded rows
 * for the pack files (phase 2b) is a no-op for every existing company.
 *
 * This is the test that makes the format change safe to ship. If it fails, the
 * catalogue has drifted from production and the loader must not be switched on.
 */

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

  it('reproduces exactly the templates the migration seeds', () => {
    const fromPacks = packs.map((p) => canonical(packToLibraryRow(p.pack))).sort()
    const fromDb = (seeded as SeededTemplate[]).map(canonical).sort()

    expect(fromPacks).toHaveLength(fromDb.length)
    expect(fromPacks).toEqual(fromDb)
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
