/**
 * A database error envelope is not an app error envelope (issue #2831).
 *
 * supabase-js returns `{ code, message, details, hint }`, the same shape as
 * our own `{ code, message }`, and the bare-envelope branch used to return the
 * database's English text, constraint names included. For the codes whose
 * message Postgres writes itself (classes 22, 23, 42 and PostgREST's PGRST
 * codes) the Swedish sentence for the code is now the floor. What our own
 * RPCs write for the reader still gets through: Swedish sentences, registered
 * codes and every message under P0001.
 */
import { describe, expect, it } from 'vitest'
import { getErrorMessage } from '../get-error-message'
import { getStructuredError } from '../get-structured-error'
import { getErrorEntry } from '../structured-errors'

/** A PostgREST error exactly as supabase-js hands it back. */
function pg(code: string, message: string, details: string | null = null) {
  return { code, message, details, hint: null }
}

const UNMAPPED_FK = pg(
  '23503',
  'update or delete on table "customers" violates foreign key constraint "recurring_invoice_schedules_customer_id_fkey" on table "recurring_invoice_schedules"',
  'Key (id)=(8c1b8f1e-6a8e-4b8a-9f57-3f1f0c2d9e11) is still referenced from table "recurring_invoice_schedules".',
)
const UNIQUE = pg(
  '23505',
  'duplicate key value violates unique constraint "bankid_consumed_sessions_pkey"',
  'Key (session_id)=(abc) already exists.',
)

/** Any sign of the database's own text in what the user is shown. */
const RAW = /violates|constraint|_fkey|_pkey|duplicate key|relation|column|table "|PGRST|invalid input|permission denied|row-level/i

describe('getErrorMessage: the Swedish floor for database-authored codes', () => {
  it('an unmapped 23503 gets the generic foreign key sentence, never the constraint', () => {
    const msg = getErrorMessage(UNMAPPED_FK, { context: 'customer', statusCode: 500 })
    expect(msg).toBe('Posten kan inte ändras eftersom den refereras av annan data.')
    expect(msg).not.toMatch(RAW)
    expect(msg).not.toContain('8c1b8f1e')
  })

  it('an unmapped 23505 gets the generic duplicate sentence', () => {
    // "session" is on the keyword list isSwedishUserMessage lets through: the
    // floor must not use that list on database text.
    const msg = getErrorMessage(UNIQUE)
    expect(msg).toBe('En post med samma uppgifter finns redan.')
    expect(msg).not.toMatch(RAW)
  })

  it.each([
    ['23514', 'new row for relation "invoices" violates check constraint "invoices_document_type_check"', 'Värdet uppfyller inte de tillåtna kraven.'],
    ['23502', 'null value in column "company_id" of relation "invoices" violates not-null constraint', 'Ett obligatoriskt fält saknas.'],
    ['22P02', 'invalid input syntax for type uuid: "Företag AB"', 'Ogiltigt värde angavs.'],
    ['22003', 'numeric field overflow', 'Värdet är utanför tillåtet intervall.'],
    ['42501', 'new row violates row-level security policy for table "invoices"', 'Du har inte behörighet att utföra denna åtgärd.'],
    ['42501', 'permission denied for table invoices', 'Du har inte behörighet att utföra denna åtgärd.'],
  ])('%s: %s', (code, message, expected) => {
    const msg = getErrorMessage(pg(code, message))
    expect(msg).toBe(expected)
    expect(msg).not.toMatch(RAW)
  })

  it('a quoted value with å/ä/ö does not make the database text pass as Swedish', () => {
    expect(getErrorMessage(pg('22P02', 'invalid input syntax for type integer: "två"'))).toBe('Ogiltigt värde angavs.')
  })

  it('a code without its own sentence falls back to status, then context, then generic', () => {
    const tooLong = pg('22001', 'value too long for type character varying(50)')
    expect(getErrorMessage(tooLong, { statusCode: 400 })).toBe('Förfrågan innehåller ogiltiga uppgifter.')
    expect(getErrorMessage(tooLong, { context: 'supplier' })).toBe('Kunde inte hantera leverantören. Försök igen.')
    expect(getErrorMessage(tooLong)).toBe('Något gick fel. Försök igen.')
  })

  it('a schema error (42703) and a PostgREST error never show their text', () => {
    // "session" in the column name again: no keyword list on database text.
    expect(getErrorMessage(pg('42703', 'column invoices.session_ref does not exist'))).not.toMatch(RAW)
    const pgrst = getErrorMessage(
      pg('PGRST202', 'Could not find the function public.delete_last_voucher(p_id) in the schema cache'),
      { context: 'journal_entry' },
    )
    expect(pgrst).toBe('Kunde inte hantera verifikationen. Försök igen.')
  })

  it('English locale gets the English floor', () => {
    expect(getErrorMessage(UNMAPPED_FK, { locale: 'en' })).toBe(
      'This record cannot be changed because other data refers to it.',
    )
    expect(getErrorMessage(UNIQUE, { locale: 'en' })).toBe('A record with the same details already exists.')
  })

  it('the same envelope forwarded inside { error } is floored too', () => {
    const msg = getErrorMessage({ error: UNMAPPED_FK })
    expect(msg).toBe('Posten kan inte ändras eftersom den refereras av annan data.')
  })

  it('English prose our RPCs raise under 42501 around a Swedish name is floored', () => {
    const msg = getErrorMessage(pg('42501', 'Only byrå team owners and admins can create client companies'))
    expect(msg).toBe('Du har inte behörighet att utföra denna åtgärd.')
  })

  it('reaches the agent-facing message_sv too, while message_en keeps the raw text', () => {
    const structured = getStructuredError(UNIQUE)
    expect(structured.message_sv).toBe('En post med samma uppgifter finns redan.')
    expect(structured.message_en).toBe(UNIQUE.message)
  })
})

