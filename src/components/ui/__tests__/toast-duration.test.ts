import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  TOAST_DEFAULT_MS,
  TOAST_MIN_MS,
  toastDurationMs,
  toastTextLength,
} from '../toast-duration'

describe('toastDurationMs', () => {
  it('lets a short confirmation leave after three seconds', () => {
    expect(toastDurationMs({ title: 'Godkänt' })).toBe(3000)
    expect(toastDurationMs({ title: 'Bokfört', description: 'Verifikat A 12' })).toBe(3000)
    expect(toastDurationMs({ variant: 'success', title: 'Sparat' })).toBe(3000)
    expect(toastDurationMs({ variant: 'default', title: 'Sparat' })).toBe(3000)
  })

  it('gives longer text more time to be read', () => {
    const sixty = 'x'.repeat(60)
    expect(toastDurationMs({ title: sixty })).toBe(4000)
    expect(toastDurationMs({ title: 'x'.repeat(30), description: 'y'.repeat(30) })).toBe(4000)
    expect(toastDurationMs({ title: sixty })).toBeGreaterThan(toastDurationMs({ title: 'x'.repeat(45) }))
  })

  it('never goes under three seconds and never over the time toasts had before', () => {
    for (const length of [0, 1, 40, 41, 79, 80, 81, 500]) {
      const ms = toastDurationMs({ title: 'x'.repeat(length) })
      expect(ms).toBeGreaterThanOrEqual(TOAST_MIN_MS)
      expect(ms).toBeLessThanOrEqual(TOAST_DEFAULT_MS)
    }
    expect(toastDurationMs({})).toBe(TOAST_MIN_MS)
    expect(toastDurationMs({ title: 'x'.repeat(500) })).toBe(TOAST_DEFAULT_MS)
  })

  it('keeps errors on screen as long as before', () => {
    expect(toastDurationMs({ variant: 'destructive', title: 'Fel' })).toBe(TOAST_DEFAULT_MS)
  })

  it('keeps a toast with a button (undo, open, retry) on screen as long as before', () => {
    expect(toastDurationMs({ title: 'Borttagen', hasAction: true })).toBe(TOAST_DEFAULT_MS)
  })

  it('keeps the full time when the text cannot be measured', () => {
    const element = createElement('span', null, 'Klart')
    expect(toastDurationMs({ title: element })).toBe(TOAST_DEFAULT_MS)
    expect(toastDurationMs({ title: 'Klart', description: ['a', element] })).toBe(TOAST_DEFAULT_MS)
  })
})

describe('toastTextLength', () => {
  it('counts strings, numbers and arrays of them', () => {
    expect(toastTextLength('  Sparat  ')).toBe(6)
    expect(toastTextLength(1234)).toBe(4)
    expect(toastTextLength(['Sparat', ' ', 12])).toBe(8)
    expect(toastTextLength(null)).toBe(0)
    expect(toastTextLength(undefined)).toBe(0)
    expect(toastTextLength(false)).toBe(0)
  })

  it('answers null for anything that is not plain text', () => {
    expect(toastTextLength(createElement('b', null, 'x'))).toBeNull()
    expect(toastTextLength({ code: 'X', message: 'y' } as never)).toBeNull()
  })
})

describe('where the duration is set', () => {
  const source = readFileSync(path.resolve(__dirname, '../use-toast.tsx'), 'utf8')

  it('is the toast() helper, and a caller-set duration wins', () => {
    expect(source).toMatch(/duration: props\.duration \?\? toastDurationMs\(/)
  })
})
