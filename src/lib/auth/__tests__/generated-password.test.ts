import crypto from 'crypto'
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  generateAuthPassword,
  GENERATED_PASSWORD_LENGTH,
  GOTRUE_MAX_PASSWORD_BYTES,
  PASSWORD_CHARACTER_CLASSES,
} from '../generated-password'

// GoTrue's password_required_characters presets, verbatim as the Supabase
// platform stores them (the three non-empty choices in the dashboard). Kept as
// the test's own copy so a typo in the module cannot make the test agree with it.
const GOTRUE_PRESETS = {
  letters_digits: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789',
  lower_upper_letters_digits: 'abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789',
  lower_upper_letters_digits_symbols:
    'abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()_+-=[]{};\'\\\\:"|<>?,./`~',
} as const

const GOTRUE_SYMBOLS = '!@#$%^&*()_+-=[]{};\'\\:"|<>?,./`~'

/**
 * Port of GoTrue's PasswordRequiredCharacters.Decode (internal/conf): sets are
 * separated by ':', and a set ending in a backslash escapes that separator.
 */
function decodeRequiredCharacters(value: string): string[] {
  const parts = value.split(':')
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]
    if (part === '') continue
    if (part[part.length - 1] === '\\') {
      parts[i] = part.slice(0, -1) + ':' + parts[i + 1]
      parts[i + 1] = ''
    }
  }
  return parts.filter((part) => part !== '')
}

/** Port of GoTrue's checkPasswordStrength character and length rules. */
function gotrueAccepts(password: string, requiredCharacters: string, minLength: number): boolean {
  if (Buffer.byteLength(password, 'utf8') > 72) return false
  if (Buffer.byteLength(password, 'utf8') < minLength) return false
  return decodeRequiredCharacters(requiredCharacters).every((set) =>
    [...password].some((ch) => set.includes(ch))
  )
}

const DRAWS = 5000

afterEach(() => {
  vi.restoreAllMocks()
})

