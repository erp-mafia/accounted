import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ onFile: vi.fn(), stored: vi.fn() }))
vi.mock('@/lib/auth/bankid-signer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/bankid-signer')>()),
  signerPersonalNumberOnFile: (...a: unknown[]) => mocks.onFile(...a),
}))
vi.mock('@/lib/auth/resource-psu', () => ({ storedConnectionPsu: (...a: unknown[]) => mocks.stored(...a) }))

import { createTableMockSupabase } from '@/tests/helpers'
import { buildBankFeedParty, UNATTENDED_SIGNER } from '../party'

const base = { companyId: 'co-1', bic: 'SWEDSESS', affiliatedAspspId: null, psuType: 'business' }
const withOrg = () => createTableMockSupabase({ company_settings: { data: { org_number: '559538-6219' }, error: null } }).supabase as never

beforeEach(() => {
  vi.clearAllMocks()
  mocks.onFile.mockResolvedValue('199001011239')
  mocks.stored.mockResolvedValue(null)
})

describe('buildBankFeedParty', () => {
  it('names the PSU on an unattended read from the owner\'s number on file, without a BankID start being asked for', async () => {
    const result = await buildBankFeedParty(withOrg(), { ...base, signer: UNATTENDED_SIGNER, userId: 'owner-1' })
    expect(result).toEqual({
      ok: true,
      source: 'on_file',
      party: { orgNumber: '5595386219', accountContext: 'corporate', bic: 'SWEDSESS', personalNumber: '199001011239', psuIpAddress: null, psuUserAgent: null, affiliatedAspspId: null },
    })
    expect(mocks.onFile).toHaveBeenCalledWith('owner-1')
  })

  it('sends the PSU-ID the consent was created with on every later call, before a typed number or the one on file', async () => {
    mocks.stored.mockResolvedValue({ personalNumber: '198001019879', source: 'signatory_link' })
    const unattended = await buildBankFeedParty(withOrg(), { ...base, signer: UNATTENDED_SIGNER, userId: 'owner-1', connectionId: 'conn-1' })
    expect(unattended).toEqual({
      ok: true,
      source: 'signatory_link',
      party: { orgNumber: '5595386219', accountContext: 'corporate', bic: 'SWEDSESS', personalNumber: '198001019879', psuIpAddress: null, psuUserAgent: null, affiliatedAspspId: null },
    })
    expect(mocks.stored).toHaveBeenCalledWith('conn-1')
    expect(mocks.onFile).not.toHaveBeenCalled()

    // A person present: the stored number still leads, their IP and user agent go along.
    const present = await buildBankFeedParty(withOrg(), { ...base, signer: { personalNumber: '900101-1239', ipAddress: '203.0.113.1', userAgent: 'UA' }, userId: 'owner-1', connectionId: 'conn-1' })
    expect(present.ok && present.party).toMatchObject({ personalNumber: '198001019879', psuIpAddress: '203.0.113.1', psuUserAgent: 'UA' })
  })

  it('keeps today\'s fallbacks when nothing is stored, or the stored number cannot be read', async () => {
    mocks.stored.mockResolvedValue(null)
    const onFile = await buildBankFeedParty(withOrg(), { ...base, signer: UNATTENDED_SIGNER, userId: 'owner-1', connectionId: 'conn-1' })
    expect(onFile.ok && onFile.party.personalNumber).toBe('199001011239')
    expect(onFile.ok && onFile.source).toBe('on_file')
    const typed = await buildBankFeedParty(withOrg(), { ...base, signer: { personalNumber: '800101-9879', ipAddress: null, userAgent: null }, userId: 'owner-1', connectionId: 'conn-1' })
    expect(typed.ok && typed.party.personalNumber).toBe('198001019879')
    expect(typed.ok && typed.source).toBe('typed')
    const link = await buildBankFeedParty(withOrg(), { ...base, signer: { personalNumber: '800101-9879', ipAddress: null, userAgent: null, lookupOnFile: false }, userId: 'sender-1', connectionId: 'conn-1' })
    expect(link.ok && link.source).toBe('signatory_link')
  })

  it('carries the co-signer\'s own number on their authorisation, never the stored one', async () => {
    mocks.stored.mockResolvedValue({ personalNumber: '198001019879', source: 'typed' })
    const coSigner = await buildBankFeedParty(withOrg(), {
      ...base, signer: { personalNumber: '900101-1239', ipAddress: '203.0.113.9', userAgent: 'UA2', lookupOnFile: false }, userId: 'sender-1', connectionId: 'conn-1', coSigner: true,
    })
    expect(coSigner.ok && coSigner.party.personalNumber).toBe('199001011239')
    expect(mocks.stored).not.toHaveBeenCalled()
  })

  it('lets a typed number win over the one on file, and sends null only when nothing is known', async () => {
    const typed = await buildBankFeedParty(withOrg(), { ...base, signer: { personalNumber: '900101-1239', ipAddress: '203.0.113.1', userAgent: 'UA' }, userId: 'owner-1' })
    expect(typed.ok && typed.party.personalNumber).toBe('199001011239')
    expect(mocks.onFile).not.toHaveBeenCalled()

    mocks.onFile.mockResolvedValue(null)
    const unknown = await buildBankFeedParty(withOrg(), { ...base, signer: UNATTENDED_SIGNER, userId: 'owner-1' })
    expect(unknown.ok && unknown.party.personalNumber).toBeNull()
    const nobody = await buildBankFeedParty(withOrg(), { ...base, signer: UNATTENDED_SIGNER })
    expect(nobody.ok && nobody.party.personalNumber).toBeNull()
  })

  it('never looks the context user up when the signer says so: the signatory link acts as the sender but signs as someone else', async () => {
    const guarded = await buildBankFeedParty(withOrg(), { ...base, signer: { ...UNATTENDED_SIGNER, lookupOnFile: false }, userId: 'sender-1' })
    expect(guarded.ok && guarded.party.personalNumber).toBeNull()
    expect(mocks.onFile).not.toHaveBeenCalled()
    expect(await buildBankFeedParty(withOrg(), { ...base, signer: { ...UNATTENDED_SIGNER, lookupOnFile: false }, userId: 'sender-1', requireSigner: true })).toEqual({
      ok: false,
      outcome: { ok: false, code: 'BANK_CONSENT_PERSONAL_NUMBER_REQUIRED' },
    })
    expect(mocks.onFile).not.toHaveBeenCalled()
  })

  it('refuses a BankID start without a number, and an invalid typed number, by name', async () => {
    mocks.onFile.mockResolvedValue(null)
    expect(await buildBankFeedParty(withOrg(), { ...base, signer: UNATTENDED_SIGNER, userId: 'u', requireSigner: true })).toEqual({ ok: false, outcome: { ok: false, code: 'BANK_CONSENT_PERSONAL_NUMBER_REQUIRED' } })
    expect(await buildBankFeedParty(withOrg(), { ...base, signer: { personalNumber: '12345', ipAddress: null, userAgent: null }, userId: 'u' })).toEqual({
      ok: false,
      outcome: { ok: false, code: 'BANK_CONSENT_PERSONAL_NUMBER_REQUIRED', details: { reason: 'invalid' } },
    })
  })

  it('needs the company\'s organisationsnummer and reads the private context for an enskild firma', async () => {
    const noOrg = createTableMockSupabase({ company_settings: { data: null, error: null }, companies: { data: null, error: null } }).supabase as never
    expect(await buildBankFeedParty(noOrg, { ...base, signer: UNATTENDED_SIGNER })).toMatchObject({ ok: false, outcome: { code: 'VALIDATION_ERROR', details: { field: 'org_number' } } })
    const personal = await buildBankFeedParty(withOrg(), { ...base, psuType: 'personal', affiliatedAspspId: '08999', signer: UNATTENDED_SIGNER })
    expect(personal.ok && personal.party).toMatchObject({ accountContext: 'private', affiliatedAspspId: '08999' })
  })
})
