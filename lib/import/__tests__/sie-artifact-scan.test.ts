/**
 * Tests for the CP1252-artifact tripwire (lib/import/sie-artifact-scan.ts).
 *
 * The corruption under test is CP437 SIE bytes decoded as windows-1252 by an
 * upstream system BEFORE the string reached this repo (the retired Arcim Sync
 * gateway, 2026-03-17): o-umlaut 0x94 -> U+201D, a-umlaut 0x84 -> U+201E,
 * A-umlaut 0x8E -> U+017D. The mojibake literals below are the subject being
 * tested and must stay byte-exact.
 */
import { describe, it, expect } from 'vitest'
import {
  scanSieForCp1252Artifacts,
  formatSieArtifactWarning,
  SIE_ARTIFACT_THRESHOLD,
} from '../sie-artifact-scan'
import { parseSIEFile } from '../sie-parser'
import type { SIEAccount, SIEVoucher } from '../types'

function account(number: string, name: string): SIEAccount {
  return { number, name }
}

function voucher(
  description: string,
  lineDescriptions: (string | undefined)[] = [],
): SIEVoucher {
  return {
    series: 'A',
    number: 1,
    date: new Date('2024-01-15'),
    description,
    lines: lineDescriptions.map((d, i) => ({
      account: '1930',
      amount: i % 2 === 0 ? 100 : -100,
      description: d,
    })),
  }
}

describe('scanSieForCp1252Artifacts', () => {
  it('flags a file with artifacts in account names and voucher descriptions', () => {
    const result = scanSieForCp1252Artifacts({
      accounts: [
        account('1930', 'F”retagskonto'), // ö -> U+201D
        account('4056', 'Ink”p tj„nster inom EU'), // ö/ä -> U+201D/U+201E
      ],
      vouchers: [voucher('L”neutbetalning')],
    })

    expect(result.flagged).toBe(true)
    expect(result.artifactCount).toBe(3)
    expect(result.samples).toContain('Ink”p tj„nster inom EU')
    expect(result.samples).toContain('L”neutbetalning')
  })

  it('counts transaction line descriptions (BANKTJŽNSTER/UTLŽGG signature)', () => {
    const result = scanSieForCp1252Artifacts({
      accounts: [account('1930', 'Bank')],
      vouchers: [voucher('Banktransaktion', ['BANKTJŽNSTER', 'UTLŽGG'])],
    })

    expect(result.flagged).toBe(true)
    expect(result.artifactCount).toBe(2)
    expect(result.samples).toEqual(['BANKTJŽNSTER', 'UTLŽGG'])
  })

  it('does not flag clean Swedish text, including legitimate space-padded typography', () => {
    const result = scanSieForCp1252Artifacts({
      accounts: [
        account('1930', 'Företagskonto'),
        account('1513', 'Kundfordringar – delad faktura'), // legit space-padded en dash
      ],
      vouchers: [voucher('Löneutbetalning', ['Inköp tjänster inom EU', 'Avvaktar underlag …'])],
    })

    expect(result.flagged).toBe(false)
    expect(result.artifactCount).toBe(0)
    expect(result.samples).toEqual([])
  })

  it('stays below the threshold on a single artifact (no false alarm on one odd string)', () => {
    const result = scanSieForCp1252Artifacts({
      accounts: [account('1930', 'Företagskonto')],
      // One typographic apostrophe adjacent to letters is indistinguishable
      // from mojibake at the single-string level; the >= 2 threshold is what
      // keeps a lone occurrence from flagging the whole file.
      vouchers: [voucher('Betalning McDonald’s')],
    })

    expect(result.flagged).toBe(false)
    expect(result.artifactCount).toBe(1)
    expect(SIE_ARTIFACT_THRESHOLD).toBe(2)
  })

  it('caps samples at three distinct strings while counting every hit', () => {
    const result = scanSieForCp1252Artifacts({
      accounts: [
        account('4010', 'Ink”p material'),
        account('4056', 'Ink”p tj„nster inom EU'),
        account('7210', 'L”ner tj„nstem„n'),
        account('7510', 'Arbetsgivaravgifter l”n'),
      ],
      vouchers: [voucher('L”neutbetalning'), voucher('L”neutbetalning')],
    })

    expect(result.flagged).toBe(true)
    expect(result.artifactCount).toBe(6)
    expect(result.samples).toHaveLength(3)
    // Distinct: the duplicated voucher description appears once at most.
    expect(new Set(result.samples).size).toBe(3)
  })

  it('flags real parseSIEFile output for a gateway-mojibaked SIE string', () => {
    const mojibakeSie = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#FNAMN "Migrerad AB"',
      '#RAR 0 20240101 20241231',
      '#KONTO 1930 "F”retagskonto"',
      '#KONTO 4056 "Ink”p tj„nster inom EU"',
      '#VER A 1 20240115 "L”neutbetalning"',
      '{',
      '#TRANS 1930 {} -100.00',
      '#TRANS 4056 {} 100.00',
      '}',
    ].join('\n')

    const flagged = scanSieForCp1252Artifacts(parseSIEFile(mojibakeSie))
    expect(flagged.flagged).toBe(true)
    expect(flagged.artifactCount).toBe(3)

    const cleanSie = mojibakeSie
      .replace('F”retagskonto', 'Företagskonto')
      .replace('Ink”p tj„nster inom EU', 'Inköp tjänster inom EU')
      .replace('L”neutbetalning', 'Löneutbetalning')
    const clean = scanSieForCp1252Artifacts(parseSIEFile(cleanSie))
    expect(clean.flagged).toBe(false)
    expect(clean.artifactCount).toBe(0)
  })
})

describe('formatSieArtifactWarning', () => {
  it('includes the count and the first sample in Swedish', () => {
    const message = formatSieArtifactWarning({
      flagged: true,
      artifactCount: 3,
      samples: ['Ink”p tj„nster inom EU', 'L”neutbetalning'],
    })

    expect(message).toContain('felaktigt teckenkodad')
    expect(message).toContain('3 textfält')
    expect(message).toContain('"Ink”p tj„nster inom EU"')
    expect(message).toContain('blockeras inte')
  })

  it('omits the example clause when no sample is available', () => {
    const message = formatSieArtifactWarning({ flagged: true, artifactCount: 2, samples: [] })
    expect(message).not.toContain('till exempel')
    expect(message).toContain('2 textfält')
  })
})
