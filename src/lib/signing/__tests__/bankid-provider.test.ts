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
import { signingEnabled } from '@/lib/env/signing-switch'

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

describe('signingEnabled', () => {
  it('is off unless SIGNING_ENABLED is 1 or true', () => {
    expect(signingEnabled({})).toBe(false)
    expect(signingEnabled({ SIGNING_ENABLED: '0' })).toBe(false)
    expect(signingEnabled({ SIGNING_ENABLED: 'yes' })).toBe(false)
    expect(signingEnabled({ SIGNING_ENABLED: '1' })).toBe(true)
    expect(signingEnabled({ SIGNING_ENABLED: ' TRUE ' })).toBe(true)
  })
})
