/**
 * The company logo as the signing mails and the Signeringsbevis draw it
 * (../logo.ts): read only through the guarded logo resolver, sized by its
 * own aspect ratio, linked in a mail only when every mail client shows the
 * format, and initials when there is no logo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolver = vi.hoisted(() => ({ embeddableLogoUrl: vi.fn() }))
vi.mock('@/lib/pdf/logo', () => resolver)

import { companyInitials, fitLogo, mailLogo, pngSize, resolveSigningLogo } from '../logo'

async function png(width: number, height: number): Promise<Buffer> {
  const { default: sharp } = await import('sharp')
  return sharp({ create: { width, height, channels: 4, background: '#000000' } }).png().toBuffer()
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('pngSize', () => {
  it('reads the width and height of a PNG, and nothing else', async () => {
    expect(pngSize(new Uint8Array(await png(494, 505)))).toEqual({ width: 494, height: 505 })
    expect(pngSize(new Uint8Array(Buffer.from('GIF89a and more bytes than twenty four')))).toBeNull()
    expect(pngSize(new Uint8Array(4))).toBeNull()
  })
})

describe('resolveSigningLogo', () => {
  it('answers the drawable PNG and its size from the guarded resolver', async () => {
    const dataUrl = `data:image/png;base64,${(await png(300, 100)).toString('base64')}`
    resolver.embeddableLogoUrl.mockResolvedValue(dataUrl)
    expect(await resolveSigningLogo('https://storage.example.test/logos/c/logo-1.webp')).toEqual({ dataUrl, width: 300, height: 100 })
    expect(resolver.embeddableLogoUrl).toHaveBeenCalledWith('https://storage.example.test/logos/c/logo-1.webp')
  })

  it('answers null without a logo, when the guard refused it, or when only the raw URL came back', async () => {
    expect(await resolveSigningLogo(null)).toBeNull()
    expect(resolver.embeddableLogoUrl).not.toHaveBeenCalled()
    resolver.embeddableLogoUrl.mockResolvedValue(null)
    expect(await resolveSigningLogo('https://10.0.0.1/logo.png')).toBeNull()
    resolver.embeddableLogoUrl.mockResolvedValue('https://storage.example.test/logos/c/logo-1.png')
    expect(await resolveSigningLogo('https://storage.example.test/logos/c/logo-1.png')).toBeNull()
  })
})

describe('fitLogo', () => {
  it('keeps the aspect ratio inside the box', () => {
    expect(fitLogo({ width: 494, height: 505 }, { width: 160, height: 48 })).toEqual({ width: 47, height: 48 })
    expect(fitLogo({ width: 600, height: 150 }, { width: 160, height: 48 })).toEqual({ width: 160, height: 40 })
    expect(fitLogo({ width: 20, height: 10 }, { width: 160, height: 48 })).toEqual({ width: 96, height: 48 })
  })
})

describe('mailLogo', () => {
  const logo = { dataUrl: 'data:image/png;base64,AA', width: 600, height: 150 }

  it('links the stored https URL at its display size for PNG, JPEG and GIF', () => {
    expect(mailLogo('https://storage.example.test/logos/c/logo-1.png', logo)).toEqual({ src: 'https://storage.example.test/logos/c/logo-1.png', width: 160, height: 40 })
    expect(mailLogo('https://storage.example.test/logos/c/logo-1.JPG', logo)?.src).toBe('https://storage.example.test/logos/c/logo-1.JPG')
  })

  it('draws initials for formats mail clients drop, plain http, a data URL, or an unreadable logo', () => {
    expect(mailLogo('https://storage.example.test/logos/c/logo-1.webp', logo)).toBeNull()
    expect(mailLogo('https://storage.example.test/logos/c/logo.svg', logo)).toBeNull()
    expect(mailLogo('http://storage.example.test/logos/c/logo-1.png', logo)).toBeNull()
    expect(mailLogo('data:image/png;base64,AA', logo)).toBeNull()
    expect(mailLogo('not a url', logo)).toBeNull()
    expect(mailLogo('https://storage.example.test/logos/c/logo-1.png', null)).toBeNull()
    expect(mailLogo(null, logo)).toBeNull()
  })
})

describe('companyInitials', () => {
  it('takes the first letters of the first two words that are not a legal form', () => {
    expect(companyInitials('Arcim Technology AB')).toBe('AT')
    expect(companyInitials('Bolaget & Co AB')).toBe('BC')
    expect(companyInitials('Ängsbacka Fårö AB')).toBe('ÄF')
    expect(companyInitials('Bolaget AB')).toBe('B')
    expect(companyInitials('örebro bygg hb')).toBe('ÖB')
    expect(companyInitials('AB')).toBe('A')
  })
})
