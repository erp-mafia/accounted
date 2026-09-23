import { describe, it, expect, afterEach, vi } from 'vitest'
import { flagEnabled, isSelfHosted } from '../public-flags'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('flagEnabled', () => {
  it('is true only for the exact string "true"', () => {
    expect(flagEnabled('true')).toBe(true)
    expect(flagEnabled('false')).toBe(false)
    expect(flagEnabled('')).toBe(false)
    expect(flagEnabled(undefined)).toBe(false)
  })

  it('does not accept near-misses that would silently switch a flag on', () => {
    // An operator typing TRUE/1/yes gets the documented default, not a guess.
    expect(flagEnabled('TRUE')).toBe(false)
    expect(flagEnabled('True')).toBe(false)
    expect(flagEnabled('1')).toBe(false)
    expect(flagEnabled('yes')).toBe(false)
    expect(flagEnabled(' true')).toBe(false)
  })

  it('treats an unsubstituted Docker sentinel as off', () => {
    // The image is built with __NEXT_PUBLIC_SELF_HOSTED__ and the entrypoint
    // seds the real value in. If substitution ever fails, the flag must read
    // off rather than matching some truthy heuristic.
    expect(flagEnabled('__NEXT_PUBLIC_SELF_HOSTED__')).toBe(false)
  })

  it('reads the value the entrypoint substituted', () => {
    expect(flagEnabled('true')).toBe(true)
  })
})

describe('isSelfHosted', () => {
  it('follows NEXT_PUBLIC_SELF_HOSTED at call time, not at module load', () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    expect(isSelfHosted()).toBe(true)

    // Same module instance, different env: proves the read is not frozen into
    // a module-level constant, which is what lets the Docker entrypoint's
    // runtime substitution take effect at all.
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
    expect(isSelfHosted()).toBe(false)
  })

  it('is false when the variable is absent (hosted is the default)', () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', undefined)
    expect(isSelfHosted()).toBe(false)
  })
})
