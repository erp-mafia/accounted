import { describe, it, expect } from 'vitest'
import { getErrorMessage } from '../get-error-message'

describe('getErrorMessage: typed bookkeeping error codes', () => {
  it('ACCOUNTS_NOT_IN_CHART → lists accounts to activate', () => {
    const msg = getErrorMessage({
      error: { code: 'ACCOUNTS_NOT_IN_CHART', message: '...', account_numbers: ['1930', '2641'] },
    })
    expect(msg).toBe('Följande konton behöver aktiveras: 1930, 2641')
  })

  it('JOURNAL_ENTRY_NOT_BALANCED with details → rich amount message', () => {
    const msg = getErrorMessage({
      error: {
        code: 'JOURNAL_ENTRY_NOT_BALANCED',
        message: 'Journal entry is not balanced: debits (100) != credits (80)',
        details: { totalDebit: 100, totalCredit: 80, kind: 'draft' },
      },
    })
    expect(msg).toContain('balanserar inte')
    expect(msg).toContain('debet')
    expect(msg).toContain('kredit')
    expect(msg).toMatch(/100/)
    expect(msg).toMatch(/80/)
  })

  it('JOURNAL_ENTRY_NOT_BALANCED without details → fallback Swedish message', () => {
    const msg = getErrorMessage({
      error: { code: 'JOURNAL_ENTRY_NOT_BALANCED', message: '...' },
    })
    expect(msg).toBe('Verifikationen balanserar inte. Kontrollera att debet och kredit är lika stora.')
  })

  it('FISCAL_PERIOD_NOT_FOUND → Swedish message', () => {
    const msg = getErrorMessage({ error: { code: 'FISCAL_PERIOD_NOT_FOUND', message: '...' } })
    expect(msg).toBe('Räkenskapsperioden kunde inte hittas.')
  })

  it('ENTRY_DATE_OUTSIDE_FISCAL_PERIOD → Swedish message', () => {
    const msg = getErrorMessage({ error: { code: 'ENTRY_DATE_OUTSIDE_FISCAL_PERIOD', message: '...' } })
    expect(msg).toBe('Datumet ligger utanför det valda räkenskapsåret.')
  })

  it('JOURNAL_ENTRY_NOT_FOUND → Swedish message', () => {
    const msg = getErrorMessage({ error: { code: 'JOURNAL_ENTRY_NOT_FOUND', message: '...' } })
    expect(msg).toBe('Verifikationen kunde inte hittas.')
  })

  it('CANNOT_REVERSE_NON_POSTED → Swedish message', () => {
    const msg = getErrorMessage({ error: { code: 'CANNOT_REVERSE_NON_POSTED', message: '...' } })
    expect(msg).toBe('Endast bokförda verifikationer kan stornas.')
  })

  it('CANNOT_CORRECT_NON_POSTED → Swedish message', () => {
    const msg = getErrorMessage({ error: { code: 'CANNOT_CORRECT_NON_POSTED', message: '...' } })
    expect(msg).toBe('Endast bokförda verifikationer kan rättas.')
  })

  it('ENTRY_ALREADY_REVERSED → Swedish concurrent-conflict message', () => {
    const msg = getErrorMessage({ error: { code: 'ENTRY_ALREADY_REVERSED', message: '...' } })
    expect(msg).toContain('redan stornats')
    expect(msg).toContain('Ladda om sidan')
  })

  it('CURRENCY_REVALUATION_ALREADY_EXISTS → Swedish message', () => {
    const msg = getErrorMessage({ error: { code: 'CURRENCY_REVALUATION_ALREADY_EXISTS', message: '...' } })
    expect(msg).toBe('En valutaomvärdering finns redan för denna period.')
  })

  it('INVALID_MAPPING_RESULT → Swedish message', () => {
    const msg = getErrorMessage({ error: { code: 'INVALID_MAPPING_RESULT', message: '...' } })
    expect(msg).toBe('Kontering saknas för transaktionen. Kontrollera bokföringsreglerna.')
  })

  it('BOOKKEEPING_DATABASE_ERROR → generic "kunde inte sparas" when no pattern matches', () => {
    const msg = getErrorMessage({
      error: {
        code: 'BOOKKEEPING_DATABASE_ERROR',
        message: 'Database operation "commit_entry" failed: some random constraint',
      },
    })
    expect(msg).toBe('Verifikationen kunde inte sparas. Försök igen.')
  })

  it('BOOKKEEPING_DATABASE_ERROR falls through to regex pattern for period lock', () => {
    // Period-lock trigger errors come through as DB errors: message should still
    // match the locked-period pattern and produce the specific Swedish message.
    const msg = getErrorMessage({
      error: {
        code: 'BOOKKEEPING_DATABASE_ERROR',
        message: 'Cannot create entry in locked/closed fiscal period',
      },
    })
    expect(msg).toBe('Perioden är låst. Verifikationen kan inte skapas i en stängd eller låst period.')
  })
})

