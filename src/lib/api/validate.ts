import { z } from 'zod'
import { NextResponse } from 'next/server'
import type { Logger } from '@/lib/logger'
import { swedishIssueReason } from '@/lib/errors/refusal'
import { looksLikeUserFacingSwedish } from '@/lib/errors/get-error-message'

export interface ValidationSuccess<T> {
  success: true
  data: T
}

export interface ValidationFailure {
  success: false
  response: NextResponse
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure

interface ValidationOptions {
  /** Optional logger; when present, validation failures are logged at warn level. */
  log?: Logger
  /** Identifier for the operation/route being validated, included in the log line. */
  operation?: string
}

/** How many field issues the human-readable `error` summary names before truncating. */
const SUMMARY_ISSUE_LIMIT = 3

/**
 * Build the human-readable `error` string for a Zod validation failure.
 *
 * `errors[]` keeps the full machine-readable detail, but plenty of clients read
 * only `error`. A constant there ('Validation failed') either reached the user
 * as English boilerplate in a Swedish UI, or got swallowed by
 * `getErrorMessage()`'s generic "Något gick fel" fallback because the constant
 * matches nothing it knows. The 'Valideringsfel' lead-in is load-bearing: it is
 * what makes `getErrorMessage()` recognize the sentence as an already-Swedish
 * user message and pass it through verbatim, so clients that forward
 * `body.error` alone still show the actionable field message.
 *
 * `type: 'validation_error'` remains the machine-readable discriminator; nothing
 * should branch on this prose.
 */
function summarizeIssues(errors: Array<{ field: string; message: string }>): string {
  const shown = errors
    .slice(0, SUMMARY_ISSUE_LIMIT)
    .map((issue) => {
      // One sentence per issue: the Swedish reasons end with a period, a
      // schema's own message may not.
      const message = issue.message.trim().replace(/[.:;,]+$/, '')
      return issue.field ? `${issue.field}: ${message}` : message
    })
    .filter((text) => text.trim() !== '')

  if (shown.length === 0) return 'Valideringsfel: kontrollera fälten och försök igen.'

  const hidden = errors.length - SUMMARY_ISSUE_LIMIT
  const more = hidden > 0 ? ` (+${hidden} till)` : ''
  return `Valideringsfel: ${shown.join('. ')}.${more}`
}

/**
 * The words a person knows for the fields the dashboard's forms send. A field
 * not named here keeps its key, as before; the reason after it is Swedish
 * either way.
 */
const FIELD_LABELS: Record<string, string> = {
  name: 'Namn',
  email: 'E-postadress',
  phone: 'Telefonnummer',
  org_number: 'Organisationsnummer',
  personal_number: 'Personnummer',
  vat_number: 'Momsregistreringsnummer',
  bankgiro: 'Bankgiro',
  plusgiro: 'Plusgiro',
  iban: 'IBAN',
  bic: 'BIC/SWIFT',
  clearing_number: 'Clearingnummer',
  bank_account: 'Bankkonto',
  address_line1: 'Adress',
  address_line2: 'Adress',
  postal_code: 'Postnummer',
  city: 'Ort',
  country: 'Land',
  description: 'Beskrivning',
  title: 'Titel',
  notes: 'Anteckning',
  amount: 'Belopp',
  quantity: 'Antal',
  unit: 'Enhet',
  unit_price: 'À-pris',
  vat_rate: 'Momssats',
  currency: 'Valuta',
  exchange_rate: 'Växelkurs',
  account_number: 'Kontonummer',
  entry_date: 'Datum',
  invoice_date: 'Fakturadatum',
  due_date: 'Förfallodatum',
  invoice_number: 'Fakturanummer',
  supplier_invoice_number: 'Fakturanummer',
  your_reference: 'Er referens',
  our_reference: 'Vår referens',
  customer_number: 'Kundnummer',
  start_date: 'Startdatum',
  end_date: 'Slutdatum',
  period_start: 'Startdatum',
  period_end: 'Slutdatum',
  items: 'Rader',
  lines: 'Rader',
}

/** "Antal (rad 2)" for items.1.quantity; the dotted key when the field has no label. */
function fieldLabel(path: readonly PropertyKey[]): string {
  const keys = path.map(String)
  const isIndex = (key: string) => /^\d+$/.test(key)
  let namedAt = keys.length - 1
  while (namedAt >= 0 && isIndex(keys[namedAt])) namedAt -= 1
  const label = namedAt >= 0 ? FIELD_LABELS[keys[namedAt]] : undefined
  if (!label) return keys.join('.')
  const row = namedAt > 0 && isIndex(keys[namedAt - 1]) ? Number(keys[namedAt - 1]) + 1 : null
  return row === null ? label : `${label} (rad ${row})`
}

/**
 * The issues as a person reads them: a field label and a Swedish reason. A
 * schema's own Swedish message ("Ange periodens startdatum") is the reason;
 * Zod's English defaults get the shared Swedish sentence.
 */
function shownIssues(issues: readonly z.core.$ZodIssue[], input: unknown): Array<{ field: string; message: string }> {
  return issues.map((issue) => ({
    field: fieldLabel(issue.path),
    message: looksLikeUserFacingSwedish(issue.message) ? issue.message : swedishIssueReason(issue, input),
  }))
}

function logIssues(
  options: ValidationOptions | undefined,
  kind: 'body' | 'query' | 'json',
  issues: Array<{ field: string; message: string; code: string }> | string,
) {
  if (!options?.log) return
  options.log.warn('validation failed', {
    operation: options.operation,
    kind,
    ...(typeof issues === 'string'
      ? { reason: issues }
      : { issueCount: issues.length, issues }),
  })
}

/**
 * Validate a request body against a Zod schema.
 *
 * Returns `{ success: true, data }` on valid input, or
 * `{ success: false, response }` with a 400 NextResponse on failure.
 *
 * Usage in an API route:
 * ```ts
 * const result = await validateBody(request, CreateInvoiceSchema)
 * if (!result.success) return result.response
 * const { data } = result
 * ```
 */
export async function validateBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  options?: ValidationOptions,
): Promise<ValidationResult<T>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    logIssues(options, 'json', 'Invalid JSON in request body')
    return {
      success: false,
      response: NextResponse.json(
        {
          error: 'Invalid JSON in request body',
          type: 'validation_error',
        },
        { status: 400 },
      ),
    }
  }

  const result = schema.safeParse(body)

  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }))

    logIssues(options, 'body', errors)

    return {
      success: false,
      response: NextResponse.json(
        {
          error: summarizeIssues(shownIssues(result.error.issues, body)),
          type: 'validation_error',
          errors,
        },
        { status: 400 },
      ),
    }
  }

  return { success: true, data: result.data }
}

/**
 * Validate query parameters (from URL searchParams) against a Zod schema.
 *
 * Usage:
 * ```ts
 * const params = validateQuery(request, VatDeclarationQuerySchema)
 * if (!params.success) return params.response
 * const { data } = params
 * ```
 */
export function validateQuery<T>(
  request: Request,
  schema: z.ZodType<T>,
  options?: ValidationOptions,
): ValidationResult<T> {
  const url = new URL(request.url)
  const raw = Object.fromEntries(url.searchParams.entries())

  const result = schema.safeParse(raw)

  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }))

    logIssues(options, 'query', errors)

    return {
      success: false,
      response: NextResponse.json(
        {
          // The same Swedish summary as a body: 'Invalid query parameters'
          // reached a Swedish user verbatim, or as the generic line.
          error: summarizeIssues(shownIssues(result.error.issues, raw)),
          type: 'validation_error',
          errors,
        },
        { status: 400 },
      ),
    }
  }

  return { success: true, data: result.data }
}
