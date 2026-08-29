/**
 * Tests for the registry-exposed read service fetchVatDeclarationStatus
 * (issue #1663): the SKATTEVERKET_ENABLED gate, the #1673 company-scoped
 * read-auth model, 404 → null semantics for inlamnat/beslutat, and the
 * structured error mapping the v1 route depends on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockSkvRequestWithAuth = vi.fn()
vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, skvRequestWithAuth: (...a: unknown[]) => mockSkvRequestWithAuth(...a) }
})

const mockResolveReadAuth = vi.fn()
vi.mock('../lib/resolve-auth', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, resolveReadAuth: (...a: unknown[]) => mockResolveReadAuth(...a) }
})

const mockResolveRedovisare = vi.fn()
vi.mock('../lib/declaration-prep', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, resolveRedovisare: (...a: unknown[]) => mockResolveRedovisare(...a) }
})

const mockResolvePeriodDates = vi.fn()
vi.mock('@/lib/reports/vat-declaration', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, resolvePeriodDates: (...a: unknown[]) => mockResolvePeriodDates(...a) }
})

const mockWriteAudit = vi.fn()
vi.mock('../lib/audit', () => ({
  writeSkatteverketAudit: (...a: unknown[]) => mockWriteAudit(...a),
}))

vi.mock('@/lib/extensions/context-factory', () => ({
  createExtensionContext: () => ({
    supabase: {},
    companyId: 'company-1',
    userId: 'user-1',
    settings: { set: vi.fn().mockResolvedValue(undefined) },
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  }),
}))

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchVatDeclarationStatus } from '../lib/declaration-status'
import { SkatteverketAuthError } from '../lib/api-client'

const supabase = {} as SupabaseClient
const USER_AUTH = { mode: 'user', supabase, userId: 'user-2', companyId: 'company-1' }

function skvJson(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

let prevEnv: string | undefined
beforeEach(() => {
  vi.clearAllMocks()
  prevEnv = process.env.SKATTEVERKET_ENABLED
  process.env.SKATTEVERKET_ENABLED = 'true'
  mockResolveRedovisare.mockResolvedValue('165560000167')
  mockResolveReadAuth.mockResolvedValue({
    ok: true,
    auth: USER_AUTH,
    source: 'user',
    tokenUserId: 'user-2',
  })
})
afterEach(() => {
  if (prevEnv === undefined) delete process.env.SKATTEVERKET_ENABLED
  else process.env.SKATTEVERKET_ENABLED = prevEnv
})

describe('fetchVatDeclarationStatus', () => {
  it('flag off → EXTENSION_DISABLED, zero SKV calls', async () => {
    delete process.env.SKATTEVERKET_ENABLED
    const result = await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
      periodType: 'monthly', year: 2026, period: 3,
    })
    expect(result).toMatchObject({ ok: false, code: 'EXTENSION_DISABLED', http_status: 503 })
    expect(mockSkvRequestWithAuth).not.toHaveBeenCalled()
  })

  it('missing org number → VALIDATION_ERROR 400', async () => {
    mockResolveRedovisare.mockRejectedValue(
      new Error('Organisationsnummer saknas i företagsinställningar'),
    )
    const result = await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
      periodType: 'monthly', year: 2026, period: 3,
    })
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', http_status: 400 })
    expect(mockSkvRequestWithAuth).not.toHaveBeenCalled()
  })

  it('no company token → SKATTEVERKET_NOT_CONNECTED 401', async () => {
    mockResolveReadAuth.mockResolvedValue({ ok: false, reason: 'no_token' })
    const result = await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
      periodType: 'monthly', year: 2026, period: 3,
    })
    expect(result).toMatchObject({
      ok: false, code: 'SKATTEVERKET_NOT_CONNECTED', http_status: 401,
    })
    expect(mockSkvRequestWithAuth).not.toHaveBeenCalled()
  })

  it('needs_reconsent → SKATTEVERKET_NOT_CONNECTED with reconnect message', async () => {
    mockResolveReadAuth.mockResolvedValue({ ok: false, reason: 'needs_reconsent' })
    const result = await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
      periodType: 'monthly', year: 2026, period: 3,
    })
    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_NOT_CONNECTED' })
    expect((result as { error: string }).error).toContain('förnyas')
  })

  it('happy path both: inlamnat + beslutat via the company-resolved auth (#1673)', async () => {
    mockSkvRequestWithAuth
      .mockResolvedValueOnce(skvJson(200, { skatt: 12500 }))
      .mockResolvedValueOnce(skvJson(200, { beslut: 'FASTSTALLT' }))

    const result = await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
      periodType: 'quarterly', year: 2026, period: 1,
    })

    expect(result).toEqual({
      ok: true,
      redovisare: '165560000167',
      redovisningsperiod: '202603',
      submitted: { skatt: 12500 },
      decided: { beslut: 'FASTSTALLT' },
    })
    // The resolved (possibly another member's) auth is what hits SKV: the
    // caller's own uid is only a preference inside resolveReadAuth.
    expect(mockResolveReadAuth).toHaveBeenCalledWith(supabase, 'company-1', {
      requires: 'moms_ombud', userId: 'user-1',
    })
    expect(mockSkvRequestWithAuth.mock.calls[0]).toEqual([
      USER_AUTH, 'GET', '/inlamnat/165560000167/202603',
    ])
    expect(mockSkvRequestWithAuth.mock.calls[1]).toEqual([
      USER_AUTH, 'GET', '/beslutat/165560000167/202603',
    ])
    // One regulator audit row per SKV view.
    expect(mockWriteAudit).toHaveBeenCalledTimes(2)
    expect(mockWriteAudit.mock.calls[0][1]).toMatchObject({ endpoint: 'inlamnat', outcome: 'ok' })
    expect(mockWriteAudit.mock.calls[1][1]).toMatchObject({ endpoint: 'beslutat', outcome: 'ok' })
  })

  it('404 from SKV means nothing on file: null sections, ok audit outcome', async () => {
    mockSkvRequestWithAuth
      .mockResolvedValueOnce(skvJson(404, {}))
      .mockResolvedValueOnce(skvJson(404, {}))
    const result = await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
      periodType: 'monthly', year: 2026, period: 7,
    })
    expect(result).toEqual({
      ok: true,
      redovisare: '165560000167',
      redovisningsperiod: '202607',
      submitted: null,
      decided: null,
    })
    expect(mockWriteAudit.mock.calls[0][1]).toMatchObject({ outcome: 'ok', responseStatus: 404 })
  })

  it("state='submitted' only calls inlamnat and leaves decided null", async () => {
    mockSkvRequestWithAuth.mockResolvedValueOnce(skvJson(200, { skatt: 1 }))
    const result = await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
      periodType: 'monthly', year: 2026, period: 3, state: 'submitted',
    })
    expect(result).toMatchObject({ ok: true, submitted: { skatt: 1 }, decided: null })
    expect(mockSkvRequestWithAuth).toHaveBeenCalledTimes(1)
    expect(mockSkvRequestWithAuth.mock.calls[0][2]).toBe('/inlamnat/165560000167/202603')
  })

  it("state='decided' only calls beslutat and leaves submitted null", async () => {
    mockSkvRequestWithAuth.mockResolvedValueOnce(skvJson(200, { beslut: 'X' }))
    const result = await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
      periodType: 'monthly', year: 2026, period: 3, state: 'decided',
    })
    expect(result).toMatchObject({ ok: true, submitted: null, decided: { beslut: 'X' } })
    expect(mockSkvRequestWithAuth).toHaveBeenCalledTimes(1)
    expect(mockSkvRequestWithAuth.mock.calls[0][2]).toBe('/beslutat/165560000167/202603')
  })

  it('yearly resolves the fiscal-year end month (broken räkenskapsår)', async () => {
    mockResolvePeriodDates.mockResolvedValue({ start: '2025-07-01', end: '2026-06-30' })
    mockSkvRequestWithAuth.mockResolvedValue(skvJson(404, {}))
    const result = await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
      periodType: 'yearly', year: 2026, period: 1,
    })
    expect(result).toMatchObject({ ok: true, redovisningsperiod: '202606' })
  })

  it('upstream non-404 error → SKATTEVERKET_API_ERROR 502 with skv_error audit', async () => {
    mockSkvRequestWithAuth.mockResolvedValueOnce(skvJson(500, { fel: 'internt' }))
    const result = await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
      periodType: 'monthly', year: 2026, period: 3,
    })
    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_API_ERROR', http_status: 502 })
    expect((result as { error: string }).error).toContain('500')
    // The upstream body is logged server-side only, never forwarded to the
    // API consumer (it can leak Skatteverket system details).
    expect((result as { error: string }).error).not.toContain('internt')
    expect(mockWriteAudit.mock.calls[0][1]).toMatchObject({ outcome: 'skv_error' })
  })

  it('2xx with an unparseable body → SKATTEVERKET_API_ERROR 502 with skv_error audit', async () => {
    mockSkvRequestWithAuth.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input')
      },
      text: async () => '',
    })
    const result = await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
      periodType: 'monthly', year: 2026, period: 3,
    })
    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_API_ERROR', http_status: 502 })
    expect(mockWriteAudit.mock.calls[0][1]).toMatchObject({
      outcome: 'skv_error',
      responseStatus: 200,
    })
  })

  it('SkatteverketAuthError → structured code via skvAuthCodeToStructured', async () => {
    mockSkvRequestWithAuth.mockRejectedValueOnce(
      new SkatteverketAuthError('Behörighet saknas', 'BEHORIGHET_SAKNAS'),
    )
    const result = await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
      periodType: 'monthly', year: 2026, period: 3,
    })
    expect(result).toMatchObject({
      ok: false, code: 'SKATTEVERKET_ACCESS_DENIED', http_status: 403,
    })
  })
})
