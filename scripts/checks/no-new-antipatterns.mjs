#!/usr/bin/env node
/**
 * Ratchet guard against post-audit antipatterns.
 *
 * The audit found two repository-wide problems that are being remediated in
 * dedicated campaigns (A1 = route auth/MFA, D1 = money rounding). Those touch
 * hundreds of sites and won't land in one PR: so this guard makes sure the
 * count can only go DOWN, never up, while the migrations are in flight.
 *
 * Checks:
 *   1. raw-route-auth : an `app/api/**\/route.ts` that calls
 *      `supabase.auth.getUser()` directly instead of going through
 *      `requireAuth()` / `withRouteContext()` (the only guards that enforce
 *      MFA AAL2 on hosted). Tracked as a file-set so a NEW offending route
 *      fails CI even if an old one was fixed in the same PR.
 *   2. naive-ore-round: `Math.round(x * 100) / 100`, which is subtly wrong on
 *      exact-half values (see lib/money.ts `roundOre`). Tracked as a count.
 *      The canonical rounding modules are excluded.
 *   3. direct-jel-insert: a file that inserts into `journal_entry_lines`
 *      outside the sanctioned writers. During the dimensions dual-write window
 *      every line writer must derive cost_center/project via
 *      lineDimensionColumns() from the dimensions JSONB map
 *      (lib/bookkeeping/dimension-resolver.ts): a new direct insert site can
 *      silently diverge the mirror columns. Tracked as a file-set.
 *   3b. ledger-scanning-report: a statement generator under lib/reports or
 *      lib/bokslut that aggregates `journal_entry_lines` itself instead of
 *      going through generateTrialBalance. Aggregating raw lines means
 *      remembering, per report, that the resultatavslut posts the mirror image
 *      of every P&L account into 2099 inside the same fiscal period. Three
 *      reports forgot (årsredovisning 2026-07-23, INK2R and NE-bilaga
 *      2026-07-29) and each read ZERO revenue for a closed year while the
 *      balance sheet still tied out, so nothing warned. generateTrialBalance
 *      now requires an explicit closingEntry mode, which turns the decision
 *      into a compile error; this guard keeps new reports on that path.
 *      Tracked as a file-set. Voucher/line LISTINGS are sanctioned in
 *      LEDGER_SCAN_SANCTIONED: they have no closingEntry decision to make.
 *   4. pinned-dep    : a dependency pinned to an exact version (PINNED_DEPS)
 *      whose package.json spec or locked version drifted from the pin. Guards
 *      against a repeat of the @anthropic-ai/bedrock-sdk 0.32.0 prod outage
 *      (empty Bedrock stream). No baseline: any drift is a hard failure.
 *   5. raw-user-error: raw caught-error messages passed to API response fields,
 *      client error state, or toast fields. Engine, database, and upstream
 *      messages must pass through getErrorMessage() or errorResponse().
 *   6. sek-labelled-amount: a single-argument formatCurrency() call on a value
 *      read off a record the same file reads `.currency` from, which prints a
 *      foreign amount with the SEK symbol. Implementation and rationale in
 *      format-currency-sek-label.mjs. No baseline: the count is 0 today.
 *   7. extension-route guards: physical routes under app/api/extensions/<id>/
 *      (the sanctioned core-build carve-out for crons/OAuth callbacks) may
 *      only import their OWN extension (hard fail, 0 today) and must gate on
 *      extensionRegistry.get('<id>') so a disabled extension never exposes a
 *      live surface (allowlisted file-set, may only shrink). Implementation
 *      and rationale in extension-route-guards.mjs.
 *   8. hand-rolled-invariant: a shared format rule (BAS account number, ISO
 *      date, four-digit fiscal year) spelled out inline instead of imported
 *      from lib/invariants/. The BAS account rule was written out at 20 sites
 *      and the ISO date rule at 68, with error messages that differed per site;
 *      the four Skatteverket-bound org-number paths disagreed outright about
 *      what "valid" meant, which is the kind of drift a customer only discovers
 *      when a filing fails at the deadline. Tracked as a count.
 *
 * Usage:
 *   node scripts/checks/no-new-antipatterns.mjs            # check (CI)
 *   node scripts/checks/no-new-antipatterns.mjs --update   # re-baseline after a migration ratchets the count down
 *
 * Exit code 1 if either check regressed past its baseline.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { findSekLabelledFxAmounts } from './format-currency-sek-label.mjs'
import {
  findExtensionRouteFindings,
  UNGATED_EXTENSION_ROUTES,
} from './extension-route-guards.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASELINE_PATH = path.join(ROOT, 'scripts', 'checks', 'antipatterns-baseline.json')

const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage'])
// The sanctioned home of the öre-round implementation: must not count against itself.
const ROUND_EXEMPT = new Set(['lib/money.ts', 'lib/bokslut/rounding.ts'])

const RAW_AUTH_RE = /\.auth\.getUser\(/
// Match the guard at its CALL site, not a bare import, so a file that imports
// withRouteContext but still hand-rolls getUser() on another handler is still
// flagged. withRouteContext is usually called with a generic (`withRouteContext<…>(`),
// so accept either `<` or `(` after the name.
const GUARD_RE = /requireAuth\(|withRouteContext[<(]/
const NAIVE_ROUND_RE = /Math\.round\([^\n]*\*\s*100\s*\)\s*\/\s*100/

// 8. hand-rolled-invariant. Shared format contracts live in lib/invariants/
// (account number, ISO date, four-digit fiscal year, org number). Before that
// module the BAS account rule was written out at 20 sites and the ISO date rule
// at 68, with error messages that differed per site, and the four
// Skatteverket-bound org-number paths did not agree on what "valid" meant.
//
// Only the two unambiguous regex families are counted. An org-number
// digit-strip is too varied in shape to match reliably by regex; the
// cross-path test in lib/invariants/__tests__/org-number-cross-path.test.ts is
// the guard on that one instead.
const HAND_ROLLED_INVARIANT_RES = [
  // /^\d{4}$/ or /^[0-9]{4}$/  → accountNumberSchema or fiscalYearSchema
  /\/\^(?:\\d|\[0-9\])\{4\}\$\//,
  // /^\d{4}-\d{2}-\d{2}$/      → isoDateSchema or ISO_DATE_RE
  /\/\^(?:\\d|\[0-9\])\{4\}-(?:\\d|\[0-9\])\{2\}-(?:\\d|\[0-9\])\{2\}\$\//,
]
// The sanctioned home of these rules: must not count against itself.
const INVARIANT_EXEMPT_PREFIX = 'lib/invariants/'

function walk(dir, exts, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.well-known') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) walk(full, exts, out)
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(full)
    }
  }
  return out
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')

/** Route files that hand-roll auth instead of the MFA-enforcing guard. */
function findRawRouteAuth() {
  const apiDir = path.join(ROOT, 'app', 'api')
  return walk(apiDir, ['route.ts'])
    .filter((f) => {
      const src = fs.readFileSync(f, 'utf8')
      return RAW_AUTH_RE.test(src) && !GUARD_RE.test(src)
    })
    .map(rel)
    .sort()
}

