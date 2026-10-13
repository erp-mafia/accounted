import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ onFile: vi.fn() }))
vi.mock('@/lib/auth/bankid-signer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/bankid-signer')>()),
  signerPersonalNumberOnFile: (...a: unknown[]) => mocks.onFile(...a),
}))

import { createTableMockSupabase } from '@/tests/helpers'
import { buildBankFeedParty, UNATTENDED_SIGNER } from '../party'

const base = { companyId: 'co-1', bic: 'SWEDSESS', affiliatedAspspId: null, psuType: 'business' }
const withOrg = () => createTableMockSupabase({ company_settings: { data: { org_number: '559538-6219' }, error: null } }).supabase as never

beforeEach(() => {
  vi.clearAllMocks()
  mocks.onFile.mockResolvedValue('199001011239')
})

describe('buildBankFeedParty', () => {
  it('names the PSU on an unattended read from the owner\'s number on file, without a BankID start being asked for', async () => {
    const result = await buildBankFeedParty(withOrg(), { ...base, signer: UNATTENDED_SIGNER, userId: 'owner-1' })
    expect(result).toEqual({
      ok: true,
      party: { orgNumber: '5595386219', accountContext: 'corporate', bic: 'SWEDSESS', personalNumber: '199001011239', psuIpAddress: null, psuUserAgent: null, affiliatedAspspId: null },
    })
    expect(mocks.onFile).toHaveBeenCalledWith('owner-1')
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
