/**
 * Charset signatures of names that went through a wrong decode. Pure
 * functions only (no DB).
 *
 *  - double_encoded: UTF-8 bytes were decoded as Windows-1252 and re-encoded
 *    as UTF-8: "FÃ¶retagskonto", "Ã–vriga bankkonton", "Ã…rets resultat".
 *    LOSSLESS to reverse (reverseMojibake); the party resolver's preclean
 *    repairs counterparty names this way.
 *  - CP1252 artifact: a CP437/Latin-1 diacritic byte rendered as a Windows-1252
 *    C1 special ("F”rmedlad"). hasCp1252Artifact detects it; the SIE artifact
 *    scan counts such names in an uploaded file.
 */

/**
 * Windows-1252 code point → byte for the 0x80-0x9F block, where CP1252 diverges
 * from Latin-1 (e.g. 0x96 = U+2013 "–", 0x85 = U+2026 "…"). Reversing
 * double-encoding requires mapping these back to their original byte; the å/ä/ö
 * continuation bytes for UPPERCASE Å/Ä/Ö (0x85/0x84/0x96) land in this block.
 */
const CP1252_TO_BYTE: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
}

/** True if the name carries the double-encoded signature (Â/Ã lead byte). */
export function hasMojibakeSignature(s: string): boolean {
  return /[ÂÃ]/.test(s)
}

/**
 * True if the name contains a Windows-1252 C1 "special" character used IN PLACE
 * OF A LETTER - i.e. a CP437/Latin-1 diacritic byte mis-decoded as CP1252
 * (CP437 ö 0x94 → "”", ä 0x84 → "„", Ö 0x99 → "™"). Swedish diacritics always
 * sit mid-word, so the tell is letter-adjacency: "F”rmedlad" (corrupt) vs
 * "Periodiseringsfond 2021 – nr 2" (a legitimate space-padded en-dash, NOT
 * corrupt). Such a name must never be a repair target for another row.
 */
export function hasCp1252Artifact(s: string): boolean {
  const chars = [...s]
  const isLetter = (c: string | undefined): boolean => !!c && /\p{L}/u.test(c)
  for (let i = 0; i < chars.length; i++) {
    if (!(chars[i].codePointAt(0)! in CP1252_TO_BYTE)) continue
    if (isLetter(chars[i - 1]) || isLetter(chars[i + 1])) return true
  }
  return false
}

/**
 * Reverse a double-encoded (UTF-8-bytes-read-as-CP1252-then-re-UTF-8) string.
 * Returns the recovered string, or null when the input can't be a clean
 * double-encoding (a char outside CP1252, or bytes that aren't valid UTF-8):
 * which also makes it a no-op on already-correct names.
 */
export function reverseMojibake(s: string): string | null {
  const bytes: number[] = []
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp <= 0xff) {
      bytes.push(cp)
    } else if (cp in CP1252_TO_BYTE) {
      bytes.push(CP1252_TO_BYTE[cp])
    } else {
      return null
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes))
  } catch {
    return null
  }
}
