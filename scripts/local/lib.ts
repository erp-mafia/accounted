/**
 * Pure helpers for the local app stack: `npm run local:up`, `local:check` and
 * `local:down` (scripts/local/). No I/O here, so every rule the scripts rely
 * on is unit tested (__tests__/lib.test.ts); the scripts next to this file do
 * the docker, process and browser work.
 */
import { createHash } from 'node:crypto'
import path from 'node:path'

/** The stack's working directory under the checkout it runs from (gitignored). */
export const LOCAL_DIR = '.local'
export const STATE_FILE = 'state.json'
export const DEV_LOG_FILE = 'next-dev.log'
export const SCREENSHOT_DIR = 'screenshots'

/** The env file local:up writes. Next.js loads it in development only. */
export const ENV_FILE = '.env.development.local'
/** First line of ENV_FILE as local:up writes it: local:up and local:down only ever overwrite or delete a file that starts with it. */
export const ENV_MARKER = '# Written by npm run local:up for the local stack only. npm run local:down deletes it.'

/** Postgres major version of production (select version() in production: 17.6, 2026-10-28). */
export const PROD_PG_MAJOR = 17

/** The seeded login: one user, one aktiebolag. The password is random per stack. */
export const SEED_EMAIL = 'local-check@example.com'
export const SEED_COMPANY_NAME = 'Lokalt Testbolag AB'
/** Luhn-valid and fictitious: the org number the API docs use (556677-8899). */
export const SEED_ORG_NUMBER = '556677-8899'

/**
 * The Supabase project id for a checkout: stable per directory, so a second
 * `local:up` in the same worktree finds its own stack, and distinct across
 * worktrees, so two stacks never share containers or volumes.
 */
export function projectIdFor(repoRoot: string): string {
  const slug = path
    .basename(path.resolve(repoRoot))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  const hash = createHash('sha256').update(path.resolve(repoRoot)).digest('hex').slice(0, 6)
  return `local-${slug || 'checkout'}-${hash}`
}

/** One port per service the stack runs or the Supabase CLI insists on configuring, plus the dev server. */
export const PORT_SLOTS = ['api', 'db', 'shadow', 'studio', 'smtp', 'pooler', 'analytics', 'inspector', 'app'] as const
export type PortSlot = (typeof PORT_SLOTS)[number]
export type Ports = Record<PortSlot, number>

export function portsAt(base: number): Ports {
  return Object.fromEntries(PORT_SLOTS.map((slot, i) => [slot, base + i])) as Ports
}

/**
 * The first block of consecutive free ports, scanning `from` upward in steps
 * of ten. `isFree` is asked about each port of a block until one is taken.
 */
export async function findFreePorts(
  isFree: (port: number) => Promise<boolean>,
  { from = 64500, to = 65500 }: { from?: number; to?: number } = {},
): Promise<Ports> {
  const step = Math.ceil(PORT_SLOTS.length / 10) * 10
  for (let base = from; base + PORT_SLOTS.length - 1 <= to; base += step) {
    const ports = portsAt(base)
    let free = true
    for (const port of Object.values(ports)) {
      if (!(await isFree(port))) {
        free = false
        break
      }
    }
    if (free) return ports
  }
  throw new Error(`No ${PORT_SLOTS.length} consecutive free ports between ${from} and ${to}`)
}

/**
 * Host ports Docker publishes, from `docker ps --format '{{.Ports}}'`. A
 * published port does not always show up as a listening socket (it does not
 * when Docker's userland proxy is off), so binding a port is not proof it is
 * free.
 */
export function dockerPublishedPorts(psOutput: string): Set<number> {
  const ports = new Set<number>()
  for (const match of psOutput.matchAll(/:(\d+)(?:-(\d+))?->/g)) {
    const first = Number(match[1])
    const last = match[2] ? Number(match[2]) : first
    for (let port = first; port <= last; port++) ports.add(port)
  }
  return ports
}

/**
 * The Supabase CLI config for one stack. Prod's services and limits where
 * the app depends on them (auth, PostgREST's 1000-row cap, storage,
 * realtime for the nav badges); everything a page never reaches is off.
 * Migrations are off because the CLI applies them far slower than a psql
 * replay (local:up replays them itself, the way CI's pg-real job does).
 */
export function renderSupabaseConfig(projectId: string, ports: Ports, appUrl: string): string {
  return `# Written by npm run local:up (scripts/local/up.ts) for one throwaway stack.
project_id = "${projectId}"

[api]
enabled = true
port = ${ports.api}
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000

[db]
port = ${ports.db}
shadow_port = ${ports.shadow}
major_version = ${PROD_PG_MAJOR}

[db.pooler]
enabled = false
port = ${ports.pooler}

[db.migrations]
enabled = false

[db.seed]
enabled = false

[realtime]
enabled = true

[studio]
enabled = false
port = ${ports.studio}

[local_smtp]
enabled = false
port = ${ports.smtp}

[storage]
enabled = true
file_size_limit = "50MiB"

[auth]
enabled = true
site_url = "${appUrl}"
additional_redirect_urls = ["${appUrl}/**"]
jwt_expiry = 3600
enable_signup = true

[auth.email]
enable_signup = true
enable_confirmations = false

[edge_runtime]
enabled = false
inspector_port = ${ports.inspector}

[analytics]
enabled = false
port = ${ports.analytics}
`
}

