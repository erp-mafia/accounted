/**
 * Customer search for the shared picker (components/customers/CustomerCombobox).
 *
 * The picker used to be a plain Select fed every customer at once: no filter,
 * and the browser's typeahead only matched the START of the name, so a company
 * invoicing hundreds of private persons could find a customer by first name
 * only, never by surname, customer number or email (issue #2684).
 *
 * This matcher runs client-side over the already-cached customer list:
 *
 *  - every whitespace-separated token must match somewhere in the folded
 *    "name + customer number + org number + personnummer + email" haystack,
 *    so "andersson", "anna and" and "andersson anna" all find Anna Andersson;
 *  - identifier tokens (digits with optional hyphen/plus) also match the
 *    digits-only form of each identifier, so "5560000000" finds 556000-0000;
 *  - diacritics are folded (lib/bookkeeping/account-search foldText), so
 *    "lofgren" finds Löfgren;
 *  - results are ranked (customer number hit, name start, surname start,
 *    every token in the name) and capped, with the pre-cap total returned so
 *    the picker can say "showing 50 of 312, type more".
 *
 * Archived customers are dropped at index time unless their id is in
 * `keepIds`: the customer already on a draft (or on the schedule being edited)
 * stays selectable even after archiving, everyone else archived disappears.
 *
 * A personnummer is only indexed when it is in a plaintext or masked display
 * form (PERSONAL_NUMBER_INPUT_RE). Rows read straight from the table carry
 * ciphertext in that column; indexing it would match random substrings and
 * rendering it would leak nothing useful but look like garbage.
 *
 * Build the index once per list change with buildCustomerIndex, then call
 * searchCustomers per keystroke.
 */

import { foldText } from '@/lib/bookkeeping/account-search'
import {
  PERSONAL_NUMBER_INPUT_RE,
  customerListIdentifier,
  maskCustomerPersonalNumber,
} from '@/lib/customers/mask-personal-number'

/** Minimal shape every picker host can supply; DeadlineForm passes only id + name. */
export interface SearchableCustomer {
  id: string
  name: string
  customer_type?: string | null
  customer_number?: string | null
  org_number?: string | null
  personal_number?: string | null
  email?: string | null
  archived_at?: string | null
}

export interface CustomerIndexEntry<T extends SearchableCustomer> {
  item: T
  /** Folded "name number org personnummer email": the text every token is matched against. */
  haystack: string
  nameFolded: string
  /** Folded words of the name, for "surname starts with" ranking. */
  nameWords: string[]
  numberFolded: string
  /** Digits-only forms of the identifiers (customer number, org number, personnummer). */
  identDigits: string[]
}

export interface CustomerSearchResult<T extends SearchableCustomer> {
  items: T[]
  /** Matches before the cap: greater than items.length means the list was cut. */
  total: number
}

export const CUSTOMER_SEARCH_LIMIT = 50

const nameCollator = new Intl.Collator('sv', { sensitivity: 'base' })

/** The personnummer value the picker may index or render: plaintext or masked, never ciphertext. */
function safePersonalNumber(value: string | null | undefined): string | null {
  if (!value) return null
  return PERSONAL_NUMBER_INPUT_RE.test(value) ? value : null
}

/**
 * Build the searchable index, alphabetical by name (sv collation, so the empty
 * query lists customers the way the register does). Archived rows are dropped
 * unless their id is in `keepIds`.
 */
