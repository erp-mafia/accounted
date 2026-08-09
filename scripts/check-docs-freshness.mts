/**
 * Docs-freshness check: verifies that the public API docs on
 * https://docs.accounted.se match what this repo would generate today.
 *
 * The docs site is served by the separate gnubok-website repo from snapshot
 * files (`*.generated.ts` exported via scripts/export-docs-to-website.mts,
 * plus hand-copied duplicates for changelog/versioning/webhooks/cookbook).
 * Nothing re-syncs them automatically, so they drift whenever an endpoint,
 * error code, or content page changes here. Every docs page has a raw
 * markdown mirror route (`/<page>.md`), which makes the check exact: build
 * each page from source, fetch the live mirror, diff.
 *
 * Run with `npx tsx scripts/check-docs-freshness.mts`.
 * Exit codes: 0 = in sync, 1 = drift or missing pages, 2 = build/fetch failure.
 * Used by the weekly `loop-docs-freshness` skill; keep the output format
 * stable (the loop parses the FINGERPRINT lines for issue dedupe).
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

// `server-only` throws on import outside a Next.js server-component graph.
// The reference builder pulls it in transitively (lib/api/v1/load-routes ->
// every v1 route -> lib/init). Nothing here executes request-time code: it
// only reads exported markdown builders, so a no-op stub is the honest
// resolution. Same pattern as scripts/export-docs-to-website.mts.
const require = createRequire(import.meta.url)
const ModuleCtor = require('node:module') as {
  _load: (request: string, ...rest: unknown[]) => unknown
}
const originalLoad = ModuleCtor._load
ModuleCtor._load = function (request: string, ...rest: unknown[]) {
  if (request === 'server-only') return {}
  return originalLoad.call(this, request, ...rest)
}

// Explicit types: these are read inside buildExpectedPages(), and TS cannot
// infer a closure-captured let assigned in a try block (implicit-any error
// under next build's type check; the export script gets away with the bare
// pattern only because it reads the variables at top level).
let errors!: typeof import('@/lib/docs/content/errors')
let reference!: typeof import('@/lib/docs/content/reference')
let connectClaude!: typeof import('@/lib/docs/content/connect-claude')
let changelog!: typeof import('@/lib/docs/content/changelog')
let versioning!: typeof import('@/lib/docs/content/versioning')
let webhooks!: typeof import('@/lib/docs/content/webhooks')
let cookbook!: typeof import('@/lib/docs/content/cookbook')
try {
  errors = await import('@/lib/docs/content/errors')
  reference = await import('@/lib/docs/content/reference')
  connectClaude = await import('@/lib/docs/content/connect-claude')
  changelog = await import('@/lib/docs/content/changelog')
  versioning = await import('@/lib/docs/content/versioning')
  webhooks = await import('@/lib/docs/content/webhooks')
  cookbook = await import('@/lib/docs/content/cookbook')
} finally {
  ModuleCtor._load = originalLoad
}

const DOCS_BASE = process.env.DOCS_BASE_URL ?? 'https://docs.accounted.se'

/**
 * Same link-absolutising transform the export script applies: the website
 * cannot serve root-relative /api/v1 links. Applied to BOTH sides before
 * comparing so the check is insensitive to whether a hand-copied page was
 * adapted or not.
 */
const APP_ORIGIN = 'https://app.gnubok.se'
function canonicalise(md: string): string {
  return md
    .replaceAll('](/api/v1/', `](${APP_ORIGIN}/api/v1/`)
    .replaceAll('](/.well-known/', `](${APP_ORIGIN}/.well-known/`)
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim()
}

function sha12(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12)
}

interface PageCheck {
  /** Path of the raw-markdown mirror on the docs site, no leading slash. */
  path: string
  expected: string
}

function buildExpectedPages(): PageCheck[] {
  const buildErrorReferenceMd = errors.buildErrorReferenceMd
  const buildResourcePages = reference.buildResourcePages
  const buildReferenceOverviewMd = reference.buildReferenceOverviewMd
  const { COOKBOOK, buildPlaceholderMd } = cookbook
  if (!buildErrorReferenceMd || !buildResourcePages || !buildReferenceOverviewMd || !COOKBOOK) {
    console.error('Missing builder exports; the content modules changed shape.')
    process.exit(2)
  }

  const pages: PageCheck[] = [
    { path: 'reference.md', expected: buildReferenceOverviewMd() },
    { path: 'errors.md', expected: buildErrorReferenceMd() },
    { path: 'connect-claude.md', expected: connectClaude.CONNECT_CLAUDE_MD },
    { path: 'changelog.md', expected: changelog.CHANGELOG_MD },
    { path: 'versioning.md', expected: versioning.VERSIONING_MD },
    { path: 'webhooks.md', expected: webhooks.WEBHOOKS_MD },
  ]
  for (const page of buildResourcePages()) {
    pages.push({ path: `reference/${page.slug}.md`, expected: page.markdown })
  }
  for (const entry of COOKBOOK) {
    pages.push({
      path: `cookbook/${entry.slug}.md`,
      expected: entry.markdown ?? buildPlaceholderMd(entry),
    })
  }
  return pages
}

