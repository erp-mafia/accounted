#!/usr/bin/env node
/**
 * Guard: "today" not read from the one definition.
 *
 * `new Date().toISOString().slice(0, 10)` (and its `.split('T')[0]` twin) is
 * the UTC date, which lags the Swedish calendar day by one between midnight
 * and 01:00/02:00 Stockholm time. Used as a default entry date, payment date,
 * "is this period over yet" cutoff or report as-of date, it books, filters
 * and labels against yesterday. In October 2026 the same expression stood in
 * for "today" at about a hundred sites, next to three helpers that already
 * did it right (todayIsoStockholm and two copies of it): the
 * definition lived everywhere, so the bug did too. todayIsoStockholm() from
 * lib/dates/iso is the one definition; this check keeps the inline form out.
 *
 * The same date read off a clock variable is the same bug one line later:
 * `const now = new Date()` and then `now.toISOString().slice(0, 10)`, or a
 * horizon `new Date(now.getTime() + 14 * 86_400_000)` sliced the same way
 * (accounted#18: the deadline status engine, the MCP attention resource,
 * the ledger context, Hem's checklist and the Arkiv meter). The Stockholm
 * form is todayIsoStockholm(now) with addDaysIso / addMonthsIso on the ISO
 * date.
 *
 * Flagged, in app/, components/, extensions/ and lib/ (tests excluded):
 *   - new Date().toISOString().slice(0, 10) / .substring(0, 10)
 *   - new Date().toISOString().split('T')[0]
 *   - toIsoDate(new Date())
 *   - the same slice, substring or split on a clock variable: a name that
 *     starts with `now` or `today` (also as a property, `opts.now`), a name
 *     the file assigns `new Date()` (or `x ?? new Date()`, or a parameter
 *     default), and a name the file assigns `new Date(<clock> ...)` or
 *     `new Date(Date.now() ...)`, the horizon derived from one
 *   - toIsoDate(<clock>) and a wrapper (a function that only returns its Date
 *     argument's toISOString().slice(0, 10), or builds the date from that
 *     argument's getters) called with `new Date()` or a clock variable; an
 *     exported wrapper counts in every file that imports it
 *   - the calendar getters read off the clock: `new Date().getFullYear()`,
 *     `now.getUTCMonth()`, `today.getDate()`. getFullYear() and friends read
 *     the process zone, which is UTC on Vercel and whatever the browser says
 *     elsewhere, and getUTCFullYear() reads UTC: this year and this month are
 *     Swedish too, stockholmYearMonth(now)
 *   - the fallback forms `date || new Date()` and `(date ?? new Date()).x`
 *   - a local date printed with no zone: `new Date().toLocaleDateString('sv-SE')`
 *     and date-fns' `format(new Date(), 'yyyy-MM-dd')`
 *   - a second body of the helper itself: Intl.DateTimeFormat('sv-SE') with a
 *     zone and nothing but the date parts
 * A timestamp (the full toISOString()) is not flagged: it carries its zone.
 * A date built from a stored ISO date (`new Date(invoiceDate)`) is not a
 * clock and is not flagged.
 *
 * UTC_TODAY_ALLOWED lists files where the UTC date is the right one, each
 * with its reason. It may only shrink.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const UTC_TODAY_ALLOWED = new Set([
  // Enable Banking date_to for transaction fetches: an upper bound sent to
  // the bank's API, not a business date in the books. Banks outside the
  // Swedish zone reject a date_to in their future, which the Stockholm date
  // is for an hour after midnight.
  'extensions/general/enable-banking/index.ts',
  'app/api/extensions/enable-banking/sync/cron/route.ts',
  // Enable Banking start-date suggestions: clamped to the newest
  // initial_lookback_from_date the backend PATCH handler accepts, which it
  // checks against UTC midnight (index.ts above). A Stockholm "today" would
  // suggest a date the save refuses for an hour after midnight.
  'extensions/general/enable-banking/lib/date-suggestions.ts',
  // Feed backfill date picker: min and max mirror parseBackfillFrom
  // (lib/feed-sync/cursor-window.ts), which pins the start to UTC midnight
  // as a provider cursor and refuses one in the future. A Stockholm max
  // would offer a day the save refuses for an hour after midnight.
  'components/extensions/shared/FeedConnectorPanel.tsx',
  // The one definition: todayIsoStockholm itself.
  'lib/dates/iso.ts',
])

const SCAN_DIRS = ['app', 'components', 'extensions', 'lib']
const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__'])

const UTC_TODAY_RES = [
  /new Date\(\s*\)\.toISOString\(\)\.(?:slice|substring)\(\s*0\s*,\s*10\s*\)/g,
  /new Date\(\s*\)\.toISOString\(\)\.split\(\s*['"`]T['"`]\s*\)\[0\]/g,
  /\btoIsoDate\(\s*new Date\(\s*\)\s*\)/g,
  /new Date\(\s*\)\.get(?:UTC)?(?:FullYear|Month|Date)\(\)/g,
  /new Date\(\s*\)\.toLocaleDateString\(\s*['"]sv-SE['"]\s*(?:,\s*\{\s*timeZone:[^},]*,?\s*\}\s*)?\)/g,
  /\bformat\(\s*new Date\(\s*\)\s*,\s*['"]yyyy-MM-dd['"]\s*\)/g,
  /new Intl\.DateTimeFormat\(\s*['"]sv-SE['"]\s*,\s*\{\s*timeZone:[^},]*stockholm[^},]*(?:,\s*year:\s*'numeric'\s*,\s*month:\s*'2-digit'\s*,\s*day:\s*'2-digit')?\s*,?\s*\}\s*\)/gi,
]

const IDENT = String.raw`[A-Za-z_$][\w$]*`
/** `.toISOString()` cut to its date part: slice(0, 10), substring(0, 10) or split('T')[0]. */
const DATE_PART = String.raw`\.toISOString\(\)\.(?:(?:slice|substring)\(\s*0\s*,\s*10\s*\)|split\(\s*['"\x60]T['"\x60]\s*\)\[0\])`
/** A calendar field read off a Date, in the process zone or in UTC. */
const CALENDAR_GETTER = String.raw`\.get(?:UTC)?(?:FullYear|Month|Date)\(\)`
/** A name that reads as the current instant wherever it appears. todayIso and todayStr hold the Swedish date already. */
const CLOCK_NAME = /^(?:now|today)(?!iso|str)/i
/** `x = new Date()`, `x: Date = new Date()`, `x = opts.now ?? new Date()`, `x = date || new Date()`. */
const CLOCK_DECL = new RegExp(String.raw`\b(${IDENT})\s*(?::\s*Date\s*)?=\s*(?:[^;\n=]*(?:\?\?|\|\|)\s*)?new Date\(\s*\)`, 'g')
/** `x = new Date(<name> ...)` or `x = new Date(Date.now() ...)`: a date derived from another. */
const DERIVED_DECL = new RegExp(String.raw`\b(${IDENT})\s*(?::\s*Date\s*)?=\s*new Date\(\s*(?:(Date\.now)\(\)|(${IDENT}))`, 'g')
/**
 * The date part or a calendar getter read off a name, with whether the name is
 * a property (`opts.now`). A getter inside a setter, `d.setDate(d.getDate() - 7)`,
 * moves an instant and reads no calendar: what is later read off `d` is seen.
 */
