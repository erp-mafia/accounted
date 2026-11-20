/**
 * Free text in a pain.001 file (names, towns, the giro message), restricted
 * to the bank MIG character set. Shared by the supplier and salary
 * generators so a name reads the same in every file.
 *
 * MIG character-set restriction (Validex PFH_pain_001_001_03_214): Swedish
 * letters pass through, other accented Latin letters transliterate to their
 * base letter, and anything still outside the allowed set becomes '?', the
 * same substitution the Bankgirot LB generator uses. Sanitize BEFORE
 * escapeXml so entity-encoded characters are never mangled.
 */

const TRANSLITERATIONS: Record<string, string> = {
  'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e', 'É': 'E', 'È': 'E', 'Ê': 'E', 'Ë': 'E',
  'á': 'a', 'à': 'a', 'â': 'a', 'ã': 'a', 'Á': 'A', 'À': 'A', 'Â': 'A', 'Ã': 'A',
  'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i', 'Í': 'I', 'Ì': 'I', 'Î': 'I', 'Ï': 'I',
  'ó': 'o', 'ò': 'o', 'ô': 'o', 'õ': 'o', 'Ó': 'O', 'Ò': 'O', 'Ô': 'O', 'Õ': 'O',
  'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u', 'Ú': 'U', 'Ù': 'U', 'Û': 'U', 'Ü': 'U',
  'ý': 'y', 'ÿ': 'y', 'Ý': 'Y', 'ñ': 'n', 'Ñ': 'N', 'ç': 'c', 'Ç': 'C',
  'ø': 'o', 'Ø': 'O', 'æ': 'a', 'Æ': 'A', 'ß': 'ss',
  'š': 's', 'Š': 'S', 'ž': 'z', 'Ž': 'Z', 'đ': 'd', 'Đ': 'D',
  // '+' is in the allowed set and reads naturally where Swedish names use '&'.
  '&': '+',
}

const DISALLOWED_TEXT = /[^0-9A-Za-zåäöÅÄÖ/\-?:().,'+ ]/g

export interface MigTextOptions {
  /**
   * false drops apostrophes. Swedbank MIG 2.0 lists the Latin set as
   * a-z, A-Z, 0-9 and / - ? : ( ) . , + space, without the apostrophe its
   * MIG 1.0 allowed, so "Kalle's Bygg" is written "Kalles Bygg" there.
   */
  apostrophe?: boolean
}

export function sanitizeMigText(value: string, options: MigTextOptions = {}): string {
  // NFC first: decomposed input (base letter + combining mark, common in text
  // pasted from PDFs) must fold to the precomposed forms the map knows.
  let transliterated = ''
  for (const ch of value.normalize('NFC')) transliterated += TRANSLITERATIONS[ch] ?? ch
  const sanitized = transliterated.replace(DISALLOWED_TEXT, '?')
  return options.apostrophe === false ? sanitized.replace(/'/g, '') : sanitized
}
