#!/usr/bin/env npx tsx
import { readFile, writeFile, mkdir, unlink, lstat, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { discoverAtoms } from './lib/atom-discovery'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = '.accounted-skills-mirror.json'
const HEADER = '<!-- SPDX-License-Identifier: MIT; Copyright (c) Accounted contributors. Generated mirror; edit the Accounted source. -->\n'
const LICENSE = `MIT License

Copyright (c) Accounted contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

/** The public repository the mirror is pushed to, and the name its install lines use. */
export const PUBLIC_REPO = 'erp-mafia/accounted-skills'
const SUMMARY_MAX = 160

/**
 * One table row's worth of a skill description: its first sentence, cut to fit
 * in 160 characters at the last comma that leaves no parenthesis open (or, with
 * no such comma, at the last word). A period inside a sentence ("incl. x",
 * "2012:1") is not a stop; only one followed by a capital is.
 */
export function skillSummary(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim()
  const stop = flat.search(/\.\s+(?=[A-ZÅÄÖ])/)
  const sentence = (stop === -1 ? flat : flat.slice(0, stop)).replace(/\.$/, '')
  if (sentence.length <= SUMMARY_MAX) return sentence
  const cut = sentence.slice(0, SUMMARY_MAX)
  for (let comma = cut.lastIndexOf(','); comma > 0; comma = cut.lastIndexOf(',', comma - 1)) {
    const head = cut.slice(0, comma)
    if (head.split('(').length === head.split(')').length) return head
  }
  return cut.slice(0, cut.lastIndexOf(' '))
}

/** The mirror's README: what the skills are, one install line per way in, and every skill in a table. */
export function publicReadme(skills: { name: string; path: string; description: string }[]): string {
  return [
    '# Swedish accounting skills',
    '',
    'Agent skills for Swedish bookkeeping law, tax and reporting: reference knowledge an AI agent loads when the question comes up.',
    'They work in any agent that reads the Agent Skills format (Claude Code, Codex, Cursor, OpenClaw and others) and need no Accounted account.',
    '',
    '## Install',
    '',
    '```bash',
    `npx skills add ${PUBLIC_REPO}                      # choose from the list`,
    `npx skills add ${PUBLIC_REPO} --skill swedish-vat  # one skill`,
    `npx skills add ${PUBLIC_REPO} -a codex             # into one agent: claude-code, codex, cursor, openclaw, ...`,
    '```',
    '',
    'Or clone the repository: Claude Code loads `.claude/skills/` when you work inside the directory.',
    '',
    '## Skills',
    '',
    '| Skill | Covers |',
    '| --- | --- |',
    ...skills.map((skill) => `| [\`${skill.name}\`](${skill.path}) | ${skillSummary(skill.description).replace(/\|/g, '\\|')} |`),
    '',
    '## Community',
    '',
    "Instructions shared by Accounted's users and others live in [`community/`](community/README.md): workflows, knowledge and analyses, each reviewed by Accounted before it is merged.",
    'Browse them at [accounted.se/instruktioner](https://accounted.se/instruktioner). To share your own, see [CONTRIBUTING.md](CONTRIBUTING.md).',
    '',
    '## Source',
    '',
    "Generated from Accounted's canonical Swedish accounting skills.",
    'Edit the source in erp-mafia/accounted; the skill files in this repository are a read-only mirror.',
    '',
    'For live corrected instructions, connect your AI to Accounted over MCP.',
    'A checkout is a snapshot and does not receive withdrawals until updated.',
    '',
    '## License',
    '',
    'MIT. See [LICENSE](LICENSE).',
    '',
  ].join('\n')
}

export function stampMit(body: string): string {
  const normalized = body.replace(/\r\n/g, '\n')
  const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(normalized)
  const end = frontmatter?.[0].length ?? 0
  return normalized.slice(0, end) + HEADER + normalized.slice(end)
}

export async function publicSkillFiles(root: string): Promise<Map<string, string>> {
  const atoms = (await discoverAtoms(root)).filter((atom) => atom.tier === 'horizontal')
  const files = new Map<string, string>()
  for (const atom of atoms) {
    const path = atom.body_path.split(sep).join('/')
    if (!/^\.claude\/skills\/swedish-[a-z0-9-]+\/(SKILL\.md|references\/[a-zA-Z0-9_./-]+\.md)$/.test(path) || path.includes('..')) throw new Error(`Unsafe source path: ${path}`)
    files.set(path, stampMit(await readFile(join(root, atom.body_path), 'utf8')))
  }
  files.set('LICENSE', LICENSE)
  files.set('README.md', publicReadme(atoms.filter((atom) => !atom.parent_atom_id).map((atom) => ({ name: atom.slug, path: atom.body_path.split(sep).join('/'), description: atom.description }))))
  files.set(MANIFEST, JSON.stringify([...files.keys()].sort(), null, 2) + '\n')
  return files
}

async function safePath(target: string, file: string): Promise<string> {
  if (file !== 'README.md' && file !== 'LICENSE' && file !== MANIFEST && !/^\.claude\/skills\/swedish-[a-z0-9-]+\/(SKILL\.md|references\/[a-zA-Z0-9_./-]+\.md)$/.test(file)) throw new Error(`Unmanaged target: ${file}`)
  if (file.includes('..')) throw new Error('Unsafe mirror path')
  let part = target
  for (const segment of file.split('/')) {
    part = join(part, segment)
    const info = await lstat(part).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (info?.isSymbolicLink()) throw new Error(`Refusing symlink target: ${file}`)
  }
  return part
}

export async function syncPublicSkills(root: string, target: string, check = false): Promise<string[]> {
  // Resolve the destination itself too: a symlink outside the checkout must
  // never turn this public mirror operation into a write to its source.
  target = await realpath(resolve(target))
  const source = await realpath(root)
  if (target === source || !relative(source, target).startsWith('..')) throw new Error('Use a separate public-repo checkout or temporary directory')
  const files = await publicSkillFiles(root)
  const previous = JSON.parse(await readFile(join(target, MANIFEST), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return '[]'; throw error })) as string[]
  const changed: string[] = []
  for (const file of new Set([...files.keys(), ...previous])) {
    const output = await safePath(target, file)
    const desired = files.get(file)
    const current = await readFile(output, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (current === desired) continue
    changed.push(file)
    if (check) continue
    if (desired === undefined) await unlink(output)
    else { await mkdir(dirname(output), { recursive: true }); await writeFile(output, desired) }
  }
  return changed
}

async function main() {
  const args = process.argv.slice(2)
  const target = args[args.indexOf('--target') + 1]
  if (!args.includes('--target') || !target || target.startsWith('--')) throw new Error('Usage: skills:sync-public -- --target <checkout> [--check | --commit]')
  const check = args.includes('--check')
  if (!check && args.includes('--commit')) execFileSync('git', ['-C', target, 'diff', '--cached', '--quiet'])
  const changed = await syncPublicSkills(ROOT, target, check)
  console.log(`${changed.length} changed mirror files`)
  if (check && changed.length) process.exitCode = 1
  if (!check && args.includes('--commit') && changed.length) {
    execFileSync('git', ['-C', target, 'add', '--', ...changed])
    execFileSync('git', ['-C', target, 'commit', '-m', 'chore: sync canonical Swedish accounting skills'])
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error); process.exitCode = 1 })
