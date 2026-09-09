import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fetchCompanySuggestions } from '../fetch-company-lookup'
import type { CompanySuggestion } from '../types'

const ROW: CompanySuggestion = {
  orgNumber: '5566778899',
  name: 'Testbrand AB',
  city: 'Malmö',
  legalEntityType: 'AB',
  active: true,
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('fetchCompanySuggestions', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('returns disabled without fetching below the minimum length', async () => {
    expect(await fetchCompanySuggestions('Te')).toEqual({ status: 'disabled' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('calls the core search route, never TIC, and returns the rows', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { suggestions: [ROW], truncated: false } }))
    const outcome = await fetchCompanySuggestions('  Testbrand ')
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/company/search?q=Testbrand')
    expect(outcome).toEqual({ status: 'found', suggestions: [ROW], truncated: false })
  })

  it('reports an empty list with the truncation flag so the field can ask for more', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { suggestions: [], truncated: true } }))
    expect(await fetchCompanySuggestions('Sve')).toEqual({ status: 'empty', truncated: true })
  })

  it('drops malformed rows and treats a malformed body as an error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { suggestions: [ROW, { name: 1 }, null], truncated: false } }))
    expect(await fetchCompanySuggestions('Testbrand')).toEqual({ status: 'found', suggestions: [ROW], truncated: false })
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { nope: true } }))
    expect(await fetchCompanySuggestions('Testbrand')).toEqual({ status: 'error' })
  })

  it('maps 503 to disabled and every other failure to error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: { code: 'SCB_NOT_CONFIGURED' } }))
    expect(await fetchCompanySuggestions('Testbrand')).toEqual({ status: 'disabled' })
    fetchMock.mockResolvedValueOnce(jsonResponse(502, { error: { code: 'SCB_LOOKUP_FAILED' } }))
    expect(await fetchCompanySuggestions('Testbrand')).toEqual({ status: 'error' })
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { code: 'UNAUTHORIZED' } }))
    expect(await fetchCompanySuggestions('Testbrand')).toEqual({ status: 'error' })
    fetchMock.mockRejectedValueOnce(new TypeError('network'))
    expect(await fetchCompanySuggestions('Testbrand')).toEqual({ status: 'error' })
  })

  it('returns aborted when the caller cancels', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    fetchMock.mockRejectedValueOnce(abortErr)
    expect(await fetchCompanySuggestions('Testbrand')).toEqual({ status: 'aborted' })

    const controller = new AbortController()
    fetchMock.mockImplementationOnce(async () => {
      controller.abort()
      return jsonResponse(200, { data: { suggestions: [ROW], truncated: false } })
    })
    expect(await fetchCompanySuggestions('Testbrand', { signal: controller.signal })).toEqual({ status: 'aborted' })
  })
})
