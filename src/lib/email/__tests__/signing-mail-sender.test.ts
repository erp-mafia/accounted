/**
 * Who the signing mails are from (../signing-mail-sender.ts): a company
 * without a brand sends as "<company> via <platform>" on the platform's own
 * address; a company with a brand keeps the WL-13 identity unchanged; the
 * logo never stops a mail.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sender = vi.hoisted(() => ({ getSenderForCompany: vi.fn() }))
vi.mock('@/lib/email/brand-sender', () => sender)
const signingBrand = vi.hoisted(() => ({ signingSenderBrand: vi.fn() }))
vi.mock('@/lib/signing/brand', () => signingBrand)
const logo = vi.hoisted(() => ({ resolveSigningLogo: vi.fn() }))
vi.mock('@/lib/signing/logo', async (original) => ({ ...(await original<typeof import('@/lib/signing/logo')>()), resolveSigningLogo: logo.resolveSigningLogo }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({}) }))

import { resolveSigningMailIdentity, signingFromIdentity } from '../signing-mail-sender'

const brand = { appName: 'Byrån Ekonomi', domain: 'ekonomi.byran.se' } as never
const LOGO_URL = 'https://storage.example.test/logos/c/logo-1.png'

beforeEach(() => {
  vi.clearAllMocks()
  sender.getSenderForCompany.mockResolvedValue({ fromName: null, fromAddress: null, replyTo: null, brand: null })
  signingBrand.signingSenderBrand.mockResolvedValue({ logoUrl: LOGO_URL, platformName: 'Accounted' })
  logo.resolveSigningLogo.mockResolvedValue({ dataUrl: 'data:image/png;base64,AA', width: 494, height: 505 })
})

describe('signingFromIdentity', () => {
  it('sends a brandless company as "<company> via <platform>" on the platform address', () => {
    expect(signingFromIdentity({ fromName: null, fromAddress: null, replyTo: null, brand: null }, ' Arcim Technology AB ', 'Accounted')).toEqual({
      fromName: 'Arcim Technology AB via Accounted',
      fromAddress: null,
      replyTo: null,
    })
    expect(signingFromIdentity({ fromName: null, fromAddress: null, replyTo: null, brand: null }, '  ', 'Accounted').fromName).toBe('Accounted')
  })

  it('keeps a brand\'s WL-13 identity as it is, without "via"', () => {
    expect(signingFromIdentity({ fromName: 'Byrån Ekonomi', fromAddress: 'noreply@byran.se', replyTo: 'kontakt@byran.se', brand }, 'Bolaget AB', 'Byrån Ekonomi')).toEqual({
      fromName: 'Byrån Ekonomi',
      fromAddress: 'noreply@byran.se',
      replyTo: 'kontakt@byran.se',
    })
    expect(signingFromIdentity({ fromName: 'Byrån Ekonomi', fromAddress: null, replyTo: 'kontakt@byran.se', brand }, 'Bolaget AB', 'Byrån Ekonomi').fromName).toBe('Byrån Ekonomi')
  })
})

describe('resolveSigningMailIdentity', () => {
  it('answers the sender, the platform and the logo at its mail size', async () => {
    expect(await resolveSigningMailIdentity('company-1', 'Arcim Technology AB')).toEqual({
      fromName: 'Arcim Technology AB via Accounted',
      fromAddress: null,
      replyTo: null,
      platformName: 'Accounted',
      logo: { src: LOGO_URL, width: 47, height: 48 },
    })
    expect(signingBrand.signingSenderBrand).toHaveBeenCalledWith({}, 'company-1')
    expect(logo.resolveSigningLogo).toHaveBeenCalledWith(LOGO_URL)
  })

  it('still mails, with initials, when the logo or the brand lookup fails', async () => {
    logo.resolveSigningLogo.mockRejectedValue(new Error('timeout'))
    expect((await resolveSigningMailIdentity('company-1', 'Bolaget AB')).logo).toBeNull()

    signingBrand.signingSenderBrand.mockRejectedValue(new Error('db down'))
    sender.getSenderForCompany.mockResolvedValue({ fromName: 'Byrån Ekonomi', fromAddress: null, replyTo: 'kontakt@byran.se', brand })
    expect(await resolveSigningMailIdentity('company-1', 'Bolaget AB')).toEqual({
      fromName: 'Byrån Ekonomi',
      fromAddress: null,
      replyTo: 'kontakt@byran.se',
      platformName: 'Byrån Ekonomi',
      logo: null,
    })
  })
})
