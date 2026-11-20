import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Every literal `/api/...` path a component fetches has a route file.
 *
 * The year-end wizard's enskild firma step fetched
 * /api/bookkeeping/fiscal-periods/[id]/ef-declaration for months while no
 * such route existed: every owner saw "Kunde inte ladda EF-deklaration" and
 * nothing in CI noticed, because a fetch path is only a string. This pins the
 * string to the file tree. An interpolated segment (`${id}`) matches any
 * segment, a trailing interpolation glued to a segment (`candidates${qs}`) is
 * read as a query suffix, and paths built in a variable first are not seen.
 */

const SRC = path.resolve(__dirname, '..', '..')
const API_ROOT = path.join(SRC, 'app', 'api')
const WILDCARD = '\u0000'

function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, keep, out)
    else if (keep(entry.name)) out.push(full)
  }
  return out
}

/** Route patterns as segment lists, e.g. ['api', 'invoices', '[id]', 'send']. */
const ROUTES: string[][] = walk(API_ROOT, (name) => name === 'route.ts').map((file) =>
  path
    .relative(path.join(SRC, 'app'), path.dirname(file))
    .split(path.sep)
    .filter((segment) => !/^\(.*\)$/.test(segment)),
)

/**
 * The first argument of every `fetch(` whose argument is a string or template
 * literal starting with /api/. Interpolations become WILDCARD; nested braces
 * and template literals inside an interpolation are skipped whole.
 */
function fetchedPaths(source: string): string[] {
  const out: string[] = []
  const opener = /fetch\(\s*([`'"])\/api\//g
  let match: RegExpExecArray | null
  while ((match = opener.exec(source))) {
    const quote = match[1]
    let i = match.index + match[0].length - '/api/'.length
    let literal = ''
    while (i < source.length && source[i] !== quote) {
      if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
        let depth = 1
        i += 2
        while (i < source.length && depth > 0) {
          if (source[i] === '{') depth++
          else if (source[i] === '}') depth--
          i++
        }
        literal += WILDCARD
        continue
      }
      literal += source[i]
      i++
    }
    out.push(literal)
  }
  return out
}

/** Segments of a fetched path, with the query string and a glued trailing interpolation dropped. */
function toSegments(fetched: string): string[] {
  const segments = fetched.split('?')[0].split('/').filter(Boolean)
  return segments.map((segment, index) => {
    if (segment === WILDCARD || !segment.includes(WILDCARD)) return segment
    const prefix = segment.slice(0, segment.indexOf(WILDCARD))
    return index === segments.length - 1 && prefix ? prefix : WILDCARD
  })
}

function routeMatches(route: string[], segments: string[]): boolean {
  for (let i = 0; i < route.length; i++) {
    const part = route[i]
    if (part.startsWith('[[...')) return true
    if (part.startsWith('[...')) return segments.length > i
    if (i >= segments.length) return false
    if (part.startsWith('[') || segments[i] === WILDCARD) continue
    if (part !== segments[i]) return false
  }
  return route.length === segments.length
}

describe('component fetches', () => {
  it('only call /api/ paths that have a route file', () => {
    const missing: string[] = []
    let checked = 0
    for (const file of walk(path.join(SRC, 'components'), (name) => /\.tsx?$/.test(name))) {
      for (const fetched of fetchedPaths(fs.readFileSync(file, 'utf8'))) {
        checked++
        const segments = toSegments(fetched)
        if (!ROUTES.some((route) => routeMatches(route, segments))) {
          missing.push(`${path.relative(SRC, file)}: ${fetched.replaceAll(WILDCARD, '${...}')}`)
        }
      }
    }
    expect(missing).toEqual([])
    // The scan really ran: components fetch several hundred literal paths.
    expect(checked).toBeGreaterThan(300)
  })

  it('sees the fetches it is meant to check', () => {
    expect(ROUTES.length).toBeGreaterThan(100)
    expect(fetchedPaths('fetch(`/api/invoices/${id}/send?x=${a ? `b` : "c"}`, { method: "POST" })')).toEqual([
      `/api/invoices/${WILDCARD}/send?x=${WILDCARD}`,
    ])
    expect(toSegments(`/api/parties/${WILDCARD}/enrich/candidates${WILDCARD}`)).toEqual([
      'api',
      'parties',
      WILDCARD,
      'enrich',
      'candidates',
    ])
    expect(routeMatches(['api', 'invoices', '[id]', 'send'], ['api', 'invoices', WILDCARD, 'send'])).toBe(true)
    expect(
      routeMatches(['api', 'bookkeeping', 'fiscal-periods', '[id]', 'lock'], ['api', 'bookkeeping', 'fiscal-periods', WILDCARD, 'nope']),
    ).toBe(false)
  })
})
