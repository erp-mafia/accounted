/**
 * Proof that the unsigned-provider-names guard catches a name in every form
 * the header promises (plain, inflected, compound, camelCase, inside a host),
 * in a diff's added lines and paths and in a PR's own text, and that nothing
 * about the real names lives in the repository: the names come from a secret,
 * and these tests use a made-up one.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  UNSIGNED_PROVIDER_NAME_ALLOWLIST,
  checkWorkingChange,
  defaultBaseRef,
  findGuardedNames,
  formatFinding,
  parseDiff,
  readGuardedNames,
  scanDiff,
  scanPrText,
  scanText,
} from '../unsigned-provider-names.mjs'

// A made-up provider for the planted tokens; never a real one.
const NAME = 'zyxquab'
const NAMES = [NAME]
const hits = (text: string) => findGuardedNames(text, NAMES).map((h: { index: number }) => h.index)

describe('unsigned-provider-names: where the names come from', () => {
  it('reads a comma-separated secret, lower-cased, trimmed and de-duplicated', () => {
    expect(readGuardedNames({ UNSIGNED_PROVIDER_NAMES: ' Zyxquab , zyxquab,QuuxCorp,' })).toEqual(['zyxquab', 'quuxcorp'])
    expect(readGuardedNames({})).toEqual([])
  })

  it('refuses a name short enough to match ordinary words', () => {
    expect(() => readGuardedNames({ UNSIGNED_PROVIDER_NAMES: 'zyxquab,ab' })).toThrow(/shorter than 4/)
  })

  it('skips with a reason when the secret is not set, and scans nothing', () => {
    expect(checkWorkingChange('origin/main', [])).toEqual({ skipped: 'no-names', base: null, baseRef: 'origin/main', findings: [] })
  })
})

describe('unsigned-provider-names: what counts as naming', () => {
  it('catches the plain name in any case', () => {
    expect(hits('zyxquab')).toEqual([0])
    expect(hits('Send it to Zyxquab today')).toEqual([11])
    expect(hits('ZYXQUAB')).toEqual([0])
  })

  it('catches inflected and compound forms', () => {
    expect(hits('Zyxquabs villkor')).toEqual([0])
    expect(hits('zyxquabinkasso')).toEqual([0])
    expect(hits('inkassozyxquab')).toEqual([7])
  })

  it('catches camelCase and PascalCase identifiers and hosts', () => {
    expect(hits('const zyxquabClient = createZyxquabClient()')).toEqual([6, 28])
    expect(hits('https://api.zyxquab.ai/api/v2/auth/token')).toEqual([12])
    expect(hits('ZYXQUAB_CLIENT_SECRET')).toEqual([0])
  })

  it('leaves a name broken by a non-letter, and other words, alone', () => {
    expect(hits('zyx quab')).toEqual([])
    expect(hits('zyx-quab')).toEqual([])
    expect(hits('Acme Inkasso registers the claim')).toEqual([])
  })

  it('reports line and column of every hit in a block of text', () => {
    expect(scanText('first line\nsecond: Zyxquab and zyxquab', 'notes', NAMES)).toEqual([
      { where: 'notes', line: 2, column: 9, length: 7 },
      { where: 'notes', line: 2, column: 21, length: 7 },
    ])
  })
})

describe('unsigned-provider-names: diffs', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,0 +11,3 @@ export function x() {',
    '+const fine = 1',
    '+// calls zyxquab',
    '++++ not a header: zyxquab',
    '@@ -20,1 +23,0 @@',
    '-removed zyxquab line is fine',
    'diff --git a/docs/old.md b/docs/zyxquab-notes.md',
    'similarity index 90%',
    'rename from docs/old.md',
    'rename to docs/zyxquab-notes.md',
  ].join('\n')

  it('reads added lines with their new line numbers and every touched path', () => {
    const entries = parseDiff(diff)
    expect(entries.filter((e: { line: number }) => e.line > 0)).toEqual([
      { file: 'src/a.ts', line: 11, text: 'const fine = 1' },
      { file: 'src/a.ts', line: 12, text: '// calls zyxquab' },
      { file: 'src/a.ts', line: 13, text: '+++ not a header: zyxquab' },
    ])
    expect(entries.filter((e: { line: number }) => e.line === 0).map((e: { text: string }) => e.text)).toEqual([
      'src/a.ts',
      'src/a.ts',
      'docs/old.md',
      'docs/zyxquab-notes.md',
    ])
  })

  it('flags added lines and paths, never removed lines', () => {
    expect(scanDiff(diff, { names: NAMES, allowlist: [] })).toEqual([
      { where: 'src/a.ts', line: 12, column: 10, length: 7 },
      { where: 'src/a.ts', line: 13, column: 19, length: 7 },
      { where: 'docs/zyxquab-notes.md (path)', line: 0, column: 6, length: 7 },
    ])
  })

  it('skips allowlisted files', () => {
    expect(scanDiff(diff, { names: NAMES, allowlist: ['src/a.ts', 'docs/zyxquab-notes.md'] })).toEqual([])
  })

  it('reads a new file and an untracked-style diff', () => {
    const added = ['diff --git a/x.md b/x.md', '--- /dev/null', '+++ b/x.md', '@@ -0,0 +1,2 @@', '+hello', '+Zyxquab AB'].join('\n')
    expect(scanDiff(added, { names: NAMES, allowlist: [] })).toEqual([{ where: 'x.md', line: 2, column: 1, length: 7 }])
  })
})

describe('unsigned-provider-names: PR text', () => {
  it('scans title, body, branch and every commit message', () => {
    const findings = scanPrText(
      {
        title: 'feat(collections): capability and ports',
        body: 'Builds the port.\n\nFirst provider: Zyxquab.',
        branch: 'feat/zyxquab-port',
        commits: [
          { sha: 'a'.repeat(40), message: 'feat: add the port' },
          { sha: 'b'.repeat(40), message: 'fix: map zyxquabStates\n\nbody' },
        ],
      },
      NAMES,
    )
    expect(findings.map((f: { where: string; line: number }) => `${f.where}:${f.line}`)).toEqual([
      'PR body:3',
      'branch name:1',
      `commit ${'b'.repeat(12)} message:1`,
    ])
  })

  it('never prints the matched text', () => {
    const [finding] = scanText('see Zyxquab', 'PR body', NAMES)
    const line = formatFinding(finding)
    expect(line.toLowerCase()).not.toContain(NAME)
    expect(line).toContain('PR body:1:5')
  })
})

describe('unsigned-provider-names: nothing pinned in the repository', () => {
  it('allowlists nothing until the contract is signed', () => {
    expect(UNSIGNED_PROVIDER_NAME_ALLOWLIST).toEqual([])
  })

  it('keeps no name, and no digest of one, in the guard or its workflow', () => {
    const root = path.resolve(__dirname, '..', '..', '..')
    for (const file of ['scripts/checks/unsigned-provider-names.mjs', '.github/workflows/provider-names.yml']) {
      const text = fs.readFileSync(path.join(root, file), 'utf8')
      // A public digest of a short name lets anyone confirm a guess.
      expect(text, file).not.toMatch(/\b[0-9a-f]{64}\b/)
    }
  })

  it('diffs against the PR base branch in CI and origin/main locally', () => {
    expect(defaultBaseRef({})).toBe('origin/main')
    expect(defaultBaseRef({ GITHUB_BASE_REF: 'feat/x' })).toBe('origin/feat/x')
    expect(defaultBaseRef({ GITHUB_BASE_REF: 'feat/x', PROVIDER_NAMES_BASE: 'abc123' })).toBe('abc123')
  })
})
