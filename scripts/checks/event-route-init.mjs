/**
 * Guard: an API route that can emit a core event must have the event bus wired.
 *
 * lib/events/bus.ts is an in-process singleton that returns early when an
 * event type has no handler. Every handler (event_log persistence, public
 * webhooks, supplier-invoice booking, document reads, extension handlers) is
 * registered by ensureInitialized() in lib/init.ts, and nothing else wires
 * them. A route that reaches an emitting service without that call therefore
 * drops its events silently: no error, no log line, no event_log row. The
 * 2026-09-30 audit found 636 of 758 period locks in production with no
 * `period.locked` event: the session route that locks a period never
 * initialised the bus, so the event only landed when an earlier request had
 * happened to warm the same process.
 *
 * The contract is route-level: a route that can emit calls ensureInitialized()
 * at module scope. withRouteContext deliberately does not wire the bus, so
 * lib/init and the whole extension registry stay out of the cold-start import
 * graph of the many wrapped routes that never emit. Initialisation counts when
 * either holds:
 *   - the route file calls ensureInitialized() as a top-level statement;
 *   - a module in the route's runtime import closure does (lib/api/v1/
 *     with-api-v1.ts for every withApiV1 route, the ext/[...path] router).
 * A call inside a handler does not count: module scope is the one pattern, and
 * it runs before any handler can emit.
 *
 * "Can emit" is static reachability: the route's runtime import closure
 * (type-only imports excluded, dynamic import() included) contains a module
 * that references `eventBus.emit`, as a call or as a bound reference. That
 * over-approximates: a route that imports a service for a function that never
 * emits still counts. Wiring the bus on such a route costs only its cold
 * start, so the guard errs that way.
 *
 * Pre-existing offenders are allowlisted in UNINITIALIZED_EMITTING_ROUTES and
 * the set may only shrink.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/**
 * Routes that reach an emitting module without initialising the event bus,
 * as of the route-level fix (2026-09-30). Remove an entry once its route calls
 * ensureInitialized() at module scope or no longer reaches an emitter; never
 * add one.
 */
export const UNINITIALIZED_EMITTING_ROUTES = new Set([
  // withCronContext routes, unchanged by the route-level fix. The SIE worker
  // initialises lazily inside its sweep (lib/import/sie-post-import-sweep.ts),
  // which a module-scope check cannot see.
  'app/api/arkiv/derive/cron/route.ts',
  'app/api/documents/classify/cron/route.ts',
  'app/api/documents/read/cron/route.ts',
  'app/api/documents/verify/cron/route.ts',
  'app/api/extensions/arcim-migration/complete-invoice-lines/cron/route.ts',
  'app/api/extensions/arcim-migration/worker/cron/route.ts',
  'app/api/extensions/cloud-backup/auto-sync/cron/route.ts',
  'app/api/extensions/invoice-inbox/sweep/cron/route.ts',
  'app/api/extensions/invoice-inbox/underlag-reconcile/cron/route.ts',
  'app/api/extensions/push-notifications/cron/route.ts',
  'app/api/extensions/shopify/orders/cron/route.ts',
  'app/api/extensions/stripe/transactions/cron/route.ts',
  'app/api/extensions/whatsapp-inbox/retention/cron/route.ts',
  'app/api/extensions/whatsapp-inbox/sweep/cron/route.ts',
  'app/api/extensions/woocommerce/orders/cron/route.ts',
  'app/api/extensions/zettle/orders/cron/route.ts',
  'app/api/import/sie/worker/cron/route.ts',
  'app/api/invoices/reminders/cron/route.ts',
  // Raw requireAuth() routes that reach an emitting module only through a
  // helper that never emits (minimisePayload from lib/webhooks/handler,
  // detectFileMagic from document-service): the over-approximation above.
  'app/api/byra/brand/logo/route.ts',
  'app/api/events/route.ts',
])

// `emit` as a whole word, called or not: `eventBus.emit.bind(eventBus)` hands
// the emitter to a callback (enable-banking does this) and must still count.
const EMIT_RE = /\beventBus\s*\.\s*emit\b/
const DYNAMIC_IMPORT_RE = /\bimport\s*\(/
const INIT_FILE = 'lib/init.ts'
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx']

function isTestPath(rel) {
  return rel.includes('/__tests__/') || /\.test\.tsx?$/.test(rel)
}

function walkRouteFiles(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue
      walkRouteFiles(full, out)
    } else if (e.name === 'route.ts') {
      out.push(full)
    }
  }
  return out
}

