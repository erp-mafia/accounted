#!/usr/bin/env node
/**
 * JavaScript a page ships on a hard load, read off a production build.
 *
 *   node scripts/perf/page-js.mjs                 # the budgeted pages, .next in cwd
 *   node scripts/perf/page-js.mjs --check         # exit 1 when a page is over its budget
 *   node scripts/perf/page-js.mjs --json out.json # also write the numbers
 *   node scripts/perf/page-js.mjs --next-dir <dir> --route '/invoices' --route '/'
 *
 * What is counted: every script the document of the route references before
 * any interaction, the way the browser sees it: the root main files, the
 * polyfill file, and for the page and each layout, error and loading
 * boundary above it the entry files plus the chunks of every client module
 * the segment renders (the page's client reference manifest). Chunks behind
 * next/dynamic or import() are not counted: they load later, which is the
 * point of deferring them. Bytes are brotli (quality 11), what the CDN
 * serves; raw bytes are printed beside them because parse and compile time
 * follow the raw size.
 *
 * Budgets live in scripts/perf/page-budgets.json (`jsBrotliKb` per page).
 * The numbers depend on the build's inputs: extensions.config.json decides
 * which extensions are compiled in, so compare builds of the same
 * configuration (README, "Page budgets").
 *
 * No dependencies on purpose: this runs right after `next build` in CI.
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUDGETS_PATH = path.join(HERE, 'page-budgets.json')

/** Route as the user sees it -> the app directory segment that renders it. */
export function routeToAppPath(route, appRoutes) {
  const hit = Object.entries(appRoutes).find(([, served]) => served === route)
  return hit ? hit[0] : null
}

/** Evaluate a `page_client-reference-manifest.js` file and return its one manifest. */
export function readClientManifest(file) {
  const source = fs.readFileSync(file, 'utf8')
  const sandbox = { __RSC_MANIFEST: {} }
  // The file is `globalThis.__RSC_MANIFEST = ...; globalThis.__RSC_MANIFEST[key] = {...}`.
  new Function('globalThis', source)(sandbox)
  const manifests = Object.values(sandbox.__RSC_MANIFEST)
  if (manifests.length !== 1) throw new Error(`${file}: expected one manifest, found ${manifests.length}`)
  return manifests[0]
}

const stripPrefix = (chunk) => chunk.replace(/^\/?_next\//, '')

/** Every script file the route's document references, relative to the .next directory. */
export function firstLoadFiles(buildManifest, clientManifest) {
  const files = new Set()
  for (const file of buildManifest.rootMainFiles ?? []) files.add(file)
  for (const file of buildManifest.polyfillFiles ?? []) files.add(file)
  for (const list of Object.values(clientManifest.entryJSFiles ?? {})) {
    for (const file of list) files.add(stripPrefix(file))
  }
  for (const mod of Object.values(clientManifest.clientModules ?? {})) {
    for (const chunk of mod.chunks ?? []) {
      if (chunk.endsWith('.js')) files.add(stripPrefix(chunk))
    }
  }
  return [...files].sort()
}

/** Brotli size per chunk file, kept across routes: most chunks are shared by every page. */
const sizeCache = new Map()

function fileSizes(nextDir, file) {
  const key = path.join(nextDir, file)
  let sizes = sizeCache.get(key)
  if (!sizes) {
    const body = fs.readFileSync(key)
    const brotli = zlib.brotliCompressSync(body, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length },
    })
    sizes = { raw: body.length, brotli: brotli.length }
    sizeCache.set(key, sizes)
  }
  return sizes
}

export function measureRoute(nextDir, route) {
  const appRoutes = JSON.parse(fs.readFileSync(path.join(nextDir, 'app-path-routes-manifest.json'), 'utf8'))
  const appPath = routeToAppPath(route, appRoutes)
  if (!appPath) throw new Error(`no app route serves ${route}`)
  const buildManifest = JSON.parse(fs.readFileSync(path.join(nextDir, 'build-manifest.json'), 'utf8'))
  const manifestFile = path.join(nextDir, 'server', 'app', `${appPath}_client-reference-manifest.js`)
  const files = firstLoadFiles(buildManifest, readClientManifest(manifestFile))
  let rawBytes = 0
  let brotliBytes = 0
  for (const file of files) {
    const sizes = fileSizes(nextDir, file)
    rawBytes += sizes.raw
    brotliBytes += sizes.brotli
  }
  return { route, files: files.length, rawBytes, brotliBytes }
}

const kb = (bytes) => Math.round(bytes / 1024)

function parseArgs(argv) {
  const args = { nextDir: '.next', routes: [], check: false, json: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') args.check = true
    else if (arg === '--next-dir') args.nextDir = argv[++i]
    else if (arg === '--route') args.routes.push(argv[++i])
    else if (arg === '--json') args.json = argv[++i]
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

/** Pages over their budget, and pages with none: both fail a --check run. */
export function overBudget(rows, budgets) {
  const failures = []
  for (const row of rows) {
    const budget = budgets[row.route]?.jsBrotliKb
    if (typeof budget !== 'number') failures.push(`${row.route}: no jsBrotliKb budget`)
    else if (kb(row.brotliBytes) > budget) {
      failures.push(`${row.route}: ${kb(row.brotliBytes)} kB is over its budget of ${budget} kB`)
    }
  }
  return failures
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const budgets = JSON.parse(fs.readFileSync(BUDGETS_PATH, 'utf8')).pages
  const routes = args.routes.length > 0 ? args.routes : Object.keys(budgets)
  const rows = routes.map((route) => measureRoute(args.nextDir, route))
  console.log('page'.padEnd(28), 'files'.padStart(6), 'raw kB'.padStart(8), 'brotli kB'.padStart(10), 'budget'.padStart(8))
  for (const row of rows) {
    const budget = budgets[row.route]?.jsBrotliKb
    console.log(
      row.route.padEnd(28),
      String(row.files).padStart(6),
      String(kb(row.rawBytes)).padStart(8),
      String(kb(row.brotliBytes)).padStart(10),
      String(budget ?? '-').padStart(8),
    )
  }
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(rows, null, 2) + '\n')
  if (!args.check) return
  const failures = overBudget(rows, budgets)
  if (failures.length > 0) {
    console.error(
      `\nJavaScript budget (scripts/perf/page-budgets.json):\n  ${failures.join('\n  ')}\n` +
        'Fix: load what the first view does not render with next/dynamic (dialogs, wizards, other tabs),\n' +
        'or, when the page legitimately needs more, raise jsBrotliKb in the same merge request\n' +
        'with the before and after numbers in the description.',
    )
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
