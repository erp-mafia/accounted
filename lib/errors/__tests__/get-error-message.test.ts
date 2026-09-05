import { describe, it, expect } from 'vitest'
import {
  getErrorMessage,
  getProviderResourceForbiddenMessage,
  isSwedishUserMessage,
  looksLikeUserFacingSwedish,
} from '../get-error-message'
import { getErrorEntry, listErrorCodes } from '../structured-errors'
import {
  AccountsNotInChartError,
  BookkeepingDatabaseError,
  CannotEditNonDraftError,
  CannotReverseStornoError,
  JournalEntryNotBalancedError,
} from '@/lib/bookkeeping/errors'

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

describe('getErrorMessage: typed bookkeeping Error instances (issue #337)', () => {
  it('JournalEntryNotBalancedError instance → rich Swedish amount message', () => {
    const msg = getErrorMessage(new JournalEntryNotBalancedError(100, 80), { context: 'transaction' })
    expect(msg).toContain('balanserar inte')
    expect(msg).toMatch(/100/)
    expect(msg).toMatch(/80/)
    expect(msg).not.toContain('Journal entry is not balanced')
  })

  it('BookkeepingDatabaseError instance → Swedish, never the raw constraint string', () => {
    const msg = getErrorMessage(
      new BookkeepingDatabaseError(
        'commit_entry',
        'new row for relation "journal_entries" violates check constraint "check_balanced"',
      ),
      { context: 'transaction' },
    )
    expect(msg).toBe('Verifikationen kunde inte sparas. Försök igen.')
    expect(msg).not.toContain('check constraint')
    expect(msg).not.toContain('Database operation')
  })

  it('BookkeepingDatabaseError instance wrapping a period-lock trigger → specific Swedish message', () => {
    const msg = getErrorMessage(
      new BookkeepingDatabaseError('commit_entry', 'Cannot create entry in locked/closed fiscal period'),
    )
    expect(msg).toBe('Perioden är låst. Verifikationen kan inte skapas i en stängd eller låst period.')
  })

  it('AccountsNotInChartError instance → Swedish account-activation message', () => {
    const msg = getErrorMessage(new AccountsNotInChartError(['1930']))
    expect(msg).toBe('Följande konton behöver aktiveras: 1930')
  })

  it('CannotReverseStornoError instance → registry Swedish message (no dynamic branch)', () => {
    const msg = getErrorMessage(new CannotReverseStornoError('storno'))
    expect(msg).toBe(
      'En stornering kan inte stornas. Om verifikationen makulerades av misstag, bokför den på nytt (kopiera originalet).',
    )
    expect(msg).not.toContain('Cannot reverse')
  })

  it('locale "en" on a typed instance → registry English message', () => {
    const msg = getErrorMessage(new CannotReverseStornoError('storno'), { locale: 'en' })
    expect(msg).toBe(
      'A storno entry cannot be reversed. If the entry was cancelled by mistake, re-book it (copy the original).',
    )
  })

  it('regression: plain-object bare envelope with a Swedish message passes through unchanged', () => {
    const msg = getErrorMessage({ code: 'SOME_CODE', message: 'Kunde inte hantera fakturan. Försök igen.' })
    expect(msg).toBe('Kunde inte hantera fakturan. Försök igen.')
  })
})

