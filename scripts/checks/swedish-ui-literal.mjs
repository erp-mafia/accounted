#!/usr/bin/env node
/**
 * Guard: Swedish text written straight into a UI file instead of a message key.
 *
 * The app is bilingual: a user who picks English in /settings/account gets
 * src/messages/en.json, but only for the strings that go through t(). A
 * sentence typed into JSX, a placeholder, a toast title or a step-label map
 * renders in Swedish whatever the locale. In October 2026 an English-locale
 * customer moving their books over by SIE file met a Swedish upload step,
 * mapping step, review and result (crm#1356), next to steps of the same
 * wizard that were translated: nothing told the author of a new string that
 * it skipped the catalogue. This check is that signal.
 *
 * Counted, in .tsx files under app/ (app/api excluded), components/ and
 * extensions/, and .ts files under components/ (a canvas engine or a label
 * map beside its component), tests excluded:
 *   - JSX text, string literals and the text parts of template literals
 *     that look Swedish: a letter å, ä or ö, or one of a few function words
 *     English text does not use (och, eller, inte, ej, att, som, ...).
 * Not counted: import and export specifiers, regular expressions, string
 * literal types, object keys written as strings, and console.* arguments
 * (developer logs).
 *
 * Per-file ratchet, the same shape as bas-account-literal: a file's count may
 * only go down, and a file outside the baseline may not introduce one. Put
 * the text in src/messages/sv.json and en.json and read it with t().
 *
 * SWEDISH_BY_DESIGN lists the files that are Swedish in both locales on
 * purpose (.claude/rules/i18n.md, "Stays Swedish"), each with its reason.
 * Data that is Swedish in every locale (BAS account names, a bank's name)
 * belongs in lib/, which this check does not read.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

/** Files that stay Swedish in both locales, with the reason. */
export const SWEDISH_BY_DESIGN = new Map([
  // .claude/rules/i18n.md: statutory bokslut terminology, English would mislead.
  ['app/(dashboard)/bookkeeping/year-end/page.tsx', 'year-end wizard (i18n.md)'],
  // .claude/rules/i18n.md: verifikat, voucher numbers and BAS are regulatory.
  ['app/(dashboard)/bookkeeping/[id]/page.tsx', 'journal entry editor (i18n.md)'],
  // The published legal texts are Swedish documents, edited as a whole.
  ['app/(public)/privacy/page.tsx', 'privacy policy, a Swedish legal document'],
  ['app/(public)/dpa/page.tsx', 'data processing agreement, a Swedish legal document'],
  ['app/(public)/terms/page.tsx', 'terms of use, a Swedish legal document'],
  ['app/(public)/terms/2026-10-22/page.tsx', 'earlier terms of use still binding earlier customers, a Swedish legal document'],
  ['app/(public)/subprocessors/page.tsx', 'subprocessor list, a Swedish legal document'],
  // The chrome of those four documents, used by nothing else.
  ['components/legal/LegalShell.tsx', 'legal document layout (privacy, dpa, terms, subprocessors)'],
  ['components/legal/RecipientTable.tsx', 'recipient table inside the privacy policy and subprocessor list'],
])

const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__'])

/** [directory under src, extensions scanned there]. */
const SCAN = [
  ['app', ['.tsx']],
  ['components', ['.tsx', '.ts']],
  ['extensions', ['.tsx']],
]

const SWEDISH_LETTERS = /[åäöÅÄÖ]/
/**
 * Swedish function words without å/ä/ö that English prose does not use.
 * Kept short on purpose: in src/messages/en.json every one of them appears
 * only inside Swedish text (a bank's menu path, an untranslated string).
 */
const SWEDISH_WORDS = /(?:^|[^\p{L}\p{N}_])(?:och|eller|inte|ej|alla|att|som|ska|ingen|inga|konto|konton|sida|sidan|visar|av|kunde|finns|spara|avbryt)(?=$|[^\p{L}\p{N}_])/iu

/** One token with path or identifier punctuation: 'av.', 'mitt_konto', '/konto/1930'. */
const CODE_TOKEN = /^\S*[./:_#@=\\]\S*$/

/** True when `text` reads as Swedish prose rather than code or English. */
export function looksSwedish(text) {
  const trimmed = text.trim()
  if (!/\p{L}{2}/u.test(trimmed) || CODE_TOKEN.test(trimmed)) return false
  return SWEDISH_LETTERS.test(trimmed) || SWEDISH_WORDS.test(trimmed)
}

function isConsoleArgument(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      return (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'console'
      )
    }
    if (ts.isBlock(n) || ts.isSourceFile(n)) return false
  }
  return false
}

/**
 * The Swedish-looking UI literals in one source text, as { line, match }.
 * `fileName` only decides whether the source is parsed as TSX.
 */
export function findSwedishUiLiteralsInSource(source, fileName = 'x.tsx') {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const found = []
  const add = (node, text) => {
    if (!looksSwedish(text) || isConsoleArgument(node)) return
    found.push({
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      match: text.replace(/\s+/g, ' ').trim().slice(0, 80),
    })
  }
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isLiteralTypeNode(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      return
    }
    if (ts.isJsxText(node)) {
      add(node, node.text)
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent
      const isKey = parent && (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node
      if (!isKey) add(node, node.text)
    } else if (ts.isTemplateExpression(node)) {
      add(node, [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' '))
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

function* walk(dir, extensions) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) yield* walk(full, extensions)
    } else if (extensions.some((ext) => entry.name.endsWith(ext)) && !/\.test\.tsx?$/.test(entry.name)) {
      yield full
    }
  }
}

/**
 * Every Swedish-looking UI literal under `sourceRoot` (src/), as
 * { file, line, match } with `file` relative to it, sorted by file and line.
 */
export function findSwedishUiLiterals(sourceRoot) {
  const findings = []
  for (const [dir, extensions] of SCAN) {
    for (const full of walk(path.join(sourceRoot, dir), extensions)) {
      const file = path.relative(sourceRoot, full).split(path.sep).join('/')
      if (file.startsWith('app/api/') || SWEDISH_BY_DESIGN.has(file)) continue
      for (const site of findSwedishUiLiteralsInSource(fs.readFileSync(full, 'utf8'), file)) {
        findings.push({ file, ...site })
      }
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

export const SWEDISH_UI_LITERAL_HINT = [
  'the text renders in Swedish whatever language the user picked. Add a key to both',
  'src/messages/sv.json and src/messages/en.json and read it with t() (useTranslations in a',
  'client component, getTranslations on the server). Pass translated strings into canvas',
  'engines and label maps rather than writing them there. A surface that stays Swedish in',
  'both locales by rule (.claude/rules/i18n.md) goes in SWEDISH_BY_DESIGN in',
  'scripts/checks/swedish-ui-literal.mjs with its reason.',
]

// CLI: list the sites, optionally for one file: node scripts/checks/swedish-ui-literal.mjs [file]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
  const only = process.argv[2]
  for (const f of findSwedishUiLiterals(sourceRoot)) {
    if (!only || f.file.includes(only)) console.log(`${f.file}:${f.line}  ${f.match}`)
  }
}
