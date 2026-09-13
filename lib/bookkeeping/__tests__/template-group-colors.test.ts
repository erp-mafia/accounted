import { describe, expect, it } from 'vitest'
import { HUE_DOT_CLASS, accountHue, templateGroupHue } from '../template-group-colors'

describe('template group colours', () => {
  it('gives every family a hue and unknown groups the neutral one', () => {
    expect(templateGroupHue('revenue')).toBe('green')
    expect(templateGroupHue('it_software')).toBe('blue')
    expect(templateGroupHue('representation')).toBe('rose')
    expect(templateGroupHue(null)).toBe('slate')
  })

  it('falls back to the account class for bare account numbers', () => {
    expect(accountHue('3041')).toBe('green')
    expect(accountHue('5420')).toBe('blue')
    expect(accountHue('6071')).toBe('rose')
    expect(accountHue('1930')).toBe('slate')
    expect(accountHue(null)).toBe('slate')
  })

  it('has a dot class for every hue', () => {
    for (const hue of ['green', 'blue', 'amber', 'rose', 'violet', 'teal', 'slate'] as const) {
      expect(HUE_DOT_CLASS[hue]).toMatch(/^bg-/)
    }
  })
})
