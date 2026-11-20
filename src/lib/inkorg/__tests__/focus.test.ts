import { describe, expect, it } from 'vitest'
import { focusAfterChange, focusKeyAction, focusPosition, neighbour, swipeStep, type FocusKeyInput } from '../focus'

describe('focusPosition and neighbour', () => {
  const queue = ['a', 'b', 'c']

  it('says N av M, 1-based, and nothing for an id outside the queue', () => {
    expect(focusPosition(queue, 'b')).toEqual({ index: 2, total: 3 })
    expect(focusPosition(queue, 'x')).toBeNull()
    expect(focusPosition(queue, null)).toBeNull()
  })

  it('steps to the next and the previous item, and stops at either end', () => {
    expect(neighbour(queue, 'b', 1)).toBe('c')
    expect(neighbour(queue, 'b', -1)).toBe('a')
    expect(neighbour(queue, 'c', 1)).toBeNull()
    expect(neighbour(queue, 'a', -1)).toBeNull()
    expect(neighbour(queue, 'x', 1)).toBeNull()
  })
})

describe('focusAfterChange: the next opens by itself', () => {
  it('stays on the focused item while it is in the queue', () => {
    expect(focusAfterChange(['a', 'b', 'c'], ['a', 'b', 'c'], 'b')).toBe('b')
    expect(focusAfterChange(['a', 'b', 'c'], ['c', 'b'], 'b')).toBe('b')
  })

  it('opens the next one when the focused item left', () => {
    expect(focusAfterChange(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c')
  })

  it('skips the ones that left at the same time', () => {
    expect(focusAfterChange(['a', 'b', 'c', 'd'], ['a', 'd'], 'b')).toBe('d')
  })

  it('falls back to the nearest before it when it was the last', () => {
    expect(focusAfterChange(['a', 'b', 'c'], ['a', 'b'], 'c')).toBe('b')
    expect(focusAfterChange(['a', 'b', 'c'], ['a'], 'c')).toBe('a')
  })

  it('ignores a new arrival when choosing, and ends at nothing when the queue is empty', () => {
    expect(focusAfterChange(['a', 'b'], ['new', 'a'], 'b')).toBe('a')
    expect(focusAfterChange(['a'], [], 'a')).toBeNull()
  })

  it('opens the first item when the focused one was never in the old queue', () => {
    expect(focusAfterChange([], ['a', 'b'], 'x')).toBe('a')
    expect(focusAfterChange([], [], 'x')).toBeNull()
  })
})

describe('focusKeyAction', () => {
  const key = (k: string, extra: Partial<FocusKeyInput> = {}) =>
    focusKeyAction({ key: k, targetIsEditable: false, overlayOpen: false, ...extra })

  it('J and the right arrow go to the next, K and the left arrow to the previous, Esc back', () => {
    expect(key('j')).toBe('next')
    expect(key('J')).toBe('next')
    expect(key('ArrowRight')).toBe('next')
    expect(key('k')).toBe('previous')
    expect(key('K')).toBe('previous')
    expect(key('ArrowLeft')).toBe('previous')
    expect(key('Escape')).toBe('back')
    expect(key('x')).toBeNull()
    expect(key('ArrowDown')).toBeNull()
  })

  it('does nothing while typing, under a dialog, or with a modifier (Cmd+K is the palette)', () => {
    expect(key('j', { targetIsEditable: true })).toBeNull()
    expect(key('Escape', { overlayOpen: true })).toBeNull()
    expect(key('k', { metaKey: true })).toBeNull()
    expect(key('k', { ctrlKey: true })).toBeNull()
    expect(key('j', { altKey: true })).toBeNull()
  })
})

describe('swipeStep', () => {
  const base = { width: 400, canPrevious: true, canNext: true }

  it('a long swipe to the left is the next, to the right the previous', () => {
    expect(swipeStep({ ...base, offset: -200, velocity: 0 })).toBe(1)
    expect(swipeStep({ ...base, offset: 200, velocity: 0 })).toBe(-1)
  })

  it('a short slow drag springs back; a short fast flick moves on', () => {
    expect(swipeStep({ ...base, offset: -60, velocity: 0 })).toBe(0)
    expect(swipeStep({ ...base, offset: -60, velocity: -900 })).toBe(1)
  })

  it('a drag let go while moving back the other way springs back', () => {
    expect(swipeStep({ ...base, offset: -150, velocity: 600 })).toBe(0)
  })

  it('springs back at the first and the last item', () => {
    expect(swipeStep({ ...base, canNext: false, offset: -300, velocity: -1000 })).toBe(0)
    expect(swipeStep({ ...base, canPrevious: false, offset: 300, velocity: 1000 })).toBe(0)
  })

  it('does nothing without a measured width', () => {
    expect(swipeStep({ ...base, width: 0, offset: -300, velocity: 0 })).toBe(0)
  })
})
