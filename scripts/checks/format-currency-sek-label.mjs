#!/usr/bin/env node
/**
 * Guard: a foreign amount printed with the SEK symbol.
 *
 * `formatCurrency(amount, currency = 'SEK')` (lib/utils.ts) defaults its second
 * argument, and that default is deliberate: `formatCurrency(amount)` is the
 * right call on the ~hundreds of values that ARE kronor, and sv-SE/SEK output
 * in both locales is a Swedish accounting convention rather than a UI string
 * (.claude/rules/i18n.md). What the default cannot do is notice when the number
 * handed to it came off a record that carries its own currency: there the
 * omitted argument silently relabels 100 EUR as "100,00 kr".
 *
 * So this check does not touch the signature; it fails CI on the ONE shape the
 * default cannot defend against:
 *
 *   1. A single-argument call whose amount is read off an owner that the SAME
 *      file also reads `.currency` from. The file demonstrably knows the unit
 *      and dropped it: `formatCurrency(invoice.total)` two lines under
 *      `invoice.currency !== 'SEK'`. The currency argument (or the `*_sek`
 *      twin) is right there.
 *   2. A single-argument call on `amount_in_currency`, which is by definition
 *      the foreign figure on a journal entry line and never kronor.
 *
 * NOT flagged, on purpose:
 *   - `debit_amount` / `credit_amount` (and the bare `debit` / `credit` used by
 *     preview rows). Journal entry line amounts are ALWAYS SEK; `line.currency`
 *     labels the DOCUMENT, not the figure (lib/bookkeeping/ledger-line-amount.ts).
 *     A file that correctly reads both must not be accused.
 *   - Any `*_sek` / `*Sek` field: that IS the kronor twin, and rendering it with
 *     the SEK symbol is exactly right (see the five call sites this rule was
 *     calibrated against, e.g. components/invoices/SendInvoiceDialog.tsx).
 *   - A multiplicative expression (`total * exchangeRate`): that is a
 *     conversion INTO kronor, so the result is SEK.
 *   - Owners the file never reads a currency from. Judging a bare local like
 *     `formatCurrency(totalDebit)` would need whole-program dataflow, and
 *     guessing there is how a guard earns its way onto an ignore list.
 *
 * Escape hatch: add `<relative path>#<owner>.<field>` to SANCTIONED below with
 * a justification. Line numbers are deliberately not part of the key, so an
 * unrelated edit above the call cannot break the entry.
 *
 * Usage:
 *   node scripts/checks/format-currency-sek-label.mjs            # scan the repo
 *   node scripts/checks/format-currency-sek-label.mjs <dir>      # scan a tree
 *   node scripts/checks/format-currency-sek-label.mjs <dir> --json
 *
 * Wired into `npm run check:guards` (scripts/checks/no-new-antipatterns.mjs).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/** Subtrees scanned, relative to the root passed in. */
const SCAN_DIRS = ['lib', 'app', 'components', 'extensions']
const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage'])

/**
 * Deliberate single-argument calls on a currency-bearing owner, keyed
 * `<relative path>#<owner>.<field>`. Empty today: every such call in the repo
 * formats a `*_sek` twin or a ledger column and is excluded by rule.
 */
const SANCTIONED = new Set()

/** Fields whose value is kronor no matter what currency the owner carries. */
const ALWAYS_SEK_FIELDS = new Set([
  // Journal entry line columns. See lib/bookkeeping/ledger-line-amount.ts.
  'debit_amount',
  'credit_amount',
  'debit',
  'credit',
  'total_debit',
  'total_credit',
])

/** By definition the foreign figure: never kronor, so never single-argument. */
const NEVER_SEK_FIELDS = new Set(['amount_in_currency'])

/** Calls that pass the unit through unchanged, so we look at their argument. */
const UNIT_PRESERVING_CALLS = new Set([
  'Number',
  'parseFloat',
  'parseInt',
  'abs',
  'round',
  'trunc',
  'roundOre',
  'roundToOre',
])

const UNWRAP_KINDS = new Set([
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.SatisfiesExpression,
  ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.TypeAssertionExpression,
])

function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) walk(full, out)
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** `a.b.c` -> { owner: 'a.b', field: 'c' }; anything not identifier-rooted -> null. */
function accessChain(node) {
  const parts = []
  let current = node
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text)
    current = current.expression
  }
  if (!ts.isIdentifier(current) || parts.length === 0) return null
  const field = parts.pop()
  return { owner: [current.text, ...parts].join('.'), field }
}

