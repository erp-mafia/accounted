import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * registerConfiguredPeppolTransports() wires the connector transport only on
 * a self-hosted instance in connector mode (connector key, no own Qvalia
 * keys). Hosted keeps its own keys, so nothing changes there. The registry is
 * module state, so every case gets a fresh module graph.
 */

const ENV = ['GNUBOK_CONNECTOR_KEY', 'GNUBOK_CONNECT_URL', 'QVALIA_API_KEY', 'QVALIA_PARTNER_REG_NO', 'QVALIA_BASE_URL', 'PEPPOL_TRANSPORT_PROVIDER'] as const

beforeEach(() => {
  vi.resetModules()
  for (const key of ENV) vi.stubEnv(key, '')
})
afterEach(() => vi.unstubAllEnvs())

async function load() {
  const registry = await import('@/lib/invoices/peppol-transport')
  const transports = await import('@/lib/invoices/transports')
  return { ...registry, ...transports }
}

describe('registerConfiguredPeppolTransports in connector mode', () => {
  it('registers nothing without keys of any kind', async () => {
    const m = await load()
    expect(m.registerConfiguredPeppolTransports({}).map((t) => t.provider)).toEqual([])
    expect(m.getPeppolTransportAvailability().available).toBe(false)
  })

  it('registers the connector transport when a connector key is set and no Qvalia keys are', async () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_test')
    const m = await load()
    expect(m.registerConfiguredPeppolTransports({}).map((t) => t.provider)).toEqual(['connector'])
    expect(m.getPeppolTransportAvailability()).toEqual({ available: true, provider: 'connector' })
    // Idempotent: a second call registers nothing new.
    expect(m.registerConfiguredPeppolTransports({})).toEqual([])
  })

  it('prefers own Qvalia keys over the connector (hosted, or a self-host with its own access point)', async () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_test')
    const env = { QVALIA_API_KEY: 'k', QVALIA_PARTNER_REG_NO: '5560000000', QVALIA_BASE_URL: 'https://api-test.qvalia.com' }
    vi.stubEnv('QVALIA_API_KEY', env.QVALIA_API_KEY)
    vi.stubEnv('QVALIA_PARTNER_REG_NO', env.QVALIA_PARTNER_REG_NO)
    const m = await load()
    expect(m.registerConfiguredPeppolTransports(env).map((t) => t.provider)).toEqual(['qvalia'])
    expect(m.getPeppolTransport('connector')).toBeNull()
    // Own keys still need the explicit provider selection, exactly as before.
    expect(m.getPeppolTransportAvailability()).toEqual({ available: false, provider: null, reason: 'provider_selection_required' })
  })
})
