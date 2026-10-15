/**
 * Guard: a decision appended to DECISIONS.md, or a decision file where a
 * search of docs/decisions would not find it by date.
 *
 * Every merge request that made a non-obvious choice appended its line to the
 * end of DECISIONS.md, and two merge requests that append at the same place
 * conflict. Between 2026-10-05 and 2026-10-14, 117 of the 138 merged merge
 * requests touched that one file, so almost any two open at once had to be
 * rebased by hand before the second could land. A decision is now a file of
 * its own, docs/decisions/YYYY-MM/YYYY-MM-DD-<slug>.md, and a new file
 * conflicts with nothing. DECISIONS.md keeps only the layout and the links to
 * the monthly archives.
 *
 * The rules:
 *   - DECISIONS.md holds no dated `[YYYY-MM-DD]` line.
 *   - Every file in a month directory docs/decisions/YYYY-MM/ is named
 *     YYYY-MM-DD-<slug>.md with a date in that month, and holds one line that
 *     starts with `[YYYY-MM-DD] ` of that date.
 * The monthly archives (docs/decisions/YYYY-MM.md) are history and are not
 * checked. No allowlist.
 */

import fs from 'node:fs'
import path from 'node:path'

const DATED_LINE_RE = /^\[\d{4}-\d{2}-\d{2}\]/
const MONTH_DIR_RE = /^\d{4}-\d{2}$/
const ENTRY_NAME_RE = /^(\d{4}-\d{2})-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/

export const DECISION_LOG_HINT =
  'Write a decision as its own file, docs/decisions/YYYY-MM/YYYY-MM-DD-<slug>.md (slug: lowercase words joined by ' +
  "hyphens), holding one line: `[YYYY-MM-DD] <decision>: <why>`. Never append to DECISIONS.md: two merge requests " +
  'that append to one file conflict.'

/**
 * @param {string} root repository root
 * @returns {{ file: string, problem: string }[]} sorted by file
 */
export function findDecisionLogFindings(root) {
  const findings = []

  const logPath = path.join(root, 'DECISIONS.md')
  if (fs.existsSync(logPath)) {
    const dated = fs
      .readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => DATED_LINE_RE.test(line)).length
    if (dated) findings.push({ file: 'DECISIONS.md', problem: `${dated} dated line(s) appended` })
  }

  const decisionsDir = path.join(root, 'docs', 'decisions')
  const monthDirs = fs.existsSync(decisionsDir)
    ? fs
        .readdirSync(decisionsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && MONTH_DIR_RE.test(d.name))
        .map((d) => d.name)
    : []
  for (const month of monthDirs) {
    for (const entry of fs.readdirSync(path.join(decisionsDir, month), { withFileTypes: true })) {
      const file = `docs/decisions/${month}/${entry.name}`
      const nameMatch = entry.isFile() ? ENTRY_NAME_RE.exec(entry.name) : null
      if (!nameMatch) {
        findings.push({ file, problem: 'not named YYYY-MM-DD-<slug>.md' })
        continue
      }
      if (nameMatch[1] !== month) {
        findings.push({ file, problem: `dated outside ${month}` })
        continue
      }
      const lines = fs
        .readFileSync(path.join(decisionsDir, month, entry.name), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
      const date = entry.name.slice(0, 10)
      if (lines.length !== 1) {
        findings.push({ file, problem: `${lines.length} lines, expected one` })
      } else if (!lines[0].startsWith(`[${date}] `)) {
        findings.push({ file, problem: `does not start with [${date}]` })
      }
    }
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file))
}
