#!/usr/bin/env node
/**
 * Guard: a voucher reference built by hand from series and number.
 *
 * One verifikat read "A113" on its page, "A-113" in an MCP answer and "113" in
 * the arkiv list: each door spelled the reference itself, with its own
 * separator, series fallback and draft handling (format audit 2026-10-18).
 * formatVoucher (lib/bookkeeping/voucher-series-resolver.ts) is the one
 * format: "A113", the series uppercased with 'A' for a legacy row without
 * one, "-" for a draft. Its `separator: '-'` option serves only the v1 fields
 * documented as "A-12".
 *
 * This check keeps the count of hand-built references from growing: the
 * baseline is what is left after the 2026-10-18 migration, matching keys and
 * text matchers that are not display (voucher-ref-resolver, skattekonto
 * cancellation matching, a React key) among them. Tracked as a count.
 *
 * Shapes counted, one per line (comments are not code and are skipped):
 *   `${x.voucher_series}${x.voucher_number}`          template, any fallbacks
 *   `${x.voucher_series}-${x.voucher_number}`         hyphenated
 *   `${x.voucherSeries}${x.voucherNumber}`            camelCase fields
 *   {x.voucher_series}-{x.voucher_number}             JSX text
 *
 * Exempt: tests (they spell out what they assert) and the formatter itself.
 */

import fs from 'node:fs'
import path from 'node:path'

const FIELD = '[^{}]*\\.voucher_?[sS]eries[^{}]*'
const NUMBER = '[^{}]*\\.voucher_?[nN]umber[^{}]*'

export const HAND_BUILT_VOUCHER_REF_RES = [
  new RegExp(`\\$\\{${FIELD}\\}-?\\$\\{${NUMBER}\\}`),
  new RegExp(`(?<!\\$)\\{${FIELD}\\}-?\\{${NUMBER}\\}`),
]

export const HAND_BUILT_VOUCHER_REF_EXEMPT = ['lib/bookkeeping/voucher-series-resolver.ts']

const SCAN_DIRS = ['lib', 'app', 'components', 'extensions']
const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__'])
const EXTS = new Set(['.ts', '.tsx'])

const isTestFile = (relPath) =>
  relPath.includes('__tests__/') || relPath.endsWith('.test.ts') || relPath.endsWith('.test.tsx')

const isExempt = (relPath) =>
  isTestFile(relPath) || HAND_BUILT_VOUCHER_REF_EXEMPT.some((prefix) => relPath.startsWith(prefix))

const isComment = (text) => /^\s*(\/\/|\/?\*)/.test(text)

/** Every line of `source` that builds a voucher reference the way the header lists. */
export function findHandBuiltVoucherRefsInSource(source) {
  const findings = []
  source.split('\n').forEach((text, i) => {
    if (isComment(text)) return
    if (HAND_BUILT_VOUCHER_REF_RES.some((re) => re.test(text))) {
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

/** Every hand-built voucher reference under the scanned dirs of `root`, sorted by file and line. */
export function findHandBuiltVoucherRefs(root) {
  const findings = []
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(root, dir), [])) {
      const relPath = path.relative(root, file).split(path.sep).join('/')
      if (isExempt(relPath)) continue
      for (const f of findHandBuiltVoucherRefsInSource(fs.readFileSync(file, 'utf8'))) {
        findings.push({ file: relPath, ...f })
      }
    }
  }
  return findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)))
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'src')
  const findings = findHandBuiltVoucherRefs(root)
  for (const f of findings) console.log(`${f.file}:${f.line}: ${f.text}`)
  console.log(`\n${findings.length} hand-built voucher reference(s).`)
}
