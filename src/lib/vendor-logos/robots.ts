/**
 * robots.txt, as far as the logo fetcher needs it: whether our user agent
 * may fetch a path. Pure.
 *
 * The group for our own product token (AccountedLogoFetcher) applies when
 * there is one, else the `*` group. Within it the longest matching Allow or
 * Disallow wins, Allow on a tie; `*` matches any run of characters and a
 * trailing `$` anchors the end (RFC 9309). An empty Disallow allows all.
 */

export const ROBOTS_PRODUCT_TOKEN = 'accountedlogofetcher'

interface Rule {
  allow: boolean
  pattern: string
}

export interface RobotsRules {
  rules: readonly Rule[]
}

/** Rules that allow everything: no robots.txt, or one we may ignore (4xx). */
export const ALLOW_ALL: RobotsRules = { rules: [] }

export function parseRobots(text: string, productToken: string = ROBOTS_PRODUCT_TOKEN): RobotsRules {
  const groups: Array<{ agents: string[]; rules: Rule[] }> = []
  let current: { agents: string[]; rules: Rule[] } | null = null
  let lastWasAgent = false
  for (const rawLine of text.split(/\r?\n|\r/)) {
    // A comment runs to the end of the line, and RFC 9309 ends a line only at
    // CR or LF. A . stops at a U+2028: the match then failed, and each #
    // before it searched the rest of the line again.
    const line = rawLine.replace(/#[\s\S]*$/, '').trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!current) continue
    if (field === 'allow' || field === 'disallow') {
      if (field === 'disallow' && value === '') continue
      current.rules.push({ allow: field === 'allow', pattern: value })
    }
  }
  const token = productToken.toLowerCase()
  // The version after the / runs to the end of the value, as a comment does.
  const own = groups.filter((g) => g.agents.some((a) => a.replace(/\/[\s\S]*$/, '').trim() === token))
  const chosen = own.length > 0 ? own : groups.filter((g) => g.agents.includes('*'))
  return { rules: chosen.flatMap((g) => g.rules) }
}

/**
 * Whether a robots pattern matches a path from its start: `*` is any run of
 * characters, a trailing `$` anchors the end. Iterative wildcard matching
 * (one backtrack point), so a hostile pattern costs at most
 * pattern x path steps, never an exponential regular expression.
 */
export function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$')
  const p = anchored ? pattern.slice(0, -1) : pattern
  let pi = 0
  let si = 0
  let star = -1
  let mark = 0
  while (si < path.length) {
    if (pi < p.length && p[pi] !== '*' && p[pi] === path[si]) {
      pi++
      si++
    } else if (pi < p.length && p[pi] === '*') {
      star = pi++
      mark = si
    } else if (pi >= p.length && !anchored) {
      return true
    } else if (star >= 0) {
      pi = star + 1
      si = ++mark
    } else {
      return false
    }
  }
  while (pi < p.length && p[pi] === '*') pi++
  return pi === p.length
}

/** Whether the path (with its query) may be fetched under these rules. */
export function robotsAllows(rules: RobotsRules, pathWithQuery: string): boolean {
  let best: Rule | null = null
  for (const rule of rules.rules) {
    if (!rule.pattern.startsWith('/') && !rule.pattern.startsWith('*')) continue
    if (!patternMatches(rule.pattern, pathWithQuery)) continue
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule
  }
  return best ? best.allow : true
}
