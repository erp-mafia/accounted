import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchEcbEuroRate, parseEcbCsv, resetEcbRatesForTests } from '../ecb'

const HEADER = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE'

function csv(...rows: Array<[string, string]>): string {
  return [HEADER, ...rows.map(([date, value]) => `EXR.D.SEK.EUR.SP00.A,D,SEK,EUR,SP00,A,${date},${value}`)].join('\n')
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  resetEcbRatesForTests()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseEcbCsv', () => {
  it('takes the observation on the date', () => {
    expect(parseEcbCsv(csv(['2026-09-30', '11.331'], ['2026-10-01', '11.29']), 'SEK', '2026-09-30')).toEqual({
      currency: 'SEK',
      rate: 11.331,
      date: '2026-09-30',
    })
  })

  it('takes the next day of publication when the date has none (a quarter ending on a Sunday)', () => {
    expect(parseEcbCsv(csv(['2024-07-02', '11.417'], ['2024-07-01', '11.3675']), 'SEK', '2024-06-30')).toEqual({
      currency: 'SEK',
      rate: 11.3675,
      date: '2024-07-01',
    })
  })

  it('answers null for an empty answer, a missing column or a rate that is not a number', () => {
    expect(parseEcbCsv('', 'SEK', '2026-09-30')).toBeNull()
    expect(parseEcbCsv('KEY,TIME_PERIOD\nX,2026-09-30', 'SEK', '2026-09-30')).toBeNull()
    expect(parseEcbCsv(csv(['2026-09-30', 'NaN']), 'SEK', '2026-09-30')).toBeNull()
  })

  it('never takes an observation before the date', () => {
    expect(parseEcbCsv(csv(['2026-09-29', '11.4']), 'SEK', '2026-09-30')).toBeNull()
  })
})

describe('fetchEcbEuroRate', () => {
  it('answers 1 for euro without asking the ECB', async () => {
    await expect(fetchEcbEuroRate('eur', '2026-09-30')).resolves.toEqual({
      ok: true,
      rate: { currency: 'EUR', rate: 1, date: '2026-09-30' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks for the date and the ten days after it, and remembers a published rate', async () => {
    fetchMock.mockResolvedValue(new Response(csv(['2026-09-30', '11.331']), { status: 200 }))

    const first = await fetchEcbEuroRate('SEK', '2026-09-30')
    const second = await fetchEcbEuroRate('SEK', '2026-09-30')

    expect(first).toEqual({ ok: true, rate: { currency: 'SEK', rate: 11.331, date: '2026-09-30' } })
    expect(second).toEqual(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/EXR/D.SEK.EUR.SP00.A?')
    expect(url).toContain('startPeriod=2026-09-30&endPeriod=2026-10-10')
    expect(url).toContain('detail=dataonly&format=csvdata')
  })

  it('answers no rate when the ECB has none yet, and asks again next time', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 200 }))

    await expect(fetchEcbEuroRate('SEK', '2026-12-31')).resolves.toEqual({ ok: true, rate: null })
    await fetchEcbEuroRate('SEK', '2026-12-31')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reads 404 as no rate (a currency the ECB does not quote)', async () => {
    fetchMock.mockResolvedValue(new Response('No results found.', { status: 404 }))
    await expect(fetchEcbEuroRate('XAU', '2026-09-30')).resolves.toEqual({ ok: true, rate: null })
  })

  it('answers unavailable when the ECB fails or cannot be reached', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }))
    await expect(fetchEcbEuroRate('SEK', '2026-09-30')).resolves.toEqual({ ok: false })

    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))
    await expect(fetchEcbEuroRate('SEK', '2026-09-30')).resolves.toEqual({ ok: false })
  })

  it('never builds a URL from a currency or date that is not one', async () => {
    await expect(fetchEcbEuroRate('SEK/../x', '2026-09-30')).resolves.toEqual({ ok: true, rate: null })
    await expect(fetchEcbEuroRate('SEK', '30/09/2026')).resolves.toEqual({ ok: true, rate: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
