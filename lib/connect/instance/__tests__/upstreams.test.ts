import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  bankConnectorMode,
  skatteverketConnectorMode,
  hasOwnEnableBankingCredentials,
  hasOwnSkatteverketCredentials,
} from '../upstreams'

const ENV = ['GNUBOK_CONNECTOR_KEY', 'GNUBOK_CONNECT_URL', 'ENABLE_BANKING_PRIVATE_KEY', 'ENABLE_BANKING_APP_ID', 'ENABLE_BANKING_PRIVATE_KEY_PRODUCTION', 'ENABLE_BANKING_APP_ID_PRODUCTION', 'SKATTEVERKET_OAUTH2_CLIENT_ID', 'SKATTEVERKET_APIGW_CLIENT_ID'] as const

afterEach(() => vi.unstubAllEnvs())
function clear() {
  for (const k of ENV) vi.stubEnv(k, '')
}

describe('connector-mode detection', () => {
  it('is off when no connector key is set (hosted, or a self-host without a subscription)', () => {
    clear()
    vi.stubEnv('ENABLE_BANKING_PRIVATE_KEY', 'pk')
    expect(bankConnectorMode()).toBeNull()
    expect(skatteverketConnectorMode()).toBeNull()
  })

  // The load-bearing guard: an instance (or hosted) that has its OWN
  // credentials never routes through the proxy, even with a key present.
  it('is off for an upstream the instance has its own credentials for', () => {
    clear()
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    vi.stubEnv('ENABLE_BANKING_APP_ID', 'app-id')
    vi.stubEnv('SKATTEVERKET_APIGW_CLIENT_ID', 'gw')
    expect(hasOwnEnableBankingCredentials()).toBe(true)
    expect(hasOwnSkatteverketCredentials()).toBe(true)
    expect(bankConnectorMode()).toBeNull()
    expect(skatteverketConnectorMode()).toBeNull()
  })

  it('routes to the hosted proxy when a key is set and no own credentials exist', () => {
    clear()
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    expect(bankConnectorMode()).toEqual({ baseUrl: 'https://app.gnubok.se/api/connect/bank', key: 'gnubok_ck_x' })
    expect(skatteverketConnectorMode()).toEqual({ baseUrl: 'https://app.gnubok.se/api/connect/skv', key: 'gnubok_ck_x' })
  })

  it('honours GNUBOK_CONNECT_URL and strips a trailing slash', () => {
    clear()
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    vi.stubEnv('GNUBOK_CONNECT_URL', 'https://connect.example.se/')
    expect(bankConnectorMode()?.baseUrl).toBe('https://connect.example.se/api/connect/bank')
  })

  it('treats the _PRODUCTION EB variants as own credentials', () => {
    clear()
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    vi.stubEnv('ENABLE_BANKING_PRIVATE_KEY_PRODUCTION', 'pk')
    expect(bankConnectorMode()).toBeNull()
    expect(skatteverketConnectorMode()).not.toBeNull()
  })
})
