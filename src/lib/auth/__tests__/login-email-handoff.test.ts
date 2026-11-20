import { describe, expect, it } from 'vitest'
import {
  LOGIN_EMAIL_HANDOFF_KEY,
  LOGIN_EMAIL_MAX_LENGTH,
  handOffLoginEmail,
  normalizeLoginEmail,
  takeLoginEmailHandoff,
} from '@/lib/auth/login-email-handoff'

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, String(value))
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

function throwingStorage() {
  const fail = () => {
    throw new Error('SecurityError')
  }
  return { getItem: fail, setItem: fail, removeItem: fail }
}

describe('normalizeLoginEmail', () => {
  it('keeps an address, trimmed', () => {
    expect(normalizeLoginEmail('anna@example.se')).toBe('anna@example.se')
    expect(normalizeLoginEmail('  anna.berg+bok@example.co.uk \n')).toBe('anna.berg+bok@example.co.uk')
  })

  it('drops what is not the shape of an address', () => {
    for (const value of ['', '   ', 'anna', 'anna@', '@example.se', 'a@b@c', 'anna berg@example.se']) {
      expect(normalizeLoginEmail(value), JSON.stringify(value)).toBeNull()
    }
  })

  it('drops control characters', () => {
    expect(normalizeLoginEmail('anna\u0000@example.se')).toBeNull()
    expect(normalizeLoginEmail('anna@exam\u007fple.se')).toBeNull()
  })

  it('caps the length at what SMTP can deliver to', () => {
    const domain = '@example.se'
    const longest = 'a'.repeat(LOGIN_EMAIL_MAX_LENGTH - domain.length) + domain
    expect(normalizeLoginEmail(longest)).toBe(longest)
    expect(normalizeLoginEmail(`a${longest}`)).toBeNull()
  })

  it('drops anything that is not a string', () => {
    for (const value of [null, undefined, 42, {}, ['anna@example.se']]) {
      expect(normalizeLoginEmail(value)).toBeNull()
    }
  })
})

describe('the hand-off from the signup page to the login form', () => {
  it('delivers the address once: taking it removes it', () => {
    const storage = memoryStorage()
    handOffLoginEmail('anna@example.se', storage)
    expect(storage.values.get(LOGIN_EMAIL_HANDOFF_KEY)).toBe('anna@example.se')

    expect(takeLoginEmailHandoff(storage)).toBe('anna@example.se')
    expect(storage.values.has(LOGIN_EMAIL_HANDOFF_KEY)).toBe(false)
    expect(takeLoginEmailHandoff(storage)).toBeNull()
  })

  it('stores nothing for a value that is not an address', () => {
    const storage = memoryStorage()
    handOffLoginEmail('not an address', storage)
    expect(storage.values.size).toBe(0)
  })

  it('re-checks what it reads, so a value planted in the tab is not filled in', () => {
    const storage = memoryStorage({ [LOGIN_EMAIL_HANDOFF_KEY]: `${'a'.repeat(300)}@example.se` })
    expect(takeLoginEmailHandoff(storage)).toBeNull()
    // Removed all the same: a bad value does not linger for the next visit.
    expect(storage.values.has(LOGIN_EMAIL_HANDOFF_KEY)).toBe(false)
  })

  it('touches only its own key', () => {
    const storage = memoryStorage({ other: 'kept' })
    handOffLoginEmail('anna@example.se', storage)
    takeLoginEmailHandoff(storage)
    expect(storage.values.get('other')).toBe('kept')
  })

  it('degrades to an empty form when storage is missing or blocked', () => {
    expect(() => handOffLoginEmail('anna@example.se', null)).not.toThrow()
    expect(takeLoginEmailHandoff(null)).toBeNull()
    expect(() => handOffLoginEmail('anna@example.se', throwingStorage())).not.toThrow()
    expect(takeLoginEmailHandoff(throwingStorage())).toBeNull()
  })

  it('is a no-op outside the browser', () => {
    expect(() => handOffLoginEmail('anna@example.se')).not.toThrow()
    expect(takeLoginEmailHandoff()).toBeNull()
  })
})
