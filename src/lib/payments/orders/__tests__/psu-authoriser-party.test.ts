import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ onFile: vi.fn() }))
vi.mock('@/lib/auth/bankid-signer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/bankid-signer')>()),
  signerPersonalNumberOnFile: (...a: unknown[]) => mocks.onFile(...a),
}))

import { paymentsPartySchema } from '@accounted/connect-contract'
import { createTableMockSupabase } from '@/tests/helpers'
import { toConnectorParty } from '@/lib/payments/initiation/connect'
import { buildPartyContext } from '../party'
import type { DebtorSnapshot } from '../debtor'

const debtor = (bic: string): { debtor_snapshot: DebtorSnapshot } => ({
  debtor_snapshot: { iban: 'SE4550000000058398257466', bban: null, bic, name: 'Företagskonto', currency: 'SEK', bank_name: 'Nordea' },
})
const ctx = () =>
  ({
    supabase: createTableMockSupabase({ company_settings: { data: { org_number: '5595386219' }, error: null } }).supabase,
    companyId: 'co-1',
    userId: 'u-1',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
  }) as never
const signer = (psuAuthoriserId?: string | null) => ({ personalNumber: '199001011239', ipAddress: '203.0.113.1', userAgent: 'UA', psuAuthoriserId })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.onFile.mockResolvedValue(null)
})

describe('the payment party and the Nordea Corporate Netbank logon id', () => {
  it('carries the typed logon id for a Nordea debtor account, and no key without one', async () => {
    const withId = await buildPartyContext(ctx(), debtor('NDEASESS'), signer(' corp-user-1 '), { requireSigner: true })
    expect(withId.ok && withId.ctx).toMatchObject({ debtorBic: 'NDEASESS', signerPersonalNumber: '199001011239', psuAuthoriserId: 'corp-user-1' })
    const without = await buildPartyContext(ctx(), debtor('NDEASESS'), signer(null))
    expect(without.ok && without.ctx).not.toHaveProperty('psuAuthoriserId')
  })

  it('never sends it from another bank, and refuses a malformed one at Nordea by name', async () => {
    const seb = await buildPartyContext(ctx(), debtor('ESSESESS'), signer('corp-user-1'))
    expect(seb.ok && seb.ctx).not.toHaveProperty('psuAuthoriserId')
    expect(await buildPartyContext(ctx(), debtor('NDEASESS'), signer('a;b'))).toEqual({
      ok: false,
      outcome: { ok: false, code: 'VALIDATION_ERROR', details: { field: 'psu_authoriser_id', reason: 'invalid' } },
    })
  })
})

describe('the payment party and the company\'s organisationsnummer (crm#1206)', () => {
  const withOrg = (settings: string | null, company: string | null = null) =>
    ({
      supabase: createTableMockSupabase({
        company_settings: { data: { org_number: settings }, error: null },
        companies: { data: { org_number: company }, error: null },
      }).supabase,
      companyId: 'co-1',
      userId: 'u-1',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
    }) as never

  it('sends an enskild firma\'s personnummer stored with its century as the ten digits the contract takes', async () => {
    const built = await buildPartyContext(withOrg('19121212-1212'), debtor('ESSESESS'), signer())
    expect(built.ok && built.ctx.companyOrgNumber).toBe('1212121212')
    if (!built.ok) throw new Error('party not built')
    expect(paymentsPartySchema.safeParse(toConnectorParty(built.ctx)).success).toBe(true)
  })

  it('names the missing number instead of the generic validation error', async () => {
    expect(await buildPartyContext(withOrg(null), debtor('ESSESESS'), signer())).toEqual({
      ok: false,
      outcome: { ok: false, code: 'PAYMENT_ORG_NUMBER_MISSING', details: { field: 'org_number', reason: 'missing' } },
    })
    expect(await buildPartyContext(withOrg('11223344556'), debtor('ESSESESS'), signer())).toMatchObject({ ok: false, outcome: { code: 'PAYMENT_ORG_NUMBER_MISSING' } })
  })
})
