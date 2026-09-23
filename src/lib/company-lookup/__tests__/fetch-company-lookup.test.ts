import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fetchCompanyLookup } from '../fetch-company-lookup'
import type { CompanyLookupResult } from '../types'

const LOOKUP: CompanyLookupResult = {
  companyName: 'Nordvik Bygg & Konsult AB',
  isCeased: false,
  address: { street: 'Storgatan 1', postalCode: '211 34', city: 'Malmö' },
  registration: { fTax: true, vat: true },
  bankAccounts: [],
  email: null,
  phone: null,
  sniCodes: [],
  fiscalYear: { startMonthDay: '01-01', endMonthDay: '12-31' },
  legalEntityType: 'AB',
  registrationDate: 1710000000000,
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('fetchCompanyLookup', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('returns disabled without fetching when tic is not enabled', async () => {
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: false })
    expect(outcome).toEqual({ status: 'disabled' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns disabled without fetching for a malformed orgnr', async () => {
    const outcome = await fetchCompanyLookup('12', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'disabled' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns the lookup result on 200', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: LOOKUP }))
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'found', result: LOOKUP })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/api/extensions/ext/tic/lookup?org_number=',
    )
  })

  it("maps the TIC handler's 404 (Company not found) to not_found", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'Company not found' }))
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'not_found' })
  })

  it("carries the SCB registry hint beside the TIC handler's 404", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, {
        error: 'Company not found',
        registry: {
          source: 'scb',
          companyName: 'Segelsällskapet Gambit',
          legalEntityType: 'Ideell förening',
          address: { street: 'Hamnvägen 3', postalCode: '76140', city: 'Norrtälje' },
          registration: { fTax: null, vat: true },
        },
      }),
    )
    const outcome = await fetchCompanyLookup('802481-1658', { ticEnabled: true })
    expect(outcome).toEqual({
      status: 'not_found',
      registry: {
        source: 'scb',
        companyName: 'Segelsällskapet Gambit',
        legalEntityType: 'Ideell förening',
        address: { street: 'Hamnvägen 3', postalCode: '76140', city: 'Norrtälje' },
        registration: { fTax: null, vat: true },
      },
    })
  })

  it('drops a malformed registry hint and keeps the miss', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, { error: 'Company not found', registry: { source: 'tic', companyName: 42 } }),
    )
    const outcome = await fetchCompanyLookup('802481-1658', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'not_found' })
  })

  it("maps the dispatcher's 404 (Extension not found) to disabled, not not_found", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'Extension not found' }))
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'disabled' })
  })

  it('maps a legacy 403 to disabled', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: 'Extension disabled' }))
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'disabled' })
  })

  it('maps a feature-flag 503 (EXTENSION_DISABLED) to disabled', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(503, { error: 'Not in this environment', code: 'EXTENSION_DISABLED' }),
    )
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'disabled' })
  })

  it('maps NOT_CONFIGURED 503 to error (advisory note, manual path)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { error: 'TIC is not configured' }))
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'error' })
  })

  it('maps 429 rate limit and 504 timeout to error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: 'Rate limit exceeded' }))
    expect(await fetchCompanyLookup('556677-8899', { ticEnabled: true })).toEqual({
      status: 'error',
    })
    fetchMock.mockResolvedValue(jsonResponse(504, { error: 'Timeout' }))
    expect(await fetchCompanyLookup('556677-8899', { ticEnabled: true })).toEqual({
      status: 'error',
    })
  })

  it('maps a network failure to error without throwing', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'error' })
  })

  it('maps an abort to aborted', async () => {
    const abortError = new DOMException('Aborted', 'AbortError')
    fetchMock.mockRejectedValue(abortError)
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'aborted' })
  })

  it('returns aborted when the signal fired during the response', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(async () => {
      controller.abort()
      return jsonResponse(200, { data: LOOKUP })
    })
    const outcome = await fetchCompanyLookup('556677-8899', {
      ticEnabled: true,
      signal: controller.signal,
    })
    expect(outcome).toEqual({ status: 'aborted' })
  })

  it('maps a malformed success body to error', async () => {
    fetchMock.mockResolvedValue(
      new Response('not json', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    )
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'error' })
  })
})
