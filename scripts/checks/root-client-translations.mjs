#!/usr/bin/env node
/**
 * Which message namespaces can client code read on a page that only the ROOT
 * NextIntlClientProvider serves?
 *
 * Every page inlines its client provider's messages into the HTML. The root
 * layout therefore hands NextIntlClientProvider only ROOT_CLIENT_NAMESPACES
 * (src/i18n/root-client-namespaces.ts), not the whole catalog (about 0.8 MB
 * per locale), and the layouts whose pages need the rest render
 * AllMessagesProvider (components/providers/AllMessagesProvider.tsx) around
 * their subtree. A client component outside those subtrees that reads a
 * namespace missing from the root list renders raw keys ("auth.title") in
 * production: next-intl has no build-time check for it.
 *
 * Roots: every React route file under app/ (page, layout, template, default,
 * loading, error, not-found, forbidden, unauthorized; not app/api) that no
 * AllMessagesProvider layout covers. A layout covers its own directory and
 * everything below it once it imports AllMessagesProvider. global-error and
 * global-not-found are not roots: they render without the root layout, so no
 * provider serves them at all.
 *
 * From each root the walk follows the runtime import graph: the static edges
 * of scripts/perf/client-import-closure.mjs (type-only imports erased) plus
 * literal dynamic import() (next/dynamic and React.lazy still render under the
 * same provider). A module is client code when it carries 'use client' or a
 * client module reaches it. In client code it records:
 *   - useTranslations('ns') and useTranslations('ns.sub'): a namespace read;
 *   - useTranslations(): reads the whole catalog, flagged as 'whole';
 *   - useMessages(): the same;
 *   - useTranslations(expr): a namespace the scan cannot know, 'dynamic'.
 * Server components are skipped: their useTranslations / getTranslations read
 * the full catalog from src/i18n/request.ts on the server.
 *
 *   node scripts/checks/root-client-translations.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { buildGraph, resolveSpecifier } from '../perf/client-import-closure.mjs'

/** Source-root-relative path of the provider that restores the full catalog. */
export const FULL_CATALOG_PROVIDER = 'components/providers/AllMessagesProvider.tsx'

const REACT_ROUTE_FILE_RE =
  /^(?:page|layout|template|default|loading|error|not-found|forbidden|unauthorized)\.(?:tsx?|jsx?)$/
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
const HOOK_HINT_RE = /\buse(?:Translations|Messages)\b/

const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/')

/** Route files the root provider serves, as absolute paths, sorted. */
function rootServedRouteFiles(root, graph) {
  const appDir = path.join(root, 'app')
  const apiDir = path.join(appDir, 'api')
  const provider = path.join(root, FULL_CATALOG_PROVIDER)
  const routeFiles = [...graph.keys()].filter(
    (f) =>
      f.startsWith(appDir + path.sep) &&
      !f.startsWith(apiDir + path.sep) &&
      REACT_ROUTE_FILE_RE.test(path.basename(f)),
  )
  const coveredDirs = routeFiles
    .filter((f) => path.basename(f).startsWith('layout.') && graph.get(f).edges.includes(provider))
    .map((f) => path.dirname(f) + path.sep)
  return routeFiles.filter((f) => !coveredDirs.some((dir) => f.startsWith(dir))).sort()
}

/** Every useTranslations / useMessages call in one module. */
function hookCalls(file, source) {
  const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, kind)
  const calls = []
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text
      const [arg] = node.arguments
      if (name === 'useMessages') {
        calls.push({ kind: 'whole', call: 'useMessages()' })
      } else if (name === 'useTranslations') {
        if (!arg) calls.push({ kind: 'whole', call: 'useTranslations()' })
        else if (ts.isStringLiteralLike(arg)) calls.push({ kind: 'namespace', namespace: arg.text })
        else calls.push({ kind: 'dynamic', call: `useTranslations(${arg.getText(sf)})` })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return calls
}

/**
 * Scan SOURCE_ROOT (the directory holding app/, components/, lib/, ...).
 *
 * Returns { routes, usages }: the SOURCE_ROOT-relative route files the root
 * provider serves, and one entry per distinct (file, read) in their client
 * code: { file, kind: 'namespace'|'whole'|'dynamic', namespace?, call?,
 * chain } where chain is the import path from a route file to `file`.
 */
export function findRootClientTranslations(root) {
  const graph = buildGraph(root)
  const routes = rootServedRouteFiles(root, graph)

  const sources = new Map()
  const sourceOf = (file) => {
    if (!sources.has(file)) sources.set(file, fs.readFileSync(file, 'utf8'))
    return sources.get(file)
  }
  const edgesOf = (file) => {
    const edges = graph.get(file)?.edges.filter((e) => !e.startsWith('bare:')) ?? []
    const source = sourceOf(file)
    if (!source.includes('import(')) return edges
    const dynamic = []
    for (const m of source.matchAll(DYNAMIC_IMPORT_RE)) {
      const r = resolveSpecifier(m[1], file, root)
      if (r.file) dynamic.push(r.file)
    }
    return [...edges, ...dynamic]
  }

  // BFS over (file, client) states: a module reached from server code is a
  // server component until 'use client' (or a client importer) says otherwise.
  const prev = new Map()
  const queue = []
  for (const file of routes) {
    const key = `${graph.get(file).client}|${file}`
    if (prev.has(key)) continue
    prev.set(key, null)
    queue.push(key)
  }
  const usages = new Map()
  while (queue.length) {
    const key = queue.shift()
    const sep = key.indexOf('|')
    const client = key.slice(0, sep) === 'true'
    const file = key.slice(sep + 1)
    if (!graph.has(file)) continue

    if (client && HOOK_HINT_RE.test(sourceOf(file))) {
      for (const call of hookCalls(file, sourceOf(file))) {
        const id = `${file}|${call.namespace ?? call.call}`
        if (usages.has(id)) continue
        const chain = []
        for (let k = key; k; k = prev.get(k)) chain.unshift(toRel(root, k.slice(k.indexOf('|') + 1)))
        usages.set(id, { file: toRel(root, file), ...call, chain })
      }
    }

    for (const next of edgesOf(file)) {
      const nextKey = `${client || (graph.get(next)?.client ?? false)}|${next}`
      if (prev.has(nextKey)) continue
      prev.set(nextKey, key)
      queue.push(nextKey)
    }
  }

  return {
    routes: routes.map((f) => toRel(root, f)),
    usages: [...usages.values()].sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        (a.namespace ?? a.call).localeCompare(b.namespace ?? b.call),
    ),
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
  const { routes, usages } = findRootClientTranslations(root)
  console.log(`${routes.length} route file(s) served by the root provider:`)
  for (const r of routes) console.log(`  ${r}`)
  const byNamespace = new Map()
  for (const u of usages) {
    const label = u.kind === 'namespace' ? u.namespace : `${u.kind}: ${u.call}`
    if (!byNamespace.has(label)) byNamespace.set(label, [])
    byNamespace.get(label).push(u)
  }
  console.log(`\n${byNamespace.size} distinct read(s) in their client code:`)
  for (const [label, list] of [...byNamespace].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${label}`)
    for (const u of list) console.log(`      ${u.chain.join(' > ')}`)
  }
}
