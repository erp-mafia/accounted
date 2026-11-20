import { describe, it, expect, afterEach, vi } from 'vitest'
import { requireHttpsUrl } from '../require-https'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('requireHttpsUrl', () => {
  it('returns an https URL unchanged', () => {
    expect(requireHttpsUrl('https://api.skatteverket.se/momsdeklaration/v1', 'X_URL')).toBe(
      'https://api.skatteverket.se/momsdeklaration/v1',
    )
  })

  it('refuses a plaintext http URL and names the setting', () => {
    expect(() => requireHttpsUrl('http://api.skatteverket.se/momsdeklaration/v1', 'X_URL')).toThrow(
      /^X_URL must be https/,
    )
  })

  it('refuses other schemes and unparseable values without echoing them', () => {
    expect(() => requireHttpsUrl('ftp://api.example', 'X_URL')).toThrow(/X_URL must be https/)
    expect(() => requireHttpsUrl('api.example/v1', 'X_URL')).toThrow('X_URL is not a valid URL')
  })

  it('accepts http on localhost and 127.0.0.1 in test and development', () => {
    for (const env of ['test', 'development']) {
      vi.stubEnv('NODE_ENV', env)
      expect(requireHttpsUrl('http://localhost:4010/skv', 'X_URL')).toBe('http://localhost:4010/skv')
      expect(requireHttpsUrl('http://127.0.0.1:4010/skv', 'X_URL')).toBe('http://127.0.0.1:4010/skv')
    }
  })

  it('refuses loopback http in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(() => requireHttpsUrl('http://localhost:4010/skv', 'X_URL')).toThrow(/must be https/)
    expect(() => requireHttpsUrl('http://127.0.0.1:4010/skv', 'X_URL')).toThrow(/must be https/)
  })

  it('accepts only the exact loopback names, even in test', () => {
    vi.stubEnv('NODE_ENV', 'test')
    expect(() => requireHttpsUrl('http://localhost.evil.example/skv', 'X_URL')).toThrow(/must be https/)
    expect(() => requireHttpsUrl('http://127.0.0.2/skv', 'X_URL')).toThrow(/must be https/)
    expect(() => requireHttpsUrl('http://api.example/skv', 'X_URL')).toThrow(/must be https/)
  })
})