describe('getErrorMessage: unknown-code Error instances never leak raw text (#337 follow-up)', () => {
  it('CannotEditNonDraftError instance → registry Swedish message', () => {
    const msg = getErrorMessage(new CannotEditNonDraftError('posted'))
    expect(msg).toBe('Endast utkast kan redigeras. Bokförda verifikationer rättas med storno.')
    expect(msg).not.toContain('Only draft entries')
  })

  it('CANNOT_EDIT_NON_DRAFT envelope → registry Swedish message', () => {
    const msg = getErrorMessage({
      error: { code: 'CANNOT_EDIT_NON_DRAFT', message: 'Only draft entries can be edited' },
    })
    expect(msg).toBe('Endast utkast kan redigeras. Bokförda verifikationer rättas med storno.')
  })

  it('ECONNREFUSED Error → transient Swedish message, never the socket string', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    })
    const msg = getErrorMessage(err)
    expect(msg).toBe('Kunde inte nå en extern tjänst. Försök igen om en stund.')
    expect(msg).not.toContain('127.0.0.1')
  })

  it('ECONNREFUSED Error with locale "en" → registry English message', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    })
    const msg = getErrorMessage(err, { locale: 'en' })
    expect(msg).toBe(
      'An upstream network call failed. Retry the same request after a short backoff.'
    )
  })

  it('Error with an unregistered code and English message → context fallback, not raw', () => {
    const err = Object.assign(new Error('some upstream failure text'), {
      code: 'E_SOMETHING_WEIRD',
    })
    const msg = getErrorMessage(err, { context: 'transaction' })
    expect(msg).toBe('Kunde inte hantera transaktionen. Försök igen.')
    expect(msg).not.toContain('upstream failure')
  })

  it('Error wrapping a Postgres SQLSTATE → Postgres-map Swedish message', () => {
    const err = Object.assign(
      new Error('duplicate key value violates unique constraint "invoices_pkey"'),
      { code: '23505' },
    )
    const msg = getErrorMessage(err)
    expect(msg).toBe('En post med samma uppgifter finns redan.')
    expect(msg).not.toContain('duplicate key')
  })

  it('Error with an unregistered code but a Swedish message passes through', () => {
    const err = Object.assign(new Error('Kunde inte hantera fakturan. Försök igen.'), {
      code: 'EXT_CUSTOM_CODE',
    })
    expect(getErrorMessage(err)).toBe('Kunde inte hantera fakturan. Försök igen.')
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

describe('getErrorMessage: payment-file route messages surface (issue #945)', () => {
  // These specific { error: '...' } strings previously collapsed to the generic
  // HTTP-400 message because isSwedishUserMessage did not recognize "krävs" /
  // "saknar", so the user learned nothing about why the betalfil failed.
  it('surfaces a "saknar bankkontouppgifter" message instead of the generic 400', () => {
    const msg = getErrorMessage(
      { error: '2 anställd(a) saknar bankkontouppgifter' },
      { context: 'salary', statusCode: 400 },
    )
    expect(msg).toBe('2 anställd(a) saknar bankkontouppgifter')
    expect(msg).not.toBe('Förfrågan innehåller ogiltiga uppgifter.')
  })

  it('surfaces a "... krävs ..." message instead of the generic 400', () => {
    const msg = getErrorMessage(
      { error: 'Momsregistreringsnummer krävs när företaget är momsregistrerat (ML 17 kap. 24 §)' },
      { context: 'settings', statusCode: 400 },
    )
    expect(msg).toContain('krävs')
    expect(msg).not.toBe('Förfrågan innehåller ogiltiga uppgifter.')
  })

  it('surfaces the missing company bank-account message', () => {
    const msg = getErrorMessage(
      { error: 'Företagets bankkonto (clearingnummer och kontonummer) saknas i företagsinställningar. Fyll i det under Inställningar → Fakturering för att skapa betalfil.' },
      { context: 'salary', statusCode: 400 },
    )
    expect(msg).toContain('Företagets bankkonto')
    expect(msg).not.toBe('Förfrågan innehåller ogiltiga uppgifter.')
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

/**
 * Client handlers must hand getErrorMessage() the PARSED RESPONSE BODY plus the
 * HTTP status, never `new Error(body.error)`.
 *
 * `withRouteContext` answers any thrown error with the canonical envelope
 * `{ error: { code, message, message_en } }`, so `body.error` is an OBJECT on
 * that path. `new Error(object)` stringifies it to "[object Object]", which
 * matches no known pattern and no Swedish heuristic, so the route's own reason
 * is discarded and the user is told "Något gick fel". The same call site also
 * loses the HTTP status, so the status map cannot rescue it either.
 *
 * These cases pin the contract for all three response shapes a route can
 * produce: nested envelope, the deprecated bare `{ error: 'string' }`, and no
 * parseable body at all.
 */
describe('getErrorMessage: API response body vs new Error(body.error)', () => {
  // Exactly what withRouteContext -> errorResponse() -> buildResponse() emits.
  const envelope = {
    error: {
      code: 'TARGET_PERIOD_LOCKED',
      message:
        'Räkenskapsperioden för det valda datumet är låst (t.o.m. 2026-03-31). Lås upp perioden för att flytta verifikationen dit.',
      message_en: 'The fiscal period for the selected date is locked.',
      requestId: 'req_00000000-0000-4000-8000-000000000000',
      details: { lockDate: '2026-03-31' },
    },
  }

  it('the parsed body plus statusCode resolves the envelope reason', () => {
    const msg = getErrorMessage(envelope, { statusCode: 409 })
    expect(msg).toContain('låst')
    expect(msg).toContain('2026-03-31')
    expect(msg).not.toBe('Något gick fel. Försök igen.')
  })

  it('the inner error object alone also resolves (forwarded body.error)', () => {
    const msg = getErrorMessage(envelope.error, { statusCode: 409 })
    expect(msg).toContain('låst')
    expect(msg).not.toBe('Något gick fel. Försök igen.')
  })

  // A body the platform rejects never reaches a route, and the 413 it answers
  // with is plain text: the status is the only thing left to translate.
  it('a payload-too-large rejection says so, with no body to read', () => {
    expect(getErrorMessage(null, { statusCode: 413 })).toBe(
      'Filen är för stor för att skickas. Försök igen med en mindre fil.',
    )
    expect(getErrorMessage(null, { statusCode: 413, locale: 'en' })).toBe(
      'The file is too large to send. Try again with a smaller file.',
    )
  })

  it('new Error(body.error) stringifies the envelope to "[object Object]"', () => {
    // The defect in one line: the Error constructor calls String() on the object.
    expect(new Error(envelope.error as unknown as string).message).toBe('[object Object]')
  })

  it('new Error(body.error) discards the reason and yields the generic fallback', () => {
    const thrown = new Error(envelope.error as unknown as string)
    expect(getErrorMessage(thrown)).toBe('Något gick fel. Försök igen.')
  })

  it('new Error(body.error) is not rescued by passing statusCode either', () => {
    // The status map fires, but the specific reason is already gone: the user
    // is told "a conflict occurred", not which period is locked.
    const thrown = new Error(envelope.error as unknown as string)
    const msg = getErrorMessage(thrown, { statusCode: 409 })
    expect(msg).toBe('En konflikt uppstod. Ladda om sidan och försök igen.')
    expect(msg).not.toContain('2026-03-31')
  })

  it('the same call handles the deprecated bare { error: string } shape', () => {
    const body = { error: 'Du har endast läsbehörighet i detta företag.' }
    expect(getErrorMessage(body, { statusCode: 403 })).toBe(
      'Du har endast läsbehörighet i detta företag.',
    )
  })

  // #1996: the envelope a missing PERSONNUMMER_ENCRYPTION_KEY now produces.
  it('a typed configuration-gap envelope yields the registry text per locale', () => {
    const configGap = {
      error: {
        code: 'PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED',
        message:
          'Lönemodulen är inte konfigurerad: krypteringsnyckeln för personnummer (PERSONNUMMER_ENCRYPTION_KEY) saknas i driftmiljön. Kontakta supporten.',
        message_en:
          'Payroll is not configured: the personal-number encryption key (PERSONNUMMER_ENCRYPTION_KEY) is missing from the deployment environment. Contact support.',
        requestId: 'req_00000000-0000-4000-8000-000000000001',
      },
    }
    const sv = getErrorMessage(configGap, { context: 'salary', statusCode: 503, locale: 'sv' })
    expect(sv).toBe(configGap.error.message)
    const en = getErrorMessage(configGap, { context: 'salary', statusCode: 503, locale: 'en' })
    expect(en).toBe(configGap.error.message_en)
    // Neither locale falls back to the generic 503 "temporarily unavailable"
    // text: this failure is permanent until an operator sets the variable.
    expect(sv).not.toMatch(/tillfälligt/i)
    expect(en).not.toMatch(/temporarily/i)
  })

  it('the same call handles an unparseable body via statusCode', () => {
    // `await response.json().catch(() => null)` on an HTML 403 page.
    expect(getErrorMessage(null, { statusCode: 403 })).toBe(
      'Du har inte behörighet att utföra denna åtgärd.',
    )
  })

  it('English locale gets message_en from the envelope, not the Swedish prose', () => {
    const msg = getErrorMessage(envelope, { statusCode: 409, locale: 'en' })
    expect(msg).not.toContain('Räkenskapsperioden')
    expect(msg).not.toBe('Something went wrong. Please try again.')
  })
})

/**
 * Hand-rolled `{ error: '<Swedish sentence>' }` routes (the extension routes,
 * /api/team/accept, and friends) only reach the toast verbatim when
 * isSwedishUserMessage() recognizes the sentence. Several real route strings
 * ("hittades inte", "är redan bokförd", "kan inte matchas", "en låst eller
 * saknad räkenskapsperiod") matched none of the original patterns, so even the
 * correct call-site treatment (body plus statusCode) collapsed them to the
 * status-map sentence, or, where the status has no map entry (423), to the
 * generic fallback. These pin the added patterns: hittades / redan / kan inte /
 * låst.
 */
describe('getErrorMessage: Swedish heuristic covers real route sentences', () => {
  it('"hittades inte" passes through verbatim instead of the 404 map sentence', () => {
    const body = { error: 'Skattekonto-transaktionen hittades inte.', code: 'TRANSACTION_NOT_FOUND' }
    expect(getErrorMessage(body, { statusCode: 404 })).toBe(
      'Skattekonto-transaktionen hittades inte.',
    )
  })

  it('"är redan bokförd" passes through verbatim instead of the 409 map sentence', () => {
    const body = { error: 'Transaktionen är redan bokförd.', code: 'ALREADY_BOOKED' }
    expect(getErrorMessage(body, { statusCode: 409 })).toBe('Transaktionen är redan bokförd.')
  })

  it('"kan inte" passes through verbatim', () => {
    const body = { error: 'Verifikatet är makulerat och kan inte matchas.', code: 'INVALID_CANDIDATE' }
    expect(getErrorMessage(body, { statusCode: 422 })).toBe(
      'Verifikatet är makulerat och kan inte matchas.',
    )
  })

  it('"låst eller saknad räkenskapsperiod" survives a status (423) that has no map entry', () => {
    const body = {
      error: 'Datumet 2026-01-15 ligger i en låst eller saknad räkenskapsperiod. Lås upp perioden eller hoppa över raden.',
      code: 'PERIOD_LOCKED',
    }
    const msg = getErrorMessage(body, { statusCode: 423 })
    expect(msg).toContain('låst eller saknad räkenskapsperiod')
    expect(msg).not.toBe('Något gick fel. Försök igen.')
  })

  it('an English body still falls to the status map, not passthrough', () => {
    expect(getErrorMessage({ error: 'Extension context required' }, { statusCode: 500 })).toBe(
      'Ett oväntat serverfel uppstod. Försök igen senare.',
    )
  })

  // The CashLeads Fortnox migration (2026-08-06): the sie-import finalizer's
  // guard message reached the wizard as a thrown Error, matched none of the
  // patterns, and the user saw the generic fallback instead of the reason the
  // migration stopped. Pins the added patterns: verifikation / importen.
  it('the 0-verifikationer import guard sentence passes through verbatim', () => {
    const thrown = new Error(
      'Importen skapade 0 verifikationer: markerar som misslyckad så filen kan importeras om utan replace/undo. Granska varningarna för att se vilka konton som behöver mappas.',
    )
    const msg = getErrorMessage(thrown)
    expect(msg).toContain('0 verifikationer')
    expect(msg).not.toBe('Något gick fel. Försök igen.')
  })
})

describe('getErrorMessage: GoTrue auth error patterns', () => {
  it('maps "Signups not allowed for this instance" to the closed-installation message', () => {
    // Shape mirrors a real AuthApiError: an Error instance carrying a GoTrue
    // error code that the structured registry does not know.
    const authError = Object.assign(new Error('Signups not allowed for this instance'), {
      code: 'signup_disabled',
      status: 422,
    })
    const msg = getErrorMessage(authError, { context: 'auth' })
    expect(msg).toBe(
      'Kontoregistrering är avstängd på den här installationen. Kontakta den som bjöd in dig eller din administratör för att få ett konto.',
    )
  })

  it('maps a plain "Signups not allowed" string as well', () => {
    const msg = getErrorMessage('Signups not allowed for this instance', { context: 'auth' })
    expect(msg).toContain('avstängd på den här installationen')
  })

  it('maps GoTrue "Error sending invite email" to the SMTP guidance message', () => {
    const authError = Object.assign(new Error('Error sending invite email'), {
      code: 'unexpected_failure',
      status: 500,
    })
    const msg = getErrorMessage(authError, { context: 'auth', statusCode: 502 })
    expect(msg).toBe(
      'E-postmeddelandet kunde inte skickas av autentiseringstjänsten. Kontrollera installationens SMTP-inställningar och försök igen.',
    )
  })
})

describe('getProviderResourceForbiddenMessage', () => {
  it('builds on the registry copy and appends the provider\'s own sentence', () => {
    const entry = getErrorEntry('PROVIDER_RESOURCE_FORBIDDEN')!
    const msg = getProviderResourceForbiddenMessage('Saknar behörighet för leverantörsregister.')

    // One copy of the sentence, in the registry: the toast, the API envelope
    // and the public error catalogue all have to say the same thing.
    expect(msg.startsWith(entry.message_sv)).toBe(true)
    // The provider's own words are the only part that names the register.
    expect(msg).toContain('Leverantörens svar: "Saknar behörighet för leverantörsregister."')
  })

  it('falls back to the base sentence alone when the provider sent an opaque body', () => {
    const entry = getErrorEntry('PROVIDER_RESOURCE_FORBIDDEN')!
    expect(getProviderResourceForbiddenMessage(null)).toBe(entry.message_sv)
    expect(getProviderResourceForbiddenMessage('   ')).toBe(entry.message_sv)
    expect(getProviderResourceForbiddenMessage(null, 'en')).toBe(entry.message_en)
  })

  it('never tells the user to reconnect: the same grant meets the same 403', () => {
    expect(getProviderResourceForbiddenMessage(null)).not.toMatch(/återanslut för att fortsätta/i)
  })
})

describe('getErrorMessage: INVOICE_SEND_PAYMENT_ACCOUNT_MISSING (#2126)', () => {
  const envelope = (currency?: unknown) => ({
    error: {
      code: 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING',
      message: getErrorEntry('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING')!.message_sv,
      message_en: getErrorEntry('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING')!.message_en,
      ...(currency !== undefined ? { details: { currency } } : {}),
    },
  })

  it('SEK invoice: names bankgiro/plusgiro/Swish, not a currency account', () => {
    const msg = getErrorMessage(envelope('SEK'), { statusCode: 400 })
    expect(msg).toContain('bankgiro')
    expect(msg).toContain('Inställningar → Fakturering')
    expect(msg).not.toMatch(/valuta/i)
  })

  it('EUR invoice: asks for an IBAN account for EUR', () => {
    const msg = getErrorMessage(envelope('EUR'), { statusCode: 400 })
    expect(msg).toContain('EUR')
    expect(msg).toContain('IBAN')
  })

  it('English locale gets the currency-specific English text, not the registry fallback', () => {
    const msg = getErrorMessage(envelope('SEK'), { statusCode: 400, locale: 'en' })
    expect(msg).toContain('bankgiro')
    expect(msg).toContain('Settings → Invoicing')
    expect(msg).not.toMatch(/currency/i)
  })

  it('without a currency in details, falls back to the registry text', () => {
    const msg = getErrorMessage(envelope(), { statusCode: 400 })
    expect(msg).toBe(getErrorEntry('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING')!.message_sv)
    const unknown = getErrorMessage(envelope('JPY'), { statusCode: 400 })
    expect(unknown).toBe(getErrorEntry('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING')!.message_sv)
  })

  // The preview surfaces (settings dialog, invoice page) hand the whole
  // parsed body to the mapper with the invoice context. The context fallback
  // must not shadow the specific text, and the stringified-object shape the
  // old `new Error(body.error)` produced must be recognisably the bug.
  it('preview surfaces: whole body + invoice context still yields the specific text', () => {
    const msg = getErrorMessage(envelope('SEK'), { statusCode: 400, context: 'invoice', locale: 'sv' })
    expect(msg).toContain('bankgiro')
    expect(msg).not.toBe('Kunde inte hantera fakturan. Försök igen.')

    const mangled = getErrorMessage(new Error(String(envelope('SEK').error)), { context: 'invoice' })
    expect(mangled).toBe('Kunde inte hantera fakturan. Försök igen.')
  })
})


// Issue #2086: the keyword heuristic dropped correct Swedish route messages
// that happened to lack one of its ~30 keywords and replaced them with generic
// HTTP text whose advice was sometimes wrong. A sentence that reads as Swedish
// and shows no sign of a technical leak now passes through.
describe('getErrorMessage: Swedish route messages without a keyword pass through (#2086)', () => {
  it('shows the skattekonto sync reason instead of the generic 500 text', () => {
    const msg = getErrorMessage(
      { error: 'Inget skattekonto är registrerat hos Skatteverket.' },
      { statusCode: 500 },
    )
    expect(msg).toBe('Inget skattekonto är registrerat hos Skatteverket.')
  })

  it.each([
    'Datumet ligger utanför det valda räkenskapsåret.',
    'Rättelsen motsvarar ingen ekonomisk händelse: det finns inget att rätta.',
    'Funktionen är inte implementerad ännu.',
  ])('passes through %s', (text) => {
    expect(getErrorMessage({ error: text }, { statusCode: 400 })).toBe(text)
    expect(getErrorMessage({ message: text }, { statusCode: 400 })).toBe(text)
  })

  it('still hides English and technical text behind the status/context fallback', () => {
    expect(getErrorMessage({ error: 'Failed to fetch customer' }, { statusCode: 500 })).toBe(
      'Ett oväntat serverfel uppstod. Försök igen senare.',
    )
    expect(
      getErrorMessage({ error: 'TypeError: Cannot read properties of undefined (reading "id")' }, { statusCode: 500 }),
    ).toBe('Ett oväntat serverfel uppstod. Försök igen senare.')
    // Swedish words next to a leak are still a leak.
    expect(
      getErrorMessage({ error: 'Kontot är trasigt: TypeError: x is not a function' }, { statusCode: 500 }),
    ).toBe('Ett oväntat serverfel uppstod. Försök igen senare.')
    expect(
      getErrorMessage({ error: 'Det gick inte att läsa relation "public.invoices"' }, { statusCode: 500 }),
    ).toBe('Ett oväntat serverfel uppstod. Försök igen senare.')
  })

  it('looksLikeUserFacingSwedish scores on å/ä/ö, a strong Swedish word, or two weak ones, never on English', () => {
    expect(looksLikeUserFacingSwedish('Inget skattekonto är registrerat hos Skatteverket.')).toBe(true)
    expect(looksLikeUserFacingSwedish('Det finns inget att rätta.')).toBe(true)
    expect(looksLikeUserFacingSwedish('Kopplingen misslyckades.')).toBe(true)
    expect(looksLikeUserFacingSwedish('Ingen fil bifogad.')).toBe(true)
    expect(looksLikeUserFacingSwedish('Kan hittas med den.')).toBe(true) // two weak words
    expect(looksLikeUserFacingSwedish('Not found')).toBe(false)
    expect(looksLikeUserFacingSwedish('Request failed with status 500')).toBe(false)
    expect(looksLikeUserFacingSwedish('Invalid input: expected string, received undefined')).toBe(false)
    expect(looksLikeUserFacingSwedish('')).toBe(false)
    // A lone weak word is not enough ("till" is also English).
    expect(looksLikeUserFacingSwedish('Redirect till /login')).toBe(false)
    expect(looksLikeUserFacingSwedish('Set the value for det')).toBe(false)
  })

  it('every message_sv in the structured-error registry passes the combined test', () => {
    const failing = listErrorCodes().filter((code) => {
      const entry = getErrorEntry(code)
      return entry ? !isSwedishUserMessage(entry.message_sv) : false
    })
    expect(failing).toEqual([])
  })
})
