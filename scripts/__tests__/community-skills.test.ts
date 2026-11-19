import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { discoverAtoms } from '../lib/atom-discovery'
import { buildMigrationSql } from '../generate-skill-bodies'
import { PUBLIC_REPO, publicSkillFiles, repoOnlySkills, skillSummary, stampMit, syncPublicSkills } from '../sync-public-skills'
import { COMMUNITY_REPO } from '@/lib/agent-skills/community-repo-name'

const directories: string[] = []
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'accounted-skills-test-')); directories.push(dir); return dir }
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function fixture(root: string, slug: string, body: string, extra: Record<string, unknown> = {}) {
  await mkdir(join(root, '.claude/skills'), { recursive: true })
  await mkdir(join(root, 'registry/entries'), { recursive: true })
  await mkdir(join(root, `registry/skills/${slug}`), { recursive: true })
  await writeFile(join(root, `registry/entries/${slug}.mdx`), `---\n${yaml.dump({ slug, title: slug, description: 'Reviewed workflow', kind: 'skill', status: 'live', mcp_exposed: true, reviewedAt: '2026-09-17', ...extra })}---\n\nDescription.\n`)
  await writeFile(join(root, `registry/skills/${slug}/SKILL.md`), body)
}

describe('reviewed community generation', () => {
  it('seeds developer and firm submissions through the same generator', async () => {
    const root = await directory()
    await fixture(root, 'developer-workflow', 'Review the selected transactions.')
    await fixture(root, 'firm-workflow', 'Use the approved company mappings.', { submissionHash: 'reviewed-frozen-hash', author: 'firm-author' })
    const atoms = await discoverAtoms(root)
    expect(atoms.map((atom) => atom.id)).toEqual(['community/developer-workflow', 'community/firm-workflow'])
    expect(atoms.every((atom) => atom.mcp_exposed && atom.reviewed_at === '2026-09-17')).toBe(true)
    const sql = buildMigrationSql(atoms, Object.fromEntries(atoms.map((atom) => [atom.id, 1])))
    expect(sql).toContain('Review the selected transactions.')
    expect(sql).toContain('Use the approved company mappings.')
  })
  it('requires reviewer metadata before MCP exposure', async () => {
    const root = await directory()
    await fixture(root, 'unreviewed', 'Body', { reviewedAt: undefined })
    await expect(discoverAtoms(root)).rejects.toThrow('reviewedAt')
  })
  it('rejects raw tags in the loadable body, not only the registry description', async () => {
    const root = await directory()
    await fixture(root, 'unsafe', '<script>alert(1)</script>')
    await expect(discoverAtoms(root)).rejects.toThrow('plain Markdown')
  })
  it('does not expose archived entries', async () => {
    const root = await directory()
    await fixture(root, 'archived', 'Body', { status: 'archived' })
    expect((await discoverAtoms(root))[0].mcp_exposed).toBe(false)
  })
})

