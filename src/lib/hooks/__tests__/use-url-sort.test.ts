import { describe, it, expect } from 'vitest'
import { readUrlSort, toggledUrlSort } from '../use-url-sort'

const COLUMNS = ['name', 'number', 'city'] as const

describe('readUrlSort', () => {
  it('reads a known column and direction', () => {
    expect(readUrlSort(new URLSearchParams('sort=city&dir=desc'), COLUMNS, 'name')).toEqual({
      column: 'city',
      direction: 'desc',
    })
  })

  it('falls back to the default column, ascending, for anything else', () => {
    expect(readUrlSort(new URLSearchParams('sort=evil&dir=up'), COLUMNS, 'name')).toEqual({
      column: 'name',
      direction: 'asc',
    })
    expect(readUrlSort(new URLSearchParams(''), COLUMNS, 'name')).toEqual({ column: 'name', direction: 'asc' })
  })
})

describe('toggledUrlSort', () => {
  // Parity with the hand-written updateSort the customer and article lists carried.
  it('flips the direction on the current column and starts another ascending', () => {
    expect(toggledUrlSort(new URLSearchParams('sort=name&dir=asc'), COLUMNS, 'name', 'name').toString()).toBe(
      'sort=name&dir=desc',
    )
    expect(toggledUrlSort(new URLSearchParams('sort=name&dir=desc'), COLUMNS, 'name', 'name').toString()).toBe(
      'sort=name&dir=asc',
    )
    expect(toggledUrlSort(new URLSearchParams('sort=name&dir=desc'), COLUMNS, 'name', 'city').toString()).toBe(
      'sort=city&dir=asc',
    )
  })

  it('treats a missing sort as the default column and keeps other params', () => {
    expect(toggledUrlSort(new URLSearchParams('q=anna'), COLUMNS, 'name', 'name').toString()).toBe(
      'q=anna&sort=name&dir=desc',
    )
  })
})
