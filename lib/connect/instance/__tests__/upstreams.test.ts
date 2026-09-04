import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  bankConnectorMode,
  peppolConnectorMode,
  skatteverketConnectorMode,
  hasOwnEnableBankingCredentials,
  hasOwnPeppolCredentials,
  hasOwnSkatteverketCredentials,
} from '../upstreams'

const ENV = ['GNUBOK_CONNECTOR_KEY', 'GNUBOK_CONNECT_URL', 'ENABLE_BANKING_PRIVATE_KEY', 'ENABLE_BANKING_APP_ID', 'ENABLE_BANKING_PRIVATE_KEY_PRODUCTION', 'ENABLE_BANKING_APP_ID_PRODUCTION', 'SKATTEVERKET_OAUTH2_CLIENT_ID', 'SKATTEVERKET_APIGW_CLIENT_ID', 'QVALIA_API_KEY', 'QVALIA_PARTNER_REG_NO', 'CONNECT_BANK_CANARY_COMPANIES', 'CONNECT_SKV_CANARY_COMPANIES'] as const

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
    expect(bankConnectorMode()).toEqual({ baseUrl: 'https://connect.accounted.se/api/connect/bank', key: 'gnubok_ck_x' })
    expect(skatteverketConnectorMode()).toEqual({ baseUrl: 'https://connect.accounted.se/api/connect/skv', key: 'gnubok_ck_x' })
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

describe('peppol connector mode', () => {
  it('is off without a key and off with own Qvalia keys, on otherwise', () => {
    clear()
    expect(peppolConnectorMode()).toBeNull()
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    expect(peppolConnectorMode()).toEqual({ baseUrl: 'https://connect.accounted.se/api/connect/peppol', key: 'gnubok_ck_x' })
    vi.stubEnv('QVALIA_PARTNER_REG_NO', '5560000000')
    expect(hasOwnPeppolCredentials()).toBe(true)
    expect(peppolConnectorMode()).toBeNull()
  })
})

describe('bank canary companies', () => {
  it('routes only the listed companies through the connector while own credentials exist', () => {
    clear()
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    vi.stubEnv('ENABLE_BANKING_APP_ID', 'app-id')
    vi.stubEnv('ENABLE_BANKING_PRIVATE_KEY', 'pk')
    vi.stubEnv('CONNECT_BANK_CANARY_COMPANIES', 'c-1, c-2')
    expect(bankConnectorMode()).toBeNull()
    expect(bankConnectorMode('c-9')).toBeNull()
    expect(bankConnectorMode('c-1')).toEqual({ baseUrl: 'https://connect.accounted.se/api/connect/bank', key: 'gnubok_ck_x' })
    expect(bankConnectorMode('c-2')).not.toBeNull()
  })

  it('ignores the canary list without a connector key', () => {
    clear()
    vi.stubEnv('ENABLE_BANKING_APP_ID', 'app-id')
    vi.stubEnv('CONNECT_BANK_CANARY_COMPANIES', 'c-1')
    expect(bankConnectorMode('c-1')).toBeNull()
  })
})

describe('skatteverket canary companies', () => {
  it('routes only the listed companies through the connector while own credentials exist', () => {
    clear()
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    vi.stubEnv('SKATTEVERKET_OAUTH2_CLIENT_ID', 'client')
    vi.stubEnv('SKATTEVERKET_APIGW_CLIENT_ID', 'gw')
    vi.stubEnv('CONNECT_SKV_CANARY_COMPANIES', 'c-1, c-2')
    expect(skatteverketConnectorMode()).toBeNull()
    expect(skatteverketConnectorMode('c-9')).toBeNull()
    expect(skatteverketConnectorMode('c-1')).toEqual({ baseUrl: 'https://connect.accounted.se/api/connect/skv', key: 'gnubok_ck_x' })
    expect(skatteverketConnectorMode('c-2')).not.toBeNull()
  })

  it('does not let the bank list leak into Skatteverket routing', () => {
    clear()
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    vi.stubEnv('SKATTEVERKET_OAUTH2_CLIENT_ID', 'client')
    vi.stubEnv('CONNECT_BANK_CANARY_COMPANIES', 'c-1')
    expect(skatteverketConnectorMode('c-1')).toBeNull()
  })

  it('ignores the canary list without a connector key', () => {
    clear()
    vi.stubEnv('SKATTEVERKET_OAUTH2_CLIENT_ID', 'client')
    vi.stubEnv('CONNECT_SKV_CANARY_COMPANIES', 'c-1')
    expect(skatteverketConnectorMode('c-1')).toBeNull()
  })
})
