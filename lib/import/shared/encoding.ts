/**
 * Encoding detection and conversion for Swedish import files.
 *
 * Used by bank file, supplier, customer, and opening-balance parsers.
 * Swedish data exports use either UTF-8 or Windows-1252 (ISO-8859-1).
 * We detect encoding by checking for valid Swedish characters.
 */

/**
 * Decode file content, handling both UTF-8 and Windows-1252 encodings.
 *
 * Strategy: Try UTF-8 first. If the result contains replacement characters
 * (U+FFFD) or garbled Swedish chars, fall back to Windows-1252.
 */
export function decodeFileContent(buffer: ArrayBuffer): string {
  const utf8Decoder = new TextDecoder('utf-8', { fatal: false })
  const utf8Result = utf8Decoder.decode(buffer)

  if (!hasEncodingIssues(utf8Result)) {
    return utf8Result
  }

  const latin1Decoder = new TextDecoder('windows-1252', { fatal: false })
  return latin1Decoder.decode(buffer)
}

/**
 * Re-decode a string that suffered the canonical "UTF-8 bytes read as Latin-1"
 * mojibake (e.g. "MalmÃ¶" → "Malmö", "GÃ–TEBORG" → "GÖTEBORG").
 *
 * Mechanism: each char in the input is a codepoint that was originally a UTF-8
 * byte misinterpreted as a Latin-1/Windows-1252 character. We pack those chars
 * back into a byte sequence and decode the bytes as UTF-8 to recover the
 * original text.
 *
 * No-op when the string is already clean (no garbled patterns).
 */
export function decodeStringContent(content: string): string {
  if (!hasEncodingIssues(content)) {
    return content
  }

  try {
    const bytes = new Uint8Array(content.length)
    for (let i = 0; i < content.length; i++) {
      bytes[i] = content.charCodeAt(i) & 0xff
    }
    const decoder = new TextDecoder('utf-8', { fatal: false })
    return decoder.decode(bytes)
  } catch {
    return content
  }
}

/**
 * Check if a string has encoding issues (garbled Swedish characters).
 */
export function hasEncodingIssues(text: string): boolean {
  if (text.includes('\uFFFD')) return true

  // Common garbled patterns when Windows-1252 is read as UTF-8:
  // Ã¥ = å, Ã¤ = ä, Ã¶ = ö, Ã… = Å, Ã„ = Ä, Ã– = Ö
  const garbledPatterns = ['Ã¥', 'Ã¤', 'Ã¶', 'Ã\u0085', 'Ã\u0084', 'Ã\u0096']
  return garbledPatterns.some((pattern) => text.includes(pattern))
}

/**
 * Normalize line endings to \n
 */
export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * Strip BOM (Byte Order Mark) from start of content
 */
export function stripBOM(content: string): string {
  if (content.charCodeAt(0) === 0xfeff) {
    return content.slice(1)
  }
  return content
}

/**
 * Prepare file content for parsing: strip BOM, normalize line endings, handle encoding
 */
export function prepareContent(content: string): string {
  return normalizeLineEndings(stripBOM(decodeStringContent(content)))
}

/**
 * --- U+FFFD heuristic recovery ---
 *
 * When Windows-1252 / Latin-1 bytes are decoded as UTF-8 with `fatal: false`,
 * invalid sequences silently become U+FFFD. The original byte is lost, but
 * for Swedish text we can guess from context: the missing letter is almost
 * always one of Å/Ä/Ö (uppercase context) or å/ä/ö (lowercase context).
 *
 * This recovery tries each Swedish vowel substitution and scores the resulting
 * word against a small dictionary of Swedish stems. If exactly one candidate
 * scores above the threshold, it's applied. Ambiguous cases return null and
 * must be reviewed manually.
 */

const REPLACEMENT = '\uFFFD'
const SWEDISH_VOWELS_UPPER = ['Å', 'Ä', 'Ö'] as const
const SWEDISH_VOWELS_LOWER = ['å', 'ä', 'ö'] as const

/**
 * Stems of common Swedish words containing åäö that appear in business names,
 * place names, addresses, and accounting descriptions.
 */