const CALENDAR_READ_ON_NAME = new RegExp(String.raw`(?<![\w$])(?<!\.set(?:UTC)?(?:FullYear|Month|Date)\(\s*)(\.?)(${IDENT})[!?]?(?:${DATE_PART}|${CALENDAR_GETTER})`, 'dg')
/** The same read off an inline fallback: `(date ?? new Date()).getFullYear()`. */
const CALENDAR_READ_ON_FALLBACK = new RegExp(String.raw`\([^()\n]*(?:\?\?|\|\|)\s*new Date\(\s*\)\s*\)(?:${DATE_PART}|${CALENDAR_GETTER})`, 'g')
/** A one-line wrapper around the date part. */
const WRAPPER_FN = new RegExp(String.raw`function\s+(${IDENT})\s*\(\s*(${IDENT})\s*(?::\s*Date\s*)?\)\s*(?::\s*string\s*)?\{\s*return\s+\2${DATE_PART}`, 'g')
const WRAPPER_ARROW = new RegExp(String.raw`(?:const|let)\s+(${IDENT})\s*=\s*\(\s*(${IDENT})\s*(?::\s*Date\s*)?\)\s*(?::\s*string\s*)?=>\s*\{?\s*(?:return\s+)?\2${DATE_PART}`, 'g')
/** A function of one Date, up to the closing brace at its own indent: the wrapper that builds the date from getters. */
const DATE_FN = new RegExp(String.raw`^([ \t]*)(?:export\s+)?function\s+(${IDENT})\s*\(\s*(${IDENT})\s*:\s*Date\s*\)\s*(?::\s*string\s*)?\{\n([\s\S]*?)\n\1\}`, 'gm')

