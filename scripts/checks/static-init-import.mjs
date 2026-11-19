/**
 * Guard: lib/init, and the extension list it loads, is imported by
 * instrumentation.ts and by nothing else that a server entry or a client
 * module can reach.
 *
 * lib/init wires the core event handlers and loads every enabled extension.
 * instrumentation.ts register() registers its loader when the server boots
 * (a dynamic import, Node.js runtime only), and eventBus.emit() and every
 * getter of a registry that init fills wait for that loader
 * (lib/initialized.ts). Until 2026-10-11 about 300 entries called
 * ensureInitialized() at module scope; until 2026-10-16 lib/initialized.ts
 * itself imported lib/init dynamically, and since the bundler follows a
 * dynamic import, every server entry that touched the event bus or a
 * registry getter compiled lib/init and every extension (474 of about 1,090
 * entries, with every Vercel production build OOM-killed on 2026-10-15). An
 * import of lib/init anywhere a server entry can reach, static or dynamic,
 * would quietly bring that back.
 *
 * The graph is the runtime import graph the bundler builds: `import` and
 * `export ... from` declarations, dynamic `import('...')` and `require('...')`
 * with a literal specifier; type-only imports excluded. The one sanctioned
 * edge is instrumentation.ts's dynamic import of lib/init.
 *
 * Entry points: every App Router file convention Next.js runs on the server
 * (route handlers, pages, layouts, templates, metadata routes, ...), every
 * 'use server' module, and the root instrumentation, middleware and proxy
 * files.
 *
 * Client modules ('use client') get a stricter rule: they must not reach
 * lib/initialized.ts either, statically or dynamically. The event bus and the
 * registries are server state, filled in the server process by the loader
 * instrumentation.ts registers; a client module that imports a pure helper
 * from a server module that also emits ships the bus to the browser, where
 * emit() reaches no handler and the event is lost. Import the helper from a
 * module of its own. A 'use server' module is where the client walk stops:
 * the client bundle gets a reference to each action, not the module's code.
 *
 * No allowlist.
 *
 * A second, counted question rides on the same graph: which server entries
 * reach lib/init, following dynamic imports too, which is what compiles every
 * extension into an entry (findInitReach().lazyInitEntries). With the loader
 * in instrumentation.ts that is instrumentation.ts alone.
 * no-new-antipatterns.mjs ratchets the count.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/** Modules that load every extension: lib/init and what it loads them through. */
export const FORBIDDEN_IMPORTS = [
  'lib/init.ts',
  'lib/extensions/loader.ts',
  'lib/extensions/_generated/extension-list.ts',
]
/** The module every extension is compiled through. */
export const INIT_MODULE = 'lib/init.ts'
/** The one module that may import lib/init, and only dynamically. */
export const INIT_IMPORTER = 'instrumentation.ts'
/** The event bus's and the registry getters' wait for the loader. */
export const LAZY_INIT_MODULE = 'lib/initialized.ts'
/** What a client module must not reach: lib/init, and the server state behind lib/initialized.ts. */
export const FORBIDDEN_CLIENT_IMPORTS = [...FORBIDDEN_IMPORTS, LAZY_INIT_MODULE]

// The App Router file conventions Next.js runs on the server.
const APP_ENTRY_RE =
  /^(?:page|layout|template|default|loading|error|global-error|not-found|global-not-found|forbidden|unauthorized|route|sitemap|robots|manifest|icon|apple-icon|opengraph-image|twitter-image)\.(?:tsx?|jsx?)$/
const ROOT_ENTRY_RE = /^(?:instrumentation|middleware|proxy)\.(?:tsx?|jsx?)$/
const USE_SERVER_RE = /^(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*['"]use server['"]/
const USE_CLIENT_RE = /^(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*['"]use client['"]/
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx']

function isTestPath(rel) {
  return rel.includes('/__tests__/') || /\.test\.tsx?$/.test(rel)
}

function walkFiles(dir, accept, out = []) {
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
      walkFiles(full, accept, out)
    } else if (accept(full, e.name)) {
      out.push(full)
    }
  }
  return out
}

function findClientModules(sourceRoot) {
  return walkFiles(sourceRoot, (full, name) => {
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) return false
    try {
      return USE_CLIENT_RE.test(fs.readFileSync(full, 'utf8'))
    } catch {
      return false
    }
  }).sort()
}

function findServerActionModules(sourceRoot) {
  return walkFiles(sourceRoot, (full, name) => {
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) return false
    try {
      return USE_SERVER_RE.test(fs.readFileSync(full, 'utf8'))
    } catch {
      return false
    }
  })
}

function findEntryPoints(sourceRoot, serverActions) {
  const appEntries = walkFiles(path.join(sourceRoot, 'app'), (_full, name) => APP_ENTRY_RE.test(name))
  const rootEntries = fs
    .readdirSync(sourceRoot)
    .filter((name) => ROOT_ENTRY_RE.test(name))
    .map((name) => path.join(sourceRoot, name))
  return [...new Set([...appEntries, ...rootEntries, ...serverActions])].sort()
}

/** True for `import type`, and `import { type A, type B }`. */
function isTypeOnlyImport(node) {
  const clause = node.importClause
  if (!clause) return false
  if (clause.isTypeOnly) return true
  if (clause.name) return false
  const bindings = clause.namedBindings
  if (!bindings || !ts.isNamedImports(bindings)) return false
  return bindings.elements.length > 0 && bindings.elements.every((el) => el.isTypeOnly)
}