/** `KEY="value"` lines, as `supabase status -o env` prints them. */
export function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (!match) continue
    const raw = match[2]
    out[match[1]] = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
  }
  return out
}

/** True for a URL whose host is this machine's loopback. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return false
  }
}

export interface DevEnv {
  appUrl: string
  supabaseUrl: string
  anonKey: string
  serviceRoleKey: string
  personnummerKey: string
  cronSecret: string
}

/**
 * The dev server's whole configuration. Only the local stack's URL and keys
 * plus the two secrets the app refuses to start without: no provider, mail
 * or analytics key, so nothing it does can reach a real service.
 */
export function renderDevEnv(env: DevEnv): string {
  for (const url of [env.appUrl, env.supabaseUrl]) {
    if (!isLoopbackUrl(url)) throw new Error(`Refusing a non-local URL in ${ENV_FILE}: ${url}`)
  }
  return [
    ENV_MARKER,
    `NEXT_PUBLIC_SUPABASE_URL=${env.supabaseUrl}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${env.anonKey}`,
    `SUPABASE_SERVICE_ROLE_KEY=${env.serviceRoleKey}`,
    `NEXT_PUBLIC_APP_URL=${env.appUrl}`,
    `PERSONNUMMER_ENCRYPTION_KEY=${env.personnummerKey}`,
    `CRON_SECRET=${env.cronSecret}`,
    'NEXT_TELEMETRY_DISABLED=1',
    '',
  ].join('\n')
}

/**
 * Process environment for the spawned dev server: these names from the
 * caller's shell and nothing else, so an exported production key cannot
 * override the local env file (process env wins over every .env file).
 */
export const PASSED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'NODE_OPTIONS'] as const

export function devServerEnv(parent: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'development', NO_COLOR: '1', NEXT_TELEMETRY_DISABLED: '1' }
  for (const name of PASSED_ENV) {
    if (parent[name] !== undefined) env[name] = parent[name]
  }
  return env
}

export type FindingKind =
  | 'console_error'
  | 'page_error'
  | 'http_5xx'
  | 'missing_translation'
  | 'server_error'
  | 'login_redirect'
  | 'horizontal_scroll'

export interface Finding {
  kind: FindingKind
  detail: string
  /** How often the page hit it, when more than once (dev mode renders and runs effects twice). */
  count?: number
}

/** A browser console error, or a missing next-intl message (next-intl reports those through console.error). */
export function classifyConsoleError(text: string): FindingKind {
  return text.includes('MISSING_MESSAGE') ? 'missing_translation' : 'console_error'
}

/**
 * A finding in the dev server's log, or null. Server components render on the
 * server, so their missing messages and render errors never reach the
 * browser console; Next.js marks every server error line with ⨯. Lines the
 * dev server copies from the browser console ([browser]) are skipped: the
 * page's own console already reported them.
 */
export function classifyServerLogLine(line: string): FindingKind | null {
  const text = line.trim()
  if (text.startsWith('[browser]')) return null
  if (text.includes('MISSING_MESSAGE:')) return 'missing_translation'
  if (text.startsWith('⨯ ')) return 'server_error'
  return null
}

/** One finding per kind and first line of detail, counted. */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>()
  for (const finding of findings) {
    const detail = finding.detail.split('\n')[0].trim()
    const key = `${finding.kind}\u0000${detail}`
    const seen = byKey.get(key)
    if (seen) seen.count = (seen.count ?? 1) + (finding.count ?? 1)
    else byKey.set(key, { kind: finding.kind, detail, ...(finding.count ? { count: finding.count } : {}) })
  }
  return [...byKey.values()]
}

export interface PageResult {
  path: string
  locale: string
  status: number | null
  finalPath: string
  screenshot: string
  findings: Finding[]
}

export interface CheckSummary {
  ok: boolean
  pages: number
  findings: number
  byKind: Partial<Record<FindingKind, number>>
  results: PageResult[]
}

export function summarize(results: PageResult[]): CheckSummary {
  const byKind: Partial<Record<FindingKind, number>> = {}
  let findings = 0
  for (const result of results) {
    for (const finding of result.findings) {
      byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1
      findings++
    }
  }
  return { ok: findings === 0, pages: results.length, findings, byKind, results }
}

/** A file name for a page's screenshot: `en-bookkeeping.png`, `sv-root.png`. */
export function screenshotName(locale: string, pagePath: string): string {
  const slug = pagePath
    .replace(/[?#].*$/, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
  return `${locale}-${slug || 'root'}.png`
}
