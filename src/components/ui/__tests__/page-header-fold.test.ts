import { describe, it, expect } from 'vitest'
import { pickFolded } from '../page-header-fold'

const outline = { filled: false, stays: false }
const primary = { filled: true, stays: false }
const picker = { filled: false, stays: true }

describe('pickFolded', () => {
  it('keeps the primary and folds every other action', () => {
    expect(pickFolded([outline, outline, primary])).toEqual([0, 1])
  })

  it('keeps the primary wherever it sits in the bar', () => {
    expect(pickFolded([primary, outline])).toEqual([1])
  })

  it('keeps the last filled button when a bar has two', () => {
    expect(pickFolded([primary, outline, primary])).toEqual([0, 1])
  })

  it('folds every action of a bar with no primary', () => {
    expect(pickFolded([outline, outline])).toEqual([0, 1])
  })

  it('keeps a lone action that is not filled', () => {
    expect(pickFolded([outline])).toEqual([])
  })

  it('folds an action that is not filled beside a picker', () => {
    expect(pickFolded([outline, picker, picker])).toEqual([0])
  })

  it('never folds a control that keeps its place', () => {
    expect(pickFolded([picker, outline, primary, picker])).toEqual([1])
    expect(pickFolded([picker, picker])).toEqual([])
  })

  it("keeps a split button's caret beside its primary", () => {
    const caret = { filled: true, stays: true }
    expect(pickFolded([outline, primary, caret])).toEqual([0])
  })
})
