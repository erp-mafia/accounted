/**
 * Pure helpers for scripts/usage-audit.ts (the loop-usage-audit skill): turn
 * observed paths into the code's route patterns, and decide per item whether
 * any usage source saw it.
 *
 * Which source can see what:
 *   page             PostHog pageviews (90 days) and Vercel route hits (36 days)
 *   api              Vercel route hits only
 *   extension-route  Vercel hits on /api/extensions/ext/<id>/<path>, split by request path
 *   workspace        PostHog pageviews of /e/<sector>/<slug> (Vercel sees one route for all)
 *   mcp              event_log mcp.tool_called (90 days)
 * An item is unused when every source that can see it saw nothing.
 */

export type ItemKind = 'page' | 'api' | 'extension-route' | 'workspace' | 'mcp'

export interface Usage {
  posthogViews?: number
  /** Distinct companies outside the internal ones (PostHog $group_0, event_log company_id). */
  companies?: number
  vercelHits?: number
  mcpCalls?: number
}

export interface RouteMatcher {
  pattern: string
  regex: RegExp
  staticSegments: number
}

/** A route pattern from a file path: route groups `(x)` and parallel slots `@x` are not URL segments. */
export function routePatternFromDir(dirUnderApp: string): string {
  const segments = dirUnderApp
    .split('/')
    .filter(Boolean)
    .filter((s) => !(s.startsWith('(') && s.endsWith(')')) && !s.startsWith('@'))
  return '/' + segments.join('/')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Matcher for a Next.js pattern (`/invoices/[id]`, `[...path]`, `[[...x]]`) or an
 * extension route path (`/items/:id`). Observed paths have ids already replaced
 * by `*`, which a dynamic segment matches like any other value.
 */
export function routeMatcher(pattern: string): RouteMatcher {
  let source = ''
  let staticSegments = 0
  for (const s of pattern.split('/').filter(Boolean)) {
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(s)) source += '(?:/.*)?'
    else if (/^\[\.\.\.[^\]]+\]$/.test(s)) source += '/.+'
    else if (/^\[[^\]]+\]$/.test(s) || /^:[A-Za-z_]+$/.test(s)) source += '/[^/]+'
    else {
      source += '/' + escapeRegex(s)
      staticSegments++
    }
  }
  return { pattern, regex: new RegExp(`^${source || '/'}$`), staticSegments }
}

/** The pattern an observed path belongs to; a static segment beats a dynamic one (`/invoices/new` over `/invoices/[id]`). */
export function matchRoute(path: string, matchers: readonly RouteMatcher[]): string | null {
  let best: RouteMatcher | null = null
  for (const m of matchers) {
    if (m.regex.test(path) && (!best || m.staticSegments > best.staticSegments)) best = m
  }
  return best?.pattern ?? null
}

/** Whether every source that can see this kind of item saw nothing. */
export function isUnused(kind: ItemKind, u: Usage): boolean {
  switch (kind) {
    case 'page':
      return (u.posthogViews ?? 0) === 0 && (u.vercelHits ?? 0) === 0
    case 'api':
    case 'extension-route':
      return (u.vercelHits ?? 0) === 0
    case 'workspace':
      return (u.posthogViews ?? 0) === 0
    case 'mcp':
      return (u.mcpCalls ?? 0) === 0
  }
}

/**
 * Used, but by at most one company outside the internal ones (0: only internal
 * or company-less use). Only PostHog and event_log carry a company, so this
 * judges pages and workspaces by their pageviews and tools by their calls.
 */
export function isSingleCompany(kind: ItemKind, u: Usage): boolean {
  if (kind === 'api' || kind === 'extension-route') return false
  const seen = kind === 'mcp' ? (u.mcpCalls ?? 0) : (u.posthogViews ?? 0)
  return seen > 0 && (u.companies ?? 0) <= 1
}

/** Vercel keeps 36 days, so a Vercel-only item needs three monthly runs in a row to cover 90 days. */
export function runsNeeded(kind: ItemKind): number {
  return kind === 'api' || kind === 'extension-route' ? 3 : 1
}

export interface Snapshot {
  run: string
  unused: Partial<Record<ItemKind, string[]>>
}

/** Runs in a row, this one included, that found the item unused (previous snapshots newest first). */
export function unusedStreak(kind: ItemKind, item: string, previous: readonly Snapshot[]): number {
  let streak = 1
  for (const s of previous) {
    if (!(s.unused[kind] ?? []).includes(item)) break
    streak++
  }
  return streak
}

export interface KeepEntry {
  kind: ItemKind
  /** An exact item, or a prefix ending in `*`. */
  match: string
  reason: string
  /** Re-judge after this date (YYYY-MM-DD), for seasonal or dormant items. */
  until?: string
}

/** The keep-list entry that covers an item today, if any. */
export function keptBy(kind: ItemKind, item: string, keep: readonly KeepEntry[], today: string): KeepEntry | null {
  for (const k of keep) {
    if (k.kind !== kind) continue
    if (k.until && k.until < today) continue
    const hit = k.match.endsWith('*') ? item.startsWith(k.match.slice(0, -1)) : item === k.match
    if (hit) return k
  }
  return null
}
