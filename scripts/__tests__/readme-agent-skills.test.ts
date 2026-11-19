import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverAtoms } from '../lib/atom-discovery'

/**
 * README.md lists every agent skill this repository ships, each as a table row
 * that starts with the skill's name. A skill added without a row fails here.
 */
const root = process.cwd()
const readme = readFileSync(join(root, 'README.md'), 'utf8')

function skillFolders(dir: string): string[] {
  return readdirSync(join(root, dir)).filter((name) => existsSync(join(root, dir, name, 'SKILL.md')))
}

describe('README agent skills section', () => {
  it('names every plugin flow and every skill in skills/', () => {
    const names = [...skillFolders('packages/claude-plugin/skills'), ...skillFolders('skills')]
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) expect(readme, `README.md has no row for the skill "${name}"`).toContain(`| \`${name}\` |`)
  })

  it('names every Swedish accounting skill the public mirror publishes', async () => {
    const atoms = (await discoverAtoms(root)).filter((atom) => atom.tier === 'horizontal' && !atom.parent_atom_id)
    expect(atoms.length).toBeGreaterThan(0)
    for (const atom of atoms) expect(readme, `README.md has no row for the skill "${atom.slug}"`).toContain(`| \`${atom.slug}\` |`)
  })
})
