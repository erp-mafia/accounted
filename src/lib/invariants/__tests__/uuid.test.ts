import { describe, it, expect } from 'vitest'
import { UUID_RE, isUuid } from '../uuid'

describe('UUID_RE / isUuid', () => {
  it('accepts lower- and upper-case hex layouts', () => {
    expect(isUuid('123e4567-e89b-12d3-a456-426614174000')).toBe(true)
    expect(isUuid('123E4567-E89B-12D3-A456-426614174000')).toBe(true)
    expect(UUID_RE.test('00000000-0000-0000-0000-000000000000')).toBe(true)
  })

  it('rejects anything that is not exactly the 8-4-4-4-12 shape', () => {
    expect(isUuid('123e4567e89b12d3a456426614174000')).toBe(false)
    expect(isUuid('123e4567-e89b-12d3-a456-42661417400')).toBe(false)
    expect(isUuid('123e4567-e89b-12d3-a456-426614174000,x.eq.1')).toBe(false)
    expect(isUuid(' 123e4567-e89b-12d3-a456-426614174000')).toBe(false)
    expect(isUuid('')).toBe(false)
  })

  it('narrows non-strings to false', () => {
    expect(isUuid(null)).toBe(false)
    expect(isUuid(undefined)).toBe(false)
    expect(isUuid(42)).toBe(false)
  })
})