/** Names in `src` that hold the current instant or a date derived from it. */
function clockNames(src) {
  const names = new Set()
  for (const m of src.matchAll(CLOCK_DECL)) names.add(m[1])
  const derived = [...src.matchAll(DERIVED_DECL)]
  let grew = true
  while (grew) {
    grew = false
    for (const m of derived) {
      if (names.has(m[1])) continue
      if (m[2] || CLOCK_NAME.test(m[3]) || names.has(m[3])) {
        names.add(m[1])
        grew = true
      }
    }
  }
  return names
}

/** Names of the functions in `src` that print their Date argument as a date. */
function wrapperNames(src) {
  const names = new Set()
  for (const m of src.matchAll(WRAPPER_FN)) names.add(m[1])
  for (const m of src.matchAll(WRAPPER_ARROW)) names.add(m[1])
  for (const m of src.matchAll(DATE_FN)) {
    const reads = (field) => new RegExp(String.raw`\b${m[3].replace(/\$/g, '\\$')}\.get(?:UTC)?${field}\(\)`).test(m[4])
    if (reads('FullYear') && reads('Month') && reads('Date')) names.add(m[2])
  }
  return names
}

/** `@/lib/x` or `./x` as the source-relative module it names, without an extension. */
function resolveModule(specifier, file) {
  if (specifier.startsWith('@/')) return specifier.slice(2)
  if (specifier.startsWith('.')) return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
  return null
}

/** The local names `src` imports a wrapper from another file under: exported wrappers count where they land. */
function importedWrappers(src, file, exportedWrappers) {
  const names = new Set()
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const source = resolveModule(m[2], file)
    const exported = source && exportedWrappers.get(source)
    if (!exported) continue
    for (const part of m[1].split(',')) {
      const [imported, local] = part.trim().split(/\s+as\s+/)
      if (exported.has(imported)) names.add(local ?? imported)
    }
  }
  return names
}

/** Character offsets in `src` of a calendar date read off a clock variable, a fallback or through a wrapper. */
function clockSiteOffsets(src, file, exportedWrappers) {
  const offsets = []
  const clocks = clockNames(src)
  const isClock = (name, isProperty) => CLOCK_NAME.test(name) || (!isProperty && clocks.has(name))
  for (const m of src.matchAll(CALENDAR_READ_ON_NAME)) {
    if (isClock(m[2], m[1] === '.')) offsets.push(m.indices[2][0])
  }
  for (const m of src.matchAll(CALENDAR_READ_ON_FALLBACK)) offsets.push(m.index)
  const wrappers = new Set(['toIsoDate', ...wrapperNames(src), ...importedWrappers(src, file, exportedWrappers)])
  for (const wrapper of wrappers) {
    const call = new RegExp(String.raw`(?<![\w$.])${wrapper.replace(/\$/g, '\\$')}\(\s*(?:new Date\(\s*\)|(\.?)(${IDENT}))\s*\)`, 'g')
    for (const m of src.matchAll(call)) {
      if (m[2] === undefined || isClock(m[2], false)) offsets.push(m.index)
    }
  }
  return offsets
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield full
  }
}

/** [{ file, line }] for every "today" under `root` (the src directory) not read through the helper. */
export function findUtcTodaySites(root) {
  const sources = new Map()
  const exportedWrappers = new Map()
  for (const dir of SCAN_DIRS) {
    for (const full of walk(path.join(root, dir))) {
      const file = path.relative(root, full).split(path.sep).join('/')
      const src = fs.readFileSync(full, 'utf8')
      sources.set(file, src)
      const exported = [...wrapperNames(src)].filter((name) => new RegExp(String.raw`export\s+(?:function|const|let)\s+${name.replace(/\$/g, '\\$')}\b`).test(src))
      if (exported.length > 0) exportedWrappers.set(file.replace(/\.tsx?$/, ''), new Set(exported))
    }
  }
  const findings = []
  for (const [file, src] of sources) {
    const lineOf = (offset) => src.slice(0, offset).split('\n').length
    const lines = new Set()
    for (const re of UTC_TODAY_RES) {
      for (const match of src.matchAll(re)) lines.add(lineOf(match.index))
    }
    for (const offset of clockSiteOffsets(src, file, exportedWrappers)) lines.add(lineOf(offset))
    for (const line of lines) findings.push({ file, line })
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
  const findings = findUtcTodaySites(root).filter((f) => !UTC_TODAY_ALLOWED.has(f.file))
  for (const f of findings) console.log(`${f.file}:${f.line}`)
  console.log(`${findings.length} hand-written "today" site(s) outside the allowlist`)
  process.exit(findings.length ? 1 : 0)
}
