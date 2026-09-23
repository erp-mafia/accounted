import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fetchCompanySearch } from '../fetch-company-lookup'
import type { CompanyLookupResult, CompanySearchHit } from '../types'

const LOOKUP: CompanyLookupResult = {
  companyName: 'Testbrand AB',
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

const HIT: CompanySearchHit = { orgNumber: '5560360793', result: LOOKUP }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('fetchCompanySearch', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('returns disabled without fetching when tic is not enabled', async () => {
    const outcome = await fetchCompanySearch('Testbrand', { ticEnabled: false })
    expect(outcome).toEqual({ status: 'disabled' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns disabled without fetching for a query under the minimum length', async () => {
    const outcome = await fetchCompanySearch(' ab ', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'disabled' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('calls the search route with the trimmed, encoded query', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [HIT] }))
    await fetchCompanySearch('  Testbrand & Co ', { ticEnabled: true })
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      '/api/extensions/ext/tic/search?q=Testbrand%20%26%20Co',
    )
  })

  it('returns the hits on 200', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [HIT, { ...HIT, orgNumber: '5591234567' }] }))
    const outcome = await fetchCompanySearch('Testbrand', { ticEnabled: true })
    expect(outcome.status).toBe('found')
    if (outcome.status !== 'found') throw new Error('unreachable')
    expect(outcome.hits.map((h) => h.orgNumber)).toEqual(['5560360793', '5591234567'])
  })

  it('drops malformed hits and maps an all-malformed payload to not_found', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ orgNumber: 1 }, { result: LOOKUP }] }))
    const outcome = await fetchCompanySearch('Testbrand', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'not_found' })
  })

  it('maps a non-array data payload to error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { orgNumber: '5560360793' } }))
    const outcome = await fetchCompanySearch('Testbrand', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'error' })
  })

  it("maps the TIC handler's 404 (Company not found) to not_found", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'Company not found' }))
    const outcome = await fetchCompanySearch('Testbrand', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'not_found' })
  })

  it("maps the dispatcher's 404 (Route not found) to disabled", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'Route not found' }))
    const outcome = await fetchCompanySearch('Testbrand', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'disabled' })
  })

  it('maps a feature-flag 503 to disabled and any other 5xx to error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { code: 'EXTENSION_DISABLED' }))
    expect(await fetchCompanySearch('Testbrand', { ticEnabled: true })).toEqual({ status: 'disabled' })
    fetchMock.mockResolvedValueOnce(jsonResponse(502, { error: 'upstream' }))
    expect(await fetchCompanySearch('Testbrand', { ticEnabled: true })).toEqual({ status: 'error' })
  })

  it('maps 429 to error (advisory note, manual path)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: 'Rate limit exceeded' }))
    expect(await fetchCompanySearch('Testbrand', { ticEnabled: true })).toEqual({ status: 'error' })
  })

  it('maps a network failure to error and an abort to aborted', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await fetchCompanySearch('Testbrand', { ticEnabled: true })).toEqual({ status: 'error' })
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    fetchMock.mockRejectedValueOnce(abortErr)
    expect(await fetchCompanySearch('Testbrand', { ticEnabled: true })).toEqual({ status: 'aborted' })
  })
})
