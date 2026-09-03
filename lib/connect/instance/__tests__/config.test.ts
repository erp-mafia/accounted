import { describe, it, expect, afterEach, vi } from 'vitest'
import { getConnectorConfig, isConnectorConfigured } from '../config'

afterEach(() => vi.unstubAllEnvs())

describe('getConnectorConfig', () => {
  it('is null without a key (hosted, or a self-host without a subscription)', () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', '')
    expect(getConnectorConfig()).toBeNull()
    expect(isConnectorConfigured()).toBe(false)
  })

  it('defaults to the connector service origin and strips trailing slashes from an override', () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    vi.stubEnv('GNUBOK_CONNECT_URL', '')
    expect(getConnectorConfig()).toEqual({ key: 'gnubok_ck_x', baseUrl: 'https://connect.accounted.se' })
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

  it('strips userinfo, query and fragment from the base URL (status echoes it back)', () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    for (const [dirty, clean] of [
      ['https://user:secret@connect.example.se', 'https://connect.example.se'],
      ['https://connect.example.se?token=secret', 'https://connect.example.se'],
      ['https://connect.example.se/base#fragment', 'https://connect.example.se/base'],
      ['https://user:secret@connect.example.se/base/?token=s#f', 'https://connect.example.se/base'],
    ]) {
      vi.stubEnv('GNUBOK_CONNECT_URL', dirty)
      expect(getConnectorConfig()?.baseUrl, dirty).toBe(clean)
    }
  })

  it('keeps a clean override byte-identical (no surprise normalization)', () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    vi.stubEnv('GNUBOK_CONNECT_URL', 'https://connect.example.se/base')
    expect(getConnectorConfig()?.baseUrl).toBe('https://connect.example.se/base')
  })

  it('allows plain http for loopback development hosts only', () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    for (const ok of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
      vi.stubEnv('GNUBOK_CONNECT_URL', ok)
      expect(getConnectorConfig()?.baseUrl, ok).toBe(ok)
    }
  })
})