// Sanctioned journal_entry_lines insert sites. engine/storno write mirrors via
// dimension-resolver; sie-import and sandbox seed write neither dims nor
// mirrors (DB defaults keep them consistent).
const JEL_INSERT_SANCTIONED = new Set([
  'lib/bookkeeping/engine.ts',
  'lib/core/bookkeeping/storno-service.ts',
  'lib/import/sie-import.ts',
  'app/api/sandbox/seed/route.ts',
])
// Matches an insert CHAINED on the lines table (`.from('journal_entry_lines').insert(`,
// with optional whitespace/newlines in the chain): select-only readers don't count.
const JEL_INSERT_CHAIN_RE = /\.from\(\s*['"]journal_entry_lines['"]\s*\)\s*\.\s*(insert|upsert)\(/

/** Files that insert into journal_entry_lines outside the sanctioned writers. */
function findDirectJelInserts() {
  const files = [
    ...walk(path.join(ROOT, 'lib'), ['.ts', '.tsx']),
    ...walk(path.join(ROOT, 'app'), ['.ts', '.tsx']),
    ...walk(path.join(ROOT, 'extensions'), ['.ts', '.tsx']),
  ]
  return files
    .filter((f) => {
      const r = rel(f)
      if (JEL_INSERT_SANCTIONED.has(r)) return false
      if (r.includes('__tests__/') || r.endsWith('.test.ts')) return false
      return JEL_INSERT_CHAIN_RE.test(fs.readFileSync(f, 'utf8'))
    })
    .map(rel)
    .sort()
}

// Statement generators that legitimately read journal_entry_lines directly:
// the trial-balance stack itself, and the reports whose whole job is to list
// vouchers or lines rather than to aggregate a fiscal year's balances.
const LEDGER_SCAN_SANCTIONED = new Set([
  // The shared balance source and its helpers.
  'lib/reports/trial-balance.ts',
  'lib/reports/opening-balances.ts',
  // Voucher/line listings: they must show the ledger as posted, closing
  // verifikat included, so there is no closingEntry decision to get wrong.
  'lib/reports/general-ledger.ts',
  'lib/reports/journal-register.ts',
  'lib/reports/latest-vouchers.ts',
  'lib/reports/source-lines.ts',
  'lib/reports/sie-export.ts',
  'lib/reports/full-archive-export.ts',
  // Aggregate their own dimension-tagged or month-bucketed slice, and each
  // carries an explicit year-end exclusion of its own.
  'lib/reports/dimension-pnl.ts',
  'lib/reports/monthly-breakdown.ts',
  // Reconciliation and diagnostics: they compare against the ledger as posted.
  'lib/reports/ar-reconciliation.ts',
  'lib/reports/supplier-reconciliation.ts',
  'lib/reports/reskontra-payments.ts',
  'lib/reports/imbalance-diagnosis.ts',
  'lib/reports/continuity-check.ts',
  'lib/reports/rc-basis-gaps.ts',
  'lib/reports/vat-settlement.ts',
  'lib/reports/vat-declaration.ts',
  'lib/reports/periodisk-sammanstallning.ts',
  'lib/reports/avgifter-basis.ts',
  'lib/reports/salary-journal.ts',
  'lib/reports/vacation-liability.ts',
])

const LEDGER_SCAN_RE =
  /\.from\(\s*['"]journal_entry_lines['"]\s*\)|fetchEntryLines\s*[<(]|lines:\s*journal_entry_lines\(/

/**
 * Statement generators that scan journal_entry_lines instead of going through
 * generateTrialBalance.
 *
 * WHY: a generator that aggregates a fiscal year's balances from raw lines has
 * to remember, on its own, that the resultatavslut posts the mirror image of
 * every P&L account into 2099 inside the same period. Three shipped without
 * remembering (årsredovisning 2026-07-23, INK2R and NE-bilaga 2026-07-29) and
 * each reported ZERO revenue for a closed year while the balance sheet still
 * tied out, so nothing warned. generateTrialBalance now REQUIRES a
 * closingEntry mode, which makes the decision a compile error instead: this
 * guard is what keeps new generators on that path.
 */
function findLedgerScanningReports() {
  const files = [
    ...walk(path.join(ROOT, 'lib', 'reports'), ['.ts']),
    ...walk(path.join(ROOT, 'lib', 'bokslut'), ['.ts']),
  ]
  return files
    .filter((f) => {
      const r = rel(f)
      if (LEDGER_SCAN_SANCTIONED.has(r)) return false
      if (r.includes('__tests__/') || r.endsWith('.test.ts')) return false
      return LEDGER_SCAN_RE.test(fs.readFileSync(f, 'utf8'))
    })
    .map(rel)
    .sort()
}

/** Count of naive Math.round(x*100)/100 occurrences (lines) across source. */
function countNaiveRound() {
  const files = [
    ...walk(path.join(ROOT, 'lib'), ['.ts', '.tsx']),
    ...walk(path.join(ROOT, 'app'), ['.ts', '.tsx']),
    ...walk(path.join(ROOT, 'components'), ['.ts', '.tsx']),
    ...walk(path.join(ROOT, 'extensions'), ['.ts', '.tsx']),
  ]
  let count = 0
  for (const f of files) {
    if (ROUND_EXEMPT.has(rel(f))) continue
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (NAIVE_ROUND_RE.test(line)) count++
    }
  }
  return count
}

/**
 * Occurrences of a shared format rule written out by hand instead of imported
 * from lib/invariants/. Counted, not file-setted: the campaign lowers the
 * number file by file and the count may only go down.
 */
function countHandRolledInvariants() {
  const files = [
    ...walk(path.join(ROOT, 'lib'), ['.ts', '.tsx']),
    ...walk(path.join(ROOT, 'app'), ['.ts', '.tsx']),
    ...walk(path.join(ROOT, 'components'), ['.ts', '.tsx']),
    ...walk(path.join(ROOT, 'extensions'), ['.ts', '.tsx']),
  ]
  let count = 0
  for (const f of files) {
    const relPath = rel(f)
    if (relPath.startsWith(INVARIANT_EXEMPT_PREFIX)) continue
    // Tests legitimately spell out the pattern they are asserting about.
    if (relPath.includes('__tests__/') || relPath.endsWith('.test.ts')) continue
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (HAND_ROLLED_INVARIANT_RES.some((re) => re.test(line))) count++
    }
  }
  return count
}

// Dependencies pinned to an EXACT version on purpose, because a bump broke prod
// and must not silently return via `npm update`, a dependabot bump, or a manual
// install. Any drift (in package.json OR the lockfile) fails CI. See DECISIONS.md.
const PINNED_DEPS = [
  {
    name: '@anthropic-ai/bedrock-sdk',
    version: '0.29.1',
    reason:
      '0.32.0 (grouped dependabot bump #884) broke Bedrock streaming in prod: empty stream, ' +
      '"request ended without sending any chunks", taking down the AI assistant + invoice OCR. ' +
      'Keep 0.29.1 until 0.32.x streaming is verified against Bedrock.',
  },
]

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Pinned deps whose package.json spec or locked version drifted from the pin.
 *
 * Also scans .github/workflows/*.yml for literal `<name>@<version>` installs:
 * a workflow that installs the SDK by version (e.g. the compliance review's
 * out-of-tree `npm install ...@0.29.1`) bypasses package.json AND the
 * lockfile, so it is exactly where the 0.32.0 regression can drift back in
 * without either file changing.
 */
function findPinnedDepViolations() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
  const declared = { ...pkg.dependencies, ...pkg.devDependencies }
  const out = []
  const workflowFiles = walk(path.join(ROOT, '.github', 'workflows'), ['.yml', '.yaml'])
  for (const pin of PINNED_DEPS) {
    const spec = declared[pin.name]
    if (spec !== undefined && spec !== pin.version) {
      out.push({ ...pin, where: 'package.json', actual: spec })
    }
    const locked = lock.packages?.[`node_modules/${pin.name}`]?.version
    if (locked !== undefined && locked !== pin.version) {
      out.push({ ...pin, where: 'package-lock.json', actual: locked })
    }
    const literalInstall = new RegExp(
      `${escapeRegExp(pin.name)}@(\\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?)`,
      'g',
    )
    for (const wf of workflowFiles) {
      const src = fs.readFileSync(wf, 'utf8')
      for (const match of src.matchAll(literalInstall)) {
        if (match[1] !== pin.version) {
          out.push({ ...pin, where: rel(wf), actual: `${pin.name}@${match[1]}` })
        }
      }
    }
  }
  return out
}

const USER_ERROR_FIELD_NAMES = new Set([
  'description',
  'detail',
  'details',
  'error',
  'message',
  'reason',
  'title',
])

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return null
}

