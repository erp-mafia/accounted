import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ onFile: vi.fn() }))
vi.mock('@/lib/auth/bankid-signer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/bankid-signer')>()),
  signerPersonalNumberOnFile: (...a: unknown[]) => mocks.onFile(...a),
}))

import { createTableMockSupabase } from '@/tests/helpers'
import { signerFromRequest } from '@/lib/payments/orders/request-signer'
import { consentFailureText, isPermanentConsentFailure, OPEN_BANKING_GENERIC_FAILURE } from '../failure-text'
import { buildBankFeedParty, UNATTENDED_SIGNER } from '../party'
import { normalizePsuAuthoriserId, NORDEA_BIC, PSU_AUTHORISER_ID_MISSING, psuAuthoriserIdFor, takesPsuAuthoriserId } from '../psu-authoriser'

const withOrg = () => createTableMockSupabase({ company_settings: { data: { org_number: '559538-6219' }, error: null } }).supabase as never
const nordea = { companyId: 'co-1', bic: NORDEA_BIC, affiliatedAspspId: null, psuType: 'business' }
const typed = (psuAuthoriserId: string | null) => ({ personalNumber: '199001011239', ipAddress: '203.0.113.1', userAgent: 'UA', psuAuthoriserId })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.onFile.mockResolvedValue(null)
})

describe('which bank takes the logon id', () => {
  it('is Nordea, by BIC first, by name where only the name is known', () => {
    expect(takesPsuAuthoriserId({ bic: 'NDEASESS' })).toBe(true)
    expect(takesPsuAuthoriserId({ bic: ' ndeasess ' })).toBe(true)
    expect(takesPsuAuthoriserId({ bic: 'SWEDSESS', name: 'Nordea' })).toBe(false)
    expect(takesPsuAuthoriserId({ name: 'Nordea' })).toBe(true)
    expect(takesPsuAuthoriserId({ bic: null, name: 'Nordea Bank Abp' })).toBe(true)
    expect(takesPsuAuthoriserId({ name: 'Svea Bank' })).toBe(false)
    expect(takesPsuAuthoriserId({ bic: null, name: null })).toBe(false)
  })

  it('reads what was typed: trimmed, empty as none, refused outside 1 to 64 letters, digits, - and _', () => {
    expect(normalizePsuAuthoriserId('  ab-12_CD ')).toEqual({ ok: true, value: 'ab-12_CD' })
    expect(normalizePsuAuthoriserId('   ')).toEqual({ ok: true, value: null })
    expect(normalizePsuAuthoriserId(null)).toEqual({ ok: true, value: null })
    expect(normalizePsuAuthoriserId('x'.repeat(64))).toEqual({ ok: true, value: 'x'.repeat(64) })
    expect(normalizePsuAuthoriserId('x'.repeat(65))).toEqual({ ok: false })
    expect(normalizePsuAuthoriserId('ab cd')).toEqual({ ok: false })
    expect(normalizePsuAuthoriserId('åsa')).toEqual({ ok: false })
  })

  it('drops the value for any bank but Nordea, malformed or not', () => {
    expect(psuAuthoriserIdFor('NDEASESS', 'user-1')).toEqual({ ok: true, value: 'user-1' })
    expect(psuAuthoriserIdFor('NDEASESS', 'a b')).toEqual({ ok: false })
    expect(psuAuthoriserIdFor('SWEDSESS', 'user-1')).toEqual({ ok: true, value: null })
    expect(psuAuthoriserIdFor('SWEDSESS', 'a b')).toEqual({ ok: true, value: null })
    expect(psuAuthoriserIdFor(null, 'user-1')).toEqual({ ok: true, value: null })
  })
})

describe('the bank-feed party', () => {
  it('carries the typed logon id for a Nordea consent, and no key without one', async () => {
    const withId = await buildBankFeedParty(withOrg(), { ...nordea, signer: typed(' corp-user-1 '), userId: 'u-1' })
    expect(withId.ok && withId.party).toMatchObject({ bic: 'NDEASESS', personalNumber: '199001011239', psuAuthoriserId: 'corp-user-1' })
    const without = await buildBankFeedParty(withOrg(), { ...nordea, signer: typed(null), userId: 'u-1' })
    expect(without.ok && without.party).not.toHaveProperty('psuAuthoriserId')
    const unattended = await buildBankFeedParty(withOrg(), { ...nordea, signer: UNATTENDED_SIGNER, userId: 'u-1' })
    expect(unattended.ok && unattended.party).not.toHaveProperty('psuAuthoriserId')
  })

  it('never sends it to another bank, and refuses a malformed one for Nordea by name', async () => {
    const swedbank = await buildBankFeedParty(withOrg(), { ...nordea, bic: 'SWEDSESS', signer: typed('corp-user-1'), userId: 'u-1' })
    expect(swedbank.ok && swedbank.party).not.toHaveProperty('psuAuthoriserId')
    expect(await buildBankFeedParty(withOrg(), { ...nordea, signer: typed('not valid'), userId: 'u-1' })).toEqual({
      ok: false,
      outcome: { ok: false, code: 'VALIDATION_ERROR', details: { field: 'psu_authoriser_id', reason: 'invalid' } },
    })
  })
})

describe('the request signer', () => {
  it('takes the logon id beside the personnummer, trimmed, and leaves the key out when nothing was typed', () => {
    const request = new Request('https://app.accounted.se/x', { headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1', 'user-agent': 'UA' } })
    expect(signerFromRequest(request, '199001011239', ' corp-user-1 ')).toEqual({ personalNumber: '199001011239', ipAddress: '203.0.113.1', userAgent: 'UA', psuAuthoriserId: 'corp-user-1' })
    expect(signerFromRequest(request, null, '  ')).not.toHaveProperty('psuAuthoriserId')
    expect(signerFromRequest(request, null)).not.toHaveProperty('psuAuthoriserId')
  })
})

describe('the refusal for a missing logon id', () => {
  it('asks for the logon id in Swedish and English, and is not permanent: filling it in and trying again helps', () => {
    expect(consentFailureText(PSU_AUTHORISER_ID_MISSING).sv).toBe('Nordea Corporate Netbank behöver ert inloggnings-ID. Fyll i det och försök igen.')
    expect(consentFailureText(PSU_AUTHORISER_ID_MISSING)).not.toEqual(OPEN_BANKING_GENERIC_FAILURE)
    expect(isPermanentConsentFailure(PSU_AUTHORISER_ID_MISSING)).toBe(false)
  })
})