export function buildCustomerIndex<T extends SearchableCustomer>(
  customers: readonly T[],
  opts: { keepIds?: ReadonlyArray<string | null | undefined> } = {},
): CustomerIndexEntry<T>[] {
  const keep = new Set((opts.keepIds ?? []).filter((id): id is string => Boolean(id)))
  const seen = new Set<string>()
  const entries: CustomerIndexEntry<T>[] = []

  for (const c of customers) {
    if (seen.has(c.id)) continue
    if (c.archived_at && !keep.has(c.id)) continue
    seen.add(c.id)

    const number = c.customer_number?.trim() ?? ''
    const org = c.org_number?.trim() ?? ''
    const personal = safePersonalNumber(c.personal_number)
    const email = c.email?.trim() ?? ''
    const nameFolded = foldText(c.name)

    entries.push({
      item: c,
      haystack: foldText([c.name, number, org, personal ?? '', email].join(' ')),
      nameFolded,
      nameWords: nameFolded.split(/[\s,.-]+/).filter(Boolean),
      numberFolded: foldText(number),
      identDigits: [number, org, personal ?? '']
        .map((v) => v.replace(/\D/g, ''))
        .filter((d) => d.length > 0),
    })
  }

  entries.sort(
    (a, b) => nameCollator.compare(a.item.name, b.item.name) || a.item.id.localeCompare(b.item.id),
  )
  return entries
}

/** A token the user typed as an identifier: digits with optional hyphen/plus, e.g. 556000-0000. */
function identifierDigits(token: string): string | null {
  if (!/^[\d+-]+$/.test(token)) return null
  const digits = token.replace(/\D/g, '')
  return digits.length > 0 ? digits : null
}

function tokenMatches<T extends SearchableCustomer>(entry: CustomerIndexEntry<T>, token: string): boolean {
  if (entry.haystack.includes(token)) return true
  const digits = identifierDigits(token)
  return digits !== null && entry.identDigits.some((d) => d.includes(digits))
}

/**
 * Search the index. Empty query returns the whole (alphabetical) list capped
 * at `limit`; otherwise every token must match, and hits are ranked.
 */
export function searchCustomers<T extends SearchableCustomer>(
  index: CustomerIndexEntry<T>[],
  query: string,
  limit: number = CUSTOMER_SEARCH_LIMIT,
): CustomerSearchResult<T> {
  const tokens = foldText(query.trim()).split(/\s+/).filter(Boolean)

  if (tokens.length === 0) {
    return { items: index.slice(0, limit).map((e) => e.item), total: index.length }
  }

  const hits = index.filter((e) => tokens.every((t) => tokenMatches(e, t)))
  return { items: rank(hits, tokens, limit), total: hits.length }
}

/**
 * Rank: exact customer number, then customer number prefix, then name starts
 * with the first token, then any name word (surname) starts with it, then
 * every token found in the name rather than only in an identifier or email.
 * Ties keep the index's alphabetical order.
 */
function rank<T extends SearchableCustomer>(
  entries: CustomerIndexEntry<T>[],
  tokens: string[],
  limit: number,
): T[] {
  const first = tokens[0] ?? ''
  const scored = entries.map((e, order) => {
    let score = 0
    if (first && e.numberFolded) {
      if (e.numberFolded === first) score += 300
      else if (e.numberFolded.startsWith(first)) score += 200
    }
    if (first && e.nameFolded.startsWith(first)) score += 100
    else if (first && e.nameWords.some((w) => w.startsWith(first))) score += 80
    if (tokens.every((t) => e.nameFolded.includes(t))) score += 50
    return { e, score, order }
  })

  scored.sort((a, b) => b.score - a.score || a.order - b.order)
  return scored.slice(0, limit).map((s) => s.e.item)
}

/**
 * The one-line secondary text a picker row shows under the name so two
 * customers with the same name can be told apart: customer number, the
 * identifier the register would show (org number, or a masked personnummer),
 * and email. Ciphertext in personal_number is never rendered.
 */
export function customerPickerSecondary(c: SearchableCustomer): string {
  // Masked before it reaches the identifier helper: a plaintext personnummer
  // on a business row with no org number would otherwise be shown as-is.
  const identifier = customerListIdentifier({
    customer_type: c.customer_type,
    org_number: c.org_number,
    personal_number: maskCustomerPersonalNumber(safePersonalNumber(c.personal_number)),
  })
  return [c.customer_number?.trim(), identifier, c.email?.trim()]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
}
