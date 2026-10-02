/**
 * "Did you mean" for an unknown tool name.
 *
 * Agents guess names by analogy with other APIs: gnubok_get_journal_entry,
 * gnubok_list_bank_accounts, gnubok_get_customer, gnubok_list_salary_runs
 * (prod telemetry, 30 days to 2026-09-23: 82 unknown_tool calls from 22
 * companies). The answer used to be the whole catalog as one comma list, about
 * 190 names with the useful ones nowhere near the top. Ranking the catalog by
 * the words in the guess puts the real tool first, so the next call is a pick,
 * not another guess.
 */

// Every namespace token in front, however many a client stacked
// (mcp__accounted__accounted_list_skills), so the first word left is the verb.
const PREFIXES = /^(?:(?:mcp|accounted|gnubok)_+)+/

// Read verbs carry no subject; a guess's verb only says "it wanted to read".
const READ_VERBS = new Set(['get', 'list', 'fetch', 'show', 'read', 'find', 'search', 'query', 'lookup'])

// Words that appear in many names and would drown the subject.
const NOISE = new Set(['by', 'for', 'the', 'all', 'info', 'details', 'data'])

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/** One word is the other or begins it: "document" and "documentation". */
function related(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a)
}

function words(name: string): string[] {
  return name
    .toLowerCase()
    .replace(PREFIXES, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular)
}

export interface SuggestableTool {
  name: string
  description: string
  keywords?: readonly string[]
  annotations?: { readOnlyHint?: boolean }
}

/**
 * Up to `limit` catalog tools that share the most subject words with the
 * requested name. A tool must share at least one subject word; a guess made
 * only of verbs ("gnubok_get") suggests nothing rather than something random.
 */
export function suggestToolNames<T extends SuggestableTool>(
  requested: string,
  candidates: readonly T[],
  limit = 3,
): T[] {
  const guess = words(requested)
  const guessVerb = guess.find((w) => READ_VERBS.has(w))
  const subject = guess.filter((w) => !READ_VERBS.has(w) && !NOISE.has(w))
  if (subject.length === 0) return []
  // For ties only: the verb a guess starts with (tool names are verb first)
  // and the words after it; a one-word guess is all subject.
  const leadingVerb = guess[0]
  const guessRest = (guess.length > 1 ? guess.slice(1) : guess).filter((w) => !READ_VERBS.has(w) && !NOISE.has(w))

  return candidates
    .map((tool, idx) => {
      const nameWords = words(tool.name)
      const read = tool.annotations?.readOnlyHint === true
      const keywordText = (tool.keywords ?? []).join(' ').toLowerCase()
      const descriptionWords = new Set(words(tool.description))
      let hits = 0
      let score = 0
      for (const word of subject) {
        if (nameWords.includes(word)) {
          score += 10
          hits += 1
        } else if (nameWords.some((n) => n.startsWith(word) || word.startsWith(n))) {
          score += 6
          hits += 1
        } else if (keywordText.includes(word)) {
          score += 4
          hits += 1
        } else if (descriptionWords.has(word)) {
          score += 1
          hits += 1
        }
      }
      if (hits === 0) return null
      // A read guess should land on a read (get_journal_entry means
      // query_journal, not reverse_journal_entry), and one naming every
      // subject word beats one naming half of them.
      if (guessVerb && read) score += 12
      if (hits === subject.length) score += 5
      // Words after the verb that only one of the two names has.
      const nameRest = nameWords.slice(1)
      const distance =
        nameRest.filter((n) => !guessRest.some((w) => related(n, w))).length +
        guessRest.filter((w) => !nameRest.some((n) => related(n, w))).length
      return { tool, score, idx, read, distance, sameVerb: nameWords[0] === leadingVerb }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null && x.score >= 6)
    // Equal scores used to fall to registry order, which put get_salary_run
    // ahead of list_salary_runs for a list_ guess and two skattekonto writes
    // ahead of the read. A tie now goes, for a read guess, to a read over a
    // write, then to the closer name (get_supplier keeps list_suppliers
    // ahead of get_supplier_payment_batch, delete_cash_account keeps
    // list_cash_accounts ahead of delete_account), then to the guess's verb.
    .sort(
      (a, b) =>
        b.score - a.score ||
        (guessVerb ? Number(b.read) - Number(a.read) : 0) ||
        a.distance - b.distance ||
        Number(b.sameVerb) - Number(a.sameVerb) ||
        a.idx - b.idx,
    )
    .slice(0, limit)
    .map((x) => x.tool)
}