/** A literal module specifier: 'x', "x" or `x` without substitutions. */
function literalSpecifier(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null
}

/**
 * The runtime imports of a module, each `{ specifier, dynamic }`: import and
 * re-export declarations (static), and `import('...')` / `require('...')`
 * calls with a literal specifier anywhere in the module (dynamic).
 */
function moduleImports(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false)
  const found = []
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isTypeOnlyImport(node)) found.push({ specifier: node.moduleSpecifier.text, dynamic: false })
      return
    }
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
        found.push({ specifier: node.moduleSpecifier.text, dynamic: false })
      }
      return
    }
    if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const specifier = isImport || isRequire ? literalSpecifier(node.arguments[0]) : null
      if (specifier) found.push({ specifier, dynamic: true })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/**
 * Every server entry point under sourceRoot that reaches one of
 * FORBIDDEN_IMPORTS other than through instrumentation.ts's dynamic import of
 * lib/init, and every client module that reaches one of
 * FORBIDDEN_CLIENT_IMPORTS, each with one import chain that proves it
 * (sourceRoot-relative, forward-slash paths, entry first) and its kind
 * ('server' or 'client'). Static and dynamic imports alike.
 */
export function findStaticInitImports(sourceRoot) {
  return findInitReach(sourceRoot).staticInitImports
}

/**
 * Both questions from one graph walk: `staticInitImports` as above, and
 * `lazyInitEntries`, every server entry whose graph reaches INIT_MODULE
 * (sanctioned edge included), in the same shape and sorted by entry.
 */
export function findInitReach(sourceRoot) {
  const rel = (p) => path.relative(sourceRoot, p).split(path.sep).join('/')
  const abs = (r) => path.join(sourceRoot, r)
  const edges = new Map()

  const resolve = (fromAbs, spec) => {
    let base
    if (spec.startsWith('@/')) base = path.join(sourceRoot, spec.slice(2))
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

  /** The resolved runtime imports of a module, each `{ to, dynamic }`. */
  const edgesOf = (file) => {
    if (!edges.has(file)) {
      const next = []
      try {
        for (const { specifier, dynamic } of moduleImports(file, fs.readFileSync(file, 'utf8'))) {
          const to = resolve(file, specifier)
          if (to && !isTestPath(rel(to))) next.push({ to, dynamic })
        }
      } catch {
        // unreadable: no edges
      }
      edges.set(file, next)
    }
    return edges.get(file)
  }

  // 1. The graph reachable from the entries, dynamic imports included, built once.
  const serverActions = findServerActionModules(sourceRoot)
  const serverEntries = findEntryPoints(sourceRoot, serverActions)
  const clientModules = findClientModules(sourceRoot)
  const stack = [...serverEntries, ...clientModules]
  while (stack.length > 0) {
    for (const { to } of edgesOf(stack.pop())) if (!edges.has(to)) stack.push(to)
  }

  const initImporter = abs(INIT_IMPORTER)
  const initModule = abs(INIT_MODULE)
  const isSanctioned = (from, edge) => from === initImporter && edge.to === initModule && edge.dynamic
  // A client module that imports a 'use server' module gets a reference to
  // each action, not the module's code: the client walk stops there.
  const actionModules = new Set(serverActions)
  const isServerActionImport = (_from, edge) => actionModules.has(edge.to)

  const offendersFor = (kind, entries, forbiddenRel, skipEdge) => {
    const forbidden = new Set(forbiddenRel.map(abs))
    const importers = new Map()
    for (const [from, targets] of edges) {
      for (const edge of targets) {
        if (skipEdge(from, edge)) continue
        if (!importers.has(edge.to)) importers.set(edge.to, [])
        importers.get(edge.to).push(from)
      }
    }
    // 2. Every module that can reach a forbidden one (reverse reachability).
    const reaching = new Set([...forbidden].filter((f) => edges.has(f)))
    const queue = [...reaching]
    while (queue.length > 0) {
      for (const from of importers.get(queue.pop()) ?? []) {
        if (!reaching.has(from)) {
          reaching.add(from)
          queue.push(from)
        }
      }
    }
    // 3. One shortest chain per offending entry, searched within `reaching`.
    const found = []
    for (const entry of entries) {
      if (!reaching.has(entry)) continue
      const parent = new Map([[entry, null]])
      const bfs = [entry]
      let hit = null
      while (bfs.length > 0) {
        const current = bfs.shift()
        if (forbidden.has(current)) {
          hit = current
          break
        }
        for (const edge of edgesOf(current)) {
          if (skipEdge(current, edge)) continue
          if (reaching.has(edge.to) && !parent.has(edge.to)) {
            parent.set(edge.to, current)
            bfs.push(edge.to)
          }
        }
      }
      const chain = []
      for (let at = hit; at; at = parent.get(at)) chain.unshift(rel(at))
      found.push({ kind, entry: rel(entry), chain })
    }
    return found
  }

  return {
    staticInitImports: [
      ...offendersFor('server', serverEntries, FORBIDDEN_IMPORTS, isSanctioned),
      ...offendersFor('client', clientModules, FORBIDDEN_CLIENT_IMPORTS, isServerActionImport),
    ],
    lazyInitEntries: offendersFor('server', serverEntries, [INIT_MODULE], () => false),
  }
}
