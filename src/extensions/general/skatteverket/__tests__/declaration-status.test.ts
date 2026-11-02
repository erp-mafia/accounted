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

const mockRecordVatFilingConfirmed = vi.fn()
const mockSettingsGet = vi.fn()
const mockSettingsSet = vi.fn()
vi.mock('@/lib/vat/filing-record-store', () => ({
  recordVatFilingConfirmed: (...a: unknown[]) => mockRecordVatFilingConfirmed(...a),
}))

vi.mock('@/lib/extensions/context-factory', () => ({
  createExtensionContext: () => ({
    supabase: {},
    companyId: 'company-1',
    userId: 'user-1',
    settings: {
      get: (...a: unknown[]) => mockSettingsGet(...a),
      set: (...a: unknown[]) => mockSettingsSet(...a),
    },
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
  mockRecordVatFilingConfirmed.mockResolvedValue({ record: {}, created: true, changed: true })
  mockSettingsGet.mockResolvedValue(null)
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
    // One audited transport call per SKV view, recorded against the caller
    // (not the token owner): 404 is a normal answer, and a 2xx must be JSON.
    const audit = (endpoint: string) => ({
      endpoint,
      companyId: 'company-1',
      userId: 'user-1',
      agRegistreradId: '165560000167',
      redovisningsperiod: '202603',
      okStatuses: [404],
      expectJson: true,
    })
    expect(mockSkvRequestWithAuth.mock.calls[0]).toEqual([
      USER_AUTH, 'GET', '/inlamnat/165560000167/202603', audit('inlamnat'),
    ])
    expect(mockSkvRequestWithAuth.mock.calls[1]).toEqual([
      USER_AUTH, 'GET', '/beslutat/165560000167/202603', audit('beslutat'),
    ])
    // The transport writes the rows; the service writes none of its own.
    expect(mockWriteAudit).not.toHaveBeenCalled()
  })

  it('404 from SKV means nothing on file: null sections (audited ok via okStatuses)', async () => {
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
    expect(mockSkvRequestWithAuth.mock.calls[0][3]).toMatchObject({ okStatuses: [404] })
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

  it('upstream non-404 error → SKATTEVERKET_API_ERROR 502', async () => {
    mockSkvRequestWithAuth.mockResolvedValueOnce(skvJson(500, { fel: 'internt' }))
    const result = await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
      periodType: 'monthly', year: 2026, period: 3,
    })
    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_API_ERROR', http_status: 502 })
    expect((result as { error: string }).error).toContain('500')
    // The upstream body is logged server-side only, never forwarded to the
    // API consumer (it can leak Skatteverket system details).
    expect((result as { error: string }).error).not.toContain('internt')
  })

  it('2xx with an unparseable body → SKATTEVERKET_API_ERROR 502 (audited skv_error via expectJson)', async () => {
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
    expect(mockSkvRequestWithAuth.mock.calls[0][3]).toMatchObject({ expectJson: true })
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

  // crm#1607: an agent signed with BankID, read the kvittens through this
  // service, and the filing record (Moms page step 4, list_vat_filings) still
  // waited for the two-hourly kvittens cron.
  describe('records a locked submission Skatteverket now has on file (crm#1607)', () => {
    const locked = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        status: 'draft_locked',
        redovisare: '165560000167',
        redovisningsperiod: '202610',
        periodType: 'monthly',
        year: 2026,
        period: 10,
        signeringsLank: 'https://skatteverket.se/sign',
        ...extra,
      })

    it('a submitted declaration confirms the period at once, not on the next cron run', async () => {
      mockSettingsGet.mockResolvedValue(locked())
      mockSkvRequestWithAuth.mockResolvedValueOnce(
        skvJson(200, { kvittensnummer: 'K-1', tidpunkt: '2026-11-02T11:55:43' }),
      )
      const result = await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
        periodType: 'monthly', year: 2026, period: 10, state: 'submitted',
      })
      expect(result).toMatchObject({ ok: true, submitted: { kvittensnummer: 'K-1' } })
      expect(mockSettingsGet).toHaveBeenCalledWith('submission_202610')
      expect(mockRecordVatFilingConfirmed).toHaveBeenCalledTimes(1)
      expect(mockRecordVatFilingConfirmed).toHaveBeenCalledWith(supabase, 'company-1', {
        periodType: 'monthly', year: 2026, period: 10,
      })
    })

    // A locked ändringsdeklaration over a period already on file: the period
    // is filed (that is what the record says), but the correction is not
    // signed yet. The stored state is never touched here, so its signing
    // link stays on the Moms page; flipping it to 'signed' and the kvittens
    // email stay with the cron.
    it('never writes the stored state: a locked correction keeps its signing link', async () => {
      mockSettingsGet.mockResolvedValue(locked())
      mockSkvRequestWithAuth
        .mockResolvedValueOnce(skvJson(200, { kvittensnummer: 'K-original' }))
        .mockResolvedValueOnce(skvJson(200, { beslut: 'FASTSTALLT' }))
      await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
        periodType: 'monthly', year: 2026, period: 10,
      })
      expect(mockRecordVatFilingConfirmed).toHaveBeenCalledTimes(1)
      expect(mockSettingsSet).not.toHaveBeenCalled()
    })

    it('a beslut alone also confirms it', async () => {
      mockSettingsGet.mockResolvedValue(locked())
      mockSkvRequestWithAuth.mockResolvedValueOnce(skvJson(200, { beslut: 'X' }))
      await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
        periodType: 'monthly', year: 2026, period: 10, state: 'decided',
      })
      expect(mockRecordVatFilingConfirmed).toHaveBeenCalledTimes(1)
    })

    it('the cadence is the one filed, not the one asked: quarterly 1 shares 202603 with monthly 3', async () => {
      mockSettingsGet.mockResolvedValue(
        locked({ redovisningsperiod: '202603', periodType: 'monthly', period: 3 }),
      )
      mockSkvRequestWithAuth.mockResolvedValueOnce(skvJson(200, { skatt: 1 }))
      await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
        periodType: 'quarterly', year: 2026, period: 1, state: 'submitted',
      })
      expect(mockSettingsGet).toHaveBeenCalledWith('submission_202603')
      expect(mockRecordVatFilingConfirmed).toHaveBeenCalledWith(supabase, 'company-1', {
        periodType: 'monthly', year: 2026, period: 3,
      })
    })

    it('yearly is recorded as period 1, as the cron does', async () => {
      mockResolvePeriodDates.mockResolvedValue({ start: '2025-07-01', end: '2026-06-30' })
      mockSettingsGet.mockResolvedValue(
        locked({ redovisningsperiod: '202606', periodType: 'yearly', period: 6 }),
      )
      mockSkvRequestWithAuth.mockResolvedValueOnce(skvJson(200, { skatt: 1 }))
      await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
        periodType: 'yearly', year: 2026, period: 1, state: 'submitted',
      })
      expect(mockRecordVatFilingConfirmed).toHaveBeenCalledWith(supabase, 'company-1', {
        periodType: 'yearly', year: 2026, period: 1,
      })
    })

    it.each([
      ['no stored state (filed outside the app)', null],
      ['a draft not yet locked', JSON.stringify({ status: 'draft_saved', periodType: 'monthly', year: 2026, period: 10 })],
      ['an already signed state', JSON.stringify({ status: 'signed', periodType: 'monthly', year: 2026, period: 10 })],
      ['a locked state from the older routes, without picker params', JSON.stringify({ status: 'draft_locked' })],
    ])('%s records nothing', async (_label, stored) => {
      mockSettingsGet.mockResolvedValue(stored)
      mockSkvRequestWithAuth.mockResolvedValueOnce(skvJson(200, { skatt: 1 }))
      await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
        periodType: 'monthly', year: 2026, period: 10, state: 'submitted',
      })
      expect(mockRecordVatFilingConfirmed).not.toHaveBeenCalled()
    })

    it('nothing on file at Skatteverket records nothing', async () => {
      mockSettingsGet.mockResolvedValue(locked())
      mockSkvRequestWithAuth
        .mockResolvedValueOnce(skvJson(404, {}))
        .mockResolvedValueOnce(skvJson(404, {}))
      await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
        periodType: 'monthly', year: 2026, period: 10,
      })
      expect(mockRecordVatFilingConfirmed).not.toHaveBeenCalled()
    })

    it('an upstream failure records nothing', async () => {
      mockSettingsGet.mockResolvedValue(locked())
      mockSkvRequestWithAuth.mockResolvedValueOnce(skvJson(500, {}))
      await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
        periodType: 'monthly', year: 2026, period: 10,
      })
      expect(mockRecordVatFilingConfirmed).not.toHaveBeenCalled()
    })

    it('a failed record write never fails the status answer', async () => {
      mockSettingsGet.mockResolvedValue(locked())
      mockRecordVatFilingConfirmed.mockRejectedValueOnce(new Error('db down'))
      mockSkvRequestWithAuth.mockResolvedValueOnce(skvJson(200, { skatt: 1 }))
      const result = await fetchVatDeclarationStatus(supabase, 'user-1', 'company-1', {
        periodType: 'monthly', year: 2026, period: 10, state: 'submitted',
      })
      expect(result).toMatchObject({ ok: true, submitted: { skatt: 1 } })
    })
  })
})
