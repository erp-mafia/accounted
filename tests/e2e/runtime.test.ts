import { describe, expect, it } from 'vitest'
import { appEnv, owner, validateRuntime } from '../../scripts/e2e/runtime.mjs'

const runtime = {
  kind: 'synthetic-ten-year-fixture', owner,
  appUrl: 'http://127.0.0.1:3101', supabaseUrl: 'http://127.0.0.1:54331',
  encryptionKey: 'synthetic-key-for-environment-mapping',
}

describe('E2E runtime isolation', () => {
  it('accepts only this checkout and loopback endpoints', () => {
    expect(validateRuntime(runtime)).toBe(runtime)
    expect(() => validateRuntime({ ...runtime, owner: 'another-checkout' })).toThrow('isolated E2E runtime')
    expect(() => validateRuntime({ ...runtime, kind: 'production' })).toThrow('isolated E2E runtime')
    expect(() => validateRuntime({ ...runtime, supabaseUrl: 'https://production.supabase.co' })).toThrow('loopback HTTP')
    expect(() => validateRuntime({ ...runtime, appUrl: 'http://example.com' })).toThrow('loopback HTTP')
    expect(() => validateRuntime({ ...runtime, supabaseUrl: 'http://127.0.0.1:54321' })).toThrow('reserved port')
  })
  it('does not inherit optional provider credentials or database URLs', () => {
    const env = appEnv(runtime)
    expect(env).not.toHaveProperty('DATABASE_URL')
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(env).not.toHaveProperty('ENABLE_BANKING_PRIVATE_KEY')
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe(runtime.supabaseUrl)
    expect(env.PERSONNUMMER_ENCRYPTION_KEY).toBe(runtime.encryptionKey)
    expect(env).not.toHaveProperty('ENCRYPTION_KEY')
  })
})
