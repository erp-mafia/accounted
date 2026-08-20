// Bounds for the candidate scan below. Real model output is already capped by
// the caller's max_tokens (roughly 33 KB of text at 8192 tokens), so genuine
// responses never come near these; they exist so pathological or adversarially
// brace-laden text cannot make the scan quadratic (compliance review A.8.28).
// Oversized or exhausted inputs fall through to the raw text and land in the
// caller's existing parse-failure path.
const MAX_SCAN_INPUT_LENGTH = 256 * 1024
const MAX_CANDIDATE_ATTEMPTS = 50

/**
 * Models intermittently wrap a JSON answer in markdown fences (```json ... ```)
 * or add prose around it despite a JSON-only instruction. Scan for balanced
 * top-level '{'..'}' candidates (string- and escape-aware, so braces inside
 * JSON string values don't end a candidate early) and return the first one
 * JSON.parse accepts; prose braces around the object form unparseable
 * candidates and are skipped. Returns the input unchanged when no candidate
 * parses, so the caller's parse-failure path handles prose-only refusals.
 * Schema validation downstream still rejects well-formed-but-wrong JSON.
 */
export function extractJsonObject(raw: string): string {
  if (raw.length > MAX_SCAN_INPUT_LENGTH) return raw
  let attempts = 0
  let start = raw.indexOf('{')
  while (start !== -1 && attempts < MAX_CANDIDATE_ATTEMPTS) {
    attempts++
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
      } else if (ch === '"') {
        inString = true
      } else if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0) {
          const candidate = raw.slice(start, i + 1)
          try {
            JSON.parse(candidate)
            return candidate
          } catch {
            break
          }
        }
      }
    }
    start = raw.indexOf('{', start + 1)
  }
  return raw
}
