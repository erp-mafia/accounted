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

const PREFIXES = /^(mcp_accounted_|mcp_gnubok_|gnubok_|accounted_|mcp_)/

// Read verbs carry no subject; a guess's verb only says "it wanted to read".
const READ_VERBS = new Set(['get', 'list', 'fetch', 'show', 'read', 'find', 'search', 'query', 'lookup'])

// Words that appear in many names and would drown the subject.
const NOISE = new Set(['by', 'for', 'the', 'all', 'info', 'details', 'data'])

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
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

  return candidates
    .map((tool, idx) => {
      const nameWords = words(tool.name)
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
      if (guessVerb && tool.annotations?.readOnlyHint === true) score += 12
      if (hits === subject.length) score += 5
      return { tool, score, idx }
    })
    .filter((x): x is { tool: T; score: number; idx: number } => x !== null && x.score >= 6)
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .slice(0, limit)
    .map((x) => x.tool)
}
