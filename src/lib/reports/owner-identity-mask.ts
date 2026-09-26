/**
 * Masks an enskild firma owner's personnummer in report JSON served over the
 * machine doors (v1 JSON and MCP). For an enskild firma the organisation
 * number IS the owner's personnummer (usesPersonnummerAsOrgNumber), and the
 * NE-bilaga, behandlingshistorik and bokslutsbilagor all carry it in their
 * header. An agent transcript is no place for a national identifier
 * (GDPR Art. 5(1)(c)), so the JSON gets the masked form.
 *
 * The files Skatteverket takes (the SRU zip) are built from the unmasked
 * declaration and stay exact: they are the filing itself.
 *
 * Masking is value-based on the ONE known number, not a pattern scan: the
 * company's own identifier is replaced wherever it appears in a string
 * (header field, an audit detail line "Organisationsnummer: X -> Y"), in the
 * spellings a Swedish number takes (with or without the hyphen, with or
 * without the century).
 */

/** Keeps the birth date, replaces the four last digits: 19800101-1234 -> 19800101-XXXX. */
export function maskOwnerPersonnummer(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  let remaining = 4
  const chars = value.split('')
  for (let i = chars.length - 1; i >= 0 && remaining > 0; i--) {
    if (/\d/.test(chars[i])) {
      chars[i] = 'X'
      remaining--
    }
  }
  return chars.join('')
}

/** The spellings of one personnummer that may appear in stored text. */
function spellings(personnummer: string): string[] {
  const digits = personnummer.replace(/\D/g, '')
  const short = digits.length === 12 ? digits.slice(2) : digits
  const forms = new Set<string>([personnummer, digits, short])
  if (short.length === 10) {
    forms.add(`${short.slice(0, 6)}-${short.slice(6)}`)
    forms.add(`${short.slice(0, 6)}+${short.slice(6)}`)
  }
  if (digits.length === 12) forms.add(`${digits.slice(0, 8)}-${digits.slice(8)}`)
  // Longest first, so a 12-digit spelling is replaced before its 10-digit tail.
  return [...forms].filter((f) => f.replace(/\D/g, '').length >= 10).sort((a, b) => b.length - a.length)
}

/**
 * A deep copy of `value` with every occurrence of `personnummer` in any
 * string replaced by its masked form. A null or too-short number (no
 * identifier to protect) returns the value unchanged.
 */
export function redactPersonnummer<T>(value: T, personnummer: string | null | undefined): T {
  if (!personnummer || personnummer.replace(/\D/g, '').length < 10) return value
  const forms = spellings(personnummer)
  const redactString = (s: string): string => {
    let out = s
    for (const form of forms) {
      if (out.includes(form)) out = out.split(form).join(maskOwnerPersonnummer(form) ?? '')
    }
    return out
  }
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return redactString(node)
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, walk(v)]))
    }
    return node
  }
  return walk(value) as T
}
