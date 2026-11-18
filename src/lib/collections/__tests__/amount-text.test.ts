import { describe, expect, it } from 'vitest'
import { formatInvoiceAmount, formatKronor } from '../amount-text'

// Intl separates groups and the unit with no-break spaces; compare with plain ones.
const plain = (text: string) => text.replace(/\s/g, ' ')

describe('formatKronor (one rule across the collections screens)', () => {
  it('shows whole kronor without decimals', () => {
    expect(plain(formatKronor(12500))).toBe('12 500 kr')
    expect(plain(formatKronor(0))).toBe('0 kr')
    expect(plain(formatKronor(10625.004))).toBe('10 625 kr')
  })

  it('shows öre, always both digits, only when the amount is not whole kronor', () => {
    expect(plain(formatKronor(11250.5))).toBe('11 250,50 kr')
    expect(plain(formatKronor(62.5))).toBe('62,50 kr')
    expect(plain(formatKronor(0.1 + 0.2))).toBe('0,30 kr')
  })

  it('keeps the sign', () => {
    expect(plain(formatKronor(-62.5))).toMatch(/^[-−]62,50 kr$/)
    expect(plain(formatKronor(-1500))).toMatch(/^[-−]1 500 kr$/)
  })
})

describe('formatInvoiceAmount (an amount off one invoice, in its own currency)', () => {
  const samples = [12500, 0, 10625.004, 11250.5, 62.5, 0.1 + 0.2, -62.5, -1500, 1.005]

  it('reads exactly as formatKronor for SEK and for a missing currency', () => {
    for (const amount of samples) {
      expect(formatInvoiceAmount(amount, 'SEK')).toBe(formatKronor(amount))
      expect(formatInvoiceAmount(amount, null)).toBe(formatKronor(amount))
      expect(formatInvoiceAmount(amount, undefined)).toBe(formatKronor(amount))
    }
  })

  it('labels a foreign invoice with its own currency, never kr', () => {
    expect(plain(formatInvoiceAmount(1234.5, 'USD'))).toBe('1 234,50 US$')
    expect(plain(formatInvoiceAmount(12500, 'USD'))).toBe('12 500 US$')
    expect(plain(formatInvoiceAmount(1000, 'EUR'))).toBe('1 000 €')
    expect(plain(formatInvoiceAmount(10625.004, 'USD'))).toBe('10 625 US$')
    expect(formatInvoiceAmount(1234.5, 'USD')).not.toMatch(/kr/)
  })
})
