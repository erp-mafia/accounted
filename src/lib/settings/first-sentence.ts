/**
 * Splits a help string into its first sentence and whatever follows.
 *
 * Kopplingar shows the first sentence of a connection's help under its name
 * and keeps only the remainder behind the "?" (design conventions 7 and 15,
 * the one named exception). A string that is a single sentence comes back
 * whole with `rest: null`: nothing is left for a popover, so the row draws
 * no "?".
 *
 * A sentence ends at ".", "!" or "?" followed by whitespace and something
 * that is not a lowercase letter. An abbreviation never ends one: "t.ex.",
 * "bl.a." and "e.g." (a period inside the word), a single letter ("t. ex."),
 * and the short forms below. When in doubt the text is NOT split: showing a
 * little more under the name is better than cutting a sentence in half.
 */
export interface FirstSentence {
  first: string
  /** The text after the first sentence; null when there is none. */
  rest: string | null
}

// Written without their final period, lowercase.
const ABBREVIATIONS = new Set([
  // Swedish
  'ca', 'ex', 'dvs', 'osv', 'etc', 'inkl', 'exkl', 'resp', 'nr', 'tel', 'mfl', 'pga', 'tex', 'bla', 'ev', 'fr', 'jfr',
  // English
  'eg', 'ie', 'vs', 'incl', 'excl', 'approx',
])

function endsWithAbbreviation(textUpToTerminator: string): boolean {
  // The word the terminator closes: the run of non-whitespace before it.
  const word = (textUpToTerminator.match(/\S+$/)?.[0] ?? '').replace(/^[("'“”]+/, '')
  if (word.length === 0) return true
  // "t.ex", "bl.a", "e.g", "m.m": a period inside the word.
  if (word.includes('.')) return true
  // "t" in "t. ex.", an initial.
  if (/^\p{L}$/u.test(word)) return true
  return ABBREVIATIONS.has(word.toLowerCase())
}

export function firstSentence(text: string): FirstSentence {
  const trimmed = text.trim()
  const terminator = /[.!?]+(?=\s)/g
  let match: RegExpExecArray | null
  while ((match = terminator.exec(trimmed)) !== null) {
    const end = match.index + match[0].length
    const rest = trimmed.slice(end).trim()
    if (rest.length === 0) break
    // A lowercase letter next means the sentence goes on ("ca. fem dagar").
    if (/^\p{Ll}/u.test(rest)) continue
    if (match[0].startsWith('.') && endsWithAbbreviation(trimmed.slice(0, match.index))) continue
    return { first: trimmed.slice(0, end), rest }
  }
  return { first: trimmed, rest: null }
}