describe('generateAuthPassword', () => {
  it('decodes the symbol preset the way GoTrue does (guards the test itself)', () => {
    const sets = decodeRequiredCharacters(GOTRUE_PRESETS.lower_upper_letters_digits_symbols)
    expect(sets).toHaveLength(4)
    expect(sets[3]).toBe(GOTRUE_SYMBOLS)
    expect(GOTRUE_SYMBOLS).toHaveLength(32)
  })

  it('contains a lowercase letter, an uppercase letter, a digit and a GoTrue symbol on every draw', () => {
    // The generator this replaces (32 random bytes as base64url) has no '-'
    // or '_' on about 26 percent of draws, so 5000 draws cannot pass by luck.
    for (let i = 0; i < DRAWS; i += 1) {
      const password = generateAuthPassword()
      expect(password).toMatch(/[a-z]/)
      expect(password).toMatch(/[A-Z]/)
      expect(password).toMatch(/[0-9]/)
      expect([...password].some((ch) => GOTRUE_SYMBOLS.includes(ch))).toBe(true)
    }
  })

  it('is accepted by every Supabase password preset, checked the way GoTrue checks it', () => {
    for (let i = 0; i < DRAWS; i += 1) {
      const password = generateAuthPassword()
      for (const preset of Object.values(GOTRUE_PRESETS)) {
        // 64 is far above any minimum length a project would configure.
        expect(gotrueAccepts(password, preset, 64)).toBe(true)
      }
    }
  })

  it('is 64 single-byte characters, strictly under the 72-byte limit GoTrue enforces', () => {
    // Deliberately not ON the limit: at exactly 72 one off-by-one in any Auth
    // version or fork would refuse every generated password, and GoTrue is not
    // in this test loop to catch it.
    expect(GOTRUE_MAX_PASSWORD_BYTES).toBe(72)
    expect(GENERATED_PASSWORD_LENGTH).toBe(64)
    expect(GENERATED_PASSWORD_LENGTH).toBeLessThan(GOTRUE_MAX_PASSWORD_BYTES)
    for (let i = 0; i < DRAWS; i += 1) {
      const password = generateAuthPassword()
      expect(password).toHaveLength(GENERATED_PASSWORD_LENGTH)
      expect(Buffer.byteLength(password, 'utf8')).toBe(GENERATED_PASSWORD_LENGTH)
      // Printable ASCII without the space: nothing GoTrue, JSON or bcrypt can mangle.
      expect(password).toMatch(/^[\x21-\x7e]+$/)
    }
  })

  it('exposes exactly the four classes GoTrue can require, and nothing outside them', () => {
    expect(PASSWORD_CHARACTER_CLASSES.lowercase).toBe('abcdefghijklmnopqrstuvwxyz')
    expect(PASSWORD_CHARACTER_CLASSES.uppercase).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    expect(PASSWORD_CHARACTER_CLASSES.digits).toBe('0123456789')
    expect(PASSWORD_CHARACTER_CLASSES.symbols).toBe(GOTRUE_SYMBOLS)
    const all = Object.values(PASSWORD_CHARACTER_CLASSES).join('')
    expect(new Set(all).size).toBe(all.length)
    expect(all).toHaveLength(94)
  })

  it('satisfies every class by construction, not by luck: holds for adversarial random sources', () => {
    const sources: Array<(max: number) => number> = [
      () => 0,
      (max) => max - 1,
      (max) => Math.floor(max / 2),
    ]
    for (const source of sources) {
      const password = generateAuthPassword(source)
      expect(password).toHaveLength(GENERATED_PASSWORD_LENGTH)
      for (const preset of Object.values(GOTRUE_PRESETS)) {
        expect(gotrueAccepts(password, preset, 64)).toBe(true)
      }
    }
  })

  it('takes every random choice as an unbiased bounded integer: no byte-modulo indexing', () => {
    const maxes: number[] = []
    const password = generateAuthPassword((max) => {
      maxes.push(max)
      return crypto.randomInt(max)
    })
    expect(password).toHaveLength(GENERATED_PASSWORD_LENGTH)

    // One pick per required class, the rest from the full alphabet, then one
    // pick per Fisher-Yates step. Every bound is the exact size of what is
    // being chosen from, so crypto.randomInt's rejection sampling keeps each
    // choice uniform.
    const fillers = GENERATED_PASSWORD_LENGTH - 4
    const shuffleBounds = Array.from(
      { length: GENERATED_PASSWORD_LENGTH - 1 },
      (_, step) => GENERATED_PASSWORD_LENGTH - step
    )
    expect(maxes).toEqual([26, 26, 10, 32, ...Array(fillers).fill(94), ...shuffleBounds])
  })

  it('draws from crypto.randomInt by default and never from Math.random', () => {
    const mathRandom = vi.spyOn(Math, 'random')
    const randomInt = vi.spyOn(crypto, 'randomInt')
    generateAuthPassword()
    expect(mathRandom).not.toHaveBeenCalled()
    expect(randomInt).toHaveBeenCalled()
  })

  it('does not park the guaranteed characters at fixed positions', () => {
    const classesAtFirstPosition = new Set<string>()
    const classesAtLastPosition = new Set<string>()
    const classOf = (ch: string) =>
      Object.entries(PASSWORD_CHARACTER_CLASSES).find(([, chars]) => chars.includes(ch))?.[0] ?? 'none'
    for (let i = 0; i < 2000; i += 1) {
      const password = generateAuthPassword()
      classesAtFirstPosition.add(classOf(password[0]))
      classesAtLastPosition.add(classOf(password[password.length - 1]))
    }
    expect([...classesAtFirstPosition].sort()).toEqual(['digits', 'lowercase', 'symbols', 'uppercase'])
    expect([...classesAtLastPosition].sort()).toEqual(['digits', 'lowercase', 'symbols', 'uppercase'])
  })

  it('uses the whole alphabet and never repeats a password', () => {
    const seen = new Set<string>()
    const characters = new Set<string>()
    for (let i = 0; i < 2000; i += 1) {
      const password = generateAuthPassword()
      seen.add(password)
      for (const ch of password) characters.add(ch)
    }
    expect(seen.size).toBe(2000)
    expect(characters.size).toBe(94)
  })
})
