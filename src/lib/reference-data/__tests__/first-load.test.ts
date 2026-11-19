import { describe, expect, it } from 'vitest'
import { isFirstLoadPending } from '../first-load'

describe('isFirstLoadPending', () => {
  it('is pending while a fetch is in flight and nothing is held', () => {
    expect(isFirstLoadPending(true, undefined)).toBe(true)
  })

  it('is not pending while a seeded key revalidates: the seed is already data', () => {
    expect(isFirstLoadPending(true, [{ id: 'fy-2026' }])).toBe(false)
  })

  it('treats a seeded empty list and a seeded null row as answers', () => {
    expect(isFirstLoadPending(true, [])).toBe(false)
    expect(isFirstLoadPending(true, null)).toBe(false)
  })

  it('is not pending once the fetch has settled, with or without data', () => {
    expect(isFirstLoadPending(false, undefined)).toBe(false)
    expect(isFirstLoadPending(false, [])).toBe(false)
  })
})
