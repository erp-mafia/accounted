import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// loadBasCatalog caches its in-flight promise at module level, so every test
// re-imports a fresh module instance to start from an empty cache.
async function importFreshClient() {
  vi.resetModules()
  return import('@/lib/bookkeeping/bas-catalog-client')
}

const CATALOG = [
  { account_number: '6540', account_name: 'IT-tjänster', account_class: 6, account_group: '65', description: null },
]

describe('loadBasCatalog', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('returns the catalog on a successful fetch and caches it across calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: CATALOG }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { loadBasCatalog } = await importFreshClient()

    await expect(loadBasCatalog()).resolves.toEqual(CATALOG)
    await expect(loadBasCatalog()).resolves.toEqual(CATALOG)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('resolves to an empty list and logs on a non-OK response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    vi.stubGlobal('fetch', fetchMock)
    const { loadBasCatalog } = await importFreshClient()

    await expect(loadBasCatalog()).resolves.toEqual([])
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[bas-catalog] fetch failed:',
      expect.any(Error),
    )
  })

  it('resolves to an empty list when the body has no data field', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { loadBasCatalog } = await importFreshClient()

    await expect(loadBasCatalog()).resolves.toEqual([])
  })

  it('clears the cache after a failure so the next call retries the fetch', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: CATALOG }) })
    vi.stubGlobal('fetch', fetchMock)
    const { loadBasCatalog } = await importFreshClient()

    await expect(loadBasCatalog()).resolves.toEqual([])
    await expect(loadBasCatalog()).resolves.toEqual(CATALOG)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

/**
 * crm#1101: the Bokför review lists catalogue accounts the company has not
 * added and those it deactivated ("Aktiveras vid bokföring", as
 * JournalEntryForm lists them), and its booking path (the categorize route's
 * account override) takes only active accounts, so the review activates the
 * person's pick first: added when the chart lacks it, reactivated when it
 * was deactivated. Only that pick: an inactive account a proposal brought
 * is refused by the route, which offers "Aktivera och bokför".
 */
describe('pickNeedsActivation', () => {
  const ACTIVE = [
    { account_number: '1930', is_active: true },
    { account_number: '5410', is_active: true },
  ]
  const BAS = [
    { account_number: '5410' },
    { account_number: '6540' },
    { account_number: '6991' },
  ]

  it('is true for a catalogue account the active chart does not hold, never added or deactivated', async () => {
    const { pickNeedsActivation } = await importFreshClient()
    expect(pickNeedsActivation('6540', ACTIVE, BAS)).toBe(true)
    expect(pickNeedsActivation('6991', ACTIVE, BAS)).toBe(true)
    // A whole chart passed in: its deactivated row is no active account.
    expect(pickNeedsActivation('6991', [...ACTIVE, { account_number: '6991', is_active: false }], BAS)).toBe(true)
  })

  it('is false for an active account, and for a number the catalogue does not know', async () => {
    const { pickNeedsActivation } = await importFreshClient()
    expect(pickNeedsActivation('5410', ACTIVE, BAS)).toBe(false)
    // Outside BAS: the booking's own refusal says what to do.
    expect(pickNeedsActivation('8022', ACTIVE, BAS)).toBe(false)
    // The catalogue has not loaded: nothing was listed as activated at booking.
    expect(pickNeedsActivation('6540', ACTIVE, [])).toBe(false)
  })
})

describe('activateBasAccounts', () => {
  // The whole chart, inactive accounts included: 6540 was deactivated.
  const CHART = [
    { account_number: '1930', is_active: true },
    { account_number: '5410', is_active: true },
    { account_number: '6540', is_active: false },
  ]

  function activateResponse(numbers: string[]) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: numbers.map((account_number) => ({ account_number })),
        activated: numbers.length,
        reactivated: 0,
        skipped: 0,
        unknown: [],
      }),
    }
  }

  it('activates what the chart does not hold at all, once each, and reports what it activated', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(activateResponse(['6570']))
    const { activateBasAccounts } = await importFreshClient()

    await expect(
      activateBasAccounts(['6570', '1930', '6570'], CHART, fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual(['6570'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('/api/bookkeeping/accounts/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_numbers: ['6570'] }),
    })
  })

  it('reactivates an account the company deactivated, picked from a list that said it would be', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(activateResponse(['6540']))
    const { activateBasAccounts } = await importFreshClient()

    await expect(activateBasAccounts(['6540'], CHART, fetchImpl as unknown as typeof fetch)).resolves.toEqual(['6540'])
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/bookkeeping/accounts/activate',
      expect.objectContaining({ body: JSON.stringify({ account_numbers: ['6540'] }) }),
    )
  })

  it('asks nothing for active accounts or non-numbers', async () => {
    const fetchImpl = vi.fn()
    const { activateBasAccounts } = await importFreshClient()

    await expect(activateBasAccounts(['1930', '5410'], CHART, fetchImpl as unknown as typeof fetch)).resolves.toEqual([])
    await expect(activateBasAccounts(['', '65'], CHART, fetchImpl as unknown as typeof fetch)).resolves.toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports nothing activated for a number outside BAS, a refusal or a failed request, and never throws', async () => {
    const { activateBasAccounts } = await importFreshClient()
    const outsideBas = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [], activated: 0, reactivated: 0, skipped: 0, unknown: ['8022'] }),
    })
    const refused = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) })
    const offline = vi.fn().mockRejectedValue(new Error('network down'))

    await expect(activateBasAccounts(['8022'], CHART, outsideBas as unknown as typeof fetch)).resolves.toEqual([])
    await expect(activateBasAccounts(['6570'], CHART, refused as unknown as typeof fetch)).resolves.toEqual([])
    await expect(activateBasAccounts(['6570'], CHART, offline as unknown as typeof fetch)).resolves.toEqual([])
  })
})