/**
 * Every property access whose value the expression forwards in the SAME unit.
 * Both branches of `??` / `||` / `?:` and both operands of `+` / `-` count: a
 * `total_sek ?? total` fallback is precisely the shape that prints a foreign
 * number when the SEK twin is missing.
 */
function unitBearingAccesses(node, out = []) {
  if (!node) return out
  if (UNWRAP_KINDS.has(node.kind) && node.expression) return unitBearingAccesses(node.expression, out)
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)
  ) {
    return unitBearingAccesses(node.operand, out)
  }
  if (ts.isConditionalExpression(node)) {
    unitBearingAccesses(node.whenTrue, out)
    unitBearingAccesses(node.whenFalse, out)
    return out
  }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind
    const forwards =
      kind === ts.SyntaxKind.QuestionQuestionToken ||
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.PlusToken ||
      kind === ts.SyntaxKind.MinusToken
    // Multiplication / division is a CONVERSION (amount * exchangeRate), so the
    // result is no longer the operand's unit and must not be judged as one.
    if (!forwards) return out
    unitBearingAccesses(node.left, out)
    unitBearingAccesses(node.right, out)
    return out
  }
  if (ts.isCallExpression(node) && node.arguments.length >= 1) {
    const callee = node.expression
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ''
    if (UNIT_PRESERVING_CALLS.has(name)) return unitBearingAccesses(node.arguments[0], out)
    return out
  }
  if (ts.isPropertyAccessExpression(node)) {
    const chain = accessChain(node)
    if (chain) out.push(chain)
    return out
  }
  return out
}

function isSekTwin(field) {
  return /(?:_sek|sek)$/i.test(field)
}

/** Findings for one source file. `relPath` is only used to build the message. */
export function findSekLabelledFxAmountsInSource(relPath, text) {
  if (!text.includes('formatCurrency(')) return []
  const source = ts.createSourceFile(
    relPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  // Owners this file reads a currency off: `invoice.currency`, `tx?.currency`,
  // `data.invoice.currency`. Matched as a full owner path, not just the root
  // identifier, so knowing `invoice.currency` says nothing about `line.amount`.
  const currencyOwners = new Set()
  const calls = []
  const collect = (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'currency') {
      const chain = accessChain(node)
      if (chain) currencyOwners.add(chain.owner)
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ''
      if (name === 'formatCurrency') calls.push(node)
    }
    ts.forEachChild(node, collect)
  }
  collect(source)

  const findings = []
  for (const call of calls) {
    for (const { owner, field } of unitBearingAccesses(call.arguments[0])) {
      if (SANCTIONED.has(`${relPath}#${owner}.${field}`)) continue
      const foreignByName = NEVER_SEK_FIELDS.has(field)
      if (!foreignByName) {
        if (!currencyOwners.has(owner)) continue
        if (ALWAYS_SEK_FIELDS.has(field) || isSekTwin(field)) continue
      }
      const line = source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1
      findings.push({
        where: `${relPath}:${line}`,
        expr: `${owner}.${field}`,
        reason: foreignByName
          ? `${field} is the amount in the document's own currency, never SEK`
          : `${relPath.split('/').pop()} reads ${owner}.currency, so ${owner}.${field} may not be SEK`,
      })
    }
  }
  return findings
}

/** Findings across `SCAN_DIRS` under `root`, sorted and de-duplicated. */
export function findSekLabelledFxAmounts(root) {
  const files = SCAN_DIRS.flatMap((dir) => walk(path.join(root, dir)))
  const findings = []
  for (const file of files) {
    const relPath = path.relative(root, file).split(path.sep).join('/')
    findings.push(...findSekLabelledFxAmountsInSource(relPath, fs.readFileSync(file, 'utf8')))
  }
  const seen = new Set()
  return findings
    .filter((f) => {
      const key = `${f.where}|${f.expr}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => `${a.where}|${a.expr}`.localeCompare(`${b.where}|${b.expr}`))
}

// Standalone entry point: also what the unit test drives, so the CI path and
// the tested path are the same code.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const root = args.find((a) => !a.startsWith('--')) ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
  const findings = findSekLabelledFxAmounts(root)
  if (json) {
    console.log(JSON.stringify(findings, null, 2))
  } else if (findings.length) {
    for (const f of findings) console.error(`${f.where}  formatCurrency(${f.expr}): ${f.reason}`)
  } else {
    console.log('✓ no SEK-labelled foreign amounts found.')
  }
  process.exit(findings.length ? 1 : 0)
}
