/**
 * Proof that the one-definition guard flags a hand-written rule outside its
 * home, leaves its home and named exceptions alone, and refuses a rule file
 * that does not say what the rule is. Fixtures live in an OS temp directory.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  findOneDefinitionFindings,
  findRuleLines,
  loadOneDefinitionRules,
  validateRule,
} from '../one-definition.mjs'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-definition-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return root
}

const rule = {
  rule: 'sample-rule',
  says: 'A sample is doubled once.',
  home: 'src/lib/sample.ts: double',
  why: 'Two copies disagreed.',
  match: [/\bsample \* 2\b/],
  sanctioned: ['lib/sample.ts'],
}

describe('one-definition guard', () => {
  it('flags a hand-written rule with its file, line and home', () => {
    const root = fixture({ 'lib/other.ts': 'const a = 1\nconst b = sample * 2\n' })
    const { findings } = findOneDefinitionFindings(root, [rule])
    expect(findings).toEqual([
      expect.objectContaining({ rule: 'sample-rule', file: 'lib/other.ts', line: 2, home: rule.home }),
    ])
  })

  it('leaves the home, tests and comments alone', () => {
    const root = fixture({
      'lib/sample.ts': 'export const double = (sample: number) => sample * 2\n',
      'lib/__tests__/other.test.ts': 'const b = sample * 2\n',
      'lib/other.ts': '// not sample * 2 here\n * sample * 2\n',
    })
    expect(findOneDefinitionFindings(root, [rule]).findings).toEqual([])
  })

  it('respects scan prefixes', () => {
    const root = fixture({ 'app/page.ts': 'sample * 2\n', 'lib/other.ts': 'sample * 2\n' })
    const { findings } = findOneDefinitionFindings(root, [{ ...rule, scan: ['app/'] }])
    expect(findings.map((f) => f.file)).toEqual(['app/page.ts'])
  })

  it('accepts a named exception and reports it once it stops matching', () => {
    const root = fixture({ 'lib/other.ts': 'sample * 2\n', 'lib/gone.ts': 'const x = 1\n' })
    const { findings, stale } = findOneDefinitionFindings(root, [
      { ...rule, allowed: { 'lib/other.ts': 'a different rule', 'lib/gone.ts': 'was different' } },
    ])
    expect(findings).toEqual([])
    expect(stale).toEqual([{ rule: 'sample-rule', file: 'lib/gone.ts' }])
  })

  it('does not trip on a global regex between lines', () => {
    const lines = findRuleLines('sample * 2\nsample * 2\n', { ...rule, match: [/sample \* 2/g] })
    expect(lines.map((l) => l.line)).toEqual([1, 2])
  })

  it('refuses a rule file with a missing field or the wrong name', () => {
    expect(() => validateRule({ ...rule, why: '' }, 'sample-rule.mjs')).toThrow(/missing why/)
    expect(() => validateRule(rule, 'other-name.mjs')).toThrow(/named sample-rule/)
    expect(() => validateRule({ ...rule, match: ['text'] }, 'sample-rule.mjs')).toThrow(/regexes/)
  })

  it('loads rule files from a folder', async () => {
    const root = fixture({
      'sample-rule.mjs':
        "export default { rule: 'sample-rule', says: 'x', home: 'y', why: 'z', match: [/a/] }\n",
    })
    const rules = await loadOneDefinitionRules(root)
    expect(rules.map((r) => r.rule)).toEqual(['sample-rule'])
  })

  it('has no rule files that fail to load in the repo', async () => {
    await expect(loadOneDefinitionRules()).resolves.toBeInstanceOf(Array)
  })
})
