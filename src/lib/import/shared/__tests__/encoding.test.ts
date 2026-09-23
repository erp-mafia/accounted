import { describe, it, expect } from 'vitest'
import {
  decodeFileContent,
  decodeStringContent,
  hasEncodingIssues,
  recoverStringWithFFFD,
  recoverWordWithFFFD,
  stripBOM,
} from '../encoding'

describe('decodeStringContent', () => {
  it('recovers UTF-8-as-Latin-1 mojibake for lowercase Swedish chars', () => {
    expect(decodeStringContent('MalmÃ¶')).toBe('Malmö')
    expect(decodeStringContent('Ã¥re')).toBe('Åre'.toLowerCase())
    expect(decodeStringContent('LinkÃ¶ping')).toBe('Linköping')
  })

  it('recovers UTF-8-as-Latin-1 mojibake for uppercase Swedish chars', () => {
    // The middle char is U+0096 (control), invisible in most renderings → "GÃTEBORG"
    expect(decodeStringContent('GÃ\u0096TEBORG')).toBe('GÖTEBORG')
    expect(decodeStringContent('HISINGS KÃ\u0084RRA')).toBe('HISINGS KÄRRA')
    expect(decodeStringContent('Ã\u0085NGE')).toBe('ÅNGE')
  })

  it('is a no-op on already-correct Swedish strings', () => {
    expect(decodeStringContent('GÖTEBORG')).toBe('GÖTEBORG')
    expect(decodeStringContent('Malmö')).toBe('Malmö')
    expect(decodeStringContent('STOCKHOLM')).toBe('STOCKHOLM')
    expect(decodeStringContent('')).toBe('')
  })

  it('is idempotent (running twice equals running once)', () => {
    const once = decodeStringContent('MalmÃ¶')
    const twice = decodeStringContent(once)
    expect(twice).toBe(once)
    expect(twice).toBe('Malmö')
  })

  it('preserves non-Swedish strings unchanged', () => {
    expect(decodeStringContent('Café')).toBe('Café')
    expect(decodeStringContent('München')).toBe('München')
    expect(decodeStringContent('123 Main St')).toBe('123 Main St')
  })
})

describe('hasEncodingIssues', () => {
  it('detects U+FFFD replacement characters', () => {
    expect(hasEncodingIssues('Foo\uFFFDbar')).toBe(true)
  })

  it('detects all six Swedish mojibake patterns', () => {
    expect(hasEncodingIssues('MalmÃ¶')).toBe(true) // ö
    expect(hasEncodingIssues('Ã¥re')).toBe(true) // å
    expect(hasEncodingIssues('Ã¤lg')).toBe(true) // ä
    expect(hasEncodingIssues('GÃ\u0096TEBORG')).toBe(true) // Ö
    expect(hasEncodingIssues('Ã\u0085NGE')).toBe(true) // Å
    expect(hasEncodingIssues('Ã\u0084RRA')).toBe(true) // Ä
  })

  it('returns false for clean strings', () => {
    expect(hasEncodingIssues('Stockholm')).toBe(false)
    expect(hasEncodingIssues('Malmö')).toBe(false)
    expect(hasEncodingIssues('Café')).toBe(false)
  })
})

describe('decodeFileContent', () => {
  function buf(bytes: number[]): ArrayBuffer {
    return new Uint8Array(bytes).buffer
  }

  it('decodes UTF-8 bytes correctly', () => {
    const utf8 = new TextEncoder().encode('GÖTEBORG').buffer
    expect(decodeFileContent(utf8)).toBe('GÖTEBORG')
  })

  it('falls back to Windows-1252 when UTF-8 decode is invalid', () => {
    // 0xD6 = Ö in Windows-1252; lone 0xD6 is not valid UTF-8 start byte
    const cp1252 = buf([0x47, 0xd6, 0x54, 0x45, 0x42, 0x4f, 0x52, 0x47])
    expect(decodeFileContent(cp1252)).toBe('GÖTEBORG')
  })

  it('strips a UTF-8 BOM (EF BB BF) and decodes the remainder as UTF-8', () => {
    const payload = Array.from(new TextEncoder().encode('Bokföringsdag;Belopp'))
    const text = decodeFileContent(buf([0xef, 0xbb, 0xbf, ...payload]))
    expect(text).toBe('Bokföringsdag;Belopp')
    expect(text.charCodeAt(0)).not.toBe(0xfeff)
  })

  it('never produces a mojibake BOM prefix when a BOM-ed file needs the Windows-1252 fallback', () => {
    // 'Datum;' + 0xD6 (Ö in Windows-1252, invalid as a lone UTF-8 byte),
    // behind a UTF-8 BOM. The BOM bytes must never re-enter the fallback
    // decode, so the result starts with 'Datum', not the literal mojibake.
    const bytes = buf([0xef, 0xbb, 0xbf, 0x44, 0x61, 0x74, 0x75, 0x6d, 0x3b, 0xd6])
    const text = decodeFileContent(bytes)
    expect(text.startsWith('ï»¿')).toBe(false)
    expect(text).toBe('Datum;Ö')
  })

  it('decodes UTF-16LE content behind a FF FE BOM', () => {
    // 'Öre' in UTF-16LE: d6 00, 72 00, 65 00
    const bytes = buf([0xff, 0xfe, 0xd6, 0x00, 0x72, 0x00, 0x65, 0x00])
    expect(decodeFileContent(bytes)).toBe('Öre')
  })

  it('decodes UTF-16BE content behind a FE FF BOM', () => {
    const bytes = buf([0xfe, 0xff, 0x00, 0xd6, 0x00, 0x72, 0x00, 0x65])
    expect(decodeFileContent(bytes)).toBe('Öre')
  })
})

