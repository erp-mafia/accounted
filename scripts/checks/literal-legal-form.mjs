#!/usr/bin/env node
/**
 * Guard: a legal-form code compared, defaulted or tagged as a string literal
 * at a call site.
 *
 * `entityType === 'aktiebolag' ? A : B` sends every later form down branch B,
 * which was written with the other form in mind, and nothing forces an edit
 * when a form is added. Widening `EntityType` compiled everywhere and changed
 * nothing when ideell förening landed (PR #2423), and the four ledger-affecting
 * defects the 2026-09-17 audit found for that form all sat at such sites (the
 * SIE opening balance on a hard-coded 2099, the year-end dispositions step,
 * the dispositions route, the MCP EF preview). The contract in
 * docs/LEGAL-FORMS.md moves the answer into one profile per form under
 * lib/company/forms/ and has call sites read a capability instead.
 *
 * This check keeps the count of literal sites from growing: the baseline is
 * the number at adoption time, and it may only go down as files are touched.
 * Tracked as a count.
 *
 * Shapes counted, one per line:
 *   x === 'aktiebolag'   /   'aktiebolag' !== x      (comparison, either side)
 *   x ?? 'enskild_firma' /   x || 'aktiebolag'       (silent default)
 *   case 'aktiebolag':                                (switch arm)
 *   .default('aktiebolag')                            (zod default)
 *   entityType: EntityType = 'enskild_firma'          (default parameter)
 *   entity_applicability: 'aktiebolag'                (single-string data tag;
 *   entityOnly: 'aktiebolag'                           an array is the rule)
 *
 * Exempt: tests (they spell out what they assert), lib/company/forms/ (the
 * profiles are where a form is named) and lib/company/entity-type.ts (the
 * registry and its readers).
 */

import fs from 'node:fs'
import path from 'node:path'
import { sourcePath, sourceRelative } from './source-paths.mjs'

/** Keep in sync with ENTITY_TYPES in lib/company/entity-type.ts. */
export const LEGAL_FORM_CODES = ['enskild_firma', 'aktiebolag', 'ideell_forening']

const CODE = `'(?:${LEGAL_FORM_CODES.join('|')})'`

export const LITERAL_LEGAL_FORM_RES = [
  new RegExp(`(?:===|!==|==|!=)\\s*${CODE}`),
  new RegExp(`${CODE}\\s*(?:===|!==|==|!=)`),
  new RegExp(`(?:\\?\\?|\\|\\|)\\s*${CODE}`),
  new RegExp(`\\bcase\\s+${CODE}\\s*:`),
  new RegExp(`\\.default\\(${CODE}\\)`),
  new RegExp(`:\\s*EntityType\\s*=\\s*${CODE}`),
  new RegExp(`\\b(?:entity_applicability|entityOnly)\\s*:\\s*${CODE}`),
]

export const LITERAL_LEGAL_FORM_EXEMPT = ['lib/company/forms/', 'lib/company/entity-type.ts']

const SCAN_DIRS = ['lib', 'app', 'components', 'extensions']
const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__'])
const EXTS = new Set(['.ts', '.tsx'])

const isTestFile = (relPath) =>
  relPath.includes('__tests__/') || relPath.endsWith('.test.ts') || relPath.endsWith('.test.tsx')

const isExempt = (relPath) =>
  isTestFile(relPath) || LITERAL_LEGAL_FORM_EXEMPT.some((prefix) => relPath.startsWith(prefix))

/** Every line of `source` that names a legal form the way the header lists. */
export function findLiteralLegalFormsInSource(source) {
  const findings = []
  source.split('\n').forEach((text, i) => {
    if (LITERAL_LEGAL_FORM_RES.some((re) => re.test(text))) {
      findings.push({ line: i + 1, text: text.trim() })
    }
  })
  return findings
}

function walk(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) walk(full, out)
    } else if (EXTS.has(path.extname(e.name))) {
      out.push(full)
    }
  }
  return out
}

/** Every literal legal-form site under the scanned dirs of `root`, sorted by file and line. */
export function findLiteralLegalForms(root) {
  const findings = []
  for (const dir of SCAN_DIRS) {
    for (const file of walk(sourcePath(root, dir), [])) {
      const relPath = sourceRelative(root, file)
      if (isExempt(relPath)) continue
      for (const f of findLiteralLegalFormsInSource(fs.readFileSync(file, 'utf8'))) {
        findings.push({ file: relPath, ...f })
      }
    }
  }
  return findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)))
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
  const findings = findLiteralLegalForms(root)
  for (const f of findings) console.log(`${f.file}:${f.line}: ${f.text}`)
  console.log(`\n${findings.length} literal legal-form site(s).`)
}
