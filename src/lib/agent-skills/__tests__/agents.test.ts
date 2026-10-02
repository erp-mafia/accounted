import { describe, expect, it } from 'vitest'
import { discoverAtoms } from '@/scripts/lib/atom-discovery'
import { AGENTS, AREAS, CONNECTION_SETTINGS, isCheckable } from '../agents'
import { REGISTRY_SKILLS } from '../registry'
import { predicateDef } from '@/lib/arkiv/facts/predicates'

describe('AGENTS manifest', () => {
  it('defines every curated agent and nothing else', () => {
    expect(Object.keys(AGENTS).sort()).toEqual(REGISTRY_SKILLS.map((s) => s.id).sort())
  })

  it('points only at agent-audience atoms that exist, cores at top level and references below', async () => {
    const atoms = new Map((await discoverAtoms(process.cwd())).map((a) => [a.id, a]))
    for (const [id, def] of Object.entries(AGENTS)) {
      for (const k of def.knowledge) {
        const atom = atoms.get(k)
        expect(atom, `${id}: knowledge ${k}`).toBeDefined()
        expect(atom!.parent_atom_id, `${id}: ${k} must be a top-level pack`).toBeNull()
        expect(atom!.audience).toBe('agent')
      }
      for (const r of def.references) {
        const atom = atoms.get(r)
        expect(atom, `${id}: reference ${r}`).toBeDefined()
        expect(atom!.parent_atom_id, `${id}: ${r} must be a reference`).not.toBeNull()
        expect(atom!.audience, `${id}: ${r} is developer material`).toBe('agent')
      }
    }
  })

  it('gives every agent at least one area from the fixed set', () => {
    for (const [id, def] of Object.entries(AGENTS)) {
      expect(def.areas.length, `${id}: areas`).toBeGreaterThan(0)
      for (const a of def.areas) expect(AREAS, `${id}: area ${a}`).toContain(a)
    }
  })

  it('names only company facts that exist', () => {
    for (const [id, def] of Object.entries(AGENTS)) {
      for (const f of def.facts) expect(predicateDef(f), `${id}: fact ${f}`).not.toBeNull()
    }
  })

  it('gives every checkable connection a settings page', () => {
    for (const def of Object.values(AGENTS)) {
      for (const c of def.connections) if (isCheckable(c)) expect(CONNECTION_SETTINGS[c]).toMatch(/^\/settings\//)
    }
  })
})
