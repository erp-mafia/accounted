import { describe, expect, it } from 'vitest'
import { parseExpand } from '../expand'

const ALLOWED = ['customer', 'items', 'payments'] as const

const urlWith = (q: string): URL => new URL(`https://x.test/path${q}`)

describe('parseExpand', () => {
  it('returns an empty Set when no expand param is present', () => {
    const r = parseExpand(urlWith(''), ALLOWED)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.expand.size).toBe(0)
  })

  it('parses a single key', () => {
    const r = parseExpand(urlWith('?expand=customer'), ALLOWED)
    expect(r.ok).toBe(true)
    if (r.ok) expect([...r.expand]).toEqual(['customer'])
  })

  it('parses multiple comma-separated keys', () => {
    const r = parseExpand(urlWith('?expand=customer,items'), ALLOWED)
    expect(r.ok).toBe(true)
    if (r.ok) expect([...r.expand].sort()).toEqual(['customer', 'items'])
  })

  it('trims whitespace around keys', () => {
    const r = parseExpand(urlWith('?expand=customer , items'), ALLOWED)
    expect(r.ok).toBe(true)
    if (r.ok) expect([...r.expand].sort()).toEqual(['customer', 'items'])
  })

  it('collapses duplicates', () => {
    const r = parseExpand(urlWith('?expand=customer,customer'), ALLOWED)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.expand.size).toBe(1)
  })

  it('rejects unknown keys with VALIDATION_ERROR-shaped result', () => {
    const r = parseExpand(urlWith('?expand=customer,bogus'), ALLOWED)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.invalidKeys).toEqual(['bogus'])
      expect(r.allowed).toEqual(['customer', 'items', 'payments'])
    }
  })

  it('reports all invalid keys, not just the first', () => {
    const r = parseExpand(urlWith('?expand=foo,bar,customer'), ALLOWED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.invalidKeys.sort()).toEqual(['bar', 'foo'])
  })

  it('ignores empty entries from trailing commas', () => {
    const r = parseExpand(urlWith('?expand=customer,'), ALLOWED)
    expect(r.ok).toBe(true)
    if (r.ok) expect([...r.expand]).toEqual(['customer'])
  })
})
