import { describe, expect, it } from 'vitest'
import { arsredovisningDatering } from '../datering'

describe('arsredovisningDatering', () => {
  it('is the earliest signature date, so it never falls after a board signature (kontrollkod 1232)', () => {
    expect(
      arsredovisningDatering(['2026-02-21T10:00:00Z', '2026-02-20T10:00:00Z', '2026-03-02T10:00:00Z']),
    ).toBe('2026-02-20')
  })

  it('reads signing instants as Swedish days', () => {
    expect(arsredovisningDatering(['2026-10-22T22:02:16Z', '2026-10-23T10:00:00Z'])).toBe('2026-10-23')
  })

  it('skips signers who have not signed yet', () => {
    expect(arsredovisningDatering([null, '2026-02-21', undefined])).toBe('2026-02-21')
  })

  it('is null while nobody has signed', () => {
    expect(arsredovisningDatering([])).toBeNull()
    expect(arsredovisningDatering([null, null])).toBeNull()
  })
})
