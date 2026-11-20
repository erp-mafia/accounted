/**
 * Static scan for the writers of links (src/lib/links/link-basis.ts), shared
 * by the coverage ratchet next to it. Reads the code, never a database.
 *
 * Application writers: every Supabase query-builder chain, read through the
 * TypeScript AST, whose `.from(<table>)` is a link table and whose
 * `.insert()` / `.update()` / `.upsert()` writes a link:
 *   - transaction_voucher_links, invoice_payments, supplier_invoice_payments,
 *     account_reconciliation_settlements: every insert and upsert, and every
 *     update that sets journal_entry_id or transaction_id;
 *   - transactions, document_attachments: a write whose payload sets
 *     journal_entry_id to anything but a literal null (the verifikat link
 *     those rows carry);
 * plus every uploadDocument() call whose metadata names a journal_entry_id.
 * A writer is stamped when its payload names link_basis or calls
 * linkBasisColumns / linkBasisColumnsFor / scopeFreeLinkBasisColumns
 * (directly, or through a spread of a constant defined from one), or, for
 * uploadDocument, passes linkBasis.
 * linkToJournalEntry, recordInvoicePaymentRow, writeBankLink, manualLink and
 * bookSupplierBankMatch take the basis as a required parameter, so the
 * compiler covers their callers.
 *
 * SQL writers: the newest definition of every function in
 * supabase/migrations that inserts into a link table or sets a verifikat link
 * on transactions / document_attachments. A function is stamped when its body
 * names link_basis.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

export const LINK_ROW_TABLES = [
  'transaction_voucher_links',
  'invoice_payments',
  'supplier_invoice_payments',
  'account_reconciliation_settlements',
] as const
export const LINK_COLUMN_TABLES = ['transactions', 'document_attachments'] as const
export const LINK_TABLES = [...LINK_ROW_TABLES, ...LINK_COLUMN_TABLES] as const

export interface LinkWriterSite {
  /** Repo-relative path. */
  file: string
  line: number
  table: string
  op: string
  stamped: boolean
}

const SKIP_DIRS = new Set(['node_modules', '__tests__', '.next', 'dist', 'build', 'coverage'])

export function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(full)
      }
    }
  }
  walk(dir)
  return out.sort()
}

/** The nearest preceding `const|let name = <init>` in the file. */
function declarationBefore(sf: ts.SourceFile, name: string, pos: number): ts.Expression | null {
  let found: ts.Expression | null = null
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      node.getStart(sf) < pos
    ) {
      if (!found || node.getStart(sf) > found.getStart(sf)) found = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

function stringValue(sf: ts.SourceFile, node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isIdentifier(node)) {
    const init = declarationBefore(sf, node.text, node.getStart(sf))
    if (init && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))) return init.text
  }
  return null
}

/** The `.from(x)` call this method call hangs off, walking down the receiver chain. */
function fromTable(sf: ts.SourceFile, call: ts.CallExpression): string | null {
  let expr: ts.Expression = (call.expression as ts.PropertyAccessExpression).expression
  for (;;) {
    if (ts.isParenthesizedExpression(expr) || ts.isAwaitExpression(expr) || ts.isNonNullExpression(expr)) {
      expr = expr.expression
      continue
    }
    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
      if (expr.expression.name.text === 'from' && expr.arguments.length >= 1) {
        return stringValue(sf, expr.arguments[0])
      }
      expr = expr.expression.expression
      continue
    }
    if (ts.isPropertyAccessExpression(expr)) {
      expr = expr.expression
      continue
    }
    return null
  }
}

/** The payload expression, following an identifier to its declaration. */
function resolvePayload(sf: ts.SourceFile, node: ts.Expression): ts.Expression {
  if (ts.isIdentifier(node)) {
    const init = declarationBefore(sf, node.text, node.getStart(sf))
    if (init) return init
  }
  return node
}

function objectLiterals(node: ts.Node): ts.ObjectLiteralExpression[] {
  const out: ts.ObjectLiteralExpression[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n)) out.push(n)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

function propertyName(p: ts.ObjectLiteralElementLike): string | null {
  if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name) {
    if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text
  }
  return null
}

/** Does the payload set `column` to anything but a literal null/undefined? */
function setsColumn(payload: ts.Expression, column: string): boolean {
  for (const obj of objectLiterals(payload)) {
    for (const p of obj.properties) {
      if (propertyName(p) !== column) continue
      if (ts.isShorthandPropertyAssignment(p)) return true
      if (ts.isPropertyAssignment(p)) {
        const init = p.initializer
        if (init.kind === ts.SyntaxKind.NullKeyword) continue
        if (ts.isIdentifier(init) && init.text === 'undefined') continue
        return true
      }
    }
  }
  return false
}

