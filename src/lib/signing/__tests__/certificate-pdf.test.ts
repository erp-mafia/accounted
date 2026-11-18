/**
 * The pieces of the signed copy's own pages (../certificate-pdf.tsx): the
 * short id, the signers' initials and the stamp line on every original
 * page, the Swedish genitive of the company, and the fallback to the
 * standard fonts when the bundled ones cannot be registered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fonts = vi.hoisted(() => ({ registerBundledFont: vi.fn() }))
vi.mock('@/lib/pdf/bundled-fonts', () => fonts)

import { bankIdInitials, bareUrl, prepareSigningFonts, shortSigningId, signersInitials, stampLine, swedishGenitive } from '../certificate-pdf'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('shortSigningId', () => {
  it('is the first 8 hex digits of the request id, upper-cased', () => {
    expect(shortSigningId('1569bce7-031f-4dd9-8497-bcc8cea485f5')).toBe('1569BCE7')
  })
})

describe('bareUrl', () => {
  it('drops the scheme and a trailing slash', () => {
    expect(bareUrl('https://app.accounted.se/verifiera')).toBe('app.accounted.se/verifiera')
    expect(bareUrl('http://ekonomi.byran.se/verifiera/')).toBe('ekonomi.byran.se/verifiera')
  })
})

describe('initials', () => {
  it('takes the first given name and the last surname, as BankID gives them', () => {
    expect(bankIdInitials('Anna', 'Andersson')).toBe('AA')
    expect(bankIdInitials('Erik', 'Berg Lund')).toBe('EL')
    expect(bankIdInitials('anna maria', 'af ström')).toBe('AS')
    expect(bankIdInitials('Åsa', 'Öberg-Lind')).toBe('ÅÖ')
  })

  it('lists at most six signers, then how many more', () => {
    const people = (n: number) => Array.from({ length: n }, (_, i) => ({ givenName: String.fromCharCode(65 + i), surname: 'Berg' }))
    expect(signersInitials(people(2))).toBe('AB, BB')
    expect(signersInitials(people(6))).toBe('AB, BB, CB, DB, EB, FB')
    expect(signersInitials(people(9))).toBe('AB, BB, CB, DB, EB, FB +3')
  })
})

describe('stampLine', () => {
  it('says who signed with BankID, the short id and where a copy is checked', () => {
    expect(stampLine({ initials: 'JW, EM', requestId: '1569bce7-031f-4dd9-8497-bcc8cea485f5', verifyUrl: 'https://app.accounted.se/verifiera' })).toBe(
      'Signerat med BankID av JW, EM · ID 1569BCE7 · app.accounted.se/verifiera',
    )
  })
})

describe('swedishGenitive', () => {
  it('adds :s after an abbreviation or a digit, nothing after s, x or z, and s otherwise', () => {
    expect(swedishGenitive('Arcim Technology AB')).toBe('Arcim Technology AB:s')
    expect(swedishGenitive('Bygg 24')).toBe('Bygg 24:s')
    expect(swedishGenitive('Anna Svensson')).toBe('Anna Svenssons')
    expect(swedishGenitive('Kompass')).toBe('Kompass')
    expect(swedishGenitive('Kafé Linné')).toBe('Kafé Linnés')
  })
})

describe('prepareSigningFonts', () => {
  it('uses the bundled Source fonts once they are registered', async () => {
    fonts.registerBundledFont.mockResolvedValue(undefined)
    expect(await prepareSigningFonts()).toEqual({ sans: 'Source Sans 3', serif: 'Source Serif 4', mono: 'Courier' })
    expect(fonts.registerBundledFont.mock.calls.map(([family]) => family)).toEqual(['Source Sans 3', 'Source Serif 4'])
  })

  it('falls back to the standard fonts rather than leaving the request unsealed', async () => {
    fonts.registerBundledFont.mockRejectedValue(new Error('ENOENT public/fonts/invoice'))
    expect(await prepareSigningFonts()).toEqual({ sans: 'Helvetica', serif: 'Times-Roman', mono: 'Courier' })
  })
})
