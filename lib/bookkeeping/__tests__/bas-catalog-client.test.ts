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