/** True for `import type`, `export type`, and `import { type A, type B }`. */
function isTypeOnlyImport(node) {
  const clause = node.importClause
  if (!clause) return false
  if (clause.isTypeOnly) return true
  if (clause.name) return false
  const bindings = clause.namedBindings
  if (!bindings || !ts.isNamedImports(bindings)) return false
  return bindings.elements.length > 0 && bindings.elements.every((el) => el.isTypeOnly)
}

function isEnsureInitializedCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'ensureInitialized'
  )
}

/**
 * Parse one module: its runtime import specifiers, whether it emits, and
 * whether it calls ensureInitialized() as a top-level statement.
 */
function analyseSource(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false)
  const specifiers = []
  let topLevelInit = false

  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      if (!isTypeOnlyImport(stmt)) specifiers.push(stmt.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      !stmt.isTypeOnly
    ) {
      specifiers.push(stmt.moduleSpecifier.text)
    } else if (ts.isExpressionStatement(stmt) && isEnsureInitializedCall(stmt.expression)) {
      topLevelInit = true
    }
  }

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  // The full walk is only needed for dynamic imports; most modules have none,
  // and skipping them halves the scan.
  if (DYNAMIC_IMPORT_RE.test(text)) visit(source)

  return { specifiers, emits: EMIT_RE.test(text), topLevelInit }
}

/**
 * Scan every app/api route under SOURCE_ROOT.
 *
 * Returns { emittingRoutes, uninitialized }: SOURCE_ROOT-relative,
 * forward-slash paths of the routes that can reach an emitter, and of those
 * that can do so with no module-scope ensureInitialized() in the route or its
 * runtime import closure.
 */
export function findUninitializedEmittingRoutes(SOURCE_ROOT) {
  const rel = (p) => path.relative(SOURCE_ROOT, p).split(path.sep).join('/')
  const modules = new Map()

  const resolve = (fromAbs, spec) => {
    let base
    if (spec.startsWith('@/')) base = path.join(SOURCE_ROOT, spec.slice(2))
    else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromAbs), spec)
    else return null
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = base + suffix
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        // try the next suffix
      }
    }
    return null
  }

  // 1. Build the runtime import graph reachable from the routes, once.
  // lib/init.ts is a leaf: it pulls in every extension, and through them most
  // of the codebase, but it is the handler wiring, not an emit path.
  const load = (abs) => {
    if (modules.has(abs)) return modules.get(abs)
    let info = null
    try {
      info = analyseSource(abs, fs.readFileSync(abs, 'utf8'))
    } catch {
      info = null
    }
    modules.set(abs, info)
    if (info) {
      info.edges = []
      if (rel(abs) !== INIT_FILE) {
        for (const spec of info.specifiers) {
          const next = resolve(abs, spec)
          if (next && !isTestPath(rel(next))) info.edges.push(next)
        }
      }
    }
    return info
  }

  const routes = walkRouteFiles(path.join(SOURCE_ROOT, 'app', 'api')).sort()
  const stack = [...routes]
  while (stack.length > 0) {
    const info = load(stack.pop())
    if (!info) continue
    for (const next of info.edges) if (!modules.has(next)) stack.push(next)
  }

  // 2. Reverse reachability: every module that can reach an emitter, and
  // every module that can reach a top-level ensureInitialized() call.
  const importers = new Map()
  for (const [abs, info] of modules) {
    if (!info) continue
    for (const next of info.edges) {
      if (!importers.has(next)) importers.set(next, [])
      importers.get(next).push(abs)
    }
  }
  const reaching = (predicate) => {
    const out = new Set()
    const queue = []
    for (const [abs, info] of modules) {
      if (info && predicate(info)) {
        out.add(abs)
        queue.push(abs)
      }
    }
    while (queue.length > 0) {
      for (const from of importers.get(queue.pop()) ?? []) {
        if (!out.has(from)) {
          out.add(from)
          queue.push(from)
        }
      }
    }
    return out
  }
  const reachesEmitter = reaching((info) => info.emits)
  // Includes the route itself when the route file makes the top-level call.
  const reachesInit = reaching((info) => info.topLevelInit)

  const emittingRoutes = []
  const uninitialized = []
  for (const routeAbs of routes) {
    if (!modules.get(routeAbs) || !reachesEmitter.has(routeAbs)) continue
    emittingRoutes.push(rel(routeAbs))
    if (!reachesInit.has(routeAbs)) uninitialized.push(rel(routeAbs))
  }

  return { emittingRoutes, uninitialized }
}
