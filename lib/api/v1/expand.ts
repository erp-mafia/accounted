/**
 * `?expand=…` query parameter parser for embedding related resources.
 *
 * Stripe pattern: a single call returns invoice + customer + line items +
 * payments instead of forcing the caller to make 4 round-trips. For agents
 * passing the response into their own context, this is the difference
 * between 200 and 4000 tokens.
 *
 * Each endpoint declares its own allowlist of expandable keys. Unknown
 * values produce a 400 VALIDATION_ERROR rather than being silently ignored:
 * agents that typo expansions deserve a clear error.
 *
 * Usage:
 *
 *   const ALLOWED = ['customer', 'items', 'payments'] as const
 *   type ExpandKey = (typeof ALLOWED)[number]
 *   const expand = parseExpand(url, ALLOWED)
 *   // returns: Set<ExpandKey>, empty if no ?expand param
 *
 *   if (expand.has('customer')) { ... }
 */

export interface ParseExpandResult<K extends string> {
  ok: true
  expand: Set<K>
}

export interface ParseExpandError {
  ok: false
  invalidKeys: string[]
  allowed: readonly string[]
}

/**
 * Parse `?expand=a,b,c` from a URL against a per-endpoint allowlist.
 *
 * Returns either `{ ok: true, expand: Set<K> }` for valid input (including
 * the empty case when the parameter is absent), or `{ ok: false, invalidKeys,
 * allowed }` listing the unrecognised keys so the caller can build a
 * VALIDATION_ERROR detail.
 *
 * Whitespace around comma-separated keys is trimmed. Duplicate keys collapse
 * to a single Set entry.
 */
export function parseExpand<K extends string>(
  url: URL,
  allowed: readonly K[],
): ParseExpandResult<K> | ParseExpandError {
  const raw = url.searchParams.get('expand')
  if (!raw) return { ok: true, expand: new Set<K>() }

  const requested = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  const allowedSet = new Set<string>(allowed)
  const expand = new Set<K>()
  const invalidKeys: string[] = []

  for (const key of requested) {
    if (allowedSet.has(key)) {
      expand.add(key as K)
    } else if (!invalidKeys.includes(key)) {
      invalidKeys.push(key)
    }
  }

  if (invalidKeys.length > 0) {
    return { ok: false, invalidKeys, allowed }
  }
  return { ok: true, expand }
}
