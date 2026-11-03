/**
 * Resolve-don't-select for time entries: a customer, project, activity code
 * or consultant may arrive as a code ("GF", "P12", "1", "AB") or as a name
 * someone said ("Galärbryggan", "bokslut", "Anna"). Exact code, then exact
 * name (both case-insensitive), then a fuzzy match that must be confident
 * and clearly ahead of the runner-up. Anything else is refused with a ranked
 * candidate list: an hour on the wrong customer is billed to the wrong
 * customer, so nothing is guessed and nothing is created.
 *
 * Same thresholds as the dimension resolver (mcp-server/dimensions.ts).
 */
import Fuse from 'fuse.js'

export const FUZZY_SCORE_MAX = 0.3
export const FUZZY_AMBIGUITY_MARGIN = 0.15
const CANDIDATE_LIMIT = 5

export interface RefCandidate {
  /** The value stored on the entry: a code, or a customer id. */
  value: string
  /** Codes that match exactly besides `value` (customer numbers, imported customer codes). */
  aliases?: string[]
  name: string
}

export type RefResolution =
  | { ok: true; candidate: RefCandidate; exact: boolean; confidence: number }
  | { ok: false; candidates: Array<{ value: string; name: string; confidence: number }> }

const norm = (s: string) => s.trim().toLocaleLowerCase('sv')
const round2 = (x: number) => Math.round(x * 100) / 100

/**
 * `exactOnly` skips the fuzzy step, for doors where no one approves a preview
 * (the dashboard sends codes it picked from the registers).
 */
export function resolveRef(input: string, candidates: RefCandidate[], { exactOnly = false } = {}): RefResolution {
  const wanted = norm(input)
  const byCode = candidates.filter(
    (c) => norm(c.value) === wanted || (c.aliases ?? []).some((a) => norm(a) === wanted),
  )
  if (byCode.length === 1) return { ok: true, candidate: byCode[0], exact: true, confidence: 1 }
  const byName = candidates.filter((c) => norm(c.name) === wanted)
  if (byCode.length === 0 && byName.length === 1) {
    return { ok: true, candidate: byName[0], exact: true, confidence: 1 }
  }
  if (byCode.length > 1 || byName.length > 1) {
    return {
      ok: false,
      candidates: [...byCode, ...byName].slice(0, CANDIDATE_LIMIT).map((c) => ({ value: c.value, name: c.name, confidence: 1 })),
    }
  }

  if (exactOnly) return { ok: false, candidates: [] }

  const fuse = new Fuse(candidates, {
    keys: ['name', 'value', 'aliases'],
    includeScore: true,
    threshold: 0.4,
    ignoreLocation: true,
  })
  const hits = fuse.search(input.trim(), { limit: CANDIDATE_LIMIT })
  const top = hits[0]
  if (top) {
    const topScore = top.score ?? 1
    const runnerUp = hits[1]?.score ?? Number.POSITIVE_INFINITY
    if (topScore <= FUZZY_SCORE_MAX && runnerUp - topScore >= FUZZY_AMBIGUITY_MARGIN) {
      return { ok: true, candidate: top.item, exact: false, confidence: round2(1 - topScore) }
    }
  }
  return {
    ok: false,
    candidates: hits.map((h) => ({ value: h.item.value, name: h.item.name, confidence: round2(1 - (h.score ?? 1)) })),
  }
}
