#!/usr/bin/env node
/**
 * Static import closure of every 'use client' module.
 *
 * Answers "which client components pull module X into the browser bundle,
 * and through which path?" without running `next build`. Walks static
 * `import ... from` / `export ... from` edges (NOT dynamic `import()`, which
 * splits a chunk, and NOT `import type`, which is erased), resolving `@/`
 * and relative specifiers to .ts/.tsx/.js/.mjs files or directory indexes.
 * Bare specifiers (packages, Node builtins) are recorded as leaves.
 *
 *   node scripts/perf/client-import-closure.mjs lib/bookkeeping/bas-data/index.ts
 *   node scripts/perf/client-import-closure.mjs crypto node:crypto buffer vm
 *
 * Prints, per target, the client files whose closure reaches it and the
 * shortest import path for each. Used by the responsiveness plan (B7) and
 * by the client-node-builtin guard in scripts/checks.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCAN_DIRS = ['app', 'components', 'contexts', 'extensions', 'lib', 'i18n']
const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__'])
const EXTS = ['.ts', '.tsx', '.js', '.mjs', '.jsx']

// Block comment bodies are `(?:[^*]|\*(?!\/))*` so an unclosed `/*` cannot be
// re-split at every later `/*` (CodeQL js/redos on the lazy form).
const USE_CLIENT_RE = /^(?:\s+|\/\/[^\n]*\n|\/\*(?:[^*]|\*(?!\/))*\*\/)*['"]use client['"]/
// Static edges only. `import type {...} from` and `export type {...} from`
// are skipped; `import x, { type Y } from` still counts (x is a value).
const EDGE_RE = /^\s*(?:import|export)\s+(?!type\s)[^'"]*?\sfrom\s+['"]([^'"]+)['"]/gm
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+['"]([^'"]+)['"]/gm

export function walkFiles(root = ROOT) {
  const out = []
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (/\.(?:ts|tsx|js|mjs|jsx)$/.test(entry.name) && !/\.(?:test|pg\.test)\.tsx?$/.test(entry.name)) out.push(full)
    }
  }
  for (const d of SCAN_DIRS) visit(path.join(root, d))
  return out
}

export function resolveSpecifier(spec, fromFile, root = ROOT) {
  let base
  if (spec.startsWith('@/')) base = path.join(root, spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec)
  else return { bare: spec }
  const candidates = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => path.join(base, 'index' + e))]
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return { file: c }
  }
  return { missing: spec }
}

export function importsOf(source) {
  const specs = new Set()
  for (const m of source.matchAll(EDGE_RE)) specs.add(m[1])
  for (const m of source.matchAll(SIDE_EFFECT_IMPORT_RE)) specs.add(m[1])
  return [...specs]
}

/** Build the graph once: file -> { edges: [file|bare], client: boolean }. */
export function buildGraph(root = ROOT) {
  const graph = new Map()
  for (const file of walkFiles(root)) {
    const source = fs.readFileSync(file, 'utf8')
    const edges = []
    for (const spec of importsOf(source)) {
      const r = resolveSpecifier(spec, file, root)
      if (r.file) edges.push(r.file)
      else if (r.bare) edges.push(`bare:${r.bare}`)
    }
    graph.set(file, { edges, client: USE_CLIENT_RE.test(source) })
  }
  return graph
}

/**
 * For each client file, BFS its closure; return { clientFile -> path[] } for
 * closures that contain `target` (a repo-relative file path or `bare:<spec>`).
 */
export function clientReachers(graph, target, root = ROOT) {
  const targetKey = target.startsWith('bare:') ? target : path.join(root, target)
  const hits = new Map()
  for (const [file, node] of graph) {
    if (!node.client) continue
    const prev = new Map([[file, null]])
    const queue = [file]
    let found = null
    while (queue.length && !found) {
      const cur = queue.shift()
      const edges = graph.get(cur)?.edges ?? []
      for (const next of edges) {
        if (prev.has(next)) continue
        prev.set(next, cur)
        if (next === targetKey) { found = next; break }
        if (!next.startsWith('bare:')) queue.push(next)
      }
    }
    if (found) {
      const chain = []
      for (let n = found; n; n = prev.get(n)) chain.unshift(n)
      hits.set(path.relative(root, file), chain.map((n) => (n.startsWith('bare:') ? n : path.relative(root, n))))
    }
  }
  return hits
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const targets = process.argv.slice(2)
  if (!targets.length) {
    console.error('usage: node scripts/perf/client-import-closure.mjs <repo-relative file | bare specifier> ...')
    process.exit(1)
  }
  const graph = buildGraph()
  for (const t of targets) {
    const key = t.includes('/') || t.endsWith('.ts') || t.endsWith('.tsx') ? t : `bare:${t}`
    const hits = clientReachers(graph, key)
    console.log(`\n== ${t}: ${hits.size} client file(s) reach it`)
    for (const [file, chain] of [...hits].sort()) console.log(`  ${file}\n      ${chain.join('\n      > ')}`)
  }
}
