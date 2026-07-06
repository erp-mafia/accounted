import { describe, it, expect } from 'vitest'
import {
  deaccent,
  reverseMojibake,
  reverseCp437Mojibake,
  hasLostByte,
  hasMojibakeSignature,
  hasCp1252Artifact,
  isClean,
  resolveCorrectName,
  REPLACEMENT_CHAR,
} from '../charset-repair'

describe('deaccent', () => {
  it('strips Swedish diacritics, preserving case and other chars', () => {
    expect(deaccent('Utgående moms försäljning inom Sverige, 25%')).toBe(
      'Utgaende moms forsaljning inom Sverige, 25%',
    )
    expect(deaccent('Övriga bankkonton')).toBe('Ovriga bankkonton')
    expect(deaccent('Årets resultat')).toBe('Arets resultat')
    expect(deaccent('Löner')).toBe('Loner')
    expect(deaccent('HEMKÖP LINNÉ')).toBe('HEMKOP LINNE')
  })
  it('is a no-op on already-ASCII names', () => {
    expect(deaccent('Kassa')).toBe('Kassa')
  })
})

describe('reverseMojibake (double-encoding)', () => {
  // Real prod fixtures (chart_of_accounts, project pwxtzglxptnnvjrpixpg).
  it('recovers lowercase å/ä/ö', () => {
    expect(reverseMojibake('FÃ¶retagskonto / checkkonto')).toBe('Företagskonto / checkkonto')
    expect(reverseMojibake('LeverantÃ¶rsskulder')).toBe('Leverantörsskulder')
    expect(reverseMojibake('UtgÃ¥ende moms fÃ¶rsÃ¤ljning inom Sverige, 25%')).toBe(
      'Utgående moms försäljning inom Sverige, 25%',
    )
  })
  it('recovers UPPERCASE Å/Ä/Ö (CP1252 punctuation continuation bytes)', () => {
    expect(reverseMojibake('Ã–vriga bankkonton')).toBe('Övriga bankkonton')
    expect(reverseMojibake('Ã…rets resultat')).toBe('Årets resultat')
  })
  it('recovers custom (non-BAS) names losslessly', () => {
    expect(reverseMojibake('LÃ¥n frÃ¥n nÃ¤rstÃ¥ende personer, lÃ¥ngfristig del')).toBe(
      'Lån från närstående personer, långfristig del',
    )
  })
  it('returns null for already-correct names (no-op safety)', () => {
    expect(reverseMojibake('Företagskonto')).toBeNull() // ö alone isn't valid double-encoding
    expect(reverseMojibake('Kassa')).toBe('Kassa') // pure ASCII round-trips to itself
  })
})

describe('reverseCp437Mojibake (CP437 read as CP1252)', () => {
  // Real prod fixtures: CP437 SIE diacritic bytes rendered as CP1252 specials.
  it('recovers ö/ä/å/Ö from C1 specials', () => {
    expect(reverseCp437Mojibake('F”rmedlad frakt')).toBe('Förmedlad frakt') // ö (0x94→”)
    expect(reverseCp437Mojibake('™vriga fastighetskostnader, ej avdragsgilla')).toBe(
      'Övriga fastighetskostnader, ej avdragsgilla', // Ö (0x99→™)
    )
    expect(reverseCp437Mojibake('V„rdef”r„ndring kapitalf”rs„kring')).toBe(
      'Värdeförändring kapitalförsäkring', // ä (0x84→„), ö (0x94→”)
    )
    expect(reverseCp437Mojibake('p† arvoden')).toBe('på arvoden') // å (0x86→†)
    expect(reverseCp437Mojibake('L”ner till tj„nstem„n (avgiftsbefriade)')).toBe(
      'Löner till tjänstemän (avgiftsbefriade)',
    )
  })
  it('returns null on clean names and on bytes it cannot safely map', () => {
    expect(reverseCp437Mojibake('Kassa')).toBeNull()
    expect(reverseCp437Mojibake('Företagskonto')).toBeNull() // ö (0xF6→÷) not a CP437 letter byte
  })
})

describe('resolveCorrectName: CP437 branch', () => {
  it('reverses a CP437-as-CP1252 name without a sibling', () => {
    expect(resolveCorrectName('™vriga fastighetskostnader', [])).toEqual({
      corrected: 'Övriga fastighetskostnader',
      method: 'reverse_cp437',
    })
  })
})

describe('signature detectors', () => {
  it('detects lost-byte and mojibake', () => {
    expect(hasLostByte('Ackumulerade nedskrivningar p' + REPLACEMENT_CHAR + ' bilar')).toBe(true)
    expect(hasLostByte('Kassa')).toBe(false)
    expect(hasMojibakeSignature('FÃ¶retagskonto')).toBe(true)
    expect(hasMojibakeSignature('Företagskonto')).toBe(false)
  })
})

