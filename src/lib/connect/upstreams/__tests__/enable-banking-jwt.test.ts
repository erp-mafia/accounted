import { afterEach, describe, expect, it, vi } from 'vitest'

const VARIABLES = [
  'ENABLE_BANKING_APP_ID',
  'ENABLE_BANKING_APP_ID_PRODUCTION',
  'ENABLE_BANKING_PRIVATE_KEY',
  'ENABLE_BANKING_PRIVATE_KEY_PRODUCTION',
] as const

// The app id and the key are module constants read at import, hence the
// fresh import per case.
async function loadWith(env: Partial<Record<(typeof VARIABLES)[number], string>>) {
  vi.resetModules()
  for (const name of VARIABLES) vi.stubEnv(name, env[name] ?? '')
  return import('../enable-banking-jwt')
}

describe('hasSigningCredentials', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is true with both the app id and the signing key', async () => {
    const jwt = await loadWith({ ENABLE_BANKING_APP_ID: 'app', ENABLE_BANKING_PRIVATE_KEY: 'key' })
    expect(jwt.hasSigningCredentials()).toBe(true)
  })

  it('counts the _PRODUCTION variants', async () => {
    const jwt = await loadWith({
      ENABLE_BANKING_APP_ID_PRODUCTION: 'app',
      ENABLE_BANKING_PRIVATE_KEY_PRODUCTION: 'key',
    })
    expect(jwt.hasSigningCredentials()).toBe(true)
  })

  it('is false with nothing set', async () => {
    const jwt = await loadWith({})
    expect(jwt.hasSigningCredentials()).toBe(false)
  })

  it('is false with half a set, where the signer throws the name of the missing variable', async () => {
    const onlyKey = await loadWith({ ENABLE_BANKING_PRIVATE_KEY: 'key' })
    expect(onlyKey.hasSigningCredentials()).toBe(false)
    expect(() => onlyKey.getAuthorizationHeader()).toThrow('ENABLE_BANKING_APP_ID environment variable is not set')

    const onlyId = await loadWith({ ENABLE_BANKING_APP_ID: 'app' })
    expect(onlyId.hasSigningCredentials()).toBe(false)
    expect(() => onlyId.getAuthorizationHeader()).toThrow(
      'ENABLE_BANKING_PRIVATE_KEY environment variable is not set',
    )
  })
})
