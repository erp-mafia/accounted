import { describe, it, expect } from 'vitest'
import {
  escapeHtml,
  userTextToHtml,
  sanitizeSubjectLine,
  applyPlaceholders,
} from '../user-text'

describe('escapeHtml', () => {
  it('escapes all five special characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })

  it('leaves normal text untouched', () => {
    expect(escapeHtml('Hej Erik, här är fakturan.')).toBe('Hej Erik, här är fakturan.')
  })
})

describe('userTextToHtml', () => {
  it('escapes before converting newlines so user-typed <br> stays escaped', () => {
    expect(userTextToHtml('a<br>b\nc')).toBe('a&lt;br&gt;b<br>c')
  })

  it('converts \\r\\n, \\r and \\n to <br>', () => {
    expect(userTextToHtml('a\r\nb\rc\nd')).toBe('a<br>b<br>c<br>d')
  })
})

describe('sanitizeSubjectLine', () => {
  it('flattens newlines to spaces and trims', () => {
    expect(sanitizeSubjectLine(' Faktura\r\n1042\n ')).toBe('Faktura 1042')
  })

  it('leaves a normal subject untouched', () => {
    expect(sanitizeSubjectLine('Faktura 1042 från Acme AB')).toBe('Faktura 1042 från Acme AB')
  })
})

describe('applyPlaceholders', () => {
  const values = { fakturanummer: '1042', förnamn: 'Erik' }

  it('substitutes known keys', () => {
    expect(applyPlaceholders('Faktura {fakturanummer} till {förnamn}', values)).toBe(
      'Faktura 1042 till Erik',
    )
  })

  it('leaves unknown keys literal', () => {
    expect(applyPlaceholders('{fakturanumer}', values)).toBe('{fakturanumer}')
  })

  it('is forgiving about case and inner whitespace', () => {
    expect(applyPlaceholders('{ Förnamn }', values)).toBe('Erik')
  })

  it('leaves empty braces literal', () => {
    expect(applyPlaceholders('a {} b', values)).toBe('a {} b')
  })

  it('does not re-substitute values (single pass)', () => {
    expect(applyPlaceholders('{namn}', { namn: '{fakturanummer}' })).toBe('{fakturanummer}')
  })
})