describe('getErrorMessage: English locale uses registry English (C9)', () => {
  it('returns the registry English message for a known structured code instead of Swedish', () => {
    const code = 'FISCAL_PERIOD_NOT_FOUND'
    const sv = getErrorMessage({ error: { code, message: '...' } })
    const en = getErrorMessage({ error: { code, message: '...' } }, { locale: 'en' })

    expect(sv).toMatch(/[åäö]/i) // default (Swedish) path is unchanged
    expect(en).not.toBe(sv) // English locale now differs
    expect(en).not.toMatch(/[åäö]/i) // …and is no longer Swedish prose
    expect(en.toLowerCase()).toContain('fiscal period')
  })

  it('leaves the Swedish (default-locale) message identical to before', () => {
    expect(getErrorMessage({ error: { code: 'CANNOT_REVERSE_NON_POSTED', message: '...' } })).toBe(
      'Endast bokförda verifikationer kan stornas.',
    )
  })
})

describe('getErrorMessage: accumulated validation details', () => {
  it('surfaces the specific per-item reasons instead of the generic 400 message', () => {
    const msg = getErrorMessage(
      {
        error: 'Valideringsfel: korrigera innan godkännande',
        details: ['Tomas Tysén: Bankuppgifter saknas (clearingnummer och/eller kontonummer)'],
        warnings: [],
      },
      { context: 'salary', statusCode: 400 },
    )
    expect(msg).toContain('Tomas Tysén')
    expect(msg).toContain('Bankuppgifter saknas')
    expect(msg).toContain('Valideringsfel')
    // Must NOT collapse to the generic HTTP-400 fallback.
    expect(msg).not.toBe('Förfrågan innehåller ogiltiga uppgifter.')
  })

  it('joins multiple items and caps the list with an overflow hint', () => {
    const details = Array.from({ length: 7 }, (_, i) => `Anställd ${i + 1}: Bankuppgifter saknas`)
    const msg = getErrorMessage({ error: 'Valideringsfel', details }, { statusCode: 400 })
    expect(msg).toContain('Anställd 1')
    expect(msg).toContain('Anställd 5')
    expect(msg).toContain('•')
    expect(msg).toContain('(+2 till)')
    expect(msg).not.toContain('Anställd 6')
  })

  it('ignores a non-string details array and falls through to the status fallback', () => {
    const msg = getErrorMessage({ error: 'oklart fel', details: [{ x: 1 }] }, { statusCode: 400 })
    expect(msg).toBe('Förfrågan innehåller ogiltiga uppgifter.')
  })
})

describe('getErrorMessage: existing patterns still work', () => {
  it('regex match for "Entry date ... outside fiscal period" on plain string', () => {
    const msg = getErrorMessage('Entry date 2024-06-15 is outside fiscal period "FY 2025"')
    expect(msg).toBe('Datumet ligger utanför det valda räkenskapsåret.')
  })

  it('regex match for "locked/closed fiscal period" on plain string', () => {
    const msg = getErrorMessage('Cannot create entry in locked/closed fiscal period')
    expect(msg).toBe('Perioden är låst. Verifikationen kan inte skapas i en stängd eller låst period.')
  })

  it('Swedish message passes through unchanged', () => {
    const msg = getErrorMessage('Bokföringen är låst t.o.m. 2024-12-31.')
    expect(msg).toBe('Bokföringen är låst t.o.m. 2024-12-31.')
  })

  it('falls through to context fallback when no pattern matches', () => {
    const msg = getErrorMessage('Random English error', { context: 'transaction' })
    expect(msg).toBe('Kunde inte hantera transaktionen. Försök igen.')
  })

  it('falls through to HTTP status map', () => {
    const msg = getErrorMessage(null, { statusCode: 404 })
    expect(msg).toBe('Resursen kunde inte hittas.')
  })

  it('falls through to generic message', () => {
    const msg = getErrorMessage(null)
    expect(msg).toBe('Något gick fel. Försök igen.')
  })
})
