import { describe, expect, it, vi } from 'vitest'
import { shouldExposeTimingHeaders } from '../timing-headers'

describe('shouldExposeTimingHeaders', () => {
  it.each([
    // Vercel: VERCEL_ENV decides, whatever NODE_ENV says.
    [{ VERCEL_ENV: 'production', NODE_ENV: 'production' }, false],
    [{ VERCEL_ENV: 'preview', NODE_ENV: 'production' }, true],
    [{ VERCEL_ENV: 'development', NODE_ENV: 'development' }, true],
    // Self-hosted `next start` / standalone server: NODE_ENV decides.
    [{ NODE_ENV: 'production' }, false],
    [{ NODE_ENV: 'development' }, true],
    [{ NODE_ENV: 'test' }, true],
    [{}, true],
  ])('%j -> %s', (env, expected) => {
    expect(shouldExposeTimingHeaders(env as NodeJS.ProcessEnv)).toBe(expected)
  })

  it('EXPOSE_TIMING_HEADERS=true opts production back in', () => {
    expect(
      shouldExposeTimingHeaders({ VERCEL_ENV: 'production', NODE_ENV: 'production', EXPOSE_TIMING_HEADERS: 'true' } as NodeJS.ProcessEnv),
    ).toBe(true)
    expect(
      shouldExposeTimingHeaders({ NODE_ENV: 'production', EXPOSE_TIMING_HEADERS: 'true' } as NodeJS.ProcessEnv),
    ).toBe(true)
  })

  it('treats anything but the literal "true" as not opted in', () => {
    for (const value of ['1', 'yes', 'TRUE', '']) {
      expect(
        shouldExposeTimingHeaders({ NODE_ENV: 'production', EXPOSE_TIMING_HEADERS: value } as NodeJS.ProcessEnv),
      ).toBe(false)
    }
  })

  it('reads process.env on every call when called without an argument', () => {
    try {
      vi.stubEnv('VERCEL_ENV', undefined)
      vi.stubEnv('EXPOSE_TIMING_HEADERS', undefined)
      vi.stubEnv('NODE_ENV', 'production')
      expect(shouldExposeTimingHeaders()).toBe(false)
      vi.stubEnv('EXPOSE_TIMING_HEADERS', 'true')
      expect(shouldExposeTimingHeaders()).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