describe('getErrorMessage: what our own RPCs write for the reader still gets through', () => {
  it('a registered code raised under 23514 answers with its registry sentence, in both locales', () => {
    // make_cash_account_primary: RAISE ... USING ERRCODE = '23514'.
    const err = pg('23514', 'CASH_ACCOUNT_PRIMARY_INELIGIBLE: not_sek')
    const entry = getErrorEntry('CASH_ACCOUNT_PRIMARY_INELIGIBLE')!
    expect(getErrorMessage(err)).toBe(entry.message_sv)
    expect(getErrorMessage(err, { locale: 'en' })).toBe(entry.message_en)
  })

  it('a registered code raised as P0001 answers with its registry sentence', () => {
    const err = pg('P0001', 'INVOICE_QUOTE_ALREADY_INVOICED: quote 1 has a live converted invoice')
    expect(getErrorMessage(err)).toBe(getErrorEntry('INVOICE_QUOTE_ALREADY_INVOICED')!.message_sv)
  })

  it('a Swedish sentence raised under a database-authored code passes through', () => {
    const sentence = 'Ingående saldon är låsta: den anställda har en bokförd lönekörning.'
    expect(getErrorMessage(pg('23514', sentence))).toBe(sentence)
    expect(getErrorMessage(pg('42501', 'Endast ägare kan ändra detta för "Företaget AB".'))).toBe(
      'Endast ägare kan ändra detta för "Företaget AB".',
    )
  })

  it('a Swedish P0001 sentence passes through unchanged', () => {
    const sentence =
      'Verifikatet kan inte raderas: utlägget är redan utbetalt eller ligger i en utbetalning. Ångra utbetalningen först.'
    expect(getErrorMessage(pg('P0001', sentence), { context: 'journal_entry', statusCode: 400 })).toBe(sentence)
  })

  it('an English P0001 message with no translation passes through as before', () => {
    const message = 'Payment batch is not in an exportable state'
    expect(getErrorMessage(pg('P0001', message), { context: 'journal_entry', statusCode: 400 })).toBe(message)
  })

  it('the live delete_last_voucher status refusal gets its Swedish sentence', () => {
    const message = 'Only posted or draft entries can be deleted (current status: cancelled)'
    expect(getErrorMessage(pg('P0001', message), { context: 'journal_entry', statusCode: 400 })).toBe(
      'Endast bokförda verifikationer och utkast kan raderas.',
    )
  })

  it('an unregistered code raised as P0001 passes through as before', () => {
    expect(getErrorMessage(pg('P0001', 'SOME_UNREGISTERED_REFUSAL: detail'))).toBe('SOME_UNREGISTERED_REFUSAL: detail')
  })

  it('delete_last_voucher refusals raised as P0001 get the Swedish sentences written for them', () => {
    const route = { context: 'journal_entry', statusCode: 400 } as const
    expect(getErrorMessage(pg('P0001', 'Cannot delete voucher in a locked fiscal period'), route)).toBe(
      'Verifikationen kan inte raderas: perioden är låst.',
    )
    expect(getErrorMessage(pg('P0001', 'Only company owners and admins can delete vouchers'), route)).toBe(
      'Endast ägare och administratörer kan radera verifikationer.',
    )
    expect(getErrorMessage(pg('P0001', 'Cannot delete: other entries reference this voucher (1 references)'), route)).toBe(
      'Verifikationen kan inte raderas eftersom andra verifikationer (t.ex. storno eller rättelse) refererar till den.',
    )
  })

  it('a registered PT409 name still answers with its own sentence', () => {
    expect(getErrorMessage(pg('PT409', 'BANK_BOOKING_SOURCE_CHANGED'))).toBe(
      getErrorEntry('BANK_BOOKING_SOURCE_CHANGED')!.message_sv,
    )
  })
})

describe('getErrorMessage: app envelopes are not database envelopes', () => {
  it('a registry code with a Swedish message passes through unchanged', () => {
    expect(getErrorMessage({ code: 'CUSTOMER_HAS_INVOICES', message: 'Kunden har fakturor och kan inte tas bort.' })).toBe(
      'Kunden har fakturor och kan inte tas bort.',
    )
  })

  it('an app envelope in English locale still prefers message_en', () => {
    expect(
      getErrorMessage({ code: 'SOME_CODE', message: 'Kunde inte spara.', message_en: 'Could not save.' }, { locale: 'en' }),
    ).toBe('Could not save.')
  })

  it('the canonical { error: { code, message } } envelope keeps its registry handling', () => {
    expect(getErrorMessage({ error: { code: 'FISCAL_PERIOD_NOT_FOUND', message: '...' } })).toBe(
      'Räkenskapsperioden kunde inte hittas.',
    )
  })

  it('an all-letter five-character code is not read as a SQLSTATE', () => {
    expect(getErrorMessage({ code: 'BUTIK', message: 'Arbetet kan inte väljas här.' })).toBe(
      'Arbetet kan inte väljas här.',
    )
  })
})
