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

  it('rejects non-https and malformed GNUBOK_CONNECT_URL (fail closed: the key is never sent in plaintext)', () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    for (const bad of ['http://connect.example.se', 'ftp://connect.example.se', 'not a url', 'connect.example.se']) {
      vi.stubEnv('GNUBOK_CONNECT_URL', bad)
      expect(getConnectorConfig(), bad).toBeNull()
      expect(isConnectorConfigured(), bad).toBe(false)
    }
  })

  it('allows plain http for loopback development hosts only', () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    for (const ok of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
      vi.stubEnv('GNUBOK_CONNECT_URL', ok)
      expect(getConnectorConfig()?.baseUrl, ok).toBe(ok)
    }
  })
})
