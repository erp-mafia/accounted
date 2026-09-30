#!/usr/bin/env node
/**
 * Guards: Swedish jurisdiction welded into code that every country will run.
 *
 * Accounted is going multi-country (DECISIONS.md 2026-09-30): jurisdiction
 * becomes a per-company pack, with Sweden as pack number one. Until that seam
 * exists, three kinds of weld must stop growing. Each is a per-file ratchet
 * with its baseline in antipatterns-baseline.json, wired into
 * `npm run check:guards` (scripts/checks/no-new-antipatterns.mjs):
 *
 *   1. basAccountLiteral: a BAS account number spelled at a call site. Counted
 *      per occurrence:
 *        - a quoted four-digit account literal, '1930' / "2650" / `3001`
 *          (first digit 1-8, the BAS account classes);
 *        - a digit-prefix check on an account, account.startsWith('19'),
 *          acc.slice(0, 2) === '26', num.charAt(0) !== '1';
 *        - a regex prefix test, /^19\d{2}$/, /^[4-8]/, /^(26|27)\d\d$/.
 *      Every one is a place a second country's chart cannot reach. Exempt:
 *      SE_PACK_TERRITORY below, where BAS is the point.
 *   2. sekLiteral: a comparison against the literal 'SEK' (=== / !== / == /
 *      !=, either side). Each one hard-codes the ledger currency that will
 *      become a pack setting. Exempt: CURRENCY_CONVERSION_CODE below, the one
 *      place that should decide what the home currency is.
 *   3. kernelImports: lib/bookkeeping/engine.ts and lib/core/** importing an
 *      outer business module (invoices, reports, bokslut, import, api,
 *      operations, salary, documents, extensions, app, components, ...). The
 *      kernel is what every pack shares; each such import pulls a feature,
 *      usually a Swedish one, underneath it. Anything outside
 *      KERNEL_INNER_MODULES counts, so a new business module is outer by
 *      default. Tracked as (file, module) edges.
 *
 * For 1 and 2 a file's count may only go down and a file not in the baseline
 * may not introduce one; for 3 a kernel file may not gain an edge. Tests are
 * exempt everywhere (they spell out what they assert), and so are comment
 * lines.
 */

import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/**
 * The future SE jurisdiction pack. These paths are where Swedish chart and
 * filing knowledge legitimately lives today (the BAS chart, the legal-form
 * profiles, Swedish year-end and the Skatteverket filings); when the pack
 * seam is built they move behind it as a unit. BAS literals here are the
 * point, so basAccountLiteral does not count them. A path ending in '/' is a
 * directory, anything else one file. Keep the list short: a path belongs here
 * only if its whole job is Swedish law or the Swedish chart.
 */
export const SE_PACK_TERRITORY = [
  // The BAS chart, its SRU mapping, and the generated account-number list.
  'lib/bookkeeping/bas-data/',
  'lib/bookkeeping/bas-account-numbers.ts',
  // The SE legal-form profiles: equity, settlement and closing accounts per form.
  'lib/company/forms/',
  // Swedish year-end: årsredovisning and iXBRL, periodiseringsfond, bolagsskatt, EF.
  'lib/bokslut/',
  // Income tax returns and their SRU files.
  'lib/reports/ink2/',
  'lib/reports/ne-bilaga/',
  'lib/reports/sru/',
  'lib/reports/sru-encoding.ts',
  // The momsdeklaration: rutor, their BAS 26xx mapping, and the eSKD file.
  'lib/reports/vat-declaration.ts',
  'lib/vat/moms-box-mapping.ts',
  'lib/reports/vat-eskd-file.ts',
  // Arbetsgivardeklaration (AGI).
  'lib/salary/agi/',
]

/**
 * Currency-conversion code: the helpers that turn an amount in some currency
 * into ledger kronor. Deciding "is this already SEK?" is their job, so
 * sekLiteral does not count them; everywhere else should ask them.
 */
export const CURRENCY_CONVERSION_CODE = [
  'lib/currency/',
  'lib/bookkeeping/currency-utils.ts',
  'lib/bookkeeping/fx-line-slot.ts',
  'lib/bookkeeping/currency-revaluation.ts',
]

/** The ledger kernel whose imports kernelImports watches. */
export const KERNEL_FILES = ['lib/bookkeeping/engine.ts', 'lib/core/']

/**
 * What the kernel may import without it counting: the kernel itself, the
 * legal-form profile registry (keyed by jurisdiction and form, so it IS the
 * seam), and shared infrastructure with no business logic. A module root
 * matches itself and everything under it ('lib/events' covers
 * lib/events/types). External packages and node: builtins are not counted.
 */
