import { describe, it, expect } from 'vitest'
import { buildInfoSru, sruBlankettType, sruFile, sruPeriodSuffix, sruText } from '../envelope'

describe('sruPeriodSuffix (swedish-sru-filing file-format.md §2)', () => {
  it.each([
    ['2025-01-31', 'P1'], ['2025-04-30', 'P1'],
    ['2025-05-31', 'P2'], ['2025-06-30', 'P2'],
    // Both generators answered P2 for July and August: Skatteverket's P3.
    ['2025-07-31', 'P3'], ['2025-08-31', 'P3'],
    ['2025-09-30', 'P4'], ['2025-12-31', 'P4'],
  ])('a räkenskapsår ending %s is %s', (end, suffix) => {
    expect(sruPeriodSuffix(end)).toBe(suffix)
  })

  it('names the income year the räkenskapsår ends in', () => {
    expect(sruBlankettType('INK2R', '2025-06-30')).toBe('INK2R-2025P2')
    expect(sruBlankettType('NE', '2024-12-31')).toBe('NE-2024P4')
  })
})

describe('sruText', () => {
  it('drops the reserved #, turns line breaks into spaces and caps at 250', () => {
    expect(sruText('A#B\r\nC')).toBe('AB  C')
    expect(sruText('x'.repeat(300))).toHaveLength(250)
  })
})

describe('buildInfoSru', () => {
  const now = new Date(2026, 2, 1, 9, 5, 7)

  it('writes the posts in the prescribed order, CRLF-terminated', () => {
    const info = buildInfoSru(
      { identity12: '165566778899', name: 'Test AB', addressLine1: 'Gatan 1', postalCode: '111 22', city: 'Stockholm', email: 'a@b.se' },
      now,
    )
    expect(info.split('\r\n')).toEqual([
      '#DATABESKRIVNING_START',
      '#PRODUKT SRU',
      '#SKAPAD 20260301 090507',
      expect.stringMatching(/^#PROGRAM \S+ 1\.0$/),
      '#FILNAMN BLANKETTER.SRU',
      '#DATABESKRIVNING_SLUT',
      '#MEDIELEV_START',
      '#ORGNR 165566778899',
      '#NAMN Test AB',
      '#ADRESS Gatan 1',
      // #POSTNR is the 5-digit postal code (file-format.md §1); INK2 used to
      // write "111 22" as entered.
      '#POSTNR 11122',
      '#POSTORT Stockholm',
      '#EMAIL a@b.se',
      '#MEDIELEV_SLUT',
      '',
    ])
  })

  it('falls back to the placeholders and leaves the optional posts out', () => {
    const info = buildInfoSru({ identity12: '000000000000', name: 'X', postalCode: null, city: null }, now)
    expect(info).toContain('#POSTNR 00000\r\n#POSTORT Okänd\r\n')
    expect(info).not.toContain('#ADRESS')
    expect(info).not.toContain('#EMAIL')
  })

  it('sanitises the e-mail like every other text post', () => {
    expect(buildInfoSru({ identity12: '1', name: 'X', email: 'a#b@c.se\n' }, now)).toContain('#EMAIL ab@c.se \r\n')
  })
})

describe('sruFile', () => {
  it('terminates every line with CRLF', () => {
    expect(sruFile(['#A', '#B'])).toBe('#A\r\n#B\r\n')
  })
})
