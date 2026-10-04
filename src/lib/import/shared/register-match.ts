import { normalizeEmail, normalizeNameKey } from '@/lib/import/shared/column-utils'
import { orgNumberKey } from '@/lib/invariants/org-number'

/**
 * Duplicate matching for the customer and supplier register imports.
 *
 * One definition for the preview (parse route) and the write (execute
 * route). The rule used to be written out four times as hand-built
 * org/e-mail maps, so the customer number never reached any of them and the
 * preview could only agree with execute by copy.
 *
 * Keys, strongest first: customer number, org number, e-mail, name. The first
 * key that finds existing records decides. When it finds several, the later
 * keys narrow them down, and if they cannot, the first record found is used.
 *
 * A record is never a match when both sides carry an org number and the two
 * differ: the org number is the party's legal identity, the other keys are not
 * (a customer number reused by another system, a shared invoice address).
 *
 * For the same reason an individual (customer_type 'individual') and a
 * business with an org number are never a match, whichever of them is the
 * row: an individual carries no org number to compare (customerMatchRow), so
 * the rule above cannot tell a private person from a company that shares its
 * e-mail, customer number or name. Rows and records without a customer_type
 * (the supplier register) are not affected.
 */

export type RegisterMatchKey = 'customer_number' | 'org_number' | 'email' | 'name'

export type NameMatchPolicy = 'ask' | 'auto'

/**
 * What a match on name alone means.
 *
 * - 'ask': a suggestion only. The preview flags the row as a possible
 *   duplicate and the user decides per row (`confirmed_duplicate_of`);
 *   execute never merges on a name by itself, since two parties can share one.
 * - 'auto': a name match counts like the other keys.
 *
 * Flipping this constant switches the preview, execute and the review step.
 */
export const NAME_MATCH_POLICY: NameMatchPolicy = 'ask'

export interface MatchableRecord {
  id: string
  name: string
  org_number: string | null
  email: string | null
  customer_number?: string | null
  /** Customers only; 'individual' never matches a business with an org number. */
  customer_type?: string | null
}

export interface MatchableRow {
  name: string
  org_number: string | null
  email: string | null
  customer_number?: string | null
  /** Customers only; 'individual' never matches a business with an org number. */
  customer_type?: string | null
}

export interface RegisterMatch<T> {
  record: T
  matched_by: RegisterMatchKey
  /** A name-only match under the 'ask' policy: shown to the user, never merged by itself. */
  possible: boolean
}

export interface RegisterMatcherOptions {
  /** Dedup key for an org number: customers and suppliers normalise it differently. */
  orgKey: (value: string | null) => string | null
  namePolicy?: NameMatchPolicy
}

export interface RegisterMatcher<T extends MatchableRecord> {
  /** The best existing match for a row, or null. */
  find: (row: MatchableRow) => RegisterMatch<T> | null
  /**
   * The existing record execute writes this row onto, or null to create it:
   * a definite match, else the record the user confirmed in the review step.
   */
  resolve: (row: MatchableRow, confirmedId?: string | null) => T | null
  /** Index a record created or updated earlier in the same batch. */
  add: (record: T) => void
}

const KEY_ORDER: RegisterMatchKey[] = ['customer_number', 'org_number', 'email', 'name']

/**
 * Supplier org number key: the Swedish 10-digit key when the value is one (so
 * a 12-digit CSV value finds the stored 10-digit row, #2391), else the value
 * as typed, so BE0123456789 and FR0123456789 stay two suppliers.
 */
export function supplierOrgKey(value: string | null): string | null {
  return orgNumberKey(value) ?? (value?.trim() || null)
}

/**
 * A customer import row as the matcher sees it. An individual (privatperson)
 * has no org number: its personnummer is stored encrypted in personal_number
 * and is never a match key, so an individual is found by customer number,
 * e-mail or a confirmed name only. The preview and execute both match through
 * this, so neither can match on a number the other does not.
 */
export function customerMatchRow<T extends MatchableRow & { customer_type: string }>(row: T): T {
  return row.customer_type === 'individual' ? { ...row, org_number: null } : row
}

/** Customer numbers compare trimmed and case-insensitively ("k-1" is "K-1"). */
export function normalizeCustomerNumber(value: string | null | undefined): string | null {
  if (!value) return null
  return value.trim().toLowerCase() || null
}

/** Names compare trimmed and case-insensitively, with inner whitespace collapsed. */
export function normalizeNameForMatch(value: string | null | undefined): string | null {
  return normalizeNameKey(value ? value.replace(/\s+/g, ' ') : null)
}

export function createRegisterMatcher<T extends MatchableRecord>(
  records: readonly T[],
  options: RegisterMatcherOptions,
): RegisterMatcher<T> {
  const namePolicy = options.namePolicy ?? NAME_MATCH_POLICY

  const keyOf: Record<RegisterMatchKey, (r: MatchableRow) => string | null> = {
    customer_number: (r) => normalizeCustomerNumber(r.customer_number),
    org_number: (r) => options.orgKey(r.org_number),
    email: (r) => normalizeEmail(r.email),
    name: (r) => normalizeNameForMatch(r.name),
  }

  const byId = new Map<string, T>()
  // key -> normalized value -> record ids, in insertion order.
  const indexes = new Map<RegisterMatchKey, Map<string, Set<string>>>(
    KEY_ORDER.map((k) => [k, new Map()]),
  )

  const add = (record: T) => {
    byId.set(record.id, record)
    for (const key of KEY_ORDER) {
      const value = keyOf[key](record)
      if (!value) continue
      const index = indexes.get(key)!
      const ids = index.get(value) ?? new Set<string>()
      ids.add(record.id)
      index.set(value, ids)
    }
  }

  for (const record of records) add(record)

  const isIndividual = (p: MatchableRow) => p.customer_type === 'individual'
  const isBusinessWithOrg = (p: MatchableRow) => !isIndividual(p) && options.orgKey(p.org_number) !== null
  /** An individual and a business with an org number are never the same party. */
  const crossesKind = (row: MatchableRow, record: T) =>
    (isIndividual(row) && isBusinessWithOrg(record)) || (isBusinessWithOrg(row) && isIndividual(record))

  const find = (row: MatchableRow): RegisterMatch<T> | null => {
    const rowOrg = options.orgKey(row.org_number)
    let pool: T[] | null = null
    let decidedBy: RegisterMatchKey | null = null

    for (const key of KEY_ORDER) {
      const value = keyOf[key](row)
      if (!value) continue
      const ids = indexes.get(key)!.get(value)
      if (!ids) continue

      const candidates = [...ids]
        .map((id) => byId.get(id)!)
        // An update earlier in the batch can have changed the value.
        .filter((c) => keyOf[key](c) === value)
        .filter((c) => !pool || pool.includes(c))
        .filter((c) => {
          const org = options.orgKey(c.org_number)
          return !rowOrg || !org || org === rowOrg
        })
        .filter((c) => !crossesKind(row, c))
      if (candidates.length === 0) continue

      decidedBy ??= key
      pool = candidates
      if (candidates.length === 1) break
    }

    if (!pool || !decidedBy) return null
    return {
      record: pool[0],
      matched_by: decidedBy,
      possible: decidedBy === 'name' && namePolicy === 'ask',
    }
  }

  const resolve = (row: MatchableRow, confirmedId?: string | null): T | null => {
    const found = find(row)
    if (found && !found.possible) return found.record
    const confirmed = confirmedId ? byId.get(confirmedId) : undefined
    return confirmed && !crossesKind(row, confirmed) ? confirmed : null
  }

  return { find, resolve, add }
}