export const KERNEL_INNER_MODULES = [
  'lib/bookkeeping',
  'lib/core',
  'lib/company',
  'lib/auth',
  'lib/concurrency',
  'lib/currency',
  'lib/dates',
  'lib/dimensions',
  'lib/env',
  'lib/errors',
  'lib/events',
  'lib/invariants',
  'lib/logger',
  'lib/money',
  'lib/observability',
  'lib/supabase',
  'lib/utils',
  'types',
]

const SCAN_DIRS = ['lib', 'app', 'components', 'extensions']
const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__'])
const EXTS = new Set(['.ts', '.tsx'])

const isTestFile = (relPath) =>
  relPath.includes('__tests__/') || /\.test\.tsx?$/.test(relPath)

/** True when relPath is listed in `paths` (a 'dir/' entry covers its subtree). */
export const isUnder = (relPath, paths) =>
  paths.some((p) => (p.endsWith('/') ? relPath.startsWith(p) : relPath === p))

const isCommentLine = (text) => /^\s*(?:\/\/|\/\*|\*|\{\s*\/\*)/.test(text)

// 1. basAccountLiteral ------------------------------------------------------

// '1930', "2650", `3001`: the quote has to close right after four digits, so
// dates ('2026-01-01') and longer numbers ('19300') are not accounts.
const ACCOUNT_LITERAL_RE = /(['"`])[1-8]\d{3}\1/g

// account.startsWith('19'). BAS classes are 1-8 and a prefix is 1-3 digits
// (four digits is a whole account and is already counted as a literal).
const STARTS_WITH_PREFIX_RE = /\.startsWith\(\s*(['"`])[1-8]\d{0,2}\1\s*[,)]/g

// acc.slice(0, 2) === '26', num.charAt(0) !== '1', either side of the operator.
const SLICE_CALL = String.raw`\.(?:charAt\(\s*0\s*\)|(?:slice|substring|substr)\(\s*0\s*,\s*[1-3]\s*\))`
const SLICE_CALL_NAMES = ['.charAt(', '.slice(', '.substring(', '.substr(']
const SLICE_PREFIX_RES = [
  new RegExp(String.raw`${SLICE_CALL}\s*(?:===|!==|==|!=)\s*(['"\x60])[1-8]\d{0,2}\1`, 'g'),
  new RegExp(String.raw`(['"\x60])[1-8]\d{0,2}\1\s*(?:===|!==|==|!=)\s*[\w$.?]+${SLICE_CALL}`, 'g'),
]

// Account variables go by every name (a, n, value, expense, line.account), so
// a digit-prefix check counts unless its receiver is named for one of the
// other digit series this codebase handles: organisation and personal
// numbers, phone and clearing numbers, OCR and giro references, SQLSTATE and
// other codes, years and dates.
export const NON_ACCOUNT_RECEIVER_RE =
  /digit|org|person|pnr|phone|mobile|clearing|ocr|iban|bic|giro|zip|postal|year|date|period|version|status|code|canonical|sqlstate/i

// A regex literal that starts with ^ and then an account class digit, a class
// of account digits, or a group whose first alternative does: /^19\d{2}$/,
// /^[4-8]/, /^(26|27)\d\d$/. Regexes for longer numbers (org and personal
// numbers, Swish, phone) carry a run of five digits or more, and a leading
// century group, /^(19|20)\d{2}$/ or /^(16|19|20)/, is a year or an
// identity-number prefix; both are left out.
const REGEX_LITERAL_RE = /\/\^((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\[\n])*)\/[dgimsuvy]*/g
const ACCOUNT_REGEX_BODY_RE = /^(?:\((?:\?:)?)?(?:[1-8]|\[[1-8](?:-[1-8])?(?:[1-8](?:-[1-8])?)*\])/
const LONG_DIGIT_RUN_RE = /\{(?:[5-9]|[1-9]\d+)(?:,\d*)?\}|\d{5}/
const CENTURY_GROUP_RE = /^\((?:\?:)?(?:16|18|19|20)(?:\|(?:16|18|19|20))*\)/

/** The last identifier before a call, the receiver name a prefix check is judged by. */
function receiverName(textBefore) {
  const m = /([A-Za-z_$][\w$]*)[^\w$]*$/.exec(textBefore)
  return m ? m[1] : ''
}

/**
 * Locates matches in a whole source: the 1-based line of an offset, where that
 * line starts, and whether it is a comment line. Matching the whole source
 * once per pattern, instead of every pattern on every line, keeps the check
 * cheap enough to run in check:guards on every PR.
 */
function lineLocator(source) {
  // Built on the first match only: most files have none.
  let starts = null
  const lineOf = (offset) => {
    if (!starts) {
      starts = [0]
      for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) starts.push(i + 1)
    }
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const commentCache = new Map()
  return {
    locate(offset) {
      const i = lineOf(offset)
      let comment = commentCache.get(i)
      if (comment === undefined) {
        const end = i + 1 < starts.length ? starts[i + 1] - 1 : source.length
        comment = isCommentLine(source.slice(starts[i], end))
        commentCache.set(i, comment)
      }
      return { line: i + 1, lineStart: starts[i], comment }
    },
  }
}

const sortFindings = (found) =>
  found.sort((a, b) => a.index - b.index).map(({ line, kind, match }) => ({ line, kind, match }))

/**
 * Every BAS account weld on `source`, one finding per occurrence, in source
 * order: { line, kind: 'literal' | 'prefix-startsWith' | 'prefix-slice' | 'prefix-regex', match }.
 */
export function findBasAccountWeldsInSource(source) {
  const { locate } = lineLocator(source)
  const found = []
  const add = (m, kind, match, receiverAt) => {
    const at = locate(m.index)
    if (at.comment) return
    if (receiverAt !== undefined) {
      const name = receiverName(source.slice(at.lineStart, receiverAt))
      if (NON_ACCOUNT_RECEIVER_RE.test(name)) return
    }
    found.push({ index: m.index, line: at.line, kind, match })
  }
  // The includes() prefilters skip a pattern on files that cannot match it;
  // a regex that starts with \. otherwise tries every property access.
  for (const m of source.matchAll(ACCOUNT_LITERAL_RE)) add(m, 'literal', m[0])
  if (source.includes('.startsWith(')) {
    for (const m of source.matchAll(STARTS_WITH_PREFIX_RE)) add(m, 'prefix-startsWith', m[0].trim(), m.index)
  }
  if (SLICE_CALL_NAMES.some((call) => source.includes(call))) {
    for (const re of SLICE_PREFIX_RES) {
      for (const m of source.matchAll(re)) {
        const callAt = m[0].search(/\.(?:charAt|slice|substring|substr)\(/)
        add(m, 'prefix-slice', m[0].trim(), m.index + callAt)
      }
    }
  }
  if (!source.includes('/^')) return sortFindings(found)
  for (const m of source.matchAll(REGEX_LITERAL_RE)) {
    const body = m[1]
    if (!ACCOUNT_REGEX_BODY_RE.test(body)) continue
    if (LONG_DIGIT_RUN_RE.test(body) || CENTURY_GROUP_RE.test(body)) continue
    add(m, 'prefix-regex', m[0])
  }
  return sortFindings(found)
}

// 2. sekLiteral -------------------------------------------------------------

const SEK_COMPARISON_RE = /(?:===|!==|==|!=)\s*(['"`])SEK\1|(['"`])SEK\2\s*(?:===|!==|==|!=)/g

/** Every comparison against the literal 'SEK' on `source`, in source order: { line, match }. */
export function findSekComparisonsInSource(source) {
  const { locate } = lineLocator(source)
  const findings = []
  for (const m of source.matchAll(SEK_COMPARISON_RE)) {
    const at = locate(m.index)
    if (!at.comment) findings.push({ line: at.line, match: m[0] })
  }
  return findings
}

// 3. kernelImports ----------------------------------------------------------

/** '@/lib/x', './x' or '../x' as a src-relative module path, or null for a package. */
function resolveModule(specifier, relPath) {
  let mod
  if (specifier.startsWith('@/')) mod = specifier.slice(2)
  else if (specifier.startsWith('.')) mod = path.posix.normalize(path.posix.join(path.posix.dirname(relPath), specifier))
  else return null
  return mod.replace(/\.(?:ts|tsx|js|mjs)$/, '').replace(/\/index$/, '')
}

const isInnerModule = (mod) =>
  KERNEL_INNER_MODULES.some((root) => mod === root || mod.startsWith(`${root}/`))

/** True when relPath is part of the ledger kernel. */
export const isKernelFile = (relPath) => !isTestFile(relPath) && isUnder(relPath, KERNEL_FILES)

/**
 * The outer modules a kernel file imports (static imports, type imports,
 * re-exports and dynamic import()), as sorted src-relative paths.
 */
export function findKernelImportsInSource(source, relPath) {
  const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, false)
  const specifiers = []
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  const outer = new Set()
  for (const specifier of specifiers) {
    const mod = resolveModule(specifier, relPath)
    if (mod && !isInnerModule(mod)) outer.add(mod)
  }
  return [...outer].sort()
}

// Tree scan -----------------------------------------------------------------

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

/**
 * All three welds under the scanned dirs of `root` (the src directory), in
 * one pass over the files:
 *   basAccountLiteral: [{ file, line, kind, match }]
 *   sekLiteral:        [{ file, line, match }]
 *   kernelImports:     { [file]: [module, ...] }  (only files with an edge)
 */
export function findJurisdictionWelds(root) {
  const basAccountLiteral = []
  const sekLiteral = []
  const kernelImports = {}
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(root, dir), [])) {
      const relPath = path.relative(root, file).split(path.sep).join('/')
      if (isTestFile(relPath)) continue
      const countBas = !isUnder(relPath, SE_PACK_TERRITORY)
      const countSek = !isUnder(relPath, CURRENCY_CONVERSION_CODE)
      const kernel = isKernelFile(relPath)
      if (!countBas && !countSek && !kernel) continue
      const source = fs.readFileSync(file, 'utf8')
      if (countBas) {
        for (const f of findBasAccountWeldsInSource(source)) basAccountLiteral.push({ file: relPath, ...f })
      }
      if (countSek && source.includes('SEK')) {
        for (const f of findSekComparisonsInSource(source)) sekLiteral.push({ file: relPath, ...f })
      }
      if (kernel) {
        const mods = findKernelImportsInSource(source, relPath)
        if (mods.length) kernelImports[relPath] = mods
      }
    }
  }
  const byFileLine = (a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file))
  return {
    basAccountLiteral: basAccountLiteral.sort(byFileLine),
    sekLiteral: sekLiteral.sort(byFileLine),
    kernelImports: Object.fromEntries(Object.entries(kernelImports).sort(([a], [b]) => a.localeCompare(b))),
  }
}

// Ratchet comparison ---------------------------------------------------------

/** { [file]: occurrences } for a list of { file } findings, keys sorted. */
export function countByFile(findings) {
  const counts = {}
  for (const f of findings) counts[f.file] = (counts[f.file] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * Per-file count ratchet. `grown` are files above their baseline (a file
 * missing from the baseline has a baseline of 0), `shrunk` files below it.
 */
export function compareFileCounts(baselineFiles, currentCounts) {
  const grown = []
  const shrunk = []
  for (const [file, current] of Object.entries(currentCounts)) {
    const baseline = baselineFiles[file] ?? 0
    if (current > baseline) grown.push({ file, baseline, current })
  }
  for (const [file, baseline] of Object.entries(baselineFiles)) {
    const current = currentCounts[file] ?? 0
    if (current < baseline) shrunk.push({ file, baseline, current })
  }
  return { grown, shrunk }
}

/** Per-file edge ratchet: (file, module) pairs added or removed since the baseline. */
export function compareFileEdges(baselineFiles, currentFiles) {
  const added = []
  const removed = []
  for (const [file, mods] of Object.entries(currentFiles)) {
    const known = new Set(baselineFiles[file] ?? [])
    for (const mod of mods) if (!known.has(mod)) added.push({ file, module: mod })
  }
  for (const [file, mods] of Object.entries(baselineFiles)) {
    const now = new Set(currentFiles[file] ?? [])
    for (const mod of mods) if (!now.has(mod)) removed.push({ file, module: mod })
  }
  return { added, removed }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'src')
  const welds = findJurisdictionWelds(root)
  const bas = countByFile(welds.basAccountLiteral)
  const sek = countByFile(welds.sekLiteral)
  const edges = Object.values(welds.kernelImports).reduce((n, mods) => n + mods.length, 0)
  for (const [file, n] of Object.entries(bas)) console.log(`bas  ${String(n).padStart(4)}  ${file}`)
  for (const [file, n] of Object.entries(sek)) console.log(`sek  ${String(n).padStart(4)}  ${file}`)
  for (const [file, mods] of Object.entries(welds.kernelImports)) console.log(`kernel  ${file} -> ${mods.join(', ')}`)
  console.log(
    `\nbasAccountLiteral: ${welds.basAccountLiteral.length} in ${Object.keys(bas).length} file(s); ` +
      `sekLiteral: ${welds.sekLiteral.length} in ${Object.keys(sek).length} file(s); ` +
      `kernelImports: ${edges} edge(s) in ${Object.keys(welds.kernelImports).length} file(s).`,
  )
}
