/**
 * Core never imports the TIC extension: it asks through the registry's
 * services, and any missing piece (the BankID flag, the extension, one of the
 * three services) means signing is unavailable here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const registryGet = vi.hoisted(() => vi.fn())
const bankIdEnabled = vi.hoisted(() => vi.fn())
vi.mock('@/lib/extensions/registry', () => ({
  extensionRegistry: { get: registryGet },
}))
vi.mock('@/lib/auth/bankid-flags', () => ({
  isBankIdEnabled: bankIdEnabled,
}))

import { resolveBankIdSigning } from '../bankid-provider'
import { arsredovisningSigningEnabledFor, signingEnabledFor, signingRollout } from '@/lib/env/signing-switch'

const services = {
  startBankIdSignature: vi.fn(),
  pollBankIdSignature: vi.fn(),
  cancelBankIdSignature: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  bankIdEnabled.mockReturnValue(true)
})

describe('resolveBankIdSigning', () => {
  it('answers the wired services from the tic extension', async () => {
    registryGet.mockResolvedValue({ id: 'tic', services: { fetchCompanyProfile: vi.fn(), ...services } })
    const provider = await resolveBankIdSigning()
    expect(registryGet).toHaveBeenCalledWith('tic')
    expect(provider?.startBankIdSignature).toBe(services.startBankIdSignature)
  })

  it('answers null with BankID off, without asking the registry', async () => {
    bankIdEnabled.mockReturnValue(false)
    expect(await resolveBankIdSigning()).toBeNull()
    expect(registryGet).not.toHaveBeenCalled()
  })

  it('answers null when the extension is not registered', async () => {
    registryGet.mockResolvedValue(undefined)
    expect(await resolveBankIdSigning()).toBeNull()
  })

  it('answers null when any of the three services is missing', async () => {
    registryGet.mockResolvedValue({ id: 'tic', services: { startBankIdSignature: vi.fn(), pollBankIdSignature: vi.fn() } })
    expect(await resolveBankIdSigning()).toBeNull()
  })
})

const ARCIM = 'ED461BC1-DBB5-4568-AE20-9337515878E2'
const OTHER = '00000000-0000-4000-8000-0000000000aa'

describe('signingEnabledFor', () => {
  it('is off for everyone unless SIGNING_ENABLED opens it', () => {
    expect(signingEnabledFor(ARCIM, {})).toBe(false)
    expect(signingEnabledFor(ARCIM, { SIGNING_ENABLED: '0' })).toBe(false)
    expect(signingEnabledFor(ARCIM, { SIGNING_ENABLED: 'yes' })).toBe(false)
    expect(signingEnabledFor(null, { SIGNING_ENABLED: OTHER })).toBe(false)
  })

  it('opens for every company on 1, true or *', () => {
    for (const value of ['1', ' TRUE ', '*']) {
      expect(signingRollout({ SIGNING_ENABLED: value })).toBe('all')
      expect(signingEnabledFor(OTHER, { SIGNING_ENABLED: value })).toBe(true)
    }
  })

  it('opens only for the listed companies, whatever their case and spaces', () => {
    const env = { SIGNING_ENABLED: ` ${ARCIM} ,${ARCIM}` }
    expect(signingRollout(env)).toEqual([ARCIM.toLowerCase()])
    expect(signingEnabledFor(ARCIM.toLowerCase(), env)).toBe(true)
    expect(signingEnabledFor(OTHER, env)).toBe(false)
  })
})

describe('arsredovisningSigningEnabledFor', () => {
  it('needs both rollouts', () => {
    expect(arsredovisningSigningEnabledFor(ARCIM, { SIGNING_ENABLED: '1' })).toBe(false)
    expect(arsredovisningSigningEnabledFor(ARCIM, { SIGNING_ARSREDOVISNING_ENABLED: '1' })).toBe(false)
    expect(arsredovisningSigningEnabledFor(ARCIM, { SIGNING_ENABLED: '1', SIGNING_ARSREDOVISNING_ENABLED: ARCIM })).toBe(true)
    expect(arsredovisningSigningEnabledFor(OTHER, { SIGNING_ENABLED: '1', SIGNING_ARSREDOVISNING_ENABLED: ARCIM })).toBe(false)
  })
})
