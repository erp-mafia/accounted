import { beforeEach, describe, expect, it, vi } from 'vitest'
import { maskSensitiveText, replayMaskText } from '@/lib/analytics/replay-masking'

// Repo test convention. eventBus.clear() is deliberately absent: these are
// pure functions and importing the bus would only add module side effects.
beforeEach(() => {
  vi.clearAllMocks()
})

/**
 * Minimal stand-ins for the DOM elements rrweb hands to the masking
 * functions (tests run in the node environment, no jsdom). `closest` is
 * called once with the explicit-tag selector and, when that misses, once
 * with 'th'; the fake answers each selector like a real DOM lookup would.
 */
function fakeElement(
  opts: { tagged?: 'mask' | 'unmask' | 'both' | null; th?: boolean } = {}
): HTMLElement {
  const attrs =
    opts.tagged === 'mask'
      ? ['data-ph-mask']
      : opts.tagged === 'unmask'
        ? ['data-ph-unmask']
        : opts.tagged === 'both'
          ? ['data-ph-mask', 'data-ph-unmask']
          : null
  const tagged = attrs ? { hasAttribute: (name: string) => attrs.includes(name) } : null
  const thAncestor = opts.th ? { hasAttribute: () => false } : null
  return {
    closest: (selector: string) => (selector.includes('data-ph') ? tagged : thAncestor),
  } as unknown as HTMLElement
}

describe('maskSensitiveText', () => {
  it('masks sv-SE formatted amounts, preserving length and whitespace', () => {
    // First variant groups thousands with U+00A0 (what Intl sv-SE emits), the second with a regular space.
    expect(maskSensitiveText('1 234,56 kr')).toBe('* ****** **')
    expect(maskSensitiveText('1 234,56 kr')).toBe('* ****** **')
  })

  it('masks negative amounts with both hyphen and the Intl minus sign', () => {
    expect(maskSensitiveText('-500 kr')).toBe('**** **')
    expect(maskSensitiveText('−1 234 kr')).toBe('** *** **')
  })

  it('masks the amount inside surrounding text', () => {
    expect(maskSensitiveText('Totalt 1 234 kr att betala')).toBe('Totalt * *** ** att betala')
    expect(maskSensitiveText('999 kr/mån')).toBe('*** **/mån')
  })

  it('masks other currency markers', () => {
    expect(maskSensitiveText('12,00 €')).toBe('***** *')
    expect(maskSensitiveText('10 US$')).toBe('** ***')
    expect(maskSensitiveText('1 000 SEK')).toBe('* *** ***')
  })

  it('masks person- and organisationsnummer', () => {
    expect(maskSensitiveText('556677-8899')).toBe('***********')
    expect(maskSensitiveText('19850101-1234')).toBe('*************')
    expect(maskSensitiveText('850101+1234')).toBe('***********')
  })

  it('leaves non-amount, non-identity text untouched', () => {
    for (const text of [
      '2026-08-06',
      'Verifikat A-217',
      '070-123 45 67',
      '5050-1055',
      'namn@exempel.se',
      '10 kronor',
      'E-postadress',
      'Konto 1930',
    ]) {
      expect(maskSensitiveText(text)).toBe(text)
    }
  })
})

describe('replayMaskText', () => {
  it('masks everything when the node has no chrome ancestor', () => {
    expect(replayMaskText('Acme AB', fakeElement())).toBe('**** **')
    expect(replayMaskText('Kaffe till kontoret', fakeElement())).toBe('***** **** ********')
    expect(replayMaskText('Acme AB', undefined)).toBe('**** **')
  })

  it('masks everything when rrweb passes an element without closest (text node parents can be non-Element)', () => {
    expect(replayMaskText('Acme AB', {} as unknown as HTMLElement)).toBe('**** **')
  })

  it('shows chrome text under data-ph-unmask', () => {
    expect(replayMaskText('Bokför och godkänn', fakeElement({ tagged: 'unmask' }))).toBe(
      'Bokför och godkänn'
    )
  })

  it('shows table column headers (th) without a tag', () => {
    expect(replayMaskText('Datum', fakeElement({ th: true }))).toBe('Datum')
  })

  it('lets an explicit data-ph-mask beat the th fallback (th inside a masked container, or masked th)', () => {
    expect(replayMaskText('Acme AB', fakeElement({ tagged: 'mask', th: true }))).toBe('**** **')
  })

  it('pattern-scrubs amounts and identity numbers even inside chrome', () => {
    expect(replayMaskText('Betala 1 234 kr nu', fakeElement({ tagged: 'unmask' }))).toBe(
      'Betala * *** ** nu'
    )
    expect(replayMaskText('Ta bort 556677-8899', fakeElement({ tagged: 'unmask' }))).toBe(
      'Ta bort ***********'
    )
  })

  it('masks everything under data-ph-mask', () => {
    expect(replayMaskText('Acme AB', fakeElement({ tagged: 'mask' }))).toBe('**** **')
  })

  it('lets mask win when both attributes land on the same element', () => {
    expect(replayMaskText('Acme AB', fakeElement({ tagged: 'both' }))).toBe('**** **')
  })
})
