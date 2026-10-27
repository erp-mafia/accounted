#!/usr/bin/env -S npx tsx --conditions react-server
/**
 * Usage audit join: the deterministic half of the loop-usage-audit skill.
 *
 * The skill exports usage from PostHog, prod event_log and Vercel into one
 * directory. This script builds the inventory from the code (every page, API
 * route, extension route, extension workspace and MCP tool), joins the two,
 * and writes:
 *
 *   <dir>/report.md       candidates (unused in every source that can see
 *                         them, for 90 days, in code for over 90 days, not on
 *                         the keep list), items one company used, and what
 *                         each costs to keep (lines, test files)
 *   <dir>/snapshot.json   this run's unused items, so the next run can count
 *                         Vercel-only items across its 36-day window
 *
 * Inputs in <dir> (shapes and queries in .claude/skills/loop-usage-audit/SKILL.md):
 *   posthog-pages.json    [{ "path": "/invoices/*", "views": 12, "companies": 3, "company_ids": [...] }]
 *   mcp-tools.json        [{ "tool": "gnubok_create_invoice", "calls": 40, "companies": 9, "company_ids": [...] }]
 *                         (company_ids is optional and only read to count companies exactly)
 *   vercel-routes.json    { "window": { "start", "end" }, "routes": { "<route>": hits },
 *                           "extension_paths": { "/api/extensions/ext/<id>/<path>": hits } }
 *
 * Read-only: reads the repo and git history, writes only into <dir>.
 *
 * Usage:
 *   npx tsx --conditions react-server scripts/usage-audit.ts <dir> --run 2026-11 \
 *     [--previous <snapshot.json> ...] [--as-of YYYY-MM-DD]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  isSingleCompany,
  isUnused,
  keptBy,
  matchRoute,
  routeMatcher,
  routePatternFromDir,
  runsNeeded,
  unusedStreak,
  type ItemKind,
  type KeepEntry,
  type Snapshot,
  type Usage,
} from './lib/usage-audit'

const ROOT = process.cwd()
const APP = 'src/app'
const KEEP_FILE = '.claude/skills/loop-usage-audit/keep.json'

interface Item {
  kind: ItemKind
  item: string
  usage: Usage
  /** Company ids seen, when the export lists them; usage.companies is then their count. */
  companyIds?: Set<string>
  /** Files whose lines count as the cost of keeping it. */
  files: string[]
  tests: string[]
  /** Precomputed line count, when the item is a span of a larger file. */
  lines?: number
  /** Non-generated files that import the item's component: deleting the route then keeps the component. */
  sharedWith?: string[]
  /** What `git log` looks at to date the item. */
  dateBy: { file: string } | { pickaxe: string; paths: string[] }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

function args(name: string): string[] {
  const out: string[] = []
  process.argv.forEach((a, i) => {
    if (a === name && process.argv[i + 1]) out.push(process.argv[i + 1])
  })
  return out
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function lineCount(file: string): number {
  try {
    return readFileSync(join(ROOT, file), 'utf8').split('\n').length
  } catch {
    return 0
  }
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name)
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel))
    else out.push(rel)
  }
  return out
}

// ── Inventory ────────────────────────────────────────────────────────────

const appFiles = walk(APP)
const routeDirs = new Set(
  appFiles.filter((f) => /\/(page\.tsx|route\.ts)$/.test(f)).map((f) => f.slice(0, f.lastIndexOf('/'))),
)

/** The route dir's own files: itself and its non-route subfolders, never tests or child routes. */
function ownFiles(dir: string, entry: string): { files: string[]; tests: string[] } {
  const files: string[] = []
  const tests: string[] = []
  for (const f of appFiles) {
    if (!f.startsWith(dir + '/')) continue
    const rest = f.slice(dir.length + 1)
    if (rest.startsWith('__tests__/')) {
      if (/\.test\.tsx?$/.test(rest)) tests.push(f)
      continue
    }
    const parent = f.slice(0, f.lastIndexOf('/'))
    let owner = parent
    while (owner !== dir && !routeDirs.has(owner)) owner = owner.slice(0, owner.lastIndexOf('/'))
    if (owner !== dir || rest.includes('/__tests__/')) continue
    if (!/\.(tsx?|css)$/.test(f)) continue
    if ((entry === 'page.tsx' && rest === 'route.ts') || (entry === 'route.ts' && rest === 'page.tsx')) continue
    files.push(f)
  }
  return { files, tests }
}

