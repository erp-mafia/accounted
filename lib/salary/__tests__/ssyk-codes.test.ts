import { describe, it, expect } from 'vitest'
import { SSYK_CODES, findSsykLabel } from '../ssyk-codes'

describe('SSYK_CODES', () => {
  it('contains the full 4-digit SSYK 2012 catalogue', () => {
    expect(SSYK_CODES.length).toBe(426)
  })

  it('only holds well-formed 4-digit codes with non-empty labels', () => {
    for (const c of SSYK_CODES) {
      expect(c.code).toMatch(/^\d{4}$/)
      expect(c.label.length).toBeGreaterThan(0)
    }
  })

  it('has no duplicate codes', () => {
    const unique = new Set(SSYK_CODES.map((c) => c.code))
    expect(unique.size).toBe(SSYK_CODES.length)
  })
})

describe('findSsykLabel', () => {
  it('resolves a known code to its occupation title', () => {
    expect(findSsykLabel('1111')).toBe('Politiker')
  })

  it('trims whitespace before looking up', () => {
    expect(findSsykLabel(' 1111 ')).toBe('Politiker')
  })

  it('returns null for unknown, empty, or nullish input', () => {
    expect(findSsykLabel('0000')).toBeNull()
    expect(findSsykLabel('')).toBeNull()
    expect(findSsykLabel(null)).toBeNull()
    expect(findSsykLabel(undefined)).toBeNull()
  })
})