function isStamped(sf: ts.SourceFile, payload: ts.Expression): boolean {
  const text = payload.getText(sf)
  if (/\blink_basis\b|\b(?:linkBasisColumns(?:For)?|scopeFreeLinkBasisColumns)\s*\(/.test(text)) return true
  for (const obj of objectLiterals(payload)) {
    for (const p of obj.properties) {
      if (ts.isSpreadAssignment(p) && ts.isIdentifier(p.expression)) {
        const init = declarationBefore(sf, p.expression.text, p.getStart(sf))
        if (init && /\b(?:linkBasisColumns(?:For)?|scopeFreeLinkBasisColumns)\s*\(/.test(init.getText(sf))) return true
      }
    }
  }
  return false
}

export function scanApplicationWriters(files: string[] = listSourceFiles(path.join(ROOT, 'src'))): LinkWriterSite[] {
  const sites: LinkWriterSite[] = []
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    if (!/\.from\(|uploadDocument\(/.test(source)) continue
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const rel = path.relative(ROOT, file)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        if (ts.isPropertyAccessExpression(callee) && ['insert', 'update', 'upsert'].includes(callee.name.text) && node.arguments.length >= 1) {
          const table = fromTable(sf, node)
          if (table && (LINK_TABLES as readonly string[]).includes(table)) {
            const payload = resolvePayload(sf, node.arguments[0])
            const op = callee.name.text
            const isRowTable = (LINK_ROW_TABLES as readonly string[]).includes(table)
            const writesLink = isRowTable
              ? op !== 'update' || setsColumn(payload, 'journal_entry_id') || setsColumn(payload, 'transaction_id')
              : setsColumn(payload, 'journal_entry_id')
            if (writesLink) {
              sites.push({
                file: rel,
                line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
                table,
                op,
                stamped: isStamped(sf, payload),
              })
            }
          }
        }
        if (ts.isIdentifier(callee) && callee.text === 'uploadDocument' && node.arguments.length >= 5) {
          const meta = resolvePayload(sf, node.arguments[4])
          if (setsColumn(meta, 'journal_entry_id')) {
            const named = objectLiterals(meta).some((o) => o.properties.some((p) => propertyName(p) === 'linkBasis'))
            sites.push({
              file: rel,
              line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
              table: 'document_attachments',
              op: 'uploadDocument',
              stamped: named,
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return sites
}

/** Unstamped application writer sites per file. */
export function unstampedByFile(sites: LinkWriterSite[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of sites) if (!s.stamped) out[s.file] = (out[s.file] ?? 0) + 1
  return out
}

// ---------------------------------------------------------------------------
// SQL functions
// ---------------------------------------------------------------------------

/** Line comments blanked (a `--` inside a string literal is rare enough here). */
function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

/** name -> newest body, replaying supabase/migrations in version order. */
export function latestFunctionBodies(dir: string = path.join(ROOT, 'supabase', 'migrations')): Map<string, { body: string; file: string }> {
  const bodies = new Map<string, { body: string; file: string }>()
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const createRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi
  const dropRe = /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi
  for (const f of files) {
    const sql = stripLineComments(fs.readFileSync(path.join(dir, f), 'utf8'))
    // Events in file order: a DROP followed by a CREATE of the same name leaves the CREATE.
    const events: Array<{ at: number; kind: 'create' | 'drop'; name: string; body?: string }> = []
    let m: RegExpExecArray | null
    while ((m = createRe.exec(sql))) {
      const name = m[1].toLowerCase()
      const asIdx = sql.slice(m.index).search(/\bAS\s+(\$[a-z_]*\$)/i)
      if (asIdx === -1) continue
      const tagMatch = /\bAS\s+(\$[a-z_]*\$)/i.exec(sql.slice(m.index + asIdx))
      if (!tagMatch) continue
      const tag = tagMatch[1]
      const bodyStart = m.index + asIdx + tagMatch.index + tagMatch[0].length
      const bodyEnd = sql.indexOf(tag, bodyStart)
      if (bodyEnd === -1) continue
      events.push({ at: m.index, kind: 'create', name, body: sql.slice(bodyStart, bodyEnd) })
    }
    while ((m = dropRe.exec(sql))) events.push({ at: m.index, kind: 'drop', name: m[1].toLowerCase() })
    events.sort((a, b) => a.at - b.at)
    for (const e of events) {
      if (e.kind === 'drop') bodies.delete(e.name)
      else bodies.set(e.name, { body: e.body ?? '', file: f })
    }
  }
  return bodies
}

const SQL_ROW_INSERT = new RegExp(`INSERT\\s+INTO\\s+(?:public\\.)?(${LINK_ROW_TABLES.join('|')})\\b`, 'i')
const SQL_COLUMN_INSERT = /INSERT\s+INTO\s+(?:public\.)?(transactions|document_attachments)\s*\(([^)]*)\)/gi
const SQL_LINK_UPDATE = /UPDATE\s+(?:public\.)?(transactions|document_attachments|transaction_voucher_links)\b(?:\s+(?:AS\s+)?[a-z_]+)?\s+SET\s+([\s\S]*?)(?:\bWHERE\b|\bFROM\b|\bRETURNING\b|;)/gi

/** Does a function body write a link? */
export function sqlBodyWritesLink(body: string): boolean {
  if (SQL_ROW_INSERT.test(body)) return true
  for (const m of body.matchAll(SQL_COLUMN_INSERT)) {
    if (/\bjournal_entry_id\b/i.test(m[2])) return true
  }
  for (const m of body.matchAll(SQL_LINK_UPDATE)) {
    const set = m[2]
    const assign = /\bjournal_entry_id\s*=\s*([^,\n]+)/i.exec(set)
    if (assign && !/^\s*NULL\b/i.test(assign[1])) return true
  }
  return false
}

export interface SqlLinkWriter {
  name: string
  file: string
  stamped: boolean
}

export function scanSqlWriters(bodies = latestFunctionBodies()): SqlLinkWriter[] {
  const out: SqlLinkWriter[] = []
  for (const [name, { body, file }] of bodies) {
    if (!sqlBodyWritesLink(body)) continue
    out.push({ name, file, stamped: /\blink_basis\b/i.test(body) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
