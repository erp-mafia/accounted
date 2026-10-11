import { describe, it, expect } from 'vitest'
import {
  reverseMojibake,
  hasMojibakeSignature,
  hasCp1252Artifact,
} from '../charset-repair'

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

describe('signature detectors', () => {
  it('detects the double-encoded signature', () => {
    expect(hasMojibakeSignature('FÃ¶retagskonto')).toBe(true)
    expect(hasMojibakeSignature('Företagskonto')).toBe(false)
  })

  it('detects a letter-adjacent CP1252 artifact', () => {
    expect(hasCp1252Artifact('F”rmedlad frakt')).toBe(true)
    expect(hasCp1252Artifact('™vriga fastighetskostnader')).toBe(true) // Ö→™ at word start
    expect(hasCp1252Artifact('Förmedlad frakt')).toBe(false)
  })

  it('does not flag legitimate space-padded typography (false-positive guard)', () => {
    // A curly quote, ellipsis or en-dash that is NOT letter-adjacent is
    // punctuation, not a mangled diacritic. Real BAS names carry the en-dash:
    // "Kundfordringar – delad faktura" (1513), "Periodiseringsfond 2021 – nr 2".
    expect(hasCp1252Artifact('Betalning enligt avtal ” 2024')).toBe(false)
    expect(hasCp1252Artifact('Avvaktar underlag …')).toBe(false)
    expect(hasCp1252Artifact('Kundfordringar – delad faktura')).toBe(false)
    expect(hasCp1252Artifact('Periodiseringsfond 2021 – nr 2')).toBe(false)
  })
})
