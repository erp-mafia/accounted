/**
 * Small pure parts of the shell: the company tile's initials and the count
 * the Att göra page publishes for the sidebar's Behöver dig row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { companyInitials } from '../company-initials'
import { publishNeedCount } from '../need-count'

describe('companyInitials', () => {
  it.each([
    ['Kvarnby Snickeri AB', 'KS'],
    ['Simulerat Konsult AB', 'SK'],
    ['  brf   lärkan ', 'BL'],
    ['Accounted', 'AC'],
    ['X', 'X'],
    ['', '?'],
  ])('%s -> %s', (name, initials) => {
    expect(companyInitials(name)).toBe(initials)
  })
})

describe('the Behöver dig count', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is kept per company for the browser session, as a whole number of things', () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
      },
    })
    publishNeedCount('company-a', 22)
    publishNeedCount('company-b', 3.9)
    publishNeedCount('company-a', -4)
    expect(stored.get('accounted:need-count:company-a')).toBe('0')
    expect(stored.get('accounted:need-count:company-b')).toBe('3')
  })

  it('still publishes where storage is blocked', () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: () => {
          throw new Error('blocked')
        },
        setItem: () => {
          throw new Error('blocked')
        },
      },
    })
    expect(() => publishNeedCount('company-c', 5)).not.toThrow()
  })
})
