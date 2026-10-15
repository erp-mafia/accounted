/**
 * The manifest is a contract: ids are public, every src/lib folder has an
 * owner (or is declared infrastructure), and the dependency graph is a DAG.
 * A new folder, a typo'd claim or a cycle fails here, before anything
 * resolves through it.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { INFRA_LIB_FOLDERS, MODULES, MODULE_IDS } from '../manifest'
import { effectiveDependencies, modulesInDependencyOrder } from '../resolve'

const LIB_ROOT = join(__dirname, '..', '..')

/** Every claim string in one namespace, mapped to the modules that claim it. */
function claimants(pick: (m: (typeof MODULES)[number]) => readonly string[], normalize = (s: string) => s) {
  const owners = new Map<string, string[]>()
  for (const m of MODULES) {
    for (const claim of pick(m)) {
      const key = normalize(claim)
      owners.set(key, [...(owners.get(key) ?? []), m.id])
    }
  }
  return owners
}

function duplicates(owners: Map<string, string[]>): string[] {
  return [...owners].filter(([, ids]) => ids.length > 1).map(([claim, ids]) => `${claim}: ${ids.join(', ')}`)
}

describe('module manifest', () => {
  it('declares every id in MODULE_IDS exactly once, in the same order', () => {
    expect(MODULES.map((m) => m.id)).toEqual([...MODULE_IDS])
  })

  it('uses stable kebab-case ids and complete, dash-free English and Swedish copy', () => {
    for (const m of MODULES) {
      expect(m.id, m.id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
      expect(m.name.trim(), `${m.id}: name`).not.toBe('')
      expect(m.nameSv.trim(), `${m.id}: nameSv`).not.toBe('')
      // One sentence for the API docs.
      expect(m.summary, `${m.id}: summary`).toMatch(/^[A-Z][\s\S]*\.$/)
      expect(m.summary.slice(0, -1), `${m.id}: summary is one sentence`).not.toMatch(/\.\s/)
      for (const text of [m.name, m.nameSv, m.summary]) {
        expect(text, `${m.id}: no em or en dashes`).not.toMatch(/[\u2013\u2014]/)
      }
    }
  })

  it('has at least one kernel, and kernels come first', () => {
    const kinds = MODULES.map((m) => m.kind)
    expect(kinds[0]).toBe('kernel')
    expect(kinds.lastIndexOf('kernel')).toBeLessThan(kinds.indexOf('block'))
  })

  it('names only real capability keys and two-letter jurisdiction codes', () => {
    const keys = new Set<string>(Object.values(CAPABILITY))
    for (const m of MODULES) {
      if (m.capability !== undefined) expect(keys.has(m.capability), `${m.id}: ${m.capability}`).toBe(true)
      for (const code of m.jurisdictions) expect(code, m.id).toMatch(/^[A-Z]{2}$/)
    }
  })

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(MODULES)).toBe(true)
    expect(Object.isFrozen(INFRA_LIB_FOLDERS)).toBe(true)
    for (const m of MODULES) {
      expect(Object.isFrozen(m), m.id).toBe(true)
      for (const list of [m.dependsOn, m.libFolders, m.operationPrefixes, m.v1Segments, m.jurisdictions]) {
        expect(Object.isFrozen(list), m.id).toBe(true)
      }
    }
  })

  describe('dependencies', () => {
    const ids = new Set<string>(MODULE_IDS)

    it('reference existing modules, never the module itself', () => {
      for (const m of MODULES) {
        for (const dep of m.dependsOn) {
          expect(ids.has(dep), `${m.id} -> ${dep}`).toBe(true)
          expect(dep, `${m.id} depends on itself`).not.toBe(m.id)
        }
      }
    })

    it('never let a kernel depend on a block, and leave the implicit kernel out of a block', () => {
      for (const m of MODULES) {
        for (const dep of m.dependsOn) {
          const target = MODULES.find((x) => x.id === dep)
          if (m.kind === 'kernel') expect(target?.kind, `kernel ${m.id} -> ${dep}`).toBe('kernel')
          else expect(target?.kind, `block ${m.id} lists kernel ${dep}: it is implicit`).toBe('block')
        }
      }
    })

    it('form an acyclic graph whose dependency order puts every dependency first', () => {
      const order = modulesInDependencyOrder().map((m) => m.id)
      expect([...order].sort()).toEqual([...MODULE_IDS].sort())
      for (const m of MODULES) {
        for (const dep of effectiveDependencies(m)) {
          expect(order.indexOf(dep), `${dep} before ${m.id}`).toBeLessThan(order.indexOf(m.id))
        }
      }
    })
  })

  describe('claims', () => {
    it('claim each operation prefix at most once', () => {
      expect(duplicates(claimants((m) => m.operationPrefixes))).toEqual([])
      for (const m of MODULES) for (const p of m.operationPrefixes) expect(p, m.id).toMatch(/^[a-z][a-z0-9-]*$/)
    })

    it('claim each v1 path at most once (placeholder names do not make a claim distinct)', () => {
      const normalize = (claim: string) =>
        claim
          .split('/')
          .map((seg) => (seg.startsWith(':') ? ':' : seg))
          .join('/')
      expect(duplicates(claimants((m) => m.v1Segments, normalize))).toEqual([])
      for (const m of MODULES) {
        for (const claim of m.v1Segments) {
          expect(claim, m.id).toMatch(/^[a-z][a-z0-9-]*(\/(:[a-zA-Z]+|[a-z][a-z0-9-]*))*$/)
        }
      }
    })

    it('claim each src/lib folder at most once, and never one declared as infrastructure', () => {
      expect(duplicates(claimants((m) => m.libFolders))).toEqual([])
      const infra = new Set(INFRA_LIB_FOLDERS)
      for (const m of MODULES) for (const f of m.libFolders) expect(infra.has(f), `${m.id} claims infra ${f}`).toBe(false)
      expect(new Set(INFRA_LIB_FOLDERS).size).toBe(INFRA_LIB_FOLDERS.length)
    })

    it('point at folders that exist (a rename must move the claim along)', () => {
      for (const m of MODULES) {
        for (const folder of m.libFolders) {
          const full = join(LIB_ROOT, folder)
          expect(existsSync(full) && statSync(full).isDirectory(), `${m.id}: src/lib/${folder}`).toBe(true)
        }
      }
      for (const folder of INFRA_LIB_FOLDERS) {
        const full = join(LIB_ROOT, folder)
        expect(existsSync(full) && statSync(full).isDirectory(), `infra: src/lib/${folder}`).toBe(true)
      }
    })

    it('give every top-level src/lib folder exactly one owner: a module or INFRA_LIB_FOLDERS', () => {
      const folders = readdirSync(LIB_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== '__tests__')
        .map((e) => e.name)
      const topLevelOwners = claimants((m) => m.libFolders.filter((f) => !f.includes('/')))
      for (const f of INFRA_LIB_FOLDERS) topLevelOwners.set(f, [...(topLevelOwners.get(f) ?? []), 'infra'])
      const problems = folders
        .map((f) => [f, topLevelOwners.get(f) ?? []] as const)
        .filter(([, owners]) => owners.length !== 1)
        .map(([f, owners]) =>
          owners.length === 0
            ? `src/lib/${f} has no owner: add it to a module's libFolders or to INFRA_LIB_FOLDERS in lib/modules/manifest.ts`
            : `src/lib/${f} is claimed by ${owners.join(' and ')}`,
        )
      expect(problems).toEqual([])
    })

    it('carve sub-folders only out of a folder another module owns', () => {
      const topLevel = new Map<string, string>()
      for (const m of MODULES) for (const f of m.libFolders) if (!f.includes('/')) topLevel.set(f, m.id)
      for (const m of MODULES) {
        for (const f of m.libFolders.filter((x) => x.includes('/'))) {
          const parent = topLevel.get(f.split('/')[0])
          expect(parent, `${m.id}: ${f} needs an owned parent folder`).toBeDefined()
          expect(parent, `${m.id}: ${f} is already its own parent's`).not.toBe(m.id)
        }
      }
    })
  })
})
