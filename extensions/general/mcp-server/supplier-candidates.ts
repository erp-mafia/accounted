/**
 * Fuzzy supplier-candidate matching for gnubok_create_supplier_invoice_from_inbox.
 *
 * Exact resolution (matched id → org_number → full-name ilike) misses the
 * common OCR variants: punctuation ("Polarn O. Pyret" vs "Polarn o Pyret"),
 * legal-form suffixes ("… AB"), and formatted org numbers ("556677-8899" vs
 * "5566778899"). When resolution fails, the tool surfaces near-miss candidates
 * from these matchers so the agent can retry with supplier_id_override instead
 * of dead-ending — the agent (or the approving human) makes the final call,
 * fuzzy scores never auto-resolve.
 */

export type SupplierRow = {
  id: string
  name: string
  org_number: string | null
}

export type SupplierCandidate = {
  supplier_id: string
  name: string
  org_number: string | null
  score: number
  matched_on: 'org_number' | 'name'
}

// Legal-form suffixes carry no identity signal and OCR/extraction includes
// them inconsistently. Longest-first so 'aktiebolag' is stripped before 'ab'.
const LEGAL_SUFFIXES = [
  'ekonomisk förening',
  'kommanditbolag',
  'handelsbolag',
  'aktiebolag',
  'ek för',
  'filial',
  'ekf',
  'ab',
  'hb',
  'kb',
]

export function normalizeSupplierName(raw: string): string {
  let s = raw
    .toLowerCase()
    // Punctuation → space; keep letters (incl. åäöé), digits, ampersand.
    .replace(/[^a-z0-9åäöéü&]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  for (const suffix of LEGAL_SUFFIXES) {
    if (s.endsWith(` ${suffix}`)) {
      s = s.slice(0, -suffix.length - 1).trim()
      break
    }
  }
  return s
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '')
}

/**
 * Canonical 10-digit key for a Swedish org number. Orgnr is exactly 10
 * significant digits; enskild firma uses the owner's personnummer, which
 * appears in both 10-digit (YYMMDDXXXX) and 12-digit (YYYYMMDDXXXX) forms —
 * the last 10 digits are the same identifier. Anything else is not a Swedish
 * org number and must not fuzzy-match.
 */
export function orgNumberKey(raw: string): string | null {
  const d = digitsOnly(raw)
  if (d.length === 10) return d
  if (d.length === 12) return d.slice(-10)
  return null
}

/**
 * Similarity in [0, 1]. Exact normalized match = 1; containment
 * ("polarn o pyret" ⊂ "polarn o pyret sverige") = 0.9; otherwise token
 * Jaccard scaled to max 0.8 so partial overlaps never outrank containment.
 */
export function scoreSupplierName(a: string, b: string): number {
  const na = normalizeSupplierName(a)
  const nb = normalizeSupplierName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.includes(nb) || nb.includes(na)) return 0.9
  const ta = new Set(na.split(' '))
  const tb = new Set(nb.split(' '))
  let intersection = 0
  for (const t of ta) if (tb.has(t)) intersection++
  const union = new Set([...ta, ...tb]).size
  return union === 0 ? 0 : Math.round((intersection / union) * 0.8 * 100) / 100
}

export function findSupplierCandidates(
  suppliers: SupplierRow[],
  extractedName: string | null,
  extractedOrgNumber: string | null,
  options: { limit?: number; minScore?: number } = {},
): SupplierCandidate[] {
  const limit = options.limit ?? 5
  const minScore = options.minScore ?? 0.4
  const extractedOrgKey = extractedOrgNumber ? orgNumberKey(extractedOrgNumber) : null

  const scored: SupplierCandidate[] = []
  for (const s of suppliers) {
    // Canonical-key equality catches formatting variants ('556677-8899' vs
    // '5566778899') and the 10- vs 12-digit personnummer forms of enskild
    // firma org numbers — none of which the exact .eq() lookup upstream can.
    if (extractedOrgKey && s.org_number && orgNumberKey(s.org_number) === extractedOrgKey) {
      scored.push({
        supplier_id: s.id,
        name: s.name,
        org_number: s.org_number,
        score: 1,
        matched_on: 'org_number',
      })
      continue
    }
    if (extractedName) {
      const score = scoreSupplierName(extractedName, s.name)
      if (score >= minScore) {
        scored.push({
          supplier_id: s.id,
          name: s.name,
          org_number: s.org_number,
          score,
          matched_on: 'name',
        })
      }
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}
