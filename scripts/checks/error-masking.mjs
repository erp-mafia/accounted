#!/usr/bin/env node
/**
 * Guard: errors swallowed without a trace.
 *
 * GitClear's 2026 Maintainability Gap measured error-masking constructs up 47%
 * as agents write more of the code: a failure that is caught and dropped
 * turns into wrong data nobody can trace (the October 2026 accrual case: a
 * credit that "succeeded" while its storno step was skipped). A caught error
 * must leave a trace: a log line, a warning the caller shows, a rethrow, or a
 * comment saying why ignoring it is safe.
 *
 * Flagged, in src/**\/*.{ts,tsx} (tests and generated files excluded):
 *   - `catch {}` / `catch (e) {}`: an empty catch block;
 *   - a catch block whose statements are only `return`, `continue` or
 *     `break` and never mention the caught error (a fallback with no trace);
 *   - `.catch(() => {})`, and `.catch(() => null | undefined | false | void 0)`
 *     (expression body or a block holding only that return).
 * Not flagged: any of these with a comment inside the handler (the reason
 * the error is safe to ignore), a `.catch(...)` with a comment on the same
 * line, a handler that passes the error on (`return { ok: false, error: e }`)
 * or answers a typed failure (`return { ok: false, code: 'X' }`), and the
 * tolerant body read `response.json().catch(() => null)`, whose status the
 * caller checks next.
 *
 * Ratchet: per file count, a file may only go down and a new file may not
 * introduce one. The fix is in ERROR_MASKING_HINT.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const ERROR_MASKING_HINT =
  'Log it (createLogger), surface it as a warning (OperationWarning), rethrow, or add a comment saying why it is safe to ignore.'

const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__', '__fixtures__', '_generated'])
const GENERATED_HEADER = /AUTO-GENERATED|@generated|DO NOT EDIT/

function* walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) yield full
  }
}

const hasComment = (text) => /\/\/|\/\*/.test(text)

/** True when `node` (or anything under it) names the identifier `name`. */
function mentions(node, name) {
  if (!name) return false
  let found = false
  const visit = (n) => {
    if (found) return
    if (ts.isIdentifier(n) && n.text === name) found = true
    else ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

/**
 * A returned object literal that reports the failure to the caller: it has
 * `ok: false`, or a `code`, `error` or `reason` property. That surfaces the
 * error as a typed outcome, it does not drop it.
 */
function isTypedFailure(expr) {
  if (!expr) return false
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression?.(expr)) return isTypedFailure(expr.expression)
  if (!ts.isObjectLiteralExpression(expr)) return false
  return expr.properties.some((p) => {
    if (!p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return false
    const key = p.name.text
    if (key === 'ok') return ts.isPropertyAssignment(p) && p.initializer.kind === ts.SyntaxKind.FalseKeyword
    return key === 'code' || key === 'error' || key === 'reason'
  })
}

const isTrivialExit = (stmt) =>
  (ts.isReturnStatement(stmt) && !isTypedFailure(stmt.expression)) || ts.isContinueStatement(stmt) || ts.isBreakStatement(stmt)

/**
 * `response.json().catch(...)` / `.text().catch(...)`: the tolerant read of an
 * HTTP body whose status the caller checks next. Not an error being dropped.
 */
function isBodyRead(callee) {
  const target = callee.expression
  return (
    ts.isCallExpression(target) &&
    ts.isPropertyAccessExpression(target.expression) &&
    (target.expression.name.text === 'json' || target.expression.name.text === 'text')
  )
}

/** `null`, `undefined`, `false` or `void <expr>`. */
function isNothingValue(expr) {
  if (!expr) return true
  if (ts.isParenthesizedExpression(expr)) return isNothingValue(expr.expression)
  return (
    expr.kind === ts.SyntaxKind.NullKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(expr) && expr.text === 'undefined') ||
    ts.isVoidExpression(expr)
  )
}

/** Swallowing `.catch(handler)` handler: empty, or answering only nothing. */
function isSwallowingHandler(fn) {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false
  const body = fn.body
  if (!ts.isBlock(body)) return isNothingValue(body)
  if (body.statements.length === 0) return true
  return body.statements.length === 1 && ts.isReturnStatement(body.statements[0]) && isNothingValue(body.statements[0].expression)
}

// Cheap prefilter: only a file with a candidate shape is parsed. A catch
// block that opens on an exit or closes at once, or a .catch with an inline
// handler. The AST below decides; this only skips files that cannot match.
const CANDIDATE_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\}|return\b|continue\b|break\b)/
const CANDIDATE_DOT_CATCH = /\.catch\(\s*(?:async\s*)?(?:\(\s*[\w$]*\s*(?::[^)]*)?\)|[\w$]+)\s*=>|\.catch\(\s*function\b/

/** [{ line, kind }] for every swallowed error in one source text. */
export function findErrorMaskingInSource(fileName, src) {
  if (!CANDIDATE_CATCH.test(src) && !CANDIDATE_DOT_CATCH.test(src)) return []
  const source = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, false, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const findings = []
  const lineOf = (pos) => source.getLineAndCharacterOfPosition(pos).line + 1
  const lineText = (pos) => {
    const { line } = source.getLineAndCharacterOfPosition(pos)
    const starts = source.getLineStarts()
    return src.slice(starts[line], line + 1 < starts.length ? starts[line + 1] : src.length)
  }

  const visit = (node) => {
    if (ts.isCatchClause(node)) {
      const block = node.block
      const text = src.slice(block.getStart(source), block.end)
      const errName = node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name) ? node.variableDeclaration.name.text : null
      if (!hasComment(text)) {
        if (block.statements.length === 0) findings.push({ line: lineOf(node.getStart(source)), kind: 'empty catch' })
        else if (block.statements.every(isTrivialExit) && !block.statements.some((s) => mentions(s, errName)))
          findings.push({ line: lineOf(node.getStart(source)), kind: 'catch without trace' })
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'catch' &&
      node.arguments.length >= 1 &&
      !isBodyRead(node.expression) &&
      isSwallowingHandler(node.arguments[0])
    ) {
      const handler = node.arguments[0]
      const handlerText = src.slice(handler.getStart(source), handler.end)
      if (!hasComment(handlerText) && !hasComment(lineText(node.end))) {
        findings.push({ line: lineOf(node.expression.name.getStart(source)), kind: '.catch swallowing' })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

/** [{ file, line, kind }] for every swallowed error under `root` (the src directory). */
export function findErrorMasking(root) {
  const findings = []
  for (const full of walk(root)) {
    const src = fs.readFileSync(full, 'utf8')
    if (GENERATED_HEADER.test(src.slice(0, 600))) continue
    const file = path.relative(root, full).split(path.sep).join('/')
    for (const f of findErrorMaskingInSource(file, src)) findings.push({ file, ...f })
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

/** The guard's message for one site. */
export function formatErrorMasking(site) {
  return `Swallowed error in ${site.file}:${site.line} (${site.kind}). ${ERROR_MASKING_HINT}`
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
  const started = Date.now()
  const findings = findErrorMasking(root)
  const byKind = {}
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1
  for (const f of findings.slice(0, Number((process.argv.find((a) => a.startsWith('--top=')) ?? '--top=20').slice(6)))) console.log(formatErrorMasking(f))
  console.log(`${findings.length} swallowed error(s) in ${new Set(findings.map((f) => f.file)).size} file(s) ${JSON.stringify(byKind)}, ${Date.now() - started} ms`)
}
