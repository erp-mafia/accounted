import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

async function importFresh() {
  vi.resetModules()
  return import('../use-company-account-names')
}

describe('buildAccountNameMap', () => {
  it('maps account_number to account_name', async () => {
    const { buildAccountNameMap } = await importFresh()
    const map = buildAccountNameMap([
      { account_number: '1580', account_name: 'Övriga kortfristiga fordringar' },
      { account_number: '3041', account_name: 'Försäljning tjänster 25%' },
    ])
    expect(map.get('1580')).toBe('Övriga kortfristiga fordringar')
    expect(map.get('3041')).toBe('Försäljning tjänster 25%')
    expect(map.size).toBe(2)
  })

  it('returns an empty map for non-array input', async () => {
    const { buildAccountNameMap } = await importFresh()
    expect(buildAccountNameMap(null).size).toBe(0)
    expect(buildAccountNameMap(undefined).size).toBe(0)
    expect(buildAccountNameMap({ data: [] }).size).toBe(0)
  })

  it('skips rows with missing, non-string, or empty names', async () => {
    const { buildAccountNameMap } = await importFresh()
    const map = buildAccountNameMap([
      { account_number: '1930' },
      { account_number: '1940', account_name: null },
      { account_number: '1950', account_name: 42 },
      { account_number: '1960', account_name: '' },
      { account_number: 1970, account_name: 'Not a string number' },
      null,
      { account_number: '2611', account_name: 'Utgående moms 25%' },
    ])
    expect(map.size).toBe(1)
    expect(map.get('2611')).toBe('Utgående moms 25%')
  })
})

describe('ensureCompanyAccountNamesLoaded', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads names from the accounts endpoint including inactive accounts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ account_number: '1580', account_name: 'Kortfordringar' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const mod = await importFresh()
    expect(mod.getCompanyAccountNames()).toBeNull()
    await mod.ensureCompanyAccountNamesLoaded()

    expect(fetchMock).toHaveBeenCalledWith('/api/bookkeeping/accounts?active=false')
    expect(mod.getCompanyAccountNames()?.get('1580')).toBe('Kortfordringar')
  })

  it('fetches only once per session', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const mod = await importFresh()
    await mod.ensureCompanyAccountNamesLoaded()
    await mod.ensureCompanyAccountNamesLoaded()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('degrades silently on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }))

    const mod = await importFresh()
    await expect(mod.ensureCompanyAccountNamesLoaded()).resolves.toBeUndefined()
    expect(mod.getCompanyAccountNames()).toBeNull()
  })

  it('degrades silently when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const mod = await importFresh()
    await expect(mod.ensureCompanyAccountNamesLoaded()).resolves.toBeUndefined()
    expect(mod.getCompanyAccountNames()).toBeNull()
  })
})
