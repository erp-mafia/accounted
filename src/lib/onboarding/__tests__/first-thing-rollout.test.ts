import { afterEach, describe, expect, it, vi } from 'vitest'
import { hemFirstThingRollout, isHemFirstThingEnabled } from '../first-thing-rollout'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isHemFirstThingEnabled', () => {
  it('is off for everyone when the list is unset', () => {
    vi.stubEnv('HEM_FIRST_THING_USER_IDS', '')
    expect(hemFirstThingRollout()).toEqual([])
    expect(isHemFirstThingEnabled('user-1')).toBe(false)
  })

  it('is off for everyone when the list is blank', () => {
    vi.stubEnv('HEM_FIRST_THING_USER_IDS', '   ')
    expect(isHemFirstThingEnabled('user-1')).toBe(false)
  })

  it('is on only for the listed users', () => {
    vi.stubEnv('HEM_FIRST_THING_USER_IDS', 'user-1, user-2 ,,user-1')
    expect(hemFirstThingRollout()).toEqual(['user-1', 'user-2'])
    expect(isHemFirstThingEnabled('user-1')).toBe(true)
    expect(isHemFirstThingEnabled('user-2')).toBe(true)
    expect(isHemFirstThingEnabled('user-3')).toBe(false)
  })

  it('is on for everyone with a star', () => {
    vi.stubEnv('HEM_FIRST_THING_USER_IDS', '*')
    expect(hemFirstThingRollout()).toBe('all')
    expect(isHemFirstThingEnabled('anyone')).toBe(true)
  })

  it('is off without a user id', () => {
    vi.stubEnv('HEM_FIRST_THING_USER_IDS', '*')
    expect(isHemFirstThingEnabled(null)).toBe(false)
    expect(isHemFirstThingEnabled(undefined)).toBe(false)
  })
})
