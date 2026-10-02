import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverAtoms, parseAreas, type DiscoveredAtom } from '../lib/atom-discovery'

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

describe('discoverAtoms: reference audience', () => {
  it('marks developer references and keeps them out of the parent footer', async () => {
    const all = await load()
    const encoding = all.find((a) => a.id === 'horizontal/swedish-sie-import-export/encoding')!
    expect(encoding.audience).toBe('developer')
    const parent = all.find((a) => a.id === 'horizontal/swedish-sie-import-export')!
    expect(parent.audience).toBe('agent')
    expect(parent.body).not.toContain('gnubok_load_skill("horizontal/swedish-sie-import-export/encoding")')
    expect(parent.body).toContain('gnubok_load_skill("horizontal/swedish-sie-import-export/validation-rules")')
    expect(parent.body).toContain('developer material')
  })

  it('defaults to agent and leaves footers of fully agent skills unchanged', async () => {
    const all = await load()
    const vat = all.find((a) => a.id === 'horizontal/swedish-vat')!
    expect(all.find((a) => a.id === 'horizontal/swedish-vat/vat-compliance-reference')!.audience).toBe('agent')
    expect(vat.body).not.toContain('developer material')
  })

  it('rejects an unknown audience value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atoms-'))
    try {
      const dir = join(root, '.claude', 'skills', 'swedish-test')
      await mkdir(join(dir, 'references'), { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), '---\nname: swedish-test\ndescription: Test skill.\n---\n\n# Test\n')
      await writeFile(join(dir, 'references', 'x.md'), '---\naudience: reviewers\n---\n\n# X\n')
      await expect(discoverAtoms(root)).rejects.toThrow('audience must be "agent" or "developer"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('reference areas', () => {
  it('parses an inline list and drops duplicates', () => {
    expect(parseAreas('---\nareas: [moms, fakturering, moms]\n---\n\n# X\n', 'x.md')).toEqual(['moms', 'fakturering'])
    expect(parseAreas('---\naudience: agent\nareas: ["lon"]\n---\n# X\n', 'x.md')).toEqual(['lon'])
  })

  it('treats a file without frontmatter or without areas as untagged', () => {
    expect(parseAreas('# X\n', 'x.md')).toEqual([])
    expect(parseAreas('---\naudience: agent\n---\n# X\n', 'x.md')).toEqual([])
    expect(parseAreas('---\nareas: []\n---\n# X\n', 'x.md')).toEqual([])
  })

  it('throws on an unknown area or a non-list value', () => {
    expect(() => parseAreas('---\nareas: [moms, vat]\n---\n', 'x.md')).toThrow('unknown area(s) vat')
    expect(() => parseAreas('---\nareas: moms\n---\n', 'x.md')).toThrow('inline list')
  })

  it('carries areas into the child trigger_signals and leaves untagged children empty', async () => {
    const all = await load()
    const invoice = all.find((a) => a.id === 'vertical/konsult-it/invoice-templates')!
    expect(invoice.trigger_signals).toEqual({ areas: ['fakturering'] })
    expect(all.find((a) => a.id === 'vertical/bygg-hantverk/momsregler')!.trigger_signals).toEqual({ areas: ['moms', 'fakturering'] })
    expect(all.find((a) => a.id === 'vertical/bygg-hantverk/praxis')!.trigger_signals).toEqual({})
  })

  it('rejects areas on a developer reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atoms-'))
    try {
      const dir = join(root, '.claude', 'skills', 'swedish-test')
      await mkdir(join(dir, 'references'), { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), '---\nname: swedish-test\ndescription: Test skill.\n---\n\n# Test\n')
      await writeFile(join(dir, 'references', 'x.md'), '---\naudience: developer\nareas: [moms]\n---\n\n# X\n')
      await expect(discoverAtoms(root)).rejects.toThrow('cannot declare areas')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
