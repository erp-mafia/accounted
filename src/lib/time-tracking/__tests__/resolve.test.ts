import { describe, expect, it } from 'vitest'
import { resolveRef } from '../resolve'

const customers = [
  { value: 'c1', name: 'Galärbryggan AB', aliases: ['GF', '1001'] },
  { value: 'c2', name: 'Galärbryggan Event AB', aliases: [] },
  { value: 'c3', name: 'Rederi Nordstjernan AB', aliases: ['RN'] },
]

describe('resolveRef', () => {
  it('matches an exact code or alias, case-insensitively', () => {
    expect(resolveRef('gf', customers)).toMatchObject({ ok: true, exact: true, candidate: { value: 'c1' } })
    expect(resolveRef('1001', customers)).toMatchObject({ ok: true, candidate: { value: 'c1' } })
  })

  it('matches an exact name', () => {
    expect(resolveRef('galärbryggan event ab', customers)).toMatchObject({ ok: true, exact: true, candidate: { value: 'c2' } })
  })

  it('takes a confident fuzzy match that is clearly ahead, and reports it as not exact', () => {
    const r = resolveRef('Nordstjernan', customers)
    expect(r).toMatchObject({ ok: true, exact: false, candidate: { value: 'c3' } })
    if (r.ok) expect(r.confidence).toBeLessThan(1)
  })

  it('refuses a near-tie with ranked candidates instead of guessing', () => {
    const r = resolveRef('Galärbryggan', customers)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.candidates.map((c) => c.value)).toEqual(expect.arrayContaining(['c1', 'c2']))
  })

  it('refuses what matches nothing', () => {
    expect(resolveRef('Volvo', customers)).toMatchObject({ ok: false })
  })

  it('skips the fuzzy step when exactOnly', () => {
    expect(resolveRef('Nordstjernan', customers, { exactOnly: true })).toEqual({ ok: false, candidates: [] })
  })
})
