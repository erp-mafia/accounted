import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FortnoxClient } from '../fortnox/client'
import { BrioxClient } from '../briox/client'
import { BokioClient } from '../bokio/client'
import { BjornLundenClient } from '../bjornlunden/client'
import { WintClient } from '../wint/client'

/**
 * A register page is not a single-record read (#3136): getPage forwards the
 * caller's timeout to the request signal, and everything else keeps the 15 s
 * default. The same contract VismaClient has had since #3133.
 */

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

const CLIENTS = [
  {
    name: 'fortnox',
    page: (timeoutMs?: number) => new FortnoxClient().getPage('token', '/customers', 'Customers', { page: 1, timeoutMs }),
    get: () => new FortnoxClient().get('token', '/customers/1'),
    body: { Customers: [], MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1, '@TotalResources': 0 } },
  },
  {
    name: 'briox',
    page: (timeoutMs?: number) => new BrioxClient().getPage('token', '/customer', 'customers', { page: 1, timeoutMs }),
    get: () => new BrioxClient().get('token', '/customer/1'),
    body: { data: { customers: [] } },
  },
  {
    name: 'bokio',
    page: (timeoutMs?: number) => new BokioClient().getPage('token', 'company', '/customers', { page: 1, timeoutMs }),
    get: () => new BokioClient().get('token', '/companies/company/customers/1'),
    body: { items: [], totalItems: 0, totalPages: 1, currentPage: 1 },
  },
  {
    name: 'bjornlunden',
    page: (timeoutMs?: number) => new BjornLundenClient().getPage('token', 'user-key', '/customer', { page: 1, timeoutMs }),
    get: () => new BjornLundenClient().get('token', 'user-key', '/details'),
    body: [],
  },
  {
    name: 'wint',
    page: (timeoutMs?: number) => new WintClient().getPage('token', '/api/Customer', { page: 1, timeoutMs }),
    get: () => new WintClient().get('token', '/api/Auth'),
    body: { Items: [], Page: 1, NumPerPage: 200, TotalItems: 0 },
  },
]

describe.each(CLIENTS)('$name client timeouts', (client) => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  let timeoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(client.body))
    timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    timeoutSpy.mockRestore()
  })

  it('getPage forwards a caller-supplied timeout to the request signal', async () => {
    await client.page(60_000)
    expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(60_000)
  })

  it('getPage without a timeout keeps the 15 s default', async () => {
    await client.page()
    expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(15_000)
  })

  it('get keeps the 15 s single-record default', async () => {
    await client.get()
    expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(15_000)
  })
})
