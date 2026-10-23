import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  fetchReportData,
  reportRequestKey,
  startReportRequest,
  viewReportData,
  viewReportPages,
  type SettledReport,
} from '../report-data'

type Pending = {
  url: string
  signal: AbortSignal | undefined
  respond: (body: unknown) => void
}

// A fetch whose responses the test releases by hand, in any order.
function deferredFetch() {
  const pending: Pending[] = []
  const fetchMock = vi.fn((url: string, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      pending.push({
        url,
        signal: init?.signal ?? undefined,
        respond: (body) => resolve(new Response(JSON.stringify(body))),
      })
    }),
  )
  return { fetchMock, pending }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('report data', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('a year switch while the previous year is in flight', () => {
    it('drops the slower answer for the earlier year', async () => {
      const { fetchMock, pending } = deferredFetch()
      vi.stubGlobal('fetch', fetchMock)
      const settle = vi.fn()

      const url2025 = '/api/reports/balansrapport?period_id=fy-2025'
      const url2026 = '/api/reports/balansrapport?period_id=fy-2026'
      const key2025 = reportRequestKey(url2025, 0)
      const key2026 = reportRequestKey(url2026, 0)

      // The hook's effect: start 2025, then the switch to 2026 runs the
      // cleanup (cancel) before starting 2026.
      const cancel2025 = startReportRequest(key2025, url2025, 'Kunde inte hämta balansrapport', settle)
      cancel2025()
      startReportRequest(key2026, url2026, 'Kunde inte hämta balansrapport', settle)

      expect(pending.map((p) => p.url)).toEqual([url2025, url2026])
      expect(pending[0].signal?.aborted).toBe(true)
      expect(pending[1].signal?.aborted).toBe(false)

      // 2026 answers first, 2025 last.
      pending[1].respond({ data: { year: 2026 } })
      await flush()
      pending[0].respond({ data: { year: 2025 } })
      await flush()

      expect(settle).toHaveBeenCalledTimes(1)
      const settled = settle.mock.calls[0][0] as SettledReport<{ year: number }>
      expect(settled).toEqual({ key: key2026, data: { year: 2026 }, error: null })
      expect(viewReportData(settled, key2026)).toEqual({
        data: { year: 2026 },
        error: null,
        loading: false,
      })
    })

    it('never shows an answer tagged with another request key', () => {
      const url = '/api/reports/trial-balance?period_id=fy-2026'
      const stale: SettledReport<{ year: number }> = {
        key: reportRequestKey('/api/reports/trial-balance?period_id=fy-2025', 0),
        data: { year: 2025 },
        error: null,
      }

      expect(viewReportData(stale, reportRequestKey(url, 0))).toEqual({
        data: null,
        error: null,
        loading: true,
      })
    })

    it('treats a refetch of the same URL as a new request', () => {
      const url = '/api/reports/general-ledger?period_id=fy-2026'
      const first: SettledReport<number> = { key: reportRequestKey(url, 0), data: 1, error: null }

      expect(reportRequestKey(url, 1)).not.toBe(reportRequestKey(url, 0))
      expect(viewReportData(first, reportRequestKey(url, 1)).loading).toBe(true)
    })
  })

  describe('viewReportData', () => {
    it('is idle when nothing is requested', () => {
      expect(viewReportData(null, null)).toEqual({ data: null, error: null, loading: false })
    })

    it('is loading until the first answer lands', () => {
      expect(viewReportData(null, reportRequestKey('/api/reports/x', 0))).toEqual({
        data: null,
        error: null,
        loading: true,
      })
    })

    it('carries an error for the current request', () => {
      const key = reportRequestKey('/api/reports/x', 0)
      expect(viewReportData({ key, data: null, error: 'Fel' }, key)).toEqual({
        data: null,
        error: 'Fel',
        loading: false,
      })
    })
  })

  describe('fetchReportData', () => {
    it('unwraps the data envelope', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { rows: [] } }))))

      await expect(fetchReportData('/api/reports/x', 'Kunde inte hämta')).resolves.toEqual({
        data: { rows: [] },
        error: null,
      })
    })

    it('turns an error envelope into its user-facing message, not the object', async () => {
      const body = { error: { code: 'NOT_FOUND', message: 'Räkenskapsåret hittades inte' } }
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 404 })))

      const outcome = await fetchReportData('/api/reports/x', 'Kunde inte hämta')

      expect(outcome).toEqual({ data: null, error: getErrorMessage(body) })
      expect(typeof outcome.error).toBe('string')
    })

    it("uses the view's own line when the network fails", async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))

      await expect(fetchReportData('/api/reports/x', 'Kunde inte hämta saldobalans')).resolves.toEqual({
        data: null,
        error: 'Kunde inte hämta saldobalans',
      })
    })

    it("uses the view's own line when the body is not JSON", async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>504</html>', { status: 504 })))

      await expect(fetchReportData('/api/reports/x', 'Kunde inte hämta grundbok')).resolves.toEqual({
        data: null,
        error: 'Kunde inte hämta grundbok',
      })
    })

    it('reads a missing data field as no data', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}))))

      await expect(fetchReportData('/api/reports/x', 'Kunde inte hämta')).resolves.toEqual({
        data: null,
        error: null,
      })
    })
  })
})

describe('viewReportPages', () => {
  const ok = (data: string) => ({ data, error: null })

  it('fetches nothing without a base URL', () => {
    expect(viewReportPages(null, { base: null, urls: [] }, { base: null, results: {} })).toEqual({
      pages: [], pending: null, error: null, loading: false,
    })
  })

  it('asks for the first page of a new base URL, whatever another base kept', () => {
    const view = viewReportPages(
      '/p?a=1',
      { base: '/p?a=0', urls: ['/p?a=0', '/p?a=0&after=x'] },
      { base: '/p?a=0', results: { '/p?a=0': ok('old') } },
    )
    expect(view).toEqual({ pages: [], pending: '/p?a=1', error: null, loading: true })
  })

  it('renders the pages in the order they were asked for, and asks for the first unanswered one', () => {
    const chain = { base: '/p', urls: ['/p', '/p?after=1', '/p?after=2'] }
    // The third page answered before the second: it waits behind it.
    const view = viewReportPages('/p', chain, { base: '/p', results: { '/p': ok('one'), '/p?after=2': ok('three') } })
    expect(view).toEqual({ pages: ['one'], pending: '/p?after=1', error: null, loading: true })

    const done = viewReportPages('/p', chain, {
      base: '/p',
      results: { '/p': ok('one'), '/p?after=1': ok('two'), '/p?after=2': ok('three') },
    })
    expect(done).toEqual({ pages: ['one', 'two', 'three'], pending: null, error: null, loading: false })
  })

  it('stops at a failed page and keeps the ones before it', () => {
    const view = viewReportPages('/p', { base: '/p', urls: ['/p', '/p?after=1'] }, {
      base: '/p',
      results: { '/p': ok('one'), '/p?after=1': { data: null, error: 'Kunde inte hämta' } },
    })
    expect(view).toEqual({ pages: ['one'], pending: null, error: 'Kunde inte hämta', loading: false })
  })
})
