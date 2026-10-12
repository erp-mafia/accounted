/**
 * Guard: no server entry point imports lib/init, or the extension list it
 * loads, statically.
 *
 * lib/init wires the core event handlers and loads every enabled extension.
 * It loads on first use instead (lib/initialized.ts): eventBus.emit() and
 * every getter of a registry that init fills await the same memoised dynamic
 * import, so a request that neither emits nor reads such a registry loads no
 * extension, and one that does can never see the bus or a registry before
 * init has filled it. Until 2026-10-11 about 300 entries called
 * ensureInitialized() at module scope, so every one of them paid for every
 * extension on a cold start; a static import from any entry, directly or
 * through a module it imports, would quietly bring that back.
 *
 * "Static" is the runtime import graph: `import` and `export ... from`
 * declarations, type-only ones excluded. Dynamic `import()` is the sanctioned
 * way in and is not followed.
 *
 * Entry points: every App Router file convention Next.js runs on the server
 * (route handlers, pages, layouts, templates, metadata routes, ...), every
 * 'use server' module, and the root instrumentation, middleware and proxy
 * files.
 *
 * Client modules ('use client') get a stricter rule: they must not reach
 * lib/initialized.ts either. A client page that imports a pure helper from a
 * server module that also emits pulls in the event bus, and the bus's dynamic
 * import of lib/init then drags every extension into the browser build, which
 * fails it. Import the helper from a module of its own.
 *
 * No allowlist.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/** Modules that load every extension: lib/init and what it loads them through. */
export const FORBIDDEN_STATIC_IMPORTS = [
  'lib/init.ts',
  'lib/extensions/loader.ts',
  'lib/extensions/_generated/extension-list.ts',
]
/** What a client module must not reach either: the dynamic way in to lib/init. */
export const FORBIDDEN_CLIENT_IMPORTS = [...FORBIDDEN_STATIC_IMPORTS, 'lib/initialized.ts']

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

function findEntryPoints(sourceRoot) {
  const appEntries = walkFiles(path.join(sourceRoot, 'app'), (_full, name) => APP_ENTRY_RE.test(name))
  const rootEntries = fs
    .readdirSync(sourceRoot)
    .filter((name) => ROOT_ENTRY_RE.test(name))
    .map((name) => path.join(sourceRoot, name))
  const serverActions = walkFiles(sourceRoot, (full, name) => {
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) return false
    try {
      return USE_SERVER_RE.test(fs.readFileSync(full, 'utf8'))
    } catch {
      return false
    }
  })
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

/** The runtime specifiers of a module's static import and re-export declarations. */
function staticSpecifiers(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false)
  const specifiers = []
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
    }
  }
  return specifiers
}

/**
 * Every server entry point under sourceRoot whose static import graph reaches
 * one of FORBIDDEN_STATIC_IMPORTS, and every client module whose graph
 * reaches one of FORBIDDEN_CLIENT_IMPORTS, each with one import chain that
 * proves it (sourceRoot-relative, forward-slash paths, entry first) and its
 * kind ('server' or 'client').
 */
export function findStaticInitImports(sourceRoot) {
  const rel = (p) => path.relative(sourceRoot, p).split(path.sep).join('/')
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

  const edgesOf = (abs) => {
    if (!edges.has(abs)) {
      let next = []
      try {
        next = staticSpecifiers(abs, fs.readFileSync(abs, 'utf8'))
          .map((spec) => resolve(abs, spec))
          .filter((n) => n && !isTestPath(rel(n)))
      } catch {
        // unreadable: no edges
      }
      edges.set(abs, next)
    }
    return edges.get(abs)
  }

  // 1. The static graph reachable from the entries, built once.
  const serverEntries = findEntryPoints(sourceRoot)
  const clientModules = findClientModules(sourceRoot)
  const stack = [...serverEntries, ...clientModules]
  while (stack.length > 0) {
    for (const next of edgesOf(stack.pop())) if (!edges.has(next)) stack.push(next)
  }
  const importers = new Map()
  for (const [from, targets] of edges) {
    for (const to of targets) {
      if (!importers.has(to)) importers.set(to, [])
      importers.get(to).push(from)
    }
  }

  const offendersFor = (kind, entries, forbiddenRel) => {
    const forbidden = new Set(forbiddenRel.map((f) => path.join(sourceRoot, f)))
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
        for (const next of edgesOf(current)) {
          if (reaching.has(next) && !parent.has(next)) {
            parent.set(next, current)
            bfs.push(next)
          }
        }
      }
      const chain = []
      for (let at = hit; at; at = parent.get(at)) chain.unshift(rel(at))
      found.push({ kind, entry: rel(entry), chain })
    }
    return found
  }

  const offenders = [
    ...offendersFor('server', serverEntries, FORBIDDEN_STATIC_IMPORTS),
    ...offendersFor('client', clientModules, FORBIDDEN_CLIENT_IMPORTS),
  ]
  return offenders
}
