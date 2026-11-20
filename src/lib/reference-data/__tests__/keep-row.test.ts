import { describe, it, expect } from 'vitest'
import { missingKeepId, withKeptRow } from '../keep-row'

const anna = { id: 'a', name: 'Anna' }
const bertil = { id: 'b', name: 'Bertil' }
const archivedOla = { id: 'o', name: 'Öla AB' }

describe('missingKeepId', () => {
  it('asks for the kept id only once the list has loaded without it', () => {
    expect(missingKeepId([anna], 'o', true)).toBeNull()
    expect(missingKeepId([anna], 'o', false)).toBe('o')
  })

  it('asks for nothing when there is no kept id or the list already has it', () => {
    expect(missingKeepId([anna], null, false)).toBeNull()
    expect(missingKeepId([anna], undefined, false)).toBeNull()
    expect(missingKeepId([anna], 'a', false)).toBeNull()
  })
})

describe('withKeptRow', () => {
  it('adds the archived row the form points at, in Swedish name order', () => {
    // The form editing a draft for an archived customer showed a blank picker
    // in the sales order and deadline forms: the list never had that row.
    expect(withKeptRow([anna, bertil], archivedOla).map((r) => r.id)).toEqual(['a', 'b', 'o'])
    expect(withKeptRow([bertil], anna).map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('returns the list unchanged when nothing is kept or the row is already there', () => {
    const items = [anna, bertil]
    expect(withKeptRow(items, null)).toBe(items)
    expect(withKeptRow(items, { ...anna })).toBe(items)
  })
})
