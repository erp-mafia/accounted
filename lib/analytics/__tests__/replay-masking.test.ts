import { beforeEach, describe, expect, it, vi } from 'vitest'
import { maskSensitiveText, replayMaskInput, replayMaskText } from '@/lib/analytics/replay-masking'

// Repo test convention. eventBus.clear() is deliberately absent: these are
// pure functions and importing the bus would only add module side effects.
beforeEach(() => {
  vi.clearAllMocks()
})

/**
 * Minimal stand-ins for the DOM elements rrweb hands to the masking
 * functions (tests run in the node environment, no jsdom).
 */
function fakeElement(opts: { type?: string; tagged?: 'mask' | 'unmask' | 'both' | null } = {}): HTMLElement {
  const attrs =
    opts.tagged === 'mask'
      ? ['data-ph-mask']
      : opts.tagged === 'unmask'
        ? ['data-ph-unmask']
        : opts.tagged === 'both'
          ? ['data-ph-mask', 'data-ph-unmask']
          : []
  const tagged = attrs.length > 0 ? { hasAttribute: (name: string) => attrs.includes(name) } : null
  return {
    type: opts.type,
    closest: (_selector: string) => tagged,
  } as unknown as HTMLElement
}

describe('maskSensitiveText', () => {
  it('masks sv-SE formatted amounts, preserving length and whitespace', () => {
    // First variant groups thousands with U+00A0 (what Intl sv-SE emits), the second with a regular space.
    expect(maskSensitiveText('1 234,56 kr')).toBe('* ****** **')
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
  it('pattern-masks when the node has no tagged ancestor', () => {
    expect(replayMaskText('Saldo 1 234 kr', fakeElement())).toBe('Saldo * *** **')
    expect(replayMaskText('Saldo 1 234 kr', undefined)).toBe('Saldo * *** **')
  })

  it('masks everything under data-ph-mask', () => {
    expect(replayMaskText('Acme AB', fakeElement({ tagged: 'mask' }))).toBe('**** **')
  })

  it('passes everything through under data-ph-unmask', () => {
    expect(replayMaskText('Belopp i kr', fakeElement({ tagged: 'unmask' }))).toBe('Belopp i kr')
  })

  it('lets mask win when both attributes land on the same element', () => {
    expect(replayMaskText('Acme AB', fakeElement({ tagged: 'both' }))).toBe('**** **')
  })
})

describe('replayMaskInput', () => {
  it('always masks password inputs, even under data-ph-unmask', () => {
    expect(replayMaskInput('hunter2', fakeElement({ type: 'password' }))).toBe('*******')
    expect(replayMaskInput('hunter2', fakeElement({ type: 'password', tagged: 'unmask' }))).toBe('*******')
  })

  it('masks identity-number-shaped values, including partial typing', () => {
    expect(replayMaskInput('556677-8899', fakeElement({ type: 'text' }))).toBe('***********')
    expect(replayMaskInput('19850101-1234', fakeElement({ type: 'text' }))).toBe('*************')
    expect(replayMaskInput('5566778', fakeElement({ type: 'text' }))).toBe('*******')
  })

  it('passes ordinary typed values through', () => {
    for (const value of ['1234,56', 'Kaffe till kontoret', 'namn@exempel.se', '1930', 'Acme AB']) {
      expect(replayMaskInput(value, fakeElement({ type: 'text' }))).toBe(value)
    }
  })

  it('honors data-ph-mask on inputs', () => {
    expect(replayMaskInput('Acme AB', fakeElement({ type: 'text', tagged: 'mask' }))).toBe('**** **')
  })
})
