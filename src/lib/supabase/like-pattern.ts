/**
 * Text embedded in a PostgREST LIKE/ILIKE filter (.ilike / .like): the one
 * helper the ledger's searches and the blocks' share.
 */

/** Cap on supplier / merchant names before they enter an ILIKE pattern, to
 * bound query work and avoid pathological inputs degrading the index scan. */
const MAX_LIKE_NEEDLE_LENGTH = 200

/**
 * Escape LIKE/ILIKE wildcards (`%`, `_`, `\`) and truncate to a safe length
 * before embedding the value in an ILIKE pattern. SQL-injection is already
 * handled by Supabase's parameterization; this purely prevents silent
 * over-matching on names like "50% Off AB" and bounds DB work on long inputs.
 */
export function escapeLikePattern(value: string): string {
  const truncated = value.length > MAX_LIKE_NEEDLE_LENGTH
    ? value.slice(0, MAX_LIKE_NEEDLE_LENGTH)
    : value
  return truncated.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}
