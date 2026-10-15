/**
 * Proof that the decision-log guard refuses a line appended to DECISIONS.md
 * and a decision file a dated search would miss, accepts a well-formed one,
 * and that the repository passes. Fixtures live in an OS temp directory the
 * test creates and deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findDecisionLogFindings } from '../decision-log.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-log-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return root
}

const HEADER = '# Decision Log\n\nOne decision per file under docs/decisions/YYYY-MM/.\n'

describe('decision-log guard', () => {
  it('accepts a header-only DECISIONS.md, one-line entries and the monthly archives', () => {
    const root = fixture({
      'DECISIONS.md': HEADER,
      'docs/decisions/2026-09.md': '# Decisions: September 2026\n\n[2026-09-01] An archived line: kept verbatim.\n',
      'docs/decisions/2026-10/2026-10-15-one-file-each.md': '[2026-10-15] One file per decision: appends conflict.\n',
    })
    expect(findDecisionLogFindings(root)).toEqual([])
  })

  it('flags a dated line appended to DECISIONS.md', () => {
    const root = fixture({ 'DECISIONS.md': `${HEADER}\n[2026-10-15] Appended the old way: conflicts.\n` })
    expect(findDecisionLogFindings(root)).toEqual([{ file: 'DECISIONS.md', problem: '1 dated line(s) appended' }])
  })

  it('flags entries a dated search would miss', () => {
    const root = fixture({
      'DECISIONS.md': HEADER,
      'docs/decisions/2026-10/Some Decision.md': '[2026-10-15] Bad name.\n',
      'docs/decisions/2026-10/2026-11-01-wrong-month.md': '[2026-11-01] Wrong directory.\n',
      'docs/decisions/2026-10/2026-10-16-two-lines.md': '[2026-10-16] First.\n[2026-10-16] Second.\n',
      'docs/decisions/2026-10/2026-10-17-date-mismatch.md': '[2026-10-18] Date differs from the name.\n',
    })
    expect(findDecisionLogFindings(root)).toEqual([
      { file: 'docs/decisions/2026-10/2026-10-16-two-lines.md', problem: '2 lines, expected one' },
      { file: 'docs/decisions/2026-10/2026-10-17-date-mismatch.md', problem: 'does not start with [2026-10-17]' },
      { file: 'docs/decisions/2026-10/2026-11-01-wrong-month.md', problem: 'dated outside 2026-10' },
      { file: 'docs/decisions/2026-10/Some Decision.md', problem: 'not named YYYY-MM-DD-<slug>.md' },
    ])
  })

  it('finds nothing in the repository', () => {
    expect(findDecisionLogFindings(REPO_ROOT)).toEqual([])
  })
})
