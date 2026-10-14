/**
 * Tests for the extension's registry-exposed commit services: specifically the
 * VAT "send for signing" chain (POST /utkast → PUT /las → signeringslänk), the
 * SKATTEVERKET_ENABLED flag gate, and SkatteverketAuthError → recoverable
 * mapping. The op-lifecycle translation is covered separately in
 * lib/pending-operations/__tests__/skatteverket-executors.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockSkvRequest = vi.fn()
vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, skvRequest: (...a: unknown[]) => mockSkvRequest(...a) }
})

const mockBuildMomsuppgift = vi.fn()
vi.mock('../lib/declaration-prep', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, buildMomsuppgift: (...a: unknown[]) => mockBuildMomsuppgift(...a) }
})

vi.mock('../lib/audit', () => ({ writeSkatteverketAudit: vi.fn() }))

// The chain's completeness verdict runs for real; only its per-verifikat
// ledger scan is stubbed.
vi.mock('@/lib/reports/rc-basis-gaps', () => ({ findRcBasisGaps: vi.fn(async () => []) }))

vi.mock('@/lib/extensions/context-factory', () => ({
  createExtensionContext: () => ({
    supabase: {rpc:vi.fn().mockResolvedValue({data:'read-lease-token',error:null})},
    companyId: 'company-1',
    userId: 'user-1',
    settings: { set: vi.fn().mockResolvedValue(undefined) },
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  }),
}))

import { skatteverketExtension } from '../index'
import { SkatteverketAuthError } from '../lib/api-client'
import { vatDeclarationFixture } from './vat-declaration-fixture'

const MARCH = { type: 'monthly' as const, year: 2025, period: 3, start: '2025-03-01', end: '2025-03-31' }

type SkvSubmitFn = (
  supabase: unknown, userId: string, companyId: string, params: Record<string, unknown>,
) => Promise<{
  ok: boolean; code?: string; recoverable?: boolean; signing_url?: string; error?: string
  details?: Record<string, unknown>
}>

const commitSubmitVatDeclaration = skatteverketExtension.services!.commitSubmitVatDeclaration as unknown as SkvSubmitFn
const VAT_PARAMS = { period_type: 'monthly', year: 2025, period: 3 }

let prevEnv: string | undefined
beforeEach(() => {
  vi.clearAllMocks()
  prevEnv = process.env.SKATTEVERKET_ENABLED
  process.env.SKATTEVERKET_ENABLED = 'true'
  mockBuildMomsuppgift.mockResolvedValue({
    redovisare: '165560000000', redovisningsperiod: '202503', momsuppgift: { summaMoms: 150 },
    declaration: vatDeclarationFixture({ ruta05: 600, ruta10: 150, ruta49: 150 }, { period: MARCH }),
  })
})
afterEach(() => {
  if (prevEnv === undefined) delete process.env.SKATTEVERKET_ENABLED
  else process.env.SKATTEVERKET_ENABLED = prevEnv
})

describe('commitSubmitVatDeclaration', () => {
  it('flag off → recoverable EXTENSION_DISABLED, zero SKV calls', async () => {
    delete process.env.SKATTEVERKET_ENABLED
    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)
    expect(result).toMatchObject({ ok: false, code: 'EXTENSION_DISABLED', recoverable: true })
    expect(mockSkvRequest).not.toHaveBeenCalled()
  })

  it('happy path: POST /utkast then PUT /las → ok with signing_url', async () => {
    mockSkvRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ kontrollResultat: { status: 'OK' } }) }) // utkast
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ signeringsLank: 'https://skv.test/sign/abc' }) }) // las

    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)

    expect(result).toMatchObject({ ok: true, signing_url: 'https://skv.test/sign/abc' })
    expect(mockSkvRequest).toHaveBeenCalledTimes(2)
    // call order: utkast (POST) before las (PUT)
    expect(mockSkvRequest.mock.calls[0][3]).toBe('POST')
    expect(mockSkvRequest.mock.calls[0][4]).toMatch(/^\/utkast\/165560000000\/202503$/)
    expect(mockSkvRequest.mock.calls[1][3]).toBe('PUT')
    expect(mockSkvRequest.mock.calls[1][4]).toMatch(/^\/las\/165560000000\/202503$/)
  })

  it('utkast rejected by SKV → non-recoverable, no /las call', async () => {
    mockSkvRequest.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad rutor' })
    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)
    expect(result).toMatchObject({ ok: false, recoverable: false, http_status: 400 })
    expect(mockSkvRequest).toHaveBeenCalledTimes(1) // never reached /las
  })

  // An op staged while the books passed, approved after they changed: the
  // chain's completeness verdict refuses it before any call to Skatteverket,
  // and the op is consumed (non-recoverable), not released back to pending.
  // VAT_PARAMS is the params shape every op already staged carries.
  it('books now incomplete → non-recoverable VAT_DECLARATION_INCOMPLETE with the findings, zero SKV calls', async () => {
    mockBuildMomsuppgift.mockResolvedValueOnce({
      redovisare: '165560000000', redovisningsperiod: '202503', momsuppgift: { summaMoms: 0 },
      declaration: vatDeclarationFixture({ ruta30: 250, ruta48: 250, ruta49: 0 }, { rc2645: 250, period: MARCH }),
    })

    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)

    expect(result).toMatchObject({
      ok: false, code: 'VAT_DECLARATION_INCOMPLETE', http_status: 422, recoverable: false,
    })
    expect(result.error).toMatch(/ofullständig/)
    expect(result.details?.completeness_checks).toContainEqual(
      expect.objectContaining({ code: 'RC_BASIS_MISSING', status: 'ERROR' }),
    )
    expect(mockSkvRequest).not.toHaveBeenCalled()
  })

  it('SkatteverketAuthError → recoverable SKATTEVERKET_NOT_CONNECTED', async () => {
    mockSkvRequest.mockRejectedValueOnce(new SkatteverketAuthError('ingen anslutning', 'NOT_CONNECTED'))
    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)
    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_NOT_CONNECTED', recoverable: true })
  })
})