const SWEDISH_STEMS = new Set<string>([
  // -för- prefix (extremely common)
  'för', 'före', 'förening', 'företag', 'försäkring', 'försäljning',
  'försäljnings', 'förskola', 'församling', 'förvaltning', 'förbund',
  'förlag', 'föräldra', 'försök', 'förbrukning', 'förbättring', 'förskott',
  'försening', 'förhandling', 'förbättrings',
  // för-* derivatives that often appear in account names
  'förmån', 'förmåner', 'förmedlad', 'förmedlade', 'förmedling', 'förmedlings',
  'förvaltar', 'förmedla',
  // -mark- / marknadsföring
  'marknadsföring', 'marknadsförings', 'marknad',
  // common Swedish words/prefixes
  'bostadsrätt', 'rätt', 'samfällighet', 'idrott', 'fastighet', 'utbildning',
  'näring', 'växel', 'värme', 'köp', 'köpa', 'inköp', 'sälja', 'säljs',
  'tjänst', 'tjänster',
  // accounting terms
  'kostnad', 'kostnader', 'intäkt', 'intäkter', 'avskrivning', 'avsättning',
  'lön', 'löner', 'lönekostnad', 'pension', 'utgående', 'ingående',
  'momspliktig', 'redovisning', 'företagskonto', 'bankkonto',
  'överavskrivning', 'överskott', 'underskott', 'överföring', 'överlåtelse',
  'återbetalning', 'utlägg', 'utgift', 'avdrag',
  // omvänd moms etc.
  'omvänd', 'omvänt', 'omvända',
  // 3+ letter prepositions/adverbs (skip 2-letter ones: too ambiguous)
  'från', 'över', 'när', 'där', 'även', 'någon', 'något', 'många',
  'själv', 'små', 'väg', 'gång', 'räkning', 'räntor', 'är',
  // 'på': short but extremely common; include explicitly
  'på',
  // cities
  'göteborg', 'malmö', 'örebro', 'östersund', 'jönköping', 'linköping',
  'norrköping', 'lidköping', 'köping', 'helsingborg', 'umeå', 'skellefteå',
  'piteå', 'luleå', 'borås', 'växjö', 'östhammar', 'södertälje', 'västerås',
  'härnösand', 'värnamo', 'mölndal', 'mörrum', 'mönsterås', 'färjestaden',
  'eskilstuna',
  // directions / geo
  'östra', 'västra', 'södra', 'norra', 'öster', 'väster', 'söder',
  // legal forms
  'aktiebolag', 'handelsbolag', 'ekonomisk', 'allmännyttig',
  // misc
  'företagsledare', 'koncernbidrag', 'utländsk', 'utländska', 'främmande',
  'vägen', 'gatan', 'allén', 'gränden', 'torget',
  // surnames containing åäö
  'lindström', 'sjöberg', 'söderberg', 'öberg', 'åström', 'åkerlund',
  'östlund', 'lindgren', 'sjögren', 'hägglund', 'bäckström',
])

/**
 * Score a candidate word by *length-weighted* stem matching.
 *
 *  - Exact word match: 1_000_000 (still beats any substring sum).
 *  - Otherwise: sum the lengths of every stem that is a substring of the
 *    candidate. Length-weighting is the critical fix vs. simple counting:
 *    "fårmedlad" hits "år" (2 chars), "förmedlad" hits "för" (3 chars).
 *    Counting would tie them at 1; length-weighting gives 2 vs 3, so the
 *    correct candidate wins.
 */
function scoreCandidate(word: string): number {
  const lower = word.toLowerCase()
  if (SWEDISH_STEMS.has(lower)) return 1_000_000
  let score = 0
  for (const stem of SWEDISH_STEMS) {
    if (lower.includes(stem)) score += stem.length
  }
  return score
}

function chooseCase(word: string): 'upper' | 'lower' {
  let upper = 0
  let lower = 0
  for (const ch of word) {
    if (ch === REPLACEMENT) continue
    if (ch >= 'A' && ch <= 'Z') upper++
    else if (ch >= 'a' && ch <= 'z') lower++
  }
  return upper > lower ? 'upper' : 'lower'
}

/**
 * Try every Swedish-vowel substitution for the U+FFFDs in `word`, then return
 * the highest-scoring candidate. Returns null if no candidate matches a
 * dictionary stem (i.e. ambiguous: operator must review).
 */
export function recoverWordWithFFFD(word: string): string | null {
  if (!word.includes(REPLACEMENT)) return word

  const vowels = chooseCase(word) === 'upper' ? SWEDISH_VOWELS_UPPER : SWEDISH_VOWELS_LOWER
  const positions: number[] = []
  for (let i = 0; i < word.length; i++) {
    if (word[i] === REPLACEMENT) positions.push(i)
  }

  // Words with more than ~6 lost bytes blow up the combinatorial space:   // bail out rather than spend cycles on something that's likely garbage anyway.
  const totalCombos = Math.pow(vowels.length, positions.length)
  if (totalCombos > 729) return null

  let best: { word: string; score: number } | null = null
  for (let combo = 0; combo < totalCombos; combo++) {
    const chars = word.split('')
    let c = combo
    for (const pos of positions) {
      chars[pos] = vowels[c % vowels.length]
      c = Math.floor(c / vowels.length)
    }
    const candidate = chars.join('')
    const score = scoreCandidate(candidate)
    if (!best || score > best.score) {
      best = { word: candidate, score }
    }
  }

  if (!best || best.score === 0) return null
  return best.word
}

/**
 * Repair every U+FFFD-containing word in `text` via dictionary-backed
 * substitution. Returns the repaired string when *every* corrupted word
 * resolved to a confident candidate; returns null if any word remains
 * ambiguous (operator must review the whole string by hand).
 *
 * Idempotent on clean input.
 */
export function recoverStringWithFFFD(text: string): string | null {
  if (!text.includes(REPLACEMENT)) return text

  // Split on runs of non-letter/non-digit characters so punctuation,
  // whitespace, and structural characters are preserved as-is.
  const tokens = text.split(/([^\p{L}\p{N}\uFFFD]+)/u)
  const out: string[] = []
  for (const token of tokens) {
    if (!token.includes(REPLACEMENT)) {
      out.push(token)
      continue
    }
    const recovered = recoverWordWithFFFD(token)
    if (recovered === null) return null
    out.push(recovered)
  }
  return out.join('')
}
