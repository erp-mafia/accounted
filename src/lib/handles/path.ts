/**
 * Handles in a v1 URL path: `/companies/cmp_.../journal-entries/je_...`.
 *
 * A path parameter's type is the collection segment before it
 * (registry.ts `segments`): `/journal-entries/:id` takes a journal entry.
 * A handle of that type becomes its UUID; a handle of another type is a
 * mismatch; a parameter after a segment no type claims (`/benefits/:id`,
 * `/imports/sie/:id`) takes a plain UUID only, so a handle there is a
 * mismatch too. Segments that are not handles (static words, UUIDs, account
 * numbers, `bank:<uuid>` account keys) are left alone.
 */
import { parseHandle } from './format'
import { mismatchFor, type HandleMismatch, type NormalizeResult } from './fields'
import { typeForPathSegment, type HandleType } from './registry'

/** The pathname with every handle segment replaced by its UUID. */
export function normalizeHandlePath(pathname: string): NormalizeResult<string> {
  const segments = pathname.split('/')
  const mismatches: HandleMismatch[] = []
  let changed = false
  const out = segments.map((segment, i) => {
    const parsed = parseHandle(segment)
    if (!parsed) return segment
    const expected = typeForPathSegment(segments[i - 1]) ?? null
    if (parsed.type !== expected) {
      mismatches.push(mismatchFor(`path.${segments[i - 1] ?? ''}`, expected, parsed))
      return segment
    }
    changed = true
    return parsed.uuid
  })
  if (mismatches.length > 0) return { ok: false, mismatches }
  return { ok: true, value: changed ? out.join('/') : pathname, changed }
}

/**
 * The type each `:param` of a registered v1 path pattern takes, by the
 * segment before it: null for a parameter that takes no typed handle. Used
 * to publish and pin the path typing (tests, docs); the runtime reads the
 * concrete path with the same rule.
 */
export function pathParamTypes(pattern: string): Record<string, HandleType | null> {
  const segments = pattern.split('/')
  const out: Record<string, HandleType | null> = {}
  segments.forEach((segment, i) => {
    if (!segment.startsWith(':')) return
    out[segment.slice(1)] = typeForPathSegment(segments[i - 1]) ?? null
  })
  return out
}
