import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ connector: vi.fn() }))
vi.mock('@/lib/connect/instance/upstreams', () => ({
  bankConnectorMode: (companyId?: string) => h.connector(companyId),
}))

import type { BankFeedAdapter } from '../port'
import {
  CONNECT_BANK_FEED_PROVIDER,
  __resetBankFeedRegistryForTests,
  getBankFeedAdapter,
  listBankFeedProviders,
  registerBankFeedAdapter,
  resolveBankFeed,
  resolveBankFeedAdapter,
} from '../registry'

function adapter(provider: string, needsSessionId = false): BankFeedAdapter {
  return { provider, needsSessionId, syncBooked: vi.fn() }
}

const connectorOn = { baseUrl: 'https://connect.accounted.se/api/connect/bank', key: 'gnubok_ck_x' }

beforeEach(() => {
  __resetBankFeedRegistryForTests()
  h.connector.mockReset()
  h.connector.mockReturnValue(null)
})
afterEach(() => vi.unstubAllEnvs())

describe('bank feed registry', () => {
  it('registers by normalized provider id, refuses duplicates, and unregisters', () => {
    const eb = adapter('Enable-Banking')
    const off = registerBankFeedAdapter(eb)
    expect(getBankFeedAdapter('enable-banking')).toBe(eb)
    expect(() => registerBankFeedAdapter(adapter('enable-banking'))).toThrow(/already registered/)
    off()
    expect(listBankFeedProviders()).toEqual([])
  })

  it('resolves to nothing in a build with no adapters (core without the extension)', () => {
    expect(resolveBankFeed('c-1')).toEqual({ provider: null, adapter: null, reason: 'no_adapter' })
    expect(resolveBankFeedAdapter('c-1')).toBeNull()
  })

  it('serves the single direct adapter when the company is not routed through Connect', () => {
    const eb = adapter('enable-banking')
    registerBankFeedAdapter(eb)
    registerBankFeedAdapter(adapter(CONNECT_BANK_FEED_PROVIDER, true))
    expect(resolveBankFeed('c-1')).toEqual({ provider: 'enable-banking', adapter: eb })
  })

  it('serves the Connect adapter for a company the installation routes through Connect', () => {
    const eb = adapter('enable-banking')
    const connect = adapter(CONNECT_BANK_FEED_PROVIDER, true)
    registerBankFeedAdapter(eb)
    registerBankFeedAdapter(connect)
    h.connector.mockImplementation((companyId?: string) => (companyId === 'canary' ? connectorOn : null))
    expect(resolveBankFeed('canary').adapter).toBe(connect)
    expect(resolveBankFeed('other').adapter).toBe(eb)
    // Installation-level question (consent and session calls): no company.
    expect(resolveBankFeed().adapter).toBe(eb)
  })

  it('reports the Connect adapter as unavailable when routing asks for it but nothing registered it', () => {
    registerBankFeedAdapter(adapter('enable-banking'))
    h.connector.mockReturnValue(connectorOn)
    expect(resolveBankFeed('c-1')).toEqual({ provider: null, adapter: null, reason: 'provider_adapter_unavailable' })
  })

  it('needs BANK_FEED_PROVIDER once two direct adapters exist, and honours it', () => {
    const eb = adapter('enable-banking')
    const other = adapter('other-psd2')
    registerBankFeedAdapter(eb)
    registerBankFeedAdapter(other)
    expect(resolveBankFeed('c-1')).toEqual({ provider: null, adapter: null, reason: 'provider_selection_required' })
    vi.stubEnv('BANK_FEED_PROVIDER', 'Other-PSD2')
    expect(resolveBankFeed('c-1')).toEqual({ provider: 'other-psd2', adapter: other })
    vi.stubEnv('BANK_FEED_PROVIDER', 'missing')
    expect(resolveBankFeed('c-1')).toMatchObject({ provider: null, reason: 'provider_adapter_unavailable' })
  })

  it('never lets BANK_FEED_PROVIDER select Connect: that routing is the connector configuration alone', () => {
    registerBankFeedAdapter(adapter('enable-banking'))
    registerBankFeedAdapter(adapter(CONNECT_BANK_FEED_PROVIDER, true))
    vi.stubEnv('BANK_FEED_PROVIDER', 'connect')
    expect(resolveBankFeed('c-1')).toMatchObject({ provider: null, reason: 'provider_adapter_unavailable' })
  })
})
