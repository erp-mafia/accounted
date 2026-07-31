import { describe, it, expect } from 'vitest'
import { discoverAtoms, type DiscoveredAtom } from '../lib/atom-discovery'

// Runs against the real .claude/skills tree (deterministic, committed content).
// Vitest's cwd is the repo root.
let atoms: DiscoveredAtom[]

async function load(): Promise<DiscoveredAtom[]> {
  if (!atoms) atoms = await discoverAtoms(process.cwd())
  return atoms
}

describe('discoverAtoms: reference children', () => {
  it('emits top-level skills with parent_atom_id null', async () => {
    const all = await load()
    const vat = all.find((a) => a.id === 'horizontal/swedish-vat')
    expect(vat, 'swedish-vat skill should be discovered').toBeDefined()
    expect(vat!.parent_atom_id).toBeNull()
  })

  it('emits one child atom per references/*.md, linked to its parent', async () => {
    const all = await load()
    const child = all.find(
      (a) => a.id === 'horizontal/swedish-vat/vat-compliance-reference',
    )
    expect(child, 'reference child should be discovered').toBeDefined()
    expect(child!.parent_atom_id).toBe('horizontal/swedish-vat')
    expect(child!.tier).toBe('horizontal')
    // Child body is the raw reference file (its own heading), not the SKILL.md.
    expect(child!.body).toContain('# Swedish VAT (Moms) Complete Compliance Reference')
    expect(child!.estimated_tokens).toBeGreaterThan(0)
  })

  it('appends a Loadable references footer to parents that have references', async () => {
    const all = await load()
    const vat = all.find((a) => a.id === 'horizontal/swedish-vat')!
    expect(vat.body).toContain('## Loadable references')
    // The footer bridges the router filename to the loadable child id.
    expect(vat.body).toContain(
      'gnubok_load_skill("horizontal/swedish-vat/vat-compliance-reference")',
    )
  })

  it('does not put the footer inside reference children themselves', async () => {
    const all = await load()
    for (const a of all.filter((x) => x.parent_atom_id !== null)) {
      expect(a.body, `child ${a.id} should not carry the footer`).not.toContain(
        '## Loadable references',
      )
    }
  })

  it('discovers product-tier atoms from .claude/skills/product/<slug>/', async () => {
    const all = await load()
    const mallar = all.find((a) => a.id === 'product/bokforingsmallar')
    expect(mallar, 'product atom should be discovered').toBeDefined()
    expect(mallar!.tier).toBe('product')
    expect(mallar!.parent_atom_id).toBeNull()
    expect(mallar!.body).toContain('Betalning')
    // The tier README is a file, not a skill directory: it must never become an atom.
    expect(all.some((a) => a.id.startsWith('product/readme'))).toBe(false)
  })

  it('every child parent_atom_id resolves to a real top-level skill', async () => {
    const all = await load()
    const topLevelIds = new Set(all.filter((a) => a.parent_atom_id === null).map((a) => a.id))
    const children = all.filter((a) => a.parent_atom_id !== null)
    expect(children.length).toBeGreaterThan(0)
    for (const c of children) {
      expect(topLevelIds.has(c.parent_atom_id!), `${c.id} → ${c.parent_atom_id}`).toBe(true)
    }
  })
})
