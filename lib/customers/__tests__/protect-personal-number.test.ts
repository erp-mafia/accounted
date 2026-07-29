/**
 * Tests for lib/customers/protect-personal-number.ts.
 *
 * customers.personal_number holds AES-256-GCM ciphertext (migration
 * 20260726110000), and every customer read surface (list, detail, export)
 * funnels rows through maskStoredCustomerPersonalNumber / maskCustomerRow.
 * The load-bearing properties:
 *
 *   1. No caller ever receives the full personnummer or the raw ciphertext:
 *      only the '********-1234' display mask.
 *   2. The helpers NEVER throw. A single corrupted/foreign-key ciphertext row
 *      used to propagate ERR_CRYPTO out of maskCustomerRow, which would 500
 *      the entire GET /api/customers list for the company. A decrypt failure
 *      must degrade to a placeholder mask for that one row instead.
 */
import { describe, it, expect } from 'vitest'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import {
  encryptCustomerPersonalNumber,
  maskCustomerRow,
  maskEmbeddedCustomer,
  maskStoredCustomerPersonalNumber,
  revealStoredCustomerPersonalNumber,
  UNDECRYPTABLE_PERSONAL_NUMBER_MASK,
} from '../protect-personal-number'
import {
  PERSONAL_NUMBER_INPUT_RE,
  isMaskedPersonalNumber,
  maskCustomerPersonalNumber,
} from '../mask-personal-number'

// Synthetic personnummer, never a real one.
const PERSONAL_NUMBER = '19900101-1234'
const MASKED = '********-1234'

// Hex of the right shape for the ciphertext CHECK (76-255 lowercase hex) that
// is NOT a valid ciphertext: the GCM auth tag can never verify.
const GARBAGE_HEX = 'ab'.repeat(40)

describe('maskStoredCustomerPersonalNumber', () => {
  it('decrypts stored ciphertext and returns only the display mask', () => {
    const stored = encryptPersonnummer(PERSONAL_NUMBER)
    expect(maskStoredCustomerPersonalNumber(stored)).toBe(MASKED)
  })

  it('masks a legacy plaintext value without attempting a decrypt', () => {
    expect(maskStoredCustomerPersonalNumber('19900101-1234')).toBe(MASKED)
    expect(maskStoredCustomerPersonalNumber('900101-1234')).toBe(MASKED)
    expect(maskStoredCustomerPersonalNumber('9001011234')).toBe(MASKED)
  })

  it('returns null for empty values', () => {
    expect(maskStoredCustomerPersonalNumber(null)).toBeNull()
    expect(maskStoredCustomerPersonalNumber(undefined)).toBeNull()
    expect(maskStoredCustomerPersonalNumber('')).toBeNull()
  })

  it('returns the placeholder mask instead of throwing on undecryptable input', () => {
    // Garbage that passes the DB ciphertext CHECK shape but fails GCM auth.
    expect(maskStoredCustomerPersonalNumber(GARBAGE_HEX)).toBe(
      UNDECRYPTABLE_PERSONAL_NUMBER_MASK,
    )
    // Real ciphertext tampered with (auth tag mismatch).
    const stored = encryptPersonnummer(PERSONAL_NUMBER)
    const tampered = (stored[0] === 'a' ? 'b' : 'a') + stored.slice(1)
    expect(maskStoredCustomerPersonalNumber(tampered)).toBe(
      UNDECRYPTABLE_PERSONAL_NUMBER_MASK,
    )
    // Not even hex-shaped.
    expect(maskStoredCustomerPersonalNumber('not-a-ciphertext')).toBe(
      UNDECRYPTABLE_PERSONAL_NUMBER_MASK,
    )
  })

  it('placeholder mask carries no digits and is never a personnummer', () => {
    // It must never read as a real suffix, and it must not be null: null here
    // would let a blind read-modify-write round-trip DELETE the stored value.
    expect(UNDECRYPTABLE_PERSONAL_NUMBER_MASK).not.toMatch(/\d/)
    expect(UNDECRYPTABLE_PERSONAL_NUMBER_MASK).not.toMatch(/^(\d{6}|\d{8})[-+]?\d{4}$/)
  })

  it('recognizes the placeholder as a mask, so a round-trip means "unchanged"', () => {
    // The property that makes an undecryptable row editable. When only
    // '********-1234' counted as a mask, the placeholder failed validation in
    // the schema, the route and the form at once, so the customer could not be
    // edited at all: not the personnummer, not the name, not the address.
    expect(isMaskedPersonalNumber(UNDECRYPTABLE_PERSONAL_NUMBER_MASK)).toBe(true)
    expect(isMaskedPersonalNumber(MASKED)).toBe(true)
    expect(PERSONAL_NUMBER_INPUT_RE.test(UNDECRYPTABLE_PERSONAL_NUMBER_MASK)).toBe(true)
    expect(PERSONAL_NUMBER_INPUT_RE.test(MASKED)).toBe(true)
  })

  it('does not mistake a real personnummer for a mask', () => {
    for (const plaintext of ['9001011234', '900101-1234', '199001011234', '19900101-1234']) {
      expect(isMaskedPersonalNumber(plaintext)).toBe(false)
      expect(PERSONAL_NUMBER_INPUT_RE.test(plaintext)).toBe(true)
    }
    expect(isMaskedPersonalNumber(null)).toBe(false)
    expect(isMaskedPersonalNumber('')).toBe(false)
    expect(isMaskedPersonalNumber('********-12345')).toBe(false)
    expect(isMaskedPersonalNumber('****-1234')).toBe(false)
    expect(PERSONAL_NUMBER_INPUT_RE.test('not-a-personal-number')).toBe(false)
  })
})

