import { describe, it, expect, afterEach, vi } from 'vitest'
import { getConnectorConfig, isConnectorConfigured } from '../config'

afterEach(() => vi.unstubAllEnvs())

describe('getConnectorConfig', () => {
  it('is null without a key (hosted, or a self-host without a subscription)', () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', '')
    expect(getConnectorConfig()).toBeNull()
    expect(isConnectorConfigured()).toBe(false)
  })

  it('defaults the hosted origin to app.gnubok.se and strips trailing slashes from an override', () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    vi.stubEnv('GNUBOK_CONNECT_URL', '')
    expect(getConnectorConfig()).toEqual({ key: 'gnubok_ck_x', baseUrl: 'https://app.gnubok.se' })
    vi.stubEnv('GNUBOK_CONNECT_URL', 'https://connect.example.se/')
    expect(getConnectorConfig()?.baseUrl).toBe('https://connect.example.se')
  })
})