describe('stripBOM', () => {
  it('strips a leading U+FEFF', () => {
    expect(stripBOM('\uFEFF' + 'Datum;Belopp')).toBe('Datum;Belopp')
  })

  it('strips a leading literal mojibake BOM (ï»¿)', () => {
    expect(stripBOM('ï»¿Datum;Belopp')).toBe('Datum;Belopp')
  })

  it('is a no-op on clean content and never strips mid-string', () => {
    expect(stripBOM('Datum;Belopp')).toBe('Datum;Belopp')
    expect(stripBOM('Datum;ï»¿Belopp')).toBe('Datum;ï»¿Belopp')
  })
})

// --- U+FFFD heuristic recovery ---

describe('recoverWordWithFFFD', () => {
  it('recovers uppercase Ö in common Swedish stems', () => {
    expect(recoverWordWithFFFD('F\uFFFDRENING')).toBe('FÖRENING')
    expect(recoverWordWithFFFD('F\uFFFDRETAG')).toBe('FÖRETAG')
    expect(recoverWordWithFFFD('G\uFFFDTEBORG')).toBe('GÖTEBORG')
    expect(recoverWordWithFFFD('LINK\uFFFDPING')).toBe('LINKÖPING')
  })

  it('recovers lowercase ö in common Swedish stems', () => {
    expect(recoverWordWithFFFD('f\uFFFDrening')).toBe('förening')
    expect(recoverWordWithFFFD('malm\uFFFD')).toBe('malmö')
    expect(recoverWordWithFFFD('k\uFFFDp')).toBe('köp')
  })

  it('recovers compound words via substring match', () => {
    expect(recoverWordWithFFFD('BOSTADSR\uFFFDTTSF\uFFFDRENING')).toBe(
      'BOSTADSRÄTTSFÖRENING'
    )
    expect(recoverWordWithFFFD('Idrottsf\uFFFDrening')).toBe('Idrottsförening')
  })

  it('is a no-op when the input has no U+FFFD', () => {
    expect(recoverWordWithFFFD('FÖRENING')).toBe('FÖRENING')
    expect(recoverWordWithFFFD('hello')).toBe('hello')
  })

  it('returns null for ambiguous words not in the dictionary', () => {
    // Random 4-letter word with U+FFFD; no Swedish stem hits.
    expect(recoverWordWithFFFD('Z\uFFFDXQ')).toBeNull()
  })

  it('returns null for words with too many U+FFFDs to disambiguate', () => {
    expect(
      recoverWordWithFFFD('\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD')
    ).toBeNull()
  })
})

describe('recoverStringWithFFFD', () => {
  it('repairs the canonical "Levbet FÖRENING" case', () => {
    expect(recoverStringWithFFFD('Levbet F\uFFFDRENING')).toBe('Levbet FÖRENING')
  })

  it('repairs city + business-name combos', () => {
    expect(recoverStringWithFFFD('Sjöberg AB, Malm\uFFFD')).toBe('Sjöberg AB, Malmö')
    expect(recoverStringWithFFFD('Faktura fr\uFFFDn G\uFFFDTEBORG AB')).toBe(
      'Faktura från GÖTEBORG AB'
    )
  })

  it('preserves punctuation, whitespace, and digits', () => {
    expect(recoverStringWithFFFD('K\uFFFDp 1 234,56 SEK')).toBe('Köp 1 234,56 SEK')
  })

  it('is a no-op on clean strings', () => {
    expect(recoverStringWithFFFD('Hello World')).toBe('Hello World')
    expect(recoverStringWithFFFD('FÖRENING')).toBe('FÖRENING')
  })

  it('returns null when any word in the string is ambiguous', () => {
    expect(recoverStringWithFFFD('FÖRENING Z\uFFFDXQ')).toBeNull()
  })

  it('is idempotent on recovered output', () => {
    const once = recoverStringWithFFFD('F\uFFFDRENING')
    expect(once).toBe('FÖRENING')
    expect(recoverStringWithFFFD(once!)).toBe('FÖRENING')
  })
})
