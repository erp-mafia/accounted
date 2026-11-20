/**
 * The Bankgiro Lookup service (../bankgiro-lookup.ts): the flag gates every
 * call, the cache spares a second fee, Connect's typed answers map through,
 * and nothing ever throws for a provider failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/connect/instance/connector-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/connect/instance/connector-fetch')>()),
  callConnectorOperation: vi.fn(),
}))
vi.mock('@/lib/connect/instance/upstreams', () => ({ paymentsConnectorMode: vi.fn() }))
vi.mock('@/lib/auth/bankid-signer', () => ({ signerPersonalNumberOnFile: vi.fn() }))
vi.mock('@/lib/sandbox/guard', () => ({ isSandboxCompany: vi.fn() }))

import { PAYMENTS_OPERATIONS } from '@accounted/connect-contract'
import { createTableMockSupabase } from '@/tests/helpers'
import { signerPersonalNumberOnFile } from '@/lib/auth/bankid-signer'
import { ConnectorCallError, callConnectorOperation } from '@/lib/connect/instance/connector-fetch'
import { paymentsConnectorMode } from '@/lib/connect/instance/upstreams'
import type { OperationContext } from '@/lib/operations/types'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import {
  BANKGIRO_LOOKUP_CACHE_TTL_MS,
  bankgiroLookupEnabled,
  bankgiroLookupOpen,
  lookupCompanyGiroNumbers,
  lookupCreditorName,
  resetBankgiroLookupCache,
} from '../bankgiro-lookup'

const call = vi.mocked(callConnectorOperation)
const upstream = vi.mocked(paymentsConnectorMode)
const signer = vi.mocked(signerPersonalNumberOnFile)
const sandbox = vi.mocked(isSandboxCompany)

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const ON = { OPENPAYMENTS_BANKGIRO_LOOKUP: 'true' }
const UPSTREAM = { baseUrl: 'https://connect.example.se/api/connect/payments', key: 'gnubok_ck_test' }

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }

function ctx(orgNumber: string | null = '559538-6219'): OperationContext {
  const { supabase } = createTableMockSupabase({
    company_settings: { data: orgNumber ? { org_number: orgNumber } : null },
    companies: { data: null },
  })
  return { supabase: supabase as unknown as OperationContext['supabase'], companyId: COMPANY, userId: 'user-1', log: log as unknown as OperationContext['log'] }
}

const FOUND = { available: true as const, creditorName: 'Derome Bygg AB', ocrValid: true, warnings: [] }

beforeEach(() => {
  vi.clearAllMocks()
  resetBankgiroLookupCache()
  upstream.mockReturnValue(UPSTREAM)
  signer.mockResolvedValue('199001011239')
  sandbox.mockResolvedValue(false)
})
afterEach(() => vi.unstubAllEnvs())

describe('bankgiroLookupEnabled', () => {
  it('is on only when the flag is exactly true', () => {
    expect(bankgiroLookupEnabled({})).toBe(false)
    expect(bankgiroLookupEnabled({ OPENPAYMENTS_BANKGIRO_LOOKUP: '' })).toBe(false)
    expect(bankgiroLookupEnabled({ OPENPAYMENTS_BANKGIRO_LOOKUP: '1' })).toBe(false)
    expect(bankgiroLookupEnabled({ OPENPAYMENTS_BANKGIRO_LOOKUP: 'TRUE' })).toBe(false)
    expect(bankgiroLookupEnabled({ OPENPAYMENTS_BANKGIRO_LOOKUP: ' true ' })).toBe(true)
    expect(bankgiroLookupEnabled({ OPENPAYMENTS_BANKGIRO_LOOKUP: 'true' })).toBe(true)
  })

  it('reads process.env by default', () => {
    vi.stubEnv('OPENPAYMENTS_BANKGIRO_LOOKUP', 'true')
    expect(bankgiroLookupEnabled()).toBe(true)
    vi.stubEnv('OPENPAYMENTS_BANKGIRO_LOOKUP', '')
    expect(bankgiroLookupEnabled()).toBe(false)
  })
})

describe('bankgiroLookupOpen', () => {
  it('needs the flag, a connector key and a company outside the sandbox, and asks no provider', async () => {
    expect(await bankgiroLookupOpen(ctx(), ON)).toBe(true)
    expect(await bankgiroLookupOpen(ctx(), {})).toBe(false)
    upstream.mockReturnValue(null)
    expect(await bankgiroLookupOpen(ctx(), ON)).toBe(false)
    upstream.mockReturnValue(UPSTREAM)
    sandbox.mockResolvedValue(true)
    expect(await bankgiroLookupOpen(ctx(), ON)).toBe(false)
    expect(call).not.toHaveBeenCalled()
  })
})

describe('lookupCreditorName', () => {
  it('answers enabled false and never calls Connect while the flag is off', async () => {
    expect(await lookupCreditorName(ctx(), { giro: '5050-1055', type: 'bankgiro', ocr: '4400112233' }, { env: {} })).toEqual({ enabled: false })
    expect(call).not.toHaveBeenCalled()
    expect(signer).not.toHaveBeenCalled()
  })

  it('answers enabled false without a connector key, and for a sandbox company', async () => {
    upstream.mockReturnValue(null)
    expect(await lookupCreditorName(ctx(), { giro: '5050-1055', type: 'bankgiro' }, { env: ON })).toEqual({ enabled: false })
    upstream.mockReturnValue(UPSTREAM)
    sandbox.mockResolvedValue(true)
    expect(await lookupCreditorName(ctx(), { giro: '5050-1055', type: 'bankgiro' }, { env: ON })).toEqual({ enabled: false })
    expect(call).not.toHaveBeenCalled()
  })

  it('sends the lookupCreditor operation with the company as party, the giro as digits and the OCR cleaned', async () => {
    call.mockResolvedValue(FOUND)
    const result = await lookupCreditorName(ctx(), { giro: '5050-1055', type: 'bankgiro', ocr: '4400 1122 33' }, { env: ON })
    expect(result).toEqual({ enabled: true, available: true, creditorName: 'Derome Bygg AB', ocrValid: true, warnings: [] })
    expect(call).toHaveBeenCalledTimes(1)
    const options = call.mock.calls[0]![0]
    expect(options.operation).toBe('payments.lookupCreditor')
    expect(options.def).toBe(PAYMENTS_OPERATIONS.lookupCreditor)
    expect(options.upstream).toBe(UPSTREAM)
    expect(options.companyId).toBe(COMPANY)
    expect(options.body).toEqual({
      party: { orgNumber: '5595386219', signerPersonalNumber: '199001011239' },
      giroNumber: '50501055',
      giroType: 'BANKGIRO',
      ocrRef: '4400112233',
    })
    // The body is exactly what the contract takes.
    expect(PAYMENTS_OPERATIONS.lookupCreditor.request.safeParse(options.body).success).toBe(true)
  })

  it('sends the invoice reference (cut to 25 characters) when there is no OCR, and a plusgiro as PLUSGIRO', async () => {
    call.mockResolvedValue({ ...FOUND, ocrValid: null })
    signer.mockResolvedValue(null)
    await lookupCreditorName(ctx('16559538-6219'), { giro: '123456-6', type: 'plusgiro', ocr: 'not an ocr', invoiceRef: ' INV-2026-000123456789012345678 ' }, { env: ON })
    expect(call.mock.calls[0]![0].body).toEqual({
      party: { orgNumber: '5595386219', signerPersonalNumber: null },
      giroNumber: '1234566',
      giroType: 'PLUSGIRO',
      invoiceRef: 'INV-2026-0001234567890123',
    })
  })

  it('refuses a giro that fails its check digit before any call', async () => {
    expect(await lookupCreditorName(ctx(), { giro: '5050-1056', type: 'bankgiro' }, { env: ON })).toEqual({ enabled: true, available: false, reason: 'invalid_number' })
    expect(await lookupCreditorName(ctx(), { giro: '1234568', type: 'plusgiro' }, { env: ON })).toEqual({ enabled: true, available: false, reason: 'invalid_number' })
    expect(call).not.toHaveBeenCalled()
  })

  it('asks nothing for a valid plusgiro shorter than the provider takes', async () => {
    expect(await lookupCreditorName(ctx(), { giro: '45-5', type: 'plusgiro' }, { env: ON })).toEqual({ enabled: true, available: false, reason: 'provider_refused' })
    expect(call).not.toHaveBeenCalled()
  })

  it('answers org_number_missing when the company has no organisationsnummer', async () => {
    expect(await lookupCreditorName(ctx(null), { giro: '5050-1055', type: 'bankgiro' }, { env: ON })).toEqual({ enabled: true, available: false, reason: 'org_number_missing' })
    expect(call).not.toHaveBeenCalled()
  })

  it('passes the typed unavailable reasons through', async () => {
    for (const reason of ['premium_not_enabled', 'not_found', 'provider_refused'] as const) {
      resetBankgiroLookupCache()
      call.mockResolvedValue({ available: false, reason })
      expect(await lookupCreditorName(ctx(), { giro: '5050-1055', type: 'bankgiro' }, { env: ON })).toEqual({ enabled: true, available: false, reason })
    }
  })

  it('never throws: a Connect failure is provider_refused, logged', async () => {
    call.mockRejectedValue(new ConnectorCallError('Connector payments.lookupCreditor: could not reach the service', { code: 'CONNECTOR_UNREACHABLE', retryable: true }))
    expect(await lookupCreditorName(ctx(), { giro: '5050-1055', type: 'bankgiro' }, { env: ON })).toEqual({ enabled: true, available: false, reason: 'provider_refused' })
    expect(log.warn).toHaveBeenCalledWith('bankgiro lookup: Connect did not answer', expect.objectContaining({ type: 'bankgiro' }))
  })

  it('caches a found name per company, giro and OCR for ten minutes, and a not_found; never a provider refusal', async () => {
    let now = 1_000_000
    const deps = { env: ON, now: () => now }
    call.mockResolvedValue(FOUND)
    await lookupCreditorName(ctx(), { giro: '5050-1055', type: 'bankgiro', ocr: '4400112233' }, deps)
    await lookupCreditorName(ctx(), { giro: '50501055', type: 'bankgiro', ocr: '4400112233' }, deps)
    expect(call).toHaveBeenCalledTimes(1)
    // Another OCR is another question.
    await lookupCreditorName(ctx(), { giro: '5050-1055', type: 'bankgiro', ocr: '12' }, deps)
    expect(call).toHaveBeenCalledTimes(2)
    // Expired: asked again.
    now += BANKGIRO_LOOKUP_CACHE_TTL_MS + 1
    await lookupCreditorName(ctx(), { giro: '5050-1055', type: 'bankgiro', ocr: '4400112233' }, deps)
    expect(call).toHaveBeenCalledTimes(3)

    resetBankgiroLookupCache()
    call.mockResolvedValue({ available: false, reason: 'not_found' })
    await lookupCreditorName(ctx(), { giro: '5050-1055', type: 'bankgiro' }, deps)
    await lookupCreditorName(ctx(), { giro: '5050-1055', type: 'bankgiro' }, deps)
    expect(call).toHaveBeenCalledTimes(4)

    resetBankgiroLookupCache()
    call.mockResolvedValue({ available: false, reason: 'provider_refused' })
    await lookupCreditorName(ctx(), { giro: '5050-1055', type: 'bankgiro' }, deps)
    await lookupCreditorName(ctx(), { giro: '5050-1055', type: 'bankgiro' }, deps)
    expect(call).toHaveBeenCalledTimes(6)
  })

  it('keeps the cache per company', async () => {
    call.mockResolvedValue(FOUND)
    await lookupCreditorName(ctx(), { giro: '5050-1055', type: 'bankgiro' }, { env: ON })
    const other = { ...ctx(), companyId: 'c0000000-0000-4000-8000-000000000002' }
    await lookupCreditorName(other, { giro: '5050-1055', type: 'bankgiro' }, { env: ON })
    expect(call).toHaveBeenCalledTimes(2)
  })
})

describe('lookupCompanyGiroNumbers', () => {
  it('answers enabled false while the flag is off, and never calls Connect', async () => {
    expect(await lookupCompanyGiroNumbers(ctx(), { env: {} })).toEqual({ enabled: false })
    expect(call).not.toHaveBeenCalled()
  })

  it('asks for the company\'s registered giro numbers and passes them through', async () => {
    call.mockResolvedValue({ available: true, giroNumbers: [{ number: '5050-1055', type: 'bankgiro', name: 'Derome Bygg AB' }, { number: '123456-7', type: 'plusgiro', name: null }] })
    expect(await lookupCompanyGiroNumbers(ctx(), { env: ON })).toEqual({
      enabled: true,
      available: true,
      giroNumbers: [
        { number: '5050-1055', type: 'bankgiro', name: 'Derome Bygg AB' },
        { number: '123456-7', type: 'plusgiro', name: null },
      ],
    })
    const options = call.mock.calls[0]![0]
    expect(options.operation).toBe('payments.lookupGiroNumbers')
    expect(options.def).toBe(PAYMENTS_OPERATIONS.lookupGiroNumbers)
    expect(options.body).toEqual({ party: { orgNumber: '5595386219', signerPersonalNumber: '199001011239' } })
  })

  it('caches the answer per company and never throws', async () => {
    call.mockResolvedValue({ available: true, giroNumbers: [] })
    await lookupCompanyGiroNumbers(ctx(), { env: ON })
    await lookupCompanyGiroNumbers(ctx(), { env: ON })
    expect(call).toHaveBeenCalledTimes(1)

    resetBankgiroLookupCache()
    call.mockRejectedValue(new Error('boom'))
    expect(await lookupCompanyGiroNumbers(ctx(), { env: ON })).toEqual({ enabled: true, available: false, reason: 'provider_refused' })
  })

  it('answers org_number_missing without a call when the company has no organisationsnummer', async () => {
    expect(await lookupCompanyGiroNumbers(ctx(null), { env: ON })).toEqual({ enabled: true, available: false, reason: 'org_number_missing' })
    expect(call).not.toHaveBeenCalled()
  })
})
