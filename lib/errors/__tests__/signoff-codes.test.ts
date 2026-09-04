import { describe, expect, it } from 'vitest'
import { getErrorMessage } from '../get-error-message'
import { getErrorEntry } from '../structured-errors'
import { ReconciliationSignoffError, type SignoffErrorCode } from '@/lib/reconciliation/signoff'

/**
 * The sign-off refusals are composed in Swedish at the throw site (a date, an
 * amount). Before these codes were registered, getErrorMessage() fell through
 * to its generic fallback and the dialog showed "Något gick fel. Försök igen."
 * for a refused sign-off.
 */
const CODES: SignoffErrorCode[] = [
  'INVALID_DATE',
  'DATE_IN_FUTURE',
  'NOT_FETCHED_THROUGH',
  'OUTSIDE_UNKNOWN',
  'NOT_RECONCILED',
  'NOTE_REQUIRED',
  'ALREADY_SIGNED_OFF',
  'SIGNOFF_NOT_FOUND',
  'ALREADY_REOPENED',
  'SIGNOFF_RACE',
  'EXTERNAL_BALANCE_NOT_ALLOWED',
]

describe('reconciliation sign-off codes in the error registry', () => {
  it('registers every code with a Swedish and an English message', () => {
    for (const code of CODES) {
      const entry = getErrorEntry(code)
      expect(entry, code).toBeDefined()
      expect(entry?.message_sv, code).toMatch(/\S/)
      expect(entry?.message_en, code).toMatch(/\S/)
      expect(entry?.thrown_message_sv, code).toBe(true)
    }
  })

  it('passes the thrown Swedish text through verbatim, runtime detail included', () => {
    const err = new ReconciliationSignoffError(
      'Skattekontot är hämtat t.o.m. 2026-08-20. Hämta igen innan du stämmer av ett senare datum.',
      'NOT_FETCHED_THROUGH',
    )
    expect(getErrorMessage(err)).toBe(
      'Skattekontot är hämtat t.o.m. 2026-08-20. Hämta igen innan du stämmer av ett senare datum.',
    )
    const refused = new ReconciliationSignoffError(
      'Kontot har en oförklarad differens. Koppla eller bokför raderna först, eller signera med en notering.',
      'NOT_RECONCILED',
      { unexplained_difference: 53717 },
    )
    expect(getErrorMessage(refused)).toBe(
      'Kontot har en oförklarad differens. Koppla eller bokför raderna först, eller signera med en notering.',
    )
    expect(getErrorMessage(refused)).not.toMatch(/Något gick fel/)
  })

  it('gives English users the registry text', () => {
    const err = new ReconciliationSignoffError('Kontot har en oförklarad differens.', 'NOT_RECONCILED')
    expect(getErrorMessage(err, { locale: 'en' })).toBe(getErrorEntry('NOT_RECONCILED')?.message_en)
  })
})
