/**
 * The text `npm run law:refs` reads, and the citations in it.
 *
 * Every tracked Markdown, TypeScript, JavaScript, SQL and JSON file under the
 * folders in LAW_REF_PATHS; tests and the generated skill seed migrations are
 * left out. Each citation is read into a key by scripts/lib/lagrum.mjs. A
 * location written without its law ("4 kap. 4 §" under a heading that names
 * the law), or with a law missing from LAWS, gets no key: findUnresolvedLawRefs
 * lists those, so they can be named.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { findUnresolvedLocations, parseLawRefs } from './lagrum.mjs'

export const LAW_REF_PATHS = ['.claude/skills', 'skills', 'docs', 'src', 'scripts/checks/one-definition', 'supabase/migrations', 'packages']
const TEXT_FILE_RE = /\.(md|mdx|ts|tsx|mjs|mts|sql|json)$/
const SKIP_RE = /(^|\/)__tests__\/|\.test\.(ts|tsx|mjs|mts)$|seed_agent_atom_bodies\.sql$/
// Cheap prefilter: a line with none of these holds no citation.
const MAYBE_CITATION = /\d ?[a-z]? ?(?:kap|§)|BFNAR|HFD|RÅ|NJA|[Pp]rop\.|SOU|SFS/


/** Tracked text files the law references are read from, repository-relative and sorted. */
export function listLawRefFiles(root) {
  const result = spawnSync('git', ['ls-files', '-z', '--', ...LAW_REF_PATHS], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) return []
  return result.stdout
    .split('\0')
    .filter((f) => f && TEXT_FILE_RE.test(f) && !SKIP_RE.test(f))
    .sort()
}

/** Calls `visit(file, lineNumber, line)` for every line that may hold a citation. */
export function forEachCitationLine(root, files, visit) {
  for (const file of files) {
    let text
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (MAYBE_CITATION.test(lines[i])) visit(file, i + 1, lines[i])
    }
  }
}

/** Every location with no law, as { file, line, match }. */
export function findUnresolvedLawRefs(root, files = listLawRefFiles(root)) {
  const findings = []
  forEachCitationLine(root, files, (file, line, text) => {
    for (const u of findUnresolvedLocations(text)) findings.push({ file, line, match: u.raw })
  })
  return findings
}

/** Every citation, as { file, line, ...ref }. */
export function findLawRefs(root, files = listLawRefFiles(root)) {
  const refs = []
  forEachCitationLine(root, files, (file, line, text) => {
    for (const ref of parseLawRefs(text)) refs.push({ file, line, ...ref })
  })
  return refs
}
