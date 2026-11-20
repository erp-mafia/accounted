import { describe, expect, it } from 'vitest'
import { firstSentence } from '../first-sentence'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

describe('firstSentence', () => {
  it('returns a single sentence whole and leaves nothing for the popover', () => {
    expect(firstSentence('Ordrar hämtas från webshoppen och bokförs.')).toEqual({
      first: 'Ordrar hämtas från webshoppen och bokförs.',
      rest: null,
    })
  })

  it('splits two sentences at the first full stop', () => {
    expect(
      firstSentence('Transaktionerna hämtas automatiskt via PSD2. Kopplingen kan bara läsa, aldrig flytta pengar.'),
    ).toEqual({
      first: 'Transaktionerna hämtas automatiskt via PSD2.',
      rest: 'Kopplingen kan bara läsa, aldrig flytta pengar.',
    })
  })

  it('keeps every later sentence in the rest', () => {
    expect(firstSentence('Ett. Två. Tre.')).toEqual({ first: 'Ett.', rest: 'Två. Tre.' })
  })

  it('does not end the sentence at "t.ex." or "bl.a.", before a lowercase or an uppercase word', () => {
    expect(firstSentence('Hämtar underlag, t.ex. kvitton och fakturor. Inget skickas.')).toEqual({
      first: 'Hämtar underlag, t.ex. kvitton och fakturor.',
      rest: 'Inget skickas.',
    })
    expect(firstSentence('Fungerar med bl.a. Stripe och Shopify. Fler kommer.')).toEqual({
      first: 'Fungerar med bl.a. Stripe och Shopify.',
      rest: 'Fler kommer.',
    })
    expect(firstSentence('Betalningar från t.ex. Stripe hämtas.')).toEqual({
      first: 'Betalningar från t.ex. Stripe hämtas.',
      rest: null,
    })
  })

  it('does not end the sentence at the spaced form "t. ex." or at short forms like "ca." and "nr."', () => {
    expect(firstSentence('Hämtar t. ex. Kvitton varje natt. Klart.')).toEqual({
      first: 'Hämtar t. ex. Kvitton varje natt.',
      rest: 'Klart.',
    })
    expect(firstSentence('Tar ca. 5 minuter. Sedan är det klart.')).toEqual({
      first: 'Tar ca. 5 minuter.',
      rest: 'Sedan är det klart.',
    })
    expect(firstSentence('Ange nr. 12 i fältet.')).toEqual({ first: 'Ange nr. 12 i fältet.', rest: null })
  })

  it('does not end the sentence at English "e.g." and "i.e."', () => {
    expect(firstSentence('Fetches documents, e.g. Receipts and invoices. Nothing is sent.')).toEqual({
      first: 'Fetches documents, e.g. Receipts and invoices.',
      rest: 'Nothing is sent.',
    })
  })

  it('does not split inside a number, a domain or a version', () => {
    expect(firstSentence('Avgiften är 1.5 procent av beloppet.').rest).toBeNull()
    expect(firstSentence('Skicka till kvitto@example.com så sparas det.').rest).toBeNull()
  })

  it('ends a sentence at a question or exclamation mark too', () => {
    expect(firstSentence('Saknas banken? Importera en fil.')).toEqual({
      first: 'Saknas banken?',
      rest: 'Importera en fil.',
    })
  })

  it('trims surrounding whitespace and handles an empty string', () => {
    expect(firstSentence('  En mening.  ')).toEqual({ first: 'En mening.', rest: null })
    expect(firstSentence('')).toEqual({ first: '', rest: null })
  })

  // The strings Kopplingar actually renders: the first sentence must stand
  // alone, and exactly the four two-sentence rows keep a "?".
  it.each([
    ['sv', sv.settings_connections as Record<string, string>],
    ['en', en.settings_connections as Record<string, string>],
  ])('splits the shipped %s connection help as intended', (_locale, strings) => {
    const helpKeys = Object.keys(strings).filter((key) => key.endsWith('_help'))
    const withRest = helpKeys.filter((key) => firstSentence(strings[key]).rest !== null).sort()
    expect(withRest).toEqual(['bank_help', 'bank_payments_help', 'gmail_help', 'inbox_address_help'])
    for (const key of helpKeys) {
      const { first, rest } = firstSentence(strings[key])
      expect(first.endsWith('.')).toBe(true)
      expect(first.length).toBeLessThanOrEqual(140)
      // Nothing is lost: the two parts are the whole string.
      expect(rest === null ? first : `${first} ${rest}`).toBe(strings[key])
    }
  })
})