function propertyPath(node) {
  const parts = []
  let current = node
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text)
    current = current.expression
  }
  if (ts.isIdentifier(current)) parts.unshift(current.text)
  return parts
}

function isRawErrorMessage(node) {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'message') return false
  const parts = propertyPath(node)
  if (parts.length < 2) return false
  const root = parts[0]
  return (
    /^(?:e|err|error|cause)$/i.test(root) ||
    /(?:Error|Err)$/.test(root) ||
    parts.slice(0, -1).some((part) => /^(?:error|first_error)$/i.test(part))
  )
}

function isErrorLikeIdentifier(node) {
  return ts.isIdentifier(node) && (
    /^(?:e|err|error|cause)$/i.test(node.text) || /(?:Error|Err)$/.test(node.text)
  )
}

function isRawErrorString(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'String' &&
    node.arguments.length === 1 &&
    isErrorLikeIdentifier(node.arguments[0])
  )
}

function containsRawErrorMessage(node) {
  let found = false
  const visit = (child) => {
    if (found) return
    if (isRawErrorMessage(child) || isRawErrorString(child)) {
      found = true
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function enclosingCatch(node) {
  let current = node.parent
  while (current) {
    if (ts.isCatchClause(current)) return current
    if (ts.isFunctionLike(current)) return null
    current = current.parent
  }
  return null
}

const taintedCatchNames = new WeakMap()

function getTaintedNames(catchClause) {
  const cached = taintedCatchNames.get(catchClause)
  if (cached) return cached

  const declarations = []
  const collect = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      declarations.push(node)
    }
    ts.forEachChild(node, collect)
  }
  collect(catchClause.block)

  const names = new Set()

  const isTaintedValue = (node) => {
    if (isRawErrorMessage(node) || isRawErrorString(node)) return true
    if (ts.isCallExpression(node) && callName(node) === 'getErrorMessage') return false
    if (ts.isConditionalExpression(node)) {
      return isTaintedValue(node.whenTrue) || isTaintedValue(node.whenFalse)
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind !== ts.SyntaxKind.PlusToken) {
      return false
    }
    let tainted = false
    const visit = (child) => {
      if (tainted) return
      if (isRawErrorMessage(child) || isRawErrorString(child)) {
        tainted = true
        return
      }
      if (ts.isIdentifier(child) && names.has(child.text)) {
        tainted = true
        return
      }
      if (ts.isCallExpression(child) && callName(child) === 'getErrorMessage') return
      ts.forEachChild(child, visit)
    }
    ts.forEachChild(node, visit)
    return tainted
  }

  let changed = true
  while (changed) {
    changed = false
    for (const declaration of declarations) {
      if (names.has(declaration.name.text)) continue
      const tainted = isTaintedValue(declaration.initializer)
      if (tainted) {
        names.add(declaration.name.text)
        changed = true
      }
    }
  }

  taintedCatchNames.set(catchClause, names)
  return names
}

function containsRawOrTaintedError(node) {
  if (containsRawErrorMessage(node)) return true
  const catchClause = enclosingCatch(node)
  if (!catchClause) return false
  const names = getTaintedNames(catchClause)
  let found = false
  const visit = (child) => {
    if (found) return
    if (ts.isIdentifier(child) && names.has(child.text)) {
      found = true
      return
    }
    if (ts.isPropertyAssignment(child)) {
      visit(child.initializer)
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function callName(call) {
  const expression = call.expression
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return ''
}

function isLoggingCall(call) {
  const expression = call.expression
  if (!ts.isPropertyAccessExpression(expression)) return false
  const owner = expression.expression.getText()
  return (
    owner === 'console' ||
    /(?:^|\.)log$/.test(owner) ||
    /Log$/.test(owner) ||
    owner.endsWith('Logger')
  )
}

function ancestorCall(node, predicate = () => true) {
  let current = node.parent
  while (current) {
    if (ts.isCallExpression(current) && predicate(current)) return current
    if (ts.isFunctionLike(current)) return null
    current = current.parent
  }
  return null
}

function isApiResponseCall(call) {
  const name = callName(call)
  if (/^(?:errorResponse|errorResponseFromCode|getErrorMessage)$/.test(name)) return false
  if (/^(?:json|v1ErrorResponse|v1ErrorResponseFromCode)$/.test(name)) return true
  if (ts.isPropertyAccessExpression(call.expression)) {
    return call.expression.name.text === 'json'
  }
  return false
}

function isClientErrorSetter(call) {
  const name = callName(call)
  return name === 'toast' || /^set[A-Z].*(?:Error|Message)$/.test(name) || name === 'setError'
}

/**
 * Raw caught-error messages in user-visible sinks. This is deliberately an
 * AST check: line regexes cannot distinguish a logger payload from a JSON
 * response, nor a Zod issue message from err.message.
 */
function findRawUserErrors() {
  const files = [
    ...walk(path.join(ROOT, 'app', 'api'), ['route.ts']),
    ...walk(path.join(ROOT, 'app'), ['.ts', '.tsx']).filter((f) => !rel(f).startsWith('app/api/')),
    ...walk(path.join(ROOT, 'components'), ['.ts', '.tsx']),
  ]
  const findings = []

  for (const file of files) {
    const sourceText = fs.readFileSync(file, 'utf8')
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const isApi = rel(file).startsWith('app/api/')

    const add = (node) => {
      const pos = source.getLineAndCharacterOfPosition(node.getStart(source))
      findings.push(`${rel(file)}:${pos.line + 1}`)
    }

    const visit = (node) => {
      if (ts.isPropertyAssignment(node)) {
        const field = propertyNameText(node.name)
        if (
          field &&
          USER_ERROR_FIELD_NAMES.has(field) &&
          !ts.isObjectLiteralExpression(node.initializer) &&
          containsRawOrTaintedError(node.initializer)
        ) {
          const loggingCall = ancestorCall(node, isLoggingCall)
          const clientSink = ancestorCall(node, isClientErrorSetter)
          if (!loggingCall) {
            if (isApi || clientSink) add(node)
          }
        }
      }

      if (ts.isCallExpression(node) && node.arguments.some(containsRawOrTaintedError)) {
        if (!isLoggingCall(node)) {
          if ((isApi && isApiResponseCall(node)) || (!isApi && isClientErrorSetter(node))) {
            add(node)
          }
        }
      }

      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  return [...new Set(findings)].sort()
}

const current = {
  rawRouteAuth: findRawRouteAuth(),
  naiveOreRound: countNaiveRound(),
  handRolledInvariants: countHandRolledInvariants(),
  ledgerScanningReports: findLedgerScanningReports(),
  directJelInsert: findDirectJelInserts(),
  pinnedDepViolations: findPinnedDepViolations(),
  rawUserErrors: findRawUserErrors(),
  sekLabelledAmounts: findSekLabelledFxAmounts(ROOT),
  extensionRoutes: findExtensionRouteFindings(ROOT),
}

const isUpdate = process.argv.includes('--update')

if (isUpdate) {
  const baseline = {
    _comment:
      'Ratchet baseline for scripts/checks/no-new-antipatterns.mjs. These counts may only decrease. Re-run with --update after a migration lowers them. Goal: both reach 0 (A1 route-auth campaign, D1 rounding codemod).',
    rawRouteAuth: { count: current.rawRouteAuth.length, files: current.rawRouteAuth },
    naiveOreRound: { count: current.naiveOreRound },
    handRolledInvariants: { count: current.handRolledInvariants },
    ledgerScanningReports: {
      count: current.ledgerScanningReports.length,
      files: current.ledgerScanningReports,
    },
  }
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n')
  console.log(
    `Baseline written: ${current.rawRouteAuth.length} raw-route-auth files, ${current.naiveOreRound} naive-ore-round occurrences.`,
  )
  process.exit(0)
}

if (!fs.existsSync(BASELINE_PATH)) {
  console.error('No baseline found. Run: node scripts/checks/no-new-antipatterns.mjs --update')
  process.exit(1)
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
let failed = false

// 1. raw-route-auth: any file not in the baseline set is a NEW violation.
const baselineSet = new Set(baseline.rawRouteAuth.files)
const newAuthFiles = current.rawRouteAuth.filter((f) => !baselineSet.has(f))
const fixedAuthFiles = baseline.rawRouteAuth.files.filter((f) => !current.rawRouteAuth.includes(f))
if (newAuthFiles.length) {
  failed = true
  console.error(
    `\n✗ raw-route-auth: ${newAuthFiles.length} new route(s) call supabase.auth.getUser() directly ` +
      `instead of requireAuth()/withRouteContext() (skips MFA AAL2 enforcement):`,
  )
  newAuthFiles.forEach((f) => console.error(`    ${f}`))
  console.error('  → wrap the route in withRouteContext (or call requireAuth) so MFA is enforced.')
}

// 1b. direct-jel-insert: allowlist lives in this file (JEL_INSERT_SANCTIONED),
// no baseline: any unsanctioned insert site is a hard failure.
if (current.directJelInsert.length) {
  failed = true
  console.error(
    `\n✗ direct-jel-insert: ${current.directJelInsert.length} file(s) insert into journal_entry_lines ` +
      `outside the sanctioned writers:`,
  )
  current.directJelInsert.forEach((f) => console.error(`    ${f}`))
  console.error(
    '  → route line writes through lib/bookkeeping/engine.ts, or derive cost_center/project via\n' +
      '    lineDimensionColumns() (lib/bookkeeping/dimension-resolver.ts) and add the file to\n' +
      '    JEL_INSERT_SANCTIONED in this script with a justification.',
  )
}

// 1c. pinned-dep: a version-pinned dependency must match its pin EXACTLY, in
// both package.json and the lockfile. No baseline: any drift is a hard failure.
if (current.pinnedDepViolations.length) {
  failed = true
  console.error(`\n✗ pinned-dep: ${current.pinnedDepViolations.length} version-pinned dependency change(s):`)
  current.pinnedDepViolations.forEach((v) =>
    console.error(
      `    ${v.name} in ${v.where}: found "${v.actual}", must be exactly "${v.version}".\n      ${v.reason}`,
    ),
  )
  console.error(
    '  → restore the pin (npm install <name>@<version> --save-exact). Only change PINNED_DEPS in\n' +
      '    this script once the upstream regression is confirmed fixed.',
  )
}

// 1d. raw-user-error: user-facing sinks must never receive err.message.
if (current.rawUserErrors.length) {
  failed = true
  console.error(
    `\n✗ raw-user-error: ${current.rawUserErrors.length} user-visible sink(s) expose a raw caught-error message:`,
  )
  current.rawUserErrors.forEach((finding) => console.error(`    ${finding}`))
  console.error(
    '  → map the error through getErrorMessage(), or throw it inside withRouteContext so\n' +
      '    errorResponse() produces the canonical structured envelope.',
  )
}

// 1e. sek-labelled-amount: a foreign amount must never be printed with the SEK
// symbol. No baseline: every current single-argument call formats a SEK twin or
// a ledger column, so the count is 0 and any new one is a hard failure.
if (current.sekLabelledAmounts.length) {
  failed = true
  console.error(
    `\n✗ sek-labelled-amount: ${current.sekLabelledAmounts.length} formatCurrency() call(s) print a possibly-foreign amount as SEK:`,
  )
  current.sekLabelledAmounts.forEach((f) =>
    console.error(`    ${f.where}  formatCurrency(${f.expr})\n      ${f.reason}`),
  )
  console.error(
    '  → pass the record\'s currency as the second argument, formatCurrency(amount, record.currency),\n' +
      '    or format the SEK twin (record.amount_sek / record.total_sek) when one exists.',
  )
}

// 1e2. hand-rolled-invariant: counted, may only go down.
if (current.handRolledInvariants > (baseline.handRolledInvariants?.count ?? Infinity)) {
  failed = true
  console.error(
    `\n✗ hand-rolled-invariant: ${current.handRolledInvariants} inline copies of a shared format rule ` +
      `(baseline ${baseline.handRolledInvariants?.count}):`,
  )
  console.error(
    '  → import the rule instead: accountNumberSchema / isoDateSchema / saneIsoDateSchema /\n' +
      '    fiscalYearSchema from @/lib/invariants/zod, or the ACCOUNT_NUMBER_RE / ISO_DATE_RE\n' +
      '    constants from @/lib/invariants. See lib/invariants/README.md.',
  )
}

// 1f. cross-extension-import: a physical extension route may only import its
// own extension. No baseline: the count is 0 today, any hit is a hard failure.
if (current.extensionRoutes.crossImports.length) {
  failed = true
  console.error(
    `\n✗ cross-extension-import: ${current.extensionRoutes.crossImports.length} route(s) under ` +
      `app/api/extensions/<id>/ import a DIFFERENT extension:`,
  )
  current.extensionRoutes.crossImports.forEach((c) =>
    console.error(`    ${c.file} imports @/extensions/*/${c.imported}/`),
  )
  console.error(
    '  → a physical extension route may only import its own extension; shared logic belongs in lib/\n' +
      '    or behind the Extension.services registry bridge.',
  )
}

// 1g. ungated-extension-route: allowlist lives in extension-route-guards.mjs
// (UNGATED_EXTENSION_ROUTES) and may only shrink. A NEW physical extension
// route must check extensionRegistry.get('<id>') before executing extension
// code, so disabling the extension in extensions.config.json actually
// disarms the deployed route.
const newUngatedRoutes = current.extensionRoutes.ungated.filter(
  (f) => !UNGATED_EXTENSION_ROUTES.has(f),
)
const gatedSinceBaseline = [...UNGATED_EXTENSION_ROUTES].filter(
  (f) => !current.extensionRoutes.ungated.includes(f),
)
if (newUngatedRoutes.length) {
  failed = true
  console.error(
    `\n✗ ungated-extension-route: ${newUngatedRoutes.length} new physical extension route(s) run ` +
      `extension code without checking the registry:`,
  )
  newUngatedRoutes.forEach((f) => console.error(`    ${f}`))
  console.error(
    "  → call loadExtensions() and refuse (503 EXTENSION_DISABLED) when extensionRegistry.get('<id>')\n" +
      '    is undefined, like app/api/extensions/push-notifications/cron/route.ts.',
  )
}

// 1c. ledger-scanning-report: any statement generator not in the baseline set
// is a NEW violation. Grandfathered files stay until they migrate.
const ledgerScanBaseline = new Set(baseline.ledgerScanningReports?.files ?? [])
const newLedgerScans = current.ledgerScanningReports.filter((f) => !ledgerScanBaseline.has(f))
const fixedLedgerScans = (baseline.ledgerScanningReports?.files ?? []).filter(
  (f) => !current.ledgerScanningReports.includes(f),
)
if (newLedgerScans.length) {
  failed = true
  console.error(
    `\n✗ ledger-scanning-report: ${newLedgerScans.length} statement generator(s) aggregate ` +
      `journal_entry_lines directly instead of going through generateTrialBalance:`,
  )
  newLedgerScans.forEach((f) => console.error(`    ${f}`))
  console.error(
    '  → call generateTrialBalance with an explicit closingEntry mode. Aggregating raw\n' +
      '    lines means remembering the resultatavslut yourself, and three reports already\n' +
      '    forgot (each read ZERO revenue for a closed year while the balance sheet still\n' +
      '    tied out, so nothing warned). If the report genuinely lists vouchers rather\n' +
      '    than balances, add it to LEDGER_SCAN_SANCTIONED in this file with a reason.',
  )
}

// 2. naive-ore-round: count may not increase.
if (current.naiveOreRound > baseline.naiveOreRound.count) {
  failed = true
  console.error(
    `\n✗ naive-ore-round: ${current.naiveOreRound} occurrences of Math.round(x*100)/100 ` +
      `(baseline ${baseline.naiveOreRound.count}, +${current.naiveOreRound - baseline.naiveOreRound.count}).`,
  )
  console.error('  → import roundOre from @/lib/money instead.')
}

// Report ratchet-down progress (informational, never fails).
if (fixedAuthFiles.length || fixedLedgerScans.length || current.naiveOreRound < baseline.naiveOreRound.count) {
  console.log('\n✓ Progress since baseline:')
  if (fixedAuthFiles.length) console.log(`    raw-route-auth: -${fixedAuthFiles.length} file(s)`)
  if (fixedLedgerScans.length)
    console.log(`    ledger-scanning-report: -${fixedLedgerScans.length} file(s)`)
  if (current.naiveOreRound < baseline.naiveOreRound.count)
    console.log(`    naive-ore-round: -${baseline.naiveOreRound.count - current.naiveOreRound} occurrence(s)`)
  console.log('    Run with --update to ratchet the baseline down and lock in the gains.')
}
if (gatedSinceBaseline.length) {
  console.log(
    `\n✓ ungated-extension-route progress: ${gatedSinceBaseline.length} allowlisted route(s) now gated or gone.` +
      ' Remove them from UNGATED_EXTENSION_ROUTES in scripts/checks/extension-route-guards.mjs to lock it in:',
  )
  gatedSinceBaseline.forEach((f) => console.log(`    ${f}`))
}

if (failed) {
  console.error('\nAntipattern guard failed: see above.')
  process.exit(1)
}
console.log(
  `\n✓ Antipattern guard passed (raw-route-auth: ${current.rawRouteAuth.length}, naive-ore-round: ${current.naiveOreRound}, hand-rolled-invariant: ${current.handRolledInvariants}, ledger-scanning-report: ${current.ledgerScanningReports.length}, direct-jel-insert: 0, pinned-dep: 0, raw-user-error: 0, sek-labelled-amount: 0, cross-extension-import: 0, ungated-extension-route: ${current.extensionRoutes.ungated.length}/${UNGATED_EXTENSION_ROUTES.size} allowlisted).`,
)
