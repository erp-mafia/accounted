/**
 * The company verification reads and starts (../availability.ts): the stored
 * record answers when it is fresh, the provider is asked otherwise and every
 * answer is written, a provider that does not answer leaves the last record to
 * speak, and a started form is remembered with its 24-hour link.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import type { OperationContext } from '@/lib/operations/types'
import { PaymentProviderError, registerPaymentInitiationProvider, resetPaymentInitiationProviders } from '@/lib/payments/initiation/provider'

vi.mock('@/lib/entitlements/has-capability', () => ({ hasCapability: vi.fn().mockResolvedValue(true) }))
const mock = vi.hoisted(() => ({ writer: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mock.writer }))

import { hasCapability } from '@/lib/entitlements/has-capability'
import { getCompanyPaymentVerification, startCompanyPaymentVerification } from '../availability'
import { fakeProvider } from './fixtures'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const USER = 'd0000000-0000-4000-8000-0000000000aa'
const NOW = new Date('2026-10-13T10:00:00Z')
const HOUR = 60 * 60 * 1000

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
let writer: ReturnType<typeof createTableMockSupabase>
let session: ReturnType<typeof createTableMockSupabase>

function ctx(userId = USER): OperationContext {
  return { supabase: session.supabase as unknown as SupabaseClient, companyId: COMPANY, userId, log }
}

function stored(overrides: Record<string, unknown> = {}) {
  return {
    company_id: COMPANY,
    status: 'valid',
    valid_until: '2027-10-03',
    checked_at: new Date(NOW.getTime() - HOUR).toISOString(),
    link_created_at: null,
    link_expires_at: null,
    handed_off_at: null,
    started_by: null,
    updated_at: NOW.toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetPaymentInitiationProviders()
  vi.mocked(hasCapability).mockResolvedValue(true)
  session = createTableMockSupabase({ company_settings: { data: { org_number: '5560160680' } } })
  writer = createTableMockSupabase()
  mock.writer = writer.supabase
})

describe('getCompanyPaymentVerification', () => {
  it('asks the provider when nothing is on file, stores the answer and derives the state from the stored row', async () => {
    const provider = fakeProvider({ getCompanyVerification: vi.fn().mockResolvedValue({ status: 'valid', validUntil: '2027-10-03' }) })
    registerPaymentInitiationProvider(provider)
    writer.setTable('company_payment_verifications', [{ data: null }, { data: null }, { data: stored({ checked_at: NOW.toISOString() }) }])

    const outcome = await getCompanyPaymentVerification(ctx(), { now: NOW })

    expect(outcome).toEqual({
      ok: true,
      data: { status: 'valid', valid_until: '2027-10-03', state: 'valid', link_expires_at: null, checked_at: NOW.toISOString() },
    })
    expect(provider.getCompanyVerification).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY, companyOrgNumber: '5560160680', accountContext: 'corporate' }))
    expect(writer.findCall('company_payment_verifications', 'upsert')).toEqual([
      { company_id: COMPANY, status: 'valid', valid_until: '2027-10-03', checked_at: NOW.toISOString() },
      { onConflict: 'company_id' },
    ])
  })

  it('answers the stored record without a provider call while it is fresh, and asks again when forced or stale', async () => {
    const provider = fakeProvider({ getCompanyVerification: vi.fn().mockResolvedValue({ status: 'valid', validUntil: '2027-10-03' }) })
    registerPaymentInitiationProvider(provider)
    writer.setTable('company_payment_verifications', { data: stored() })

    const fresh = await getCompanyPaymentVerification(ctx(), { now: NOW })
    expect(fresh).toMatchObject({ ok: true, data: { state: 'valid', valid_until: '2027-10-03' } })
    expect(provider.getCompanyVerification).not.toHaveBeenCalled()
    expect(writer.findCall('company_payment_verifications', 'upsert')).toBeUndefined()

    await getCompanyPaymentVerification(ctx(), { now: NOW, refresh: true })
    expect(provider.getCompanyVerification).toHaveBeenCalledTimes(1)

    writer.setTable('company_payment_verifications', { data: stored({ checked_at: new Date(NOW.getTime() - 7 * HOUR).toISOString() }) })
    await getCompanyPaymentVerification(ctx(), { now: NOW })
    expect(provider.getCompanyVerification).toHaveBeenCalledTimes(2)
  })

  it('asks again while a form is out, so the poll sees the signature land', async () => {
    const provider = fakeProvider({ getCompanyVerification: vi.fn().mockResolvedValue({ status: 'valid', validUntil: '2027-10-03' }) })
    registerPaymentInitiationProvider(provider)
    const created = new Date(NOW.getTime() - HOUR)
    const formOut = stored({ status: 'invalid', valid_until: null, link_created_at: created.toISOString(), link_expires_at: new Date(created.getTime() + 24 * HOUR).toISOString(), checked_at: new Date(NOW.getTime() - 60_000).toISOString() })
    writer.setTable('company_payment_verifications', [{ data: formOut }, { data: null }, { data: { ...formOut, status: 'valid', valid_until: '2027-10-03', checked_at: NOW.toISOString() } }])

    const outcome = await getCompanyPaymentVerification(ctx(), { now: NOW })

    expect(provider.getCompanyVerification).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ ok: true, data: { status: 'valid', state: 'valid', link_expires_at: formOut.link_expires_at } })
  })

  it('lets the last known record speak when the provider does not answer, and fails only with nothing on file', async () => {
    const provider = fakeProvider({ getCompanyVerification: vi.fn().mockRejectedValue(new PaymentProviderError('down', 'TIMEOUT', true, 504)) })
    registerPaymentInitiationProvider(provider)
    writer.setTable('company_payment_verifications', { data: stored({ checked_at: new Date(NOW.getTime() - 8 * HOUR).toISOString() }) })

    const withRecord = await getCompanyPaymentVerification(ctx(), { now: NOW })
    expect(withRecord).toMatchObject({ ok: true, data: { status: 'valid', state: 'valid', valid_until: '2027-10-03' } })
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/stored record/), { code: 'TIMEOUT' })

    writer.setTable('company_payment_verifications', { data: null })
    expect(await getCompanyPaymentVerification(ctx(), { now: NOW })).toEqual({ ok: false, code: 'PAYMENT_PROVIDER_UNAVAILABLE', details: { provider_code: 'TIMEOUT' } })

    registerPaymentInitiationProvider(fakeProvider({ getCompanyVerification: vi.fn().mockRejectedValue(new PaymentProviderError('no', 'KYC_REFUSED', false, 400)) }))
    // The provider's code rides along, so the refusal's log line names it.
    expect(await getCompanyPaymentVerification(ctx(), { now: NOW })).toEqual({ ok: false, code: 'PAYMENT_PROVIDER_REFUSED', details: { provider_code: 'KYC_REFUSED' } })
  })

  it('refuses behind a closed door and without an organisationsnummer', async () => {
    expect(await getCompanyPaymentVerification(ctx(), { now: NOW })).toEqual({ ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: 'no_provider' } })

    registerPaymentInitiationProvider(fakeProvider())
    vi.mocked(hasCapability).mockResolvedValueOnce(false)
    expect(await getCompanyPaymentVerification(ctx(), { now: NOW })).toEqual({ ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: 'subscription' } })

    session.setTable('company_settings', { data: { org_number: null } })
    session.setTable('companies', { data: { org_number: null } })
    expect(await getCompanyPaymentVerification(ctx(), { now: NOW })).toEqual({ ok: false, code: 'PAYMENT_ORG_NUMBER_MISSING', details: { field: 'org_number', reason: 'missing' } })
  })

  it('addresses an enskild firma by the ten digits of the personnummer stored with its century (crm#1206)', async () => {
    const provider = fakeProvider({ getCompanyVerification: vi.fn().mockResolvedValue({ status: 'valid', validUntil: '2027-10-03' }) })
    registerPaymentInitiationProvider(provider)
    session.setTable('company_settings', { data: { org_number: '19121212-1212' } })
    writer.setTable('company_payment_verifications', [{ data: null }, { data: null }, { data: stored({ checked_at: NOW.toISOString() }) }])

    expect(await getCompanyPaymentVerification(ctx(), { now: NOW })).toMatchObject({ ok: true })
    expect(provider.getCompanyVerification).toHaveBeenCalledWith(expect.objectContaining({ companyOrgNumber: '1212121212' }))
  })
})

describe('startCompanyPaymentVerification', () => {
  it('creates the form at the provider, remembers the link for 24 hours and answers form_open', async () => {
    const provider = fakeProvider({ startCompanyVerification: vi.fn().mockResolvedValue({ url: 'https://kyc.openbankingplatform.com/?instanceId=abc' }) })
    registerPaymentInitiationProvider(provider)
    const after = stored({ status: 'invalid', valid_until: null, checked_at: null, link_created_at: NOW.toISOString(), link_expires_at: new Date(NOW.getTime() + 24 * HOUR).toISOString(), started_by: USER })
    writer.setTable('company_payment_verifications', [{ data: null }, { data: after }])

    const outcome = await startCompanyPaymentVerification(ctx(), { now: NOW })

    expect(outcome).toEqual({
      ok: true,
      data: { url: 'https://kyc.openbankingplatform.com/?instanceId=abc', expires_at: new Date(NOW.getTime() + 24 * HOUR).toISOString(), state: 'form_open' },
    })
    expect(writer.findCall('company_payment_verifications', 'upsert')).toEqual([
      {
        company_id: COMPANY,
        link_url: 'https://kyc.openbankingplatform.com/?instanceId=abc',
        link_created_at: NOW.toISOString(),
        link_expires_at: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
        handed_off_at: null,
        started_by: USER,
      },
      { onConflict: 'company_id' },
    ])
  })

  it('marks the hand-off when the link is for a firmatecknare, and stores no non-person actor', async () => {
    registerPaymentInitiationProvider(fakeProvider({ startCompanyVerification: vi.fn().mockResolvedValue({ url: 'https://kyc.example/?i=1' }) }))
    const after = stored({ status: 'invalid', valid_until: null, checked_at: null, link_created_at: NOW.toISOString(), link_expires_at: new Date(NOW.getTime() + 24 * HOUR).toISOString(), handed_off_at: NOW.toISOString() })
    writer.setTable('company_payment_verifications', [{ data: null }, { data: after }])

    const outcome = await startCompanyPaymentVerification(ctx('anonymous'), { now: NOW, handoff: true })

    expect(outcome).toMatchObject({ ok: true, data: { state: 'awaiting_signatory' } })
    expect(writer.findCall('company_payment_verifications', 'upsert')![0]).toMatchObject({ handed_off_at: NOW.toISOString(), started_by: null })
  })

  it('writes nothing when the provider refuses to create the form', async () => {
    registerPaymentInitiationProvider(fakeProvider({ startCompanyVerification: vi.fn().mockRejectedValue(new PaymentProviderError('no', 'KYC_REFUSED', false, 400)) }))
    expect(await startCompanyPaymentVerification(ctx(), { now: NOW })).toEqual({ ok: false, code: 'PAYMENT_PROVIDER_REFUSED', details: { provider_code: 'KYC_REFUSED' } })
    expect(writer.tables()).toEqual([])
  })
})
