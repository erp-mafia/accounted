#!/usr/bin/env node
/**
 * Guard: an API error read by hand in client code.
 *
 * A dashboard route answers a failure in one of two shapes: `{ error: string }`
 * (validateBody, older routes) or the structured envelope
 * `{ error: { code, message, message_en, details } }` (errorResponse,
 * sessionFailureResponse). One reader handles both and the UI language:
 * getErrorMessage(body, { locale, fallback }) in lib/errors/get-error-message.ts.
 * Before it was used everywhere, 52 client files read `body.error` by hand:
 * a structured body rendered as "[object Object]" or fell to the fallback, an
 * English UI got the Swedish `message` instead of `message_en`, and a raw
 * English route string reached a Swedish user verbatim (2026-10-18).
 *
 * Flagged, in client code (app/ outside app/api/, components/, contexts/,
 * extensions/ outside their lib/ and the MCP server), on a line that does not
 * already call the reader:
 *   1. `x.error || <fallback>` / `x.error ?? <fallback>` (also `.error?.message`)
 *      where the fallback is a translation call or a non-empty string literal;
 *   2. `typeof x.error === 'string' ? x.error ...`, on one line or broken over two;
 *   3. a response body's raw `.error` put where it renders: `setError(json.error)`,
 *      `text: result.error`. A structured body is an object there, and React throws
 *      on an object child, so a refused button takes the whole page down (2026-11-01).
 *      Toast titles and descriptions are coerced (coerceToastNode), so they are not
 *      listed here;
 *   4. `const { error } = await res.json()`, the same read under a name the rules
 *      above cannot follow.
 *
 * HAND_READ_ERROR_ALLOWED lists the files whose `.error` is not an API
 * envelope (an SDK result, a domain result field, a reader's own output),
 * each with its reason.
 */

import fs from 'node:fs'
import path from 'node:path'

export const HAND_READ_ERROR_ALLOWED = new Map([
  ['components/ui/support-link.tsx', 'the support SDK result, not an API response'],
  ['components/import/OpeningBalanceResultStep.tsx', 'the import result state, already a user message'],
  ['components/salary/SalaryCalendar.tsx', "a day's conflict reason in the calendar check, domain data"],
  ['components/onboarding/books/steps/SkvStep.tsx', "ombud-appoint's outcome.error, which the reader produced"],
  [
    'components/reconciliation/AccountOverview.tsx',
    "a signoff policy refusal's own Swedish reason, which the generic reader does not recognise",
  ],
])

const SCAN_DIRS = ['app', 'components', 'contexts', 'extensions']
const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__'])
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/
const READER_CALL = /\b(?:getErrorMessage|getUserErrorMessage|getResponseErrorMessage)\s*\(/

// 1. `.error || t('x')`, `.error ?? 'x'`, `.error?.message || \`x\``
const FALLBACK_READ = /\.error(?:\?\.message|\.message)?\s*(?:\|\||\?\?)\s*(?:t[A-Za-z]*\(|['"\x60](?!['"\x60]))/
// 2. `typeof x.error === 'string' ? x.error`, the `?` branch on the same line
const TYPEOF_READ = /typeof\s+[\w$?.]+\.error\s*===\s*['"]string['"][^\n]*\?\s*[\w$?.]+\.error\b/
// 2b. the same ternary broken before its `?` branch
const TYPEOF_READ_WRAPPED = /typeof\s+[\w$?.]+\.error\s*===\s*['"]string['"][^\n]*\n\s*\?\s*[\w$?.]+\.error\b/g
// 3. `setError(json.error)`, `text: result.error`; `.error.code` and friends are code reads.
const RAW_RENDER_READ =
  /(?:\bset[A-Z]\w*\(\s*|\b(?:text|message)\s*:\s*)(?:body|json|data|result|payload)\??\.error\b(?!\s*(?:\?\.|\.|\[))/
// 4. `const { error } = await res.json()`, `const { error: msg } = await res.json()`
const DESTRUCTURED_READ = /\{\s*error(?:\s*:\s*\w+)?\s*\}\s*=\s*await\s+[\w$.]+\.json\(\)/

/** Line numbers (1-based) of hand-rolled error reads in one source. Exported for the unit test. */
export function findHandReadErrorsInSource(source) {
  const lines = source.split('\n')
  const hits = new Set()
  lines.forEach((line, i) => {
    if (READER_CALL.test(line) || COMMENT_LINE.test(line)) return
    if ([FALLBACK_READ, TYPEOF_READ, RAW_RENDER_READ, DESTRUCTURED_READ].some((rule) => rule.test(line))) hits.add(i + 1)
  })
  for (const match of source.matchAll(TYPEOF_READ_WRAPPED)) {
    const line = source.slice(0, match.index ?? 0).split('\n').length
    if (!READER_CALL.test(lines[line - 1] ?? '')) hits.add(line)
  }
  return [...hits].sort((a, b) => a - b)
}

function isScanned(rel) {
  if (rel.startsWith('app/api/')) return false
  if (/^extensions\/general\/[^/]+\/lib\//.test(rel)) return false
  if (rel.startsWith('extensions/general/mcp-server/')) return false
  if (/^extensions\/general\/[^/]+\/index\.ts$/.test(rel)) return false
  return true
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
}

/** `file:line` findings outside the allowlist, sorted. */
export function findHandReadErrors(root) {
  const files = []
  for (const dir of SCAN_DIRS) walk(path.join(root, dir), files)
  const findings = []
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    if (!isScanned(rel) || HAND_READ_ERROR_ALLOWED.has(rel)) continue
    for (const line of findHandReadErrorsInSource(fs.readFileSync(file, 'utf8'))) findings.push(`${rel}:${line}`)
  }
  return findings.sort()
}

export const HAND_READ_ERROR_HINT =
  '  → read API errors with getErrorMessage(body, { locale, fallback }) from @/lib/errors/get-error-message\n' +
  '    (locale: `const errorLocale = useLocale() as ErrorLocale`). It reads both error shapes\n' +
  '    ({ error: string } and { error: { code, message, message_en, details } }), picks message_en\n' +
  '    in an English UI and never shows a raw English route string to a Swedish user. Pass the\n' +
  '    call site\'s own sentence as `fallback`. Keep `code`/`details` logic as it is; only the\n' +
  '    message goes through the reader. If `.error` is not an API envelope, add the file with a\n' +
  '    reason to HAND_READ_ERROR_ALLOWED in scripts/checks/hand-read-api-error.mjs.'
