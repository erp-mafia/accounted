import { describe, expect, it, vi } from 'vitest'
import { composerMayAutoFocus } from '../composer-focus'

describe('composerMayAutoFocus', () => {
  it('focuses when the primary pointer is a mouse or trackpad', () => {
    const matchMedia = vi.fn((_query: string) => ({ matches: false }))
    expect(composerMayAutoFocus(matchMedia)).toBe(true)
    expect(matchMedia.mock.calls[0][0]).toBe('(pointer: coarse)')
  })

  it('never focuses on a touch device', () => {
    expect(composerMayAutoFocus(() => ({ matches: true }))).toBe(false)
  })

  it('does not focus where matchMedia is missing', () => {
    expect(composerMayAutoFocus(undefined)).toBe(false)
    expect(composerMayAutoFocus(null)).toBe(false)
  })
})