describe('resolveCorrectName', () => {
  it('restores a stripped name from a de-accent-equal diacritic-bearing sibling', () => {
    const r = resolveCorrectName('Utgaende moms forsaljning inom Sverige, 25%', [
      'Utgående moms försäljning inom Sverige, 25%', // seed wording (clean sibling)
      'Utgående moms på försäljning inom Sverige, 25 %', // BAS wording (different, won't match)
    ])
    expect(r).toEqual({
      corrected: 'Utgående moms försäljning inom Sverige, 25%',
      method: 'sibling_stripped',
    })
  })

  it('restores a lost-byte name by wildcard-matching one sibling', () => {
    const r = resolveCorrectName(`Ackumulerade nedskrivningar p${REPLACEMENT_CHAR} bilar`, [
      'Ackumulerade nedskrivningar på bilar',
      'Ackumulerade avskrivningar på bilar', // same length but different word: must NOT match
    ])
    expect(r).toEqual({
      corrected: 'Ackumulerade nedskrivningar på bilar',
      method: 'sibling_lostbyte',
    })
  })

  it('reverses a double-encoded name without needing a sibling', () => {
    const r = resolveCorrectName('Ã…rets resultat', [])
    expect(r).toEqual({ corrected: 'Årets resultat', method: 'reverse' })
  })

  it('leaves a clean name untouched (returns null)', () => {
    expect(resolveCorrectName('Företagskonto', ['Företagskonto'])).toBeNull()
    expect(resolveCorrectName('Kassa', [])).toBeNull()
  })

  it('refuses to guess when a stripped name has no diacritic-bearing sibling', () => {
    // Only stripped / identical siblings → no confident canonical → skip.
    expect(resolveCorrectName('Forsaljning webshop', ['Forsaljning webshop'])).toBeNull()
  })

  it('refuses to guess a lost-byte name when two distinct siblings match', () => {
    const r = resolveCorrectName(`Utg${REPLACEMENT_CHAR}ende`, ['Utgående', 'Utgaende'])
    // 'Utgaende' (no diacritic) also matches the wildcard → ambiguous → null.
    expect(r).toBeNull()
  })

  it('ignores corrupt candidates when choosing a canonical', () => {
    const r = resolveCorrectName('Leverantorsskulder', [
      'LeverantÃ¶rsskulder', // mojibake candidate: ignored
      'Leverantörsskulder', // the clean one
    ])
    expect(r?.corrected).toBe('Leverantörsskulder')
  })

  it('NEVER strips a correct name down to a de-accented sibling (directional guard)', () => {
    // The dry-run bug: a correct "Försäljning varor 25%" must not be rewritten to
    // a partial-stripped "Försaljning varor 25%" sibling. The input carries
    // diacritics, so the stripped branch must not fire.
    expect(
      resolveCorrectName('Försäljning varor 25%', ['Försaljning varor 25%']),
    ).toBeNull()
    expect(resolveCorrectName('Ränteintäkter', ['Ränteintakter'])).toBeNull()
  })

  it('does not pick a CP437-as-CP1252 sibling for a lost-byte name', () => {
    // The dry-run bug: "F�rmedlad frakt" wildcard-matched "F”rmedlad frakt"
    // (itself a different mojibake). Only the genuinely clean sibling wins.
    const r = resolveCorrectName(`F${REPLACEMENT_CHAR}rmedlad frakt`, [
      'F”rmedlad frakt', // CP1252 artifact: not clean, must be ignored
      'Förmedlad frakt', // the clean one
    ])
    expect(r).toEqual({ corrected: 'Förmedlad frakt', method: 'sibling_lostbyte' })
  })

  it('classifies CP1252 artifacts as not clean', () => {
    expect(hasCp1252Artifact('F”rmedlad frakt')).toBe(true)
    expect(hasCp1252Artifact('™vriga fastighetskostnader')).toBe(true) // Ö→™ at word start
    expect(hasCp1252Artifact('Förmedlad frakt')).toBe(false)
    expect(isClean('Förmedlad frakt')).toBe(true)
    expect(isClean('F”rmedlad frakt')).toBe(false)
    expect(isClean(`F${REPLACEMENT_CHAR}rmedlad`)).toBe(false)
    expect(isClean('FÃ¶retagskonto')).toBe(false)
  })

  it('does NOT flag a legitimate space-padded en-dash as corrupt', () => {
    // Real BAS names: "Kundfordringar – delad faktura" (1513), "Periodiseringsfond
    // 2021 – nr 2". The en-dash is space-padded punctuation, not a mangled letter.
    expect(hasCp1252Artifact('Kundfordringar – delad faktura')).toBe(false)
    expect(hasCp1252Artifact('Periodiseringsfond 2021 – nr 2')).toBe(false)
    expect(isClean('Kundfordringar – delad faktura')).toBe(true)
    // …so it can serve as the repair target for its lost-byte sibling (the
    // en-dash byte 0x96 itself becomes U+FFFD when a CP1252 file is read as UTF-8).
    expect(
      resolveCorrectName(`Kundfordringar ${REPLACEMENT_CHAR} delad faktura`, [
        'Kundfordringar – delad faktura',
      ]),
    ).toEqual({ corrected: 'Kundfordringar – delad faktura', method: 'sibling_lostbyte' })
  })
})
