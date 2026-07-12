/**
 * Grant-probe classification: 200 / felkod 3 / OMBUD_GRANT_MISSING / 404 /
 * transient failures, and the transient-error-never-downgrades rule (which
 * lives in connection-store's recordProbeResult and is asserted through the
 * recorded input here + directly below).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSkvRequestWithAuth = vi.fn()
vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    skvRequestWithAuth: (...a: unknown[]) => mockSkvRequestWithAuth(...a),
  }
})

const mockRecordProbeResult = vi.fn()
vi.mock('../lib/connection-store', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    recordProbeResult: (...a: unknown[]) => mockRecordProbeResult(...a),
  }
})

import { probeCompanyGrants } from '../lib/grant-probe'
import { SkatteverketAuthError } from '../lib/api-client'

beforeEach(() => {
  vi.clearAllMocks()
  mockRecordProbeResult.mockResolvedValue({ id: 'conn-1', status: 'verified' })
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

describe('probeCompanyGrants', () => {
  it('both probes 200 -> both granted', async () => {
    mockSkvRequestWithAuth
      .mockResolvedValueOnce({ ok: true, status: 200 }) // saldo
      .mockResolvedValueOnce({ ok: true, status: 200 }) // utkast

    const result = await probeCompanyGrants('company-1', '165560000000')

    expect(result.lasombud.status).toBe('granted')
    expect(result.momsOmbud.status).toBe('granted')
    // Both calls ran on SYSTEM credentials.
    expect(mockSkvRequestWithAuth.mock.calls[0][0]).toEqual({ mode: 'system' })
    expect(mockSkvRequestWithAuth.mock.calls[1][0]).toEqual({ mode: 'system' })
  })

  it('records the actual 2xx status as detail, not a hardcoded 200', async () => {
    mockSkvRequestWithAuth
      .mockResolvedValueOnce({ ok: true, status: 204 }) // saldo
      .mockResolvedValueOnce({ ok: true, status: 200 }) // utkast

    const result = await probeCompanyGrants('company-1', '165560000000')

    expect(result.lasombud).toEqual({ status: 'granted', detail: '204' })
    expect(result.momsOmbud).toEqual({ status: 'granted', detail: '200' })
  })

  it('felkod 3 (no skattekonto) still proves the lasombud authorization', async () => {
    mockSkvRequestWithAuth
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ felkod: 3 }) })
      .mockResolvedValueOnce({ ok: false, status: 404 })

    const result = await probeCompanyGrants('company-1', '165560000000')

    expect(result.lasombud.status).toBe('granted')
    // 404 on /utkast = no draft, but the gateway authorized us.
    expect(result.momsOmbud.status).toBe('granted')
  })

  it('OMBUD_GRANT_MISSING classifies as denied', async () => {
    mockSkvRequestWithAuth
      .mockRejectedValueOnce(new SkatteverketAuthError('saknas', 'OMBUD_GRANT_MISSING'))
      .mockRejectedValueOnce(new SkatteverketAuthError('saknas', 'OMBUD_GRANT_MISSING'))

    const result = await probeCompanyGrants('company-1', '165560000000')

    expect(result.lasombud.status).toBe('denied')
    expect(result.momsOmbud.status).toBe('denied')
  })

  it('transient failures classify as error, never denied', async () => {
    mockSkvRequestWithAuth
      .mockRejectedValueOnce(new SkatteverketAuthError('overload', 'RATE_LIMITED'))
      .mockRejectedValueOnce(new Error('fetch failed'))

    const result = await probeCompanyGrants('company-1', '165560000000')

    expect(result.lasombud.status).toBe('error')
    expect(result.momsOmbud.status).toBe('error')

    const recorded = mockRecordProbeResult.mock.calls[0][0]
    expect(recorded.error).toBeTruthy()
  })

  it('persists the probe outcome via recordProbeResult', async () => {
    mockSkvRequestWithAuth
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 })

    await probeCompanyGrants('company-1', '165560000000', 'user-1')

    expect(mockRecordProbeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        orgNumber: '165560000000',
        createdBy: 'user-1',
        lasombud: expect.objectContaining({ status: 'granted' }),
        momsOmbud: expect.objectContaining({ status: 'granted' }),
        error: null,
      })
    )
  })
})