describe('public mirror', () => {
  it('stamps MIT without breaking frontmatter', () => {
    const body = '---\nname: swedish-test\n---\n# Test\n'
    expect(stampMit(body)).toMatch(/^---\nname: swedish-test\n---\n<!-- SPDX/)
  })
  it('mirrors canonical skills and references without drift and detects edits', async () => {
    const target = await directory()
    const files = await publicSkillFiles(process.cwd())
    expect(files.has('.claude/skills/swedish-vat/references/vat-compliance-reference.md')).toBe(true)
    expect([...files.keys()].some((file) => file.includes('industry/'))).toBe(false)
    await syncPublicSkills(process.cwd(), target)
    expect(await syncPublicSkills(process.cwd(), target, true)).toEqual([])
    for (const [file, body] of files) expect(await readFile(join(target, file), 'utf8')).toBe(body)
    await writeFile(join(target, '.claude/skills/swedish-vat/SKILL.md'), 'Drift')
    expect(await syncPublicSkills(process.cwd(), target, true)).toEqual(['.claude/skills/swedish-vat/SKILL.md'])
    expect(await readFile(join(target, '.claude/skills/swedish-vat/SKILL.md'), 'utf8')).toBe('Drift')
  })
  it('cuts a description to one table row: the first sentence, no parenthesis left open, at most 160 characters', () => {
    expect(skillSummary('Swedish VAT (moms) compliance reference. Covers momsredovisning.')).toBe('Swedish VAT (moms) compliance reference')
    expect(skillSummary('Mileage incl. förmånsbil and the 2012:1 rule')).toBe('Mileage incl. förmånsbil and the 2012:1 rule')
    const cut = skillSummary(`Reporting: structure (${'noter, '.repeat(12)}underskrifter), filing (deadlines, ${'fees, '.repeat(20)}audit)`)
    expect(cut.endsWith('underskrifter)')).toBe(true)
    expect(cut.length).toBeLessThanOrEqual(160)
  })
  it('lists every mirrored skill in the README, with an install line that names the public repository', async () => {
    const files = await publicSkillFiles(process.cwd())
    const readme = files.get('README.md') ?? ''
    expect(PUBLIC_REPO).toBe(COMMUNITY_REPO)
    expect(readme).toContain(`npx skills add ${PUBLIC_REPO}`)
    const skills = [...files.keys()].filter((file) => /^\.claude\/skills\/swedish-[a-z0-9-]+\/SKILL\.md$/.test(file))
    expect(skills.length).toBeGreaterThan(0)
    for (const file of skills) expect(readme).toContain(`](${file}) | `)
    const rows = readme.split('\n').filter((line) => line.startsWith('| [`'))
    expect(rows).toHaveLength(skills.length)
    for (const row of rows) {
      const summary = row.slice(row.indexOf(') | ') + 4, -2)
      expect(summary.length).toBeGreaterThan(0)
      expect(summary.length).toBeLessThanOrEqual(160)
    }
  })
  it('keeps a skill that lives only in the public repository: listed in the README, its files untouched', async () => {
    const target = await directory()
    const own = join(target, '.claude/skills/swedish-industry-test')
    await mkdir(join(own, 'references'), { recursive: true })
    const body = '---\nname: swedish-industry-test\ndescription: >\n  Accounting for a test trade. Covers | pipes and more.\n---\n# Written here\n'
    await writeFile(join(own, 'SKILL.md'), body)
    await writeFile(join(own, 'references/detail.md'), 'Detail')
    await syncPublicSkills(process.cwd(), target)
    const readme = await readFile(join(target, 'README.md'), 'utf8')
    expect(readme).toContain('### Also in this repository')
    expect(readme).toContain('| [`swedish-industry-test`](.claude/skills/swedish-industry-test/SKILL.md) | Accounting for a test trade |')
    expect(readme.indexOf('### Also in this repository')).toBeLessThan(readme.indexOf('## Community'))
    expect(await readFile(join(own, 'SKILL.md'), 'utf8')).toBe(body)
    expect(await readFile(join(own, 'references/detail.md'), 'utf8')).toBe('Detail')
    const manifest = JSON.parse(await readFile(join(target, '.accounted-skills-mirror.json'), 'utf8')) as string[]
    expect(manifest.some((file) => file.includes('swedish-industry-test'))).toBe(false)
    expect(await syncPublicSkills(process.cwd(), target, true)).toEqual([])
  })
  it('leaves the README as it was when the public repository has no skill of its own', async () => {
    const target = await directory()
    await syncPublicSkills(process.cwd(), target)
    expect(await readFile(join(target, 'README.md'), 'utf8')).not.toContain('Also in this repository')
  })
  it('reads only real skill folders as repository-only skills', async () => {
    const target = await directory()
    const skills = join(target, '.claude/skills')
    const write = async (folder: string, content: string) => { await mkdir(join(skills, folder), { recursive: true }); await writeFile(join(skills, folder, 'SKILL.md'), content) }
    await write('swedish-own', '---\nname: swedish-own\ndescription: Written in the public repository.\n---\nBody\n')
    await write('swedish-vat', '---\nname: swedish-vat\ndescription: Mirrored.\n---\nBody\n')
    await write('wrong-name', '---\nname: another-name\ndescription: The name is not the folder.\n---\nBody\n')
    await write('no-description', '---\nname: no-description\n---\nBody\n')
    await write('no-frontmatter', '# Just a heading\n')
    await write('broken-yaml', '---\nname: [broken\n---\nBody\n')
    await mkdir(join(skills, 'empty-folder'), { recursive: true })
    await symlink(join(skills, 'swedish-own'), join(skills, 'linked'))
    const found = await repoOnlySkills(target, new Set(['.claude/skills/swedish-vat/SKILL.md']))
    expect(found).toEqual([{ name: 'swedish-own', path: '.claude/skills/swedish-own/SKILL.md', description: 'Written in the public repository.' }])
    expect(await repoOnlySkills(await directory(), new Set())).toEqual([])
  })
  it('refuses the source checkout as a destination', async () => {
    await expect(syncPublicSkills(process.cwd(), process.cwd())).rejects.toThrow('separate')
  })
  it('refuses a destination symlink that points into the source checkout', async () => {
    const target = await directory()
    await symlink(process.cwd(), join(target, 'source-link'))
    await expect(syncPublicSkills(process.cwd(), join(target, 'source-link'))).rejects.toThrow('separate')
  })
})
