/**
 * Account search for the manual bookkeeping flow (AccountCombobox).
 *
 * Two problems this solves over a plain `account_name.includes(query)`:
 *
 *  1. Coverage: the combobox is fed two sources: the company's *active* chart
 *     and (optionally) the full BAS 2026 catalog. A user who types "IT" should
 *     find 6540 "IT-tjänster" even if it was never added to their chart yet.
 *     Active accounts always rank first; selecting a catalog-only account is
 *     handled by the existing activate-on-commit rail.
 *
 *  2. Matching: names are terse and statutory, so the everyday word the user
 *     reaches for is often in the description, mid-name, or typed without
 *     diacritics. We fold diacritics (so "lon" matches "Lön"), search
 *     number + name + description, and require every token to match (so word
 *     order and the hyphen in "IT-tjänster" stop mattering).
 *
 * Build the index once per (active, catalog) pair with buildAccountIndex, then
 * call searchAccounts per keystroke: the per-keystroke work is just substring
 * checks over pre-folded haystacks.
 */

/** Minimal shape both an active BASAccount and a catalog row satisfy. */
export interface SearchableAccount {
  account_number: string
  account_name: string
  account_class: number
  description?: string | null
}

/** A single result row the combobox renders. */
export interface AccountSearchItem {
  account_number: string
  account_name: string
  account_class: number
  /** true = already in the company's chart; false = catalog-only (activates on commit). */
  isActive: boolean
}

export interface AccountIndexEntry {
  item: AccountSearchItem
  /** Folded "number name description": the text every token is matched against. */
  haystack: string
  /** Folded name only: used for "starts with" / name-hit ranking. */
  nameFolded: string
}

const DEFAULT_LIMIT = 50

/**
 * Lowercase + strip diacritics so a query typed without Swedish characters
 * still matches: "lon" → "lön", "intakter" → "intäkter", "ranta" → "ränta".
 */
export function foldText(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

/**
 * Build the searchable index. Active accounts are added first so that, on a
 * duplicate account number, the active row wins and catalog duplicates are
 * dropped.
 */
export function buildAccountIndex(opts: {
  active: SearchableAccount[]
  catalog?: SearchableAccount[]
}): AccountIndexEntry[] {
  const seen = new Set<string>()
  const entries: AccountIndexEntry[] = []

  const add = (acc: SearchableAccount, isActive: boolean) => {
    if (seen.has(acc.account_number)) return
    seen.add(acc.account_number)
    const description = acc.description ?? ''
    entries.push({
      item: {
        account_number: acc.account_number,
        account_name: acc.account_name,
        account_class: acc.account_class,
        isActive,
      },
      haystack: foldText(`${acc.account_number} ${acc.account_name} ${description}`),
      nameFolded: foldText(acc.account_name),
    })
  }

  for (const a of opts.active) add(a, true)
  for (const c of opts.catalog ?? []) add(c, false)
  return entries
}

/**
 * Search the index. Returns ranked items (active first), capped at `limit`.
 *
 *  - Empty query → the active chart (what the dropdown shows when first opened).
 *  - All-digit query → prefix match on the account number, spanning the catalog
 *    so "65" browses every 65xx account, not just the active ones.
 *  - Otherwise → token-AND substring match over number + name + description.
 */
export function searchAccounts(
  index: AccountIndexEntry[],
  query: string,
  limit: number = DEFAULT_LIMIT,
): AccountSearchItem[] {
  const trimmed = query.trim()

  if (!trimmed) {
    const out: AccountSearchItem[] = []
    for (const e of index) {
      if (!e.item.isActive) continue
      out.push(e.item)
      if (out.length >= limit) break
    }
    return out
  }

  if (/^\d+$/.test(trimmed)) {
    const hits = index.filter((e) => e.item.account_number.startsWith(trimmed))
    return rank(hits, [trimmed], limit)
  }

  const tokens = foldText(trimmed).split(/[\s-]+/).filter(Boolean)
  if (tokens.length === 0) return []
  const hits = index.filter((e) => tokens.every((t) => e.haystack.includes(t)))
  return rank(hits, tokens, limit)
}

/**
 * Rank: active before catalog → name starts with the first token → all tokens
 * present in the name (vs only reachable via the description) → account number.
 */
function rank(entries: AccountIndexEntry[], tokens: string[], limit: number): AccountSearchItem[] {
  const firstToken = tokens[0] ?? ''
  const scored = entries.map((e) => {
    let score = 0
    if (e.item.isActive) score += 1000
    if (firstToken && e.nameFolded.startsWith(firstToken)) score += 100
    if (tokens.every((t) => e.nameFolded.includes(t))) score += 50
    return { e, score }
  })

  scored.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : a.e.item.account_number.localeCompare(b.e.item.account_number),
  )

  return scored.slice(0, limit).map((s) => s.e.item)
}