const items: Item[] = []
for (const dir of [...routeDirs].sort()) {
  const pattern = routePatternFromDir(dir.slice(APP.length))
  for (const entry of ['page.tsx', 'route.ts'] as const) {
    if (!existsSync(join(ROOT, dir, entry))) continue
    const own = ownFiles(dir, entry)
    items.push({
      kind: entry === 'page.tsx' ? 'page' : 'api',
      item: pattern,
      usage: {},
      files: own.files,
      tests: own.tests,
      dateBy: { file: join(dir, entry) },
    })
  }
}

/** Until 2026-09-22 the app lived at the repo root (app/, lib/, extensions/): history before the move sits there. */
function withOldLayout(paths: string[]): string[] {
  return [...paths, ...paths.map((p) => p.replace(/^src\//, ''))]
}

/** Line span of the object literal that holds `name: '<tool>'` (or toolName), found by indentation. */
const toolSources = [...walk('src/extensions/general/mcp-server'), ...walk('src/lib/operations')].filter(
  (f) => f.endsWith('.ts') && !f.includes('__tests__'),
)
const toolSourceText = new Map(toolSources.map((f) => [f, readFileSync(join(ROOT, f), 'utf8').split('\n')]))
function toolSpan(name: string): { file: string; lines: number } | null {
  for (const [file, lines] of toolSourceText) {
    const at = lines.findIndex((l) => new RegExp(`^\\s*(name|toolName): '${name}',?$`).test(l))
    if (at < 0) continue
    const indent = lines[at].length - lines[at].trimStart().length - 2
    let start = at
    while (start > 0 && !(lines[start].trimEnd().endsWith('{') && lines[start].length - lines[start].trimStart().length <= indent)) start--
    let end = at
    while (end < lines.length - 1 && !(lines[end].trimStart().startsWith('}') && lines[end].length - lines[end].trimStart().length <= indent)) end++
    return { file, lines: end - start + 1 }
  }
  return null
}

/** Test files that mention each gnubok_ tool name, read once. */
const testsByTool = new Map<string, string[]>()
for (const f of [...walk('src'), ...walk('scripts'), ...walk('tests')].filter((f) => /\.test\.tsx?$/.test(f))) {
  for (const name of new Set(readFileSync(join(ROOT, f), 'utf8').match(/\bgnubok_[a-z0-9_]+/g) ?? [])) {
    testsByTool.set(name, [...(testsByTool.get(name) ?? []), f])
  }
}

async function addMcpTools(): Promise<void> {
  const { tools } = await import('@/extensions/general/mcp-server/server')
  for (const t of tools as Array<{ name: string }>) {
    const span = toolSpan(t.name)
    items.push({
      kind: 'mcp',
      item: t.name,
      usage: {},
      files: span ? [span.file] : [],
      tests: testsByTool.get(t.name) ?? [],
      lines: span?.lines,
      dateBy: { pickaxe: t.name, paths: withOldLayout(['src/extensions/general/mcp-server', 'src/lib/operations']) },
    })
  }
}

const sourceFiles = walk('src').filter((f) => /\.tsx?$/.test(f) && !f.includes('/_generated/') && !f.includes('__tests__'))
function importersOf(specifier: string): string[] {
  return sourceFiles.filter((f) => readFileSync(join(ROOT, f), 'utf8').includes(`'${specifier}'`))
}

async function addExtensions(): Promise<void> {
  const { FIRST_PARTY_EXTENSIONS } = await import('@/lib/extensions/_generated/extension-list')
  for (const ext of FIRST_PARTY_EXTENSIONS) {
    for (const r of ext.apiRoutes ?? []) {
      const path = r.path.startsWith('/') ? r.path : `/${r.path}`
      items.push({
        kind: 'extension-route',
        item: `${r.method} /api/extensions/ext/${ext.id}${path}`,
        usage: {},
        files: [],
        tests: [],
        dateBy: { pickaxe: `path: '${r.path}'`, paths: withOldLayout([`src/extensions/general/${ext.id}`]) },
      })
    }
  }
  for (const dir of readdirSync(join(ROOT, 'src/extensions/general'))) {
    const manifest = join('src/extensions/general', dir, 'manifest.json')
    if (!existsSync(join(ROOT, manifest))) continue
    const m = readJson<{ id: string; sector?: string; workspace?: string | null }>(join(ROOT, manifest))
    if (!m.workspace) continue
    const file = m.workspace.replace(/^@\//, 'src/') + '.tsx'
    items.push({
      kind: 'workspace',
      item: `/e/${m.sector ?? 'general'}/${m.id}`,
      usage: {},
      files: [file],
      tests: [],
      dateBy: { file },
      sharedWith: importersOf(m.workspace),
    })
  }
}

// ── Usage ────────────────────────────────────────────────────────────────

/** Count companies: a union of ids when the rows carry them (two paths of one page can be two companies), else the largest count. */
function addCompanies(target: Item, row: { companies: number; company_ids?: string[] }): void {
  if (row.company_ids) {
    target.companyIds ??= new Set()
    for (const id of row.company_ids) target.companyIds.add(id)
    target.usage.companies = target.companyIds.size
  } else {
    target.usage.companies = Math.max(target.usage.companies ?? 0, row.companies)
  }
}

function applyUsage(dir: string): { window: { start: string; end: string } } {
  const posthog = readJson<Array<{ path: string; views: number; companies: number; company_ids?: string[] }>>(join(dir, 'posthog-pages.json'))
  const mcp = readJson<Array<{ tool: string; calls: number; companies: number; company_ids?: string[] }>>(join(dir, 'mcp-tools.json'))
  const vercel = readJson<{ window: { start: string; end: string }; routes: Record<string, number>; extension_paths?: Record<string, number> }>(
    join(dir, 'vercel-routes.json'),
  )
  const byKey = new Map(items.map((i) => [`${i.kind} ${i.item}`, i]))

  const pageMatchers = items.filter((i) => i.kind === 'page').map((i) => routeMatcher(i.item))
  for (const row of posthog) {
    // A workspace view is also a view of the /e/[sector]/[slug] page that renders it.
    const targets = [byKey.get(`workspace ${row.path}`), byKey.get(`page ${matchRoute(row.path, pageMatchers)}`)]
    for (const target of targets) {
      if (!target) continue
      target.usage.posthogViews = (target.usage.posthogViews ?? 0) + row.views
      addCompanies(target, row)
    }
  }

  for (const row of mcp) {
    const target = byKey.get(`mcp ${row.tool.replace(/^accounted_/, 'gnubok_')}`)
    if (!target) continue
    target.usage.mcpCalls = (target.usage.mcpCalls ?? 0) + row.calls
    addCompanies(target, row)
  }

  for (const [route, hits] of Object.entries(vercel.routes)) {
    // The skill folds signed storage paths into one entry.
    const pattern = route === '/api/storage/*' ? '/api/storage/[...path]' : route
    for (const kind of ['page', 'api'] as const) {
      const target = byKey.get(`${kind} ${pattern}`)
      if (target) target.usage.vercelHits = (target.usage.vercelHits ?? 0) + hits
    }
  }

  const extItems = items.filter((i) => i.kind === 'extension-route')
  const extMatchers = extItems.map((i) => routeMatcher(i.item.slice(i.item.indexOf(' ') + 1)))
  for (const [path, hits] of Object.entries(vercel.extension_paths ?? {})) {
    const pattern = matchRoute(path, extMatchers)
    if (!pattern) continue
    // Vercel does not split by method: every method on the path shares the hits.
    for (const i of extItems) if (i.item.endsWith(` ${pattern}`)) i.usage.vercelHits = (i.usage.vercelHits ?? 0) + hits
  }
  return { window: vercel.window }
}

// ── Dating and judging ───────────────────────────────────────────────────

function git(argv: string[]): string {
  try {
    return execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return ''
  }
}

function firstSeen(i: Item): string | null {
  const out =
    'file' in i.dateBy
      ? git(['log', '--follow', '--diff-filter=A', '--format=%as', '--', i.dateBy.file])
      : git(['log', `-S${i.dateBy.pickaxe}`, '--format=%as', '--reverse', '--', ...i.dateBy.paths])
  const dates = out.split('\n').filter(Boolean)
  if (dates.length === 0) return null
  return 'file' in i.dateBy ? dates[dates.length - 1] : dates[0]
}

function daysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

function cost(i: Item): string {
  const lines = i.lines ?? i.files.reduce((sum, f) => sum + lineCount(f), 0)
  return `${lines || '-'} · ${i.tests.length}`
}

function evidence(i: Item): string {
  const u = i.usage
  switch (i.kind) {
    case 'page':
      return `${u.posthogViews ?? 0} views, ${u.vercelHits ?? 0} hits`
    case 'workspace':
      return `${u.posthogViews ?? 0} views`
    case 'mcp':
      return `${u.mcpCalls ?? 0} calls`
    default:
      return `${u.vercelHits ?? 0} hits`
  }
}

async function main(): Promise<void> {
  const dir = process.argv[2]
  const run = arg('--run')
  if (!dir || !run || dir.startsWith('--')) {
    console.error('Usage: scripts/usage-audit.ts <dir> --run YYYY-MM [--previous <snapshot.json> ...] [--as-of YYYY-MM-DD]')
    process.exit(1)
  }
  const today = arg('--as-of') ?? new Date().toISOString().slice(0, 10)
  const cutoff = daysBefore(today, 90)
  const previous = args('--previous')
    .map((p) => readJson<Snapshot>(p))
    .sort((a, b) => b.run.localeCompare(a.run))
  const keep = existsSync(join(ROOT, KEEP_FILE)) ? readJson<KeepEntry[]>(join(ROOT, KEEP_FILE)) : []

  await addMcpTools()
  await addExtensions()
  const { window } = applyUsage(dir)

  const unused = items.filter((i) => isUnused(i.kind, i.usage))
  const used1 = items.filter((i) => isSingleCompany(i.kind, i.usage))
  const dated = new Map([...unused, ...used1].map((i) => [i, firstSeen(i)]))
  const isYoung = (i: Item) => {
    const seen = dated.get(i)
    return !!seen && seen > cutoff
  }
  const single = used1.filter((i) => !isYoung(i) && !keptBy(i.kind, i.item, keep, today))

  const candidates: Item[] = []
  const building: Item[] = []
  const kept = new Map<string, number>()
  let young = 0
  for (const i of unused) {
    if (isYoung(i)) {
      young++
      continue
    }
    const k = i.sharedWith?.length
      ? { kind: i.kind, match: i.item, reason: 'workspace component also rendered elsewhere' }
      : keptBy(i.kind, i.item, keep, today)
    if (k) {
      kept.set(k.reason, (kept.get(k.reason) ?? 0) + 1)
      continue
    }
    if (unusedStreak(i.kind, i.item, previous) >= runsNeeded(i.kind)) candidates.push(i)
    else building.push(i)
  }

  const snapshot: Snapshot = { run, unused: {} }
  for (const i of unused) (snapshot.unused[i.kind] ??= []).push(i.item)
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(snapshot, null, 1) + '\n')

  const count = (kind: ItemKind, list: Item[]) => list.filter((i) => i.kind === kind).length
  const kinds: ItemKind[] = ['page', 'workspace', 'api', 'extension-route', 'mcp']
  const L: string[] = []
  L.push(`# Usage audit ${run}`, '')
  L.push(`As of ${today}. PostHog and event_log: the 90 days before; Vercel: ${window.start} to ${window.end}. ` +
    `Vercel-only items (API and extension routes) become candidates after ${runsNeeded('api')} runs in a row.`, '')
  L.push('| Kind | Items | Unused | Candidates | Building evidence | One company |', '|---|---|---|---|---|---|')
  for (const k of kinds) {
    L.push(`| ${k} | ${items.filter((i) => i.kind === k).length} | ${count(k, unused)} | ${count(k, candidates)} | ${count(k, building)} | ${count(k, single)} |`)
  }
  L.push('', `Not judged: ${young} unused items younger than 90 days; ${[...kept.values()].reduce((a, b) => a + b, 0)} on the keep list (${[...kept].map(([r, n]) => `${n} ${r}`).join('; ') || 'none'}).`, '')
  L.push('## Candidates', '', '| Kind | Item | Evidence | In code since | Lines · test files |', '|---|---|---|---|---|')
  for (const i of candidates) L.push(`| ${i.kind} | \`${i.item}\` | ${evidence(i)} | ${dated.get(i) ?? '?'} | ${cost(i)} |`)
  L.push('', '## One company only', '', 'Companies 0 means only internal or company-less use.', '',
    '| Kind | Item | Evidence | Companies | In code since | Lines · test files |', '|---|---|---|---|---|---|')
  for (const i of single) L.push(`| ${i.kind} | \`${i.item}\` | ${evidence(i)} | ${i.usage.companies ?? 0} | ${dated.get(i) ?? '?'} | ${cost(i)} |`)
  L.push('', `## Building evidence (${building.length})`, '')
  for (const i of building) L.push(`- ${i.kind} \`${i.item}\` (${unusedStreak(i.kind, i.item, previous)} of ${runsNeeded(i.kind)} runs)`)
  writeFileSync(join(dir, 'report.md'), L.join('\n') + '\n')

  console.log(`${items.length} items, ${unused.length} unused, ${candidates.length} candidates, ${single.length} one-company.`)
  console.log(`Wrote ${relative(ROOT, join(dir, 'report.md'))} and snapshot.json.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