describe('maskCustomerPersonalNumber', () => {
  it('is idempotent, so masking an already-masked API value is safe', () => {
    // The detail view re-masks what the API already masked. Re-masking used to
    // turn the placeholder into null via the digit-stripping path, which
    // rendered a row that HAS a personnummer as having none.
    expect(maskCustomerPersonalNumber(MASKED)).toBe(MASKED)
    expect(maskCustomerPersonalNumber(UNDECRYPTABLE_PERSONAL_NUMBER_MASK)).toBe(
      UNDECRYPTABLE_PERSONAL_NUMBER_MASK,
    )
  })

  it('still masks a plaintext personnummer down to the last four digits', () => {
    expect(maskCustomerPersonalNumber('19900101-1234')).toBe(MASKED)
    expect(maskCustomerPersonalNumber(null)).toBeNull()
  })
})

describe('revealStoredCustomerPersonalNumber', () => {
  it('returns the full personnummer for stored ciphertext', () => {
    // The drill-in behind the mask. Without it the field is write-only: a user
    // can save a personnummer and never verify what was actually stored.
    const stored = encryptPersonnummer(PERSONAL_NUMBER)
    expect(revealStoredCustomerPersonalNumber(stored)).toBe(PERSONAL_NUMBER)
  })

  it('passes a legacy plaintext row through unchanged', () => {
    expect(revealStoredCustomerPersonalNumber('900101-1234')).toBe('900101-1234')
  })

  it('returns null when nothing is stored', () => {
    expect(revealStoredCustomerPersonalNumber(null)).toBeNull()
    expect(revealStoredCustomerPersonalNumber(undefined)).toBeNull()
    expect(revealStoredCustomerPersonalNumber('')).toBeNull()
  })

  it('throws on an undecryptable value rather than inventing a number', () => {
    // Deliberately unlike the masking helpers, which must never throw: here a
    // wrong-but-plausible answer would be worse than an error the caller can
    // turn into "retype it".
    expect(() => revealStoredCustomerPersonalNumber(GARBAGE_HEX)).toThrow()
  })
})

describe('maskEmbeddedCustomer', () => {
  it('masks the personnummer on an embedded customer join', () => {
    const stored = encryptPersonnummer(PERSONAL_NUMBER)
    const invoice = {
      id: 'i1',
      total: 1250,
      customer: { id: 'c1', name: 'Anna Andersson', personal_number: stored },
    }
    const masked = maskEmbeddedCustomer(invoice)
    expect(masked.customer.personal_number).toBe(MASKED)
    // Everything else survives untouched.
    expect(masked.id).toBe('i1')
    expect(masked.total).toBe(1250)
    expect(masked.customer.name).toBe('Anna Andersson')
  })

  it('leaves rows without an embedded customer alone', () => {
    expect(maskEmbeddedCustomer({ id: 'i1', customer: null })).toEqual({ id: 'i1', customer: null })
    expect(maskEmbeddedCustomer({ id: 'i1' })).toEqual({ id: 'i1' })
    expect(maskEmbeddedCustomer(null)).toBeNull()
  })
})

describe('maskCustomerRow', () => {
  it('replaces the stored value with the mask and leaves other fields alone', () => {
    const stored = encryptPersonnummer(PERSONAL_NUMBER)
    const row = { id: 'c1', name: 'Anna Andersson', personal_number: stored }
    expect(maskCustomerRow(row)).toEqual({
      id: 'c1',
      name: 'Anna Andersson',
      personal_number: MASKED,
    })
  })

  it('never throws on a corrupt row: the list endpoint must stay 200', () => {
    // GET /api/customers maps every row through maskCustomerRow; one bad row
    // must not take down the whole roster.
    const row = { id: 'c1', name: 'Anna Andersson', personal_number: GARBAGE_HEX }
    expect(() => maskCustomerRow(row)).not.toThrow()
    expect(maskCustomerRow(row).personal_number).toBe(UNDECRYPTABLE_PERSONAL_NUMBER_MASK)
  })

  it('passes through rows without a personal number', () => {
    const withNull: { id: string; personal_number: string | null } = {
      id: 'c1',
      personal_number: null,
    }
    const withoutKey: { id: string; personal_number?: string | null } = { id: 'c1' }
    expect(maskCustomerRow(withNull).personal_number).toBeNull()
    expect(maskCustomerRow(withoutKey).personal_number).toBeNull()
  })
})

describe('encryptCustomerPersonalNumber', () => {
  it('round-trips through the mask helper', () => {
    const stored = encryptCustomerPersonalNumber(PERSONAL_NUMBER)
    expect(stored).not.toBeNull()
    expect(stored).not.toBe(PERSONAL_NUMBER)
    expect(maskStoredCustomerPersonalNumber(stored)).toBe(MASKED)
  })

  it('maps empty input to null', () => {
    expect(encryptCustomerPersonalNumber(null)).toBeNull()
    expect(encryptCustomerPersonalNumber(undefined)).toBeNull()
    expect(encryptCustomerPersonalNumber('')).toBeNull()
  })
})