type Verdict =
  | { path: string; status: 'ok' }
  | { path: string; status: 'missing'; fingerprint: string }
  | {
      path: string
      status: 'drift'
      fingerprint: string
      firstDiffLine: number
      expectedLine: string
      liveLine: string
      changedLines: number
    }
  | { path: string; status: 'fetch-error'; detail: string }

async function checkPage(page: PageCheck): Promise<Verdict> {
  const url = `${DOCS_BASE}/${page.path}`
  let res: Response
  try {
    res = await fetch(url, { redirect: 'follow' })
  } catch (e) {
    return { path: page.path, status: 'fetch-error', detail: String(e) }
  }
  if (res.status === 404) {
    // A page this repo generates that the docs site does not serve at all:
    // typically a new API resource whose generated snapshot + nav entry were
    // never exported to the website repo.
    return { path: page.path, status: 'missing', fingerprint: sha12(`missing:${page.path}`) }
  }
  if (!res.ok) {
    return { path: page.path, status: 'fetch-error', detail: `HTTP ${res.status}` }
  }
  const live = canonicalise(await res.text())
  const expected = canonicalise(page.expected)
  if (live === expected) return { path: page.path, status: 'ok' }

  const expectedLines = expected.split('\n')
  const liveLines = live.split('\n')
  let firstDiffLine = 0
  while (
    firstDiffLine < Math.min(expectedLines.length, liveLines.length) &&
    expectedLines[firstDiffLine] === liveLines[firstDiffLine]
  ) {
    firstDiffLine++
  }
  const maxLen = Math.max(expectedLines.length, liveLines.length)
  let changedLines = Math.abs(expectedLines.length - liveLines.length)
  for (let i = 0; i < Math.min(expectedLines.length, liveLines.length); i++) {
    if (expectedLines[i] !== liveLines[i]) changedLines++
  }
  return {
    path: page.path,
    status: 'drift',
    // Stable while the same pair of contents drifts; changes when either
    // side changes, so a NEW drift after a fix reads as a new finding.
    fingerprint: sha12(`${page.path}:${sha12(expected)}:${sha12(live)}`),
    firstDiffLine: firstDiffLine + 1,
    expectedLine: expectedLines[firstDiffLine] ?? '<end of file>',
    liveLine: liveLines[firstDiffLine] ?? '<end of file>',
    changedLines: Math.min(changedLines, maxLen),
  }
}

async function main() {
  const pages = buildExpectedPages()
  console.log(`Checking ${pages.length} docs pages against ${DOCS_BASE} ...\n`)

  const verdicts: Verdict[] = []
  const CONCURRENCY = 6
  for (let i = 0; i < pages.length; i += CONCURRENCY) {
    const batch = pages.slice(i, i + CONCURRENCY)
    verdicts.push(...(await Promise.all(batch.map(checkPage))))
  }

  const ok = verdicts.filter((v) => v.status === 'ok')
  const drift = verdicts.filter((v) => v.status === 'drift')
  const missing = verdicts.filter((v) => v.status === 'missing')
  const failed = verdicts.filter((v) => v.status === 'fetch-error')

  for (const v of verdicts) {
    if (v.status === 'ok') continue
    if (v.status === 'missing') {
      console.log(`MISSING  ${v.path}`)
      console.log(`  page exists in erp-base but the docs site returns 404`)
      console.log(`  FINGERPRINT ${v.fingerprint}`)
    } else if (v.status === 'drift') {
      console.log(`DRIFT    ${v.path}`)
      console.log(`  ~${v.changedLines} differing line(s), first at line ${v.firstDiffLine}:`)
      console.log(`    repo builds: ${v.expectedLine.slice(0, 160)}`)
      console.log(`    site serves: ${v.liveLine.slice(0, 160)}`)
      console.log(`  FINGERPRINT ${v.fingerprint}`)
    } else {
      console.log(`ERROR    ${v.path}: ${v.detail}`)
    }
    console.log('')
  }

  console.log(
    `Summary: ${ok.length} in sync, ${drift.length} drifted, ${missing.length} missing, ${failed.length} fetch errors.`,
  )

  if (failed.length > 0) process.exit(2)
  if (drift.length > 0 || missing.length > 0) {
    console.log('\nTo fix: run `npx tsx scripts/export-docs-to-website.mts`, then port any')
    console.log('hand-copied pages (changelog/versioning/webhooks/cookbook) and nav entries')
    console.log('in the gnubok-website repo, and deploy it. See loop-docs-freshness skill.')
    process.exit(1)
  }
  console.log('Docs are up to date.')
}

await main()
