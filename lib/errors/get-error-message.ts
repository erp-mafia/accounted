/**
 * Maps raw errors to user-friendly localized messages.
 *
 * Priority chain:
 * 1. Zod validation field errors
 * 2. Postgres error code map
 * 3. HTTP status code map
 * 4. Context-specific fallback
 * 5. Generic fallback
 *
 * Callers can pass an explicit `locale` ('sv' | 'en'). Default 'sv' so existing
 * server-side callers (cron, background jobs, logs) keep their current Swedish
 * output. UI callers should pass the active locale from useLocale() / getLocale().
 *
 * Specific domain phrases (locked period, unbalanced voucher, etc.) remain
 * Swedish for now: those refer to statutory accounting concepts and English
 * users will still see them on Skatteverket-bound surfaces.
 */

import { formatCurrency } from '@/lib/utils'
// Pure module (no next/server): safe for the client bundles this file lives in.
import { formatDimensionValidationIssues } from '@/lib/bookkeeping/dimension-errors'
import { getErrorEntry } from './structured-errors'

type ErrorContext =
  | 'invoice'
  | 'supplier_invoice'
  | 'customer'
  | 'article'
  | 'supplier'
  | 'transaction'
  | 'journal_entry'
  | 'settings'
  | 'auth'
  | 'salary'

export type ErrorLocale = 'sv' | 'en'

interface GetErrorMessageOptions {
  context?: ErrorContext
  statusCode?: number
  locale?: ErrorLocale
}

type Bilingual = { sv: string; en: string }

function pick(b: Bilingual, locale: ErrorLocale): string {
  return b[locale] ?? b.sv
}

// Postgres error codes -> localized messages
const POSTGRES_ERROR_MAP: Record<string, Bilingual> = {
  '23505': { sv: 'En post med samma uppgifter finns redan.', en: 'A record with the same details already exists.' },
  '23503': { sv: 'Posten kan inte ändras eftersom den refereras av annan data.', en: 'This record cannot be changed because other data refers to it.' },
  '23502': { sv: 'Ett obligatoriskt fält saknas.', en: 'A required field is missing.' },
  '42501': { sv: 'Du har inte behörighet att utföra denna åtgärd.', en: 'You do not have permission to perform this action.' },
  '42P01': { sv: 'Resursen kunde inte hittas.', en: 'The resource could not be found.' },
  '23514': { sv: 'Värdet uppfyller inte de tillåtna kraven.', en: 'The value does not meet the allowed constraints.' },
  '40001': { sv: 'En annan ändring pågick samtidigt. Försök igen.', en: 'A concurrent change was in progress. Please try again.' },
  '40P01': { sv: 'En konflikt uppstod. Försök igen.', en: 'A conflict occurred. Please try again.' },
  '22P02': { sv: 'Ogiltigt värde angavs.', en: 'Invalid value supplied.' },
  '22003': { sv: 'Värdet är utanför tillåtet intervall.', en: 'Value is out of allowed range.' },
}

// HTTP status codes -> localized messages
const HTTP_STATUS_MAP: Record<number, Bilingual> = {
  400: { sv: 'Förfrågan innehåller ogiltiga uppgifter.', en: 'The request contains invalid data.' },
  401: { sv: 'Din session har gått ut. Logga in igen.', en: 'Your session has expired. Please sign in again.' },
  403: { sv: 'Du har inte behörighet att utföra denna åtgärd.', en: 'You do not have permission to perform this action.' },
  404: { sv: 'Resursen kunde inte hittas.', en: 'The resource could not be found.' },
  409: { sv: 'En konflikt uppstod. Ladda om sidan och försök igen.', en: 'A conflict occurred. Reload the page and try again.' },
  422: { sv: 'Uppgifterna kunde inte bearbetas. Kontrollera fälten och försök igen.', en: 'The data could not be processed. Check the fields and try again.' },
  429: { sv: 'För många förfrågningar. Vänta en stund och försök igen.', en: 'Too many requests. Wait a moment and try again.' },
  500: { sv: 'Ett oväntat serverfel uppstod. Försök igen senare.', en: 'An unexpected server error occurred. Please try again later.' },
  502: { sv: 'Servern är tillfälligt otillgänglig. Försök igen om en stund.', en: 'The server is temporarily unavailable. Please try again shortly.' },
  503: { sv: 'Tjänsten är tillfälligt otillgänglig. Försök igen om en stund.', en: 'The service is temporarily unavailable. Please try again shortly.' },
}

// Context-specific fallbacks
const CONTEXT_FALLBACKS: Record<ErrorContext, Bilingual> = {
  invoice: { sv: 'Kunde inte hantera fakturan. Försök igen.', en: 'Could not process the invoice. Please try again.' },
  supplier_invoice: { sv: 'Kunde inte hantera leverantörsfakturan. Försök igen.', en: 'Could not process the supplier invoice. Please try again.' },
  customer: { sv: 'Kunde inte hantera kunden. Försök igen.', en: 'Could not process the customer. Please try again.' },
  article: { sv: 'Kunde inte hantera artikeln. Försök igen.', en: 'Could not process the article. Please try again.' },
  supplier: { sv: 'Kunde inte hantera leverantören. Försök igen.', en: 'Could not process the supplier. Please try again.' },
  transaction: { sv: 'Kunde inte hantera transaktionen. Försök igen.', en: 'Could not process the transaction. Please try again.' },
  journal_entry: { sv: 'Kunde inte hantera verifikationen. Försök igen.', en: 'Could not process the journal entry. Please try again.' },
  settings: { sv: 'Kunde inte spara inställningarna. Försök igen.', en: 'Could not save settings. Please try again.' },
  auth: { sv: 'Ett fel uppstod vid inloggningen. Försök igen.', en: 'An error occurred while signing in. Please try again.' },
  salary: { sv: 'Kunde inte hantera löneuppgifterna. Försök igen.', en: 'Could not process the payroll data. Please try again.' },
}

const GENERIC_FALLBACK: Bilingual = { sv: 'Något gick fel. Försök igen.', en: 'Something went wrong. Please try again.' }

// Known error patterns → user-friendly Swedish messages
const ERROR_PATTERN_MAP: [RegExp, string | null][] = [
  [
    /locked\/closed fiscal period/i,
    'Perioden är låst. Verifikationen kan inte skapas i en stängd eller låst period.',
  ],
  [
    /Bokföringen är låst t\.o\.m\./,
    null, // null = extract the Swedish message directly from the raw error text
  ],
  [
    /Cannot attach documents to entries in a locked/i,
    'Kan inte bifoga dokument till verifikationer i en låst period.',
  ],
  [
    /Entry date .+ is outside fiscal period/i,
    'Datumet ligger utanför det valda räkenskapsåret.',
  ],
  [
    /Only company owners and admins can delete vouchers/i,
    'Endast ägare och administratörer kan radera verifikationer.',
  ],
  [
    /Journal entry not found/i,
    'Verifikationen kunde inte hittas.',
  ],
  [
    /Only posted entries can be deleted/i,
    'Endast bokförda verifikationer kan raderas.',
  ],
  [
    /Cannot delete voucher in a closed fiscal period/i,
    'Verifikationen kan inte raderas: räkenskapsåret är stängt.',
  ],
  [
    /Cannot delete voucher in a locked fiscal period/i,
    'Verifikationen kan inte raderas: perioden är låst.',
  ],
  [
    /Cannot delete: other entries reference this voucher/i,
    'Verifikationen kan inte raderas eftersom andra verifikationer (t.ex. storno eller rättelse) refererar till den.',
  ],
  [
    /timed out after \d+m?s/i,
    'Anslutningen mot tjänsten tog för lång tid. Försök igen.',
  ],
]

/**
 * Check if a message matches a known error pattern and return the Swedish translation.
 * Returns null if no pattern matches.
 */
function tryMatchKnownError(message: string): string | null {
  for (const [pattern, translation] of ERROR_PATTERN_MAP) {
    if (pattern.test(message)) {
      if (translation !== null) return translation
      // Extract the Swedish part from the message
      const match = message.match(/Bokföringen är låst t\.o\.m\. [^.]+\./)
      return match ? match[0] : 'Bokföringen är låst för denna period.'
    }
  }
  return null
}

/**
 * Simple heuristic to detect already-translated Swedish messages.
 * If the message contains common Swedish words/patterns, pass it through.
 */
function isSwedishUserMessage(message: string): boolean {
  const swedishPatterns = [
    /kunde inte/i,
    /försök igen/i,
    /ogiltigt?/i,
    /saknas/i,
    /måste/i,
    /redan finns/i,
    /gick fel/i,
    /valideringsfel/i,
    /korrigera/i,
    /bankuppgifter/i,
    /behörighet/i,
    /session/i,
    /förfrågan/i,
    /obligatorisk/i,
    /bokföringen är låst/i,
    /fält/i,
    /värde/i,
    /felaktig/i,
    /för (lång|kort|stor|liten|många|få)/i,
    /bankgiro/i,
    /personnummer/i,
    /kontonummer/i,
    /clearingnummer/i,
    /nummer är/i,
    /tillgängligt/i,
  ]
  return swedishPatterns.some((p) => p.test(message))
}

/**
 * Extract a user-friendly message from a Zod validation error shape.
 * Returns null if the error is not a Zod error.
 */
function tryParseZodErrors(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null

  const obj = error as Record<string, unknown>

  // Check for Zod-style field errors: { fieldName: ["message"] } or { issues: [...] }
  if (Array.isArray(obj.issues)) {
    const issues = obj.issues as Array<{ message?: string; path?: string[] }>
    const messages = issues
      .slice(0, 3)
      .map((issue) => {
        const field = issue.path?.join('.') || ''
        const msg = issue.message || 'ogiltigt värde'
        return field ? `${field}: ${msg}` : msg
      })
    if (messages.length > 0) return messages.join('. ')
  }

  // Check for { errors: [{ field, message, code }] } shape from validateBody
  if (Array.isArray(obj.errors)) {
    const items = obj.errors as Array<{ field?: string; message?: string }>
    const messages = items
      .slice(0, 3)
      .map((it) => {
        const field = it.field || ''
        const msg = it.message || 'ogiltigt värde'
        return field ? `${field}: ${msg}` : msg
      })
      .filter(Boolean)
    if (messages.length > 0) return messages.join('. ')
  }

  // Check for { errors: { field: ["msg"] } } shape (legacy)
  if (typeof obj.errors === 'object' && obj.errors !== null) {
    const fieldErrors = obj.errors as Record<string, string[]>
    const messages: string[] = []
    for (const [field, msgs] of Object.entries(fieldErrors)) {
      if (Array.isArray(msgs) && msgs.length > 0) {
        messages.push(`${field}: ${msgs[0]}`)
      }
      if (messages.length >= 3) break
    }
    if (messages.length > 0) return messages.join('. ')
  }

  return null
}

/**
 * Get a user-friendly Swedish error message from a raw error.
 *
 * @param error - The raw error. Can be an API response body (object), Error instance, string, or unknown.
 * @param options - Optional context and HTTP status code.
 */
export function getErrorMessage(
  error: unknown,
  options: GetErrorMessageOptions = {}
): string {
  const { context, statusCode, locale = 'sv' } = options

  // 1. If it's a string, check if it's already Swedish or matches a known pattern
  if (typeof error === 'string' && error.trim()) {
    if (isSwedishUserMessage(error)) return error
    const knownError = tryMatchKnownError(error)
    if (knownError) return knownError
  }

  // 2. If it's an object, try various parsing strategies
  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>

    // Bare envelope inner-error shape: { code, message, message_en?, ... }.
    // Happens when a caller forwards `result.error` (the inner object) instead
    // of the whole `result`. Pick the English variant when the UI locale is
    // English; otherwise fall back to the Swedish `message`.
    if (typeof obj.code === 'string' && typeof obj.message === 'string' && obj.message.trim()) {
      if (locale === 'en' && typeof obj.message_en === 'string' && obj.message_en.trim()) {
        return obj.message_en
      }
      return obj.message
    }

    // Structured application error: { error: { code, message, message_en?, ... } }
    if (typeof obj.error === 'object' && obj.error !== null) {
      const structured = obj.error as {
        code?: unknown
        message?: unknown
        message_en?: unknown
        account_numbers?: unknown
        details?: unknown
      }

      // For English UI, return the registry's English message for any known
      // code instead of falling through to the Swedish branches below (which
      // ignored locale: English users were shown Swedish prose). The Swedish
      // path is left entirely unchanged; codes absent from the registry still
      // fall through. The dynamic branches (amounts / lock date / reason) keep
      // owning Swedish display.
      if (locale === 'en' && typeof structured.code === 'string') {
        const entry = getErrorEntry(structured.code)
        if (entry?.message_en) return entry.message_en
      }

      if (structured.code === 'ACCOUNTS_NOT_IN_CHART' && Array.isArray(structured.account_numbers)) {
        const numbers = structured.account_numbers as string[]
        return `Följande konton behöver aktiveras: ${numbers.join(', ')}`
      }

      if (structured.code === 'JOURNAL_ENTRY_NOT_BALANCED') {
        const details = structured.details as { totalDebit?: number; totalCredit?: number } | undefined
        if (details && typeof details.totalDebit === 'number' && typeof details.totalCredit === 'number') {
          return `Verifikationen balanserar inte (${formatCurrency(details.totalDebit)} debet vs ${formatCurrency(details.totalCredit)} kredit).`
        }
        return 'Verifikationen balanserar inte. Kontrollera att debet och kredit är lika stora.'
      }

      if (structured.code === 'FISCAL_PERIOD_NOT_FOUND') {
        return 'Räkenskapsperioden kunde inte hittas.'
      }

      if (structured.code === 'ENTRY_DATE_OUTSIDE_FISCAL_PERIOD') {
        return 'Datumet ligger utanför det valda räkenskapsåret.'
      }

      if (structured.code === 'JOURNAL_ENTRY_NOT_FOUND') {
        return 'Verifikationen kunde inte hittas.'
      }

      if (structured.code === 'CANNOT_REVERSE_NON_POSTED') {
        return 'Endast bokförda verifikationer kan stornas.'
      }

      if (structured.code === 'CANNOT_CORRECT_NON_POSTED') {
        return 'Endast bokförda verifikationer kan rättas.'
      }

      if (structured.code === 'ENTRY_ALREADY_REVERSED') {
        return 'Verifikationen har redan stornats av en annan användare. Ladda om sidan och försök igen.'
      }

      if (structured.code === 'CURRENCY_REVALUATION_ALREADY_EXISTS') {
        return 'En valutaomvärdering finns redan för denna period.'
      }

      if (structured.code === 'INVALID_MAPPING_RESULT') {
        return 'Kontering saknas för transaktionen. Kontrollera bokföringsreglerna.'
      }

      if (structured.code === 'DIMENSION_VALIDATION_FAILED') {
        // Prefer reconstructing the per-code Swedish sentences from the
        // machine-readable issue list (present on both the dashboard and the
        // v1/registry error envelopes); fall back to the message, which the
        // engine already emits in Swedish naming the offending codes.
        const details = structured.details as { issues?: unknown } | undefined
        const formatted = formatDimensionValidationIssues(details?.issues)
        if (formatted) return formatted
        if (typeof structured.message === 'string' && structured.message.trim()) {
          return structured.message
        }
        return 'Ett angivet kostnadsställe/projekt finns inte i dimensionsregistret eller är arkiverat. Skapa värdet i registret först.'
      }

      if (structured.code === 'NO_OPEN_PERIOD_FOR_DATE') {
        return 'Det finns ingen räkenskapsperiod som täcker det valda datumet. Skapa eller öppna räkenskapsåret först.'
      }

      if (structured.code === 'TARGET_PERIOD_CLOSED') {
        return 'Räkenskapsåret för det valda datumet är stängt (bokslut) och kan inte återöppnas. Bokför rättelsen i innevarande period istället.'
      }

      if (structured.code === 'TARGET_PERIOD_LOCKED') {
        const details = structured.details as { lockDate?: string } | undefined
        return details?.lockDate
          ? `Räkenskapsperioden för det valda datumet är låst (t.o.m. ${details.lockDate}). Lås upp perioden för att flytta verifikationen dit.`
          : 'Räkenskapsperioden för det valda datumet är låst. Lås upp perioden för att flytta verifikationen dit.'
      }

      if (structured.code === 'MEANINGLESS_CORRECTION') {
        const details = structured.details as { reason?: string } | undefined
        if (details?.reason === 'no_date_change') {
          return 'Det nya datumet är samma som det nuvarande: det finns inget att flytta.'
        }
        if (details?.reason === 'identical_to_original') {
          return 'Rättelsen är identisk med originalverifikationen: inget har ändrats.'
        }
        return 'Rättelsen saknar ekonomisk innebörd: varje konto netto till noll. En rättelse måste beskriva en faktisk affärshändelse (BFL 5 kap. 5 §).'
      }

      if (structured.code === 'BOOKKEEPING_DATABASE_ERROR') {
        // A DB-layer error may carry a user-relevant cause (e.g. period lock
        // trigger). Try the known-pattern map before falling back to the
        // generic "kunde inte sparas" message.
        if (typeof structured.message === 'string') {
          const matched = tryMatchKnownError(structured.message)
          if (matched) return matched
        }
        return 'Verifikationen kunde inte sparas. Försök igen.'
      }

      if (locale === 'en' && typeof structured.message_en === 'string' && structured.message_en.trim()) {
        return structured.message_en
      }
      if (typeof structured.message === 'string' && structured.message.trim()) {
        return structured.message
      }
    }

    // Accumulated per-item validation list from routes that collect several
    // problems before responding, e.g. the salary approve route:
    //   { error: 'Valideringsfel …', details: ['Tomas Tysén: Bankuppgifter saknas …', …] }
    // Surface the specific reasons: otherwise this shape falls all the way
    // through to the generic HTTP-400 message and the user learns nothing.
    if (
      Array.isArray(obj.details) &&
      obj.details.length > 0 &&
      obj.details.every((d) => typeof d === 'string' && d.trim() !== '')
    ) {
      const items = (obj.details as string[]).map((d) => d.trim())
      const shown = items.slice(0, 5).join(' • ')
      const more = items.length > 5 ? ` (+${items.length - 5} till)` : ''
      const lead = typeof obj.error === 'string' && obj.error.trim() ? `${obj.error.trim()}: ` : ''
      return `${lead}${shown}${more}`
    }

    // Try Zod validation errors
    const zodMessage = tryParseZodErrors(obj)
    if (zodMessage) return zodMessage

    // Try Postgres error code
    if (typeof obj.code === 'string' && POSTGRES_ERROR_MAP[obj.code]) {
      return pick(POSTGRES_ERROR_MAP[obj.code], locale)
    }

    // Try known error patterns (e.g. locked period triggers)
    for (const field of ['error', 'message'] as const) {
      if (typeof obj[field] === 'string' && obj[field].trim()) {
        const knownError = tryMatchKnownError(obj[field])
        if (knownError) return knownError
      }
    }

    // Try error.message if it's already a good Swedish message
    if (typeof obj.error === 'string' && obj.error.trim()) {
      if (isSwedishUserMessage(obj.error)) return obj.error
    }

    if (typeof obj.message === 'string' && obj.message.trim()) {
      if (isSwedishUserMessage(obj.message)) return obj.message
    }
  }

  // 3. Error instance
  if (error instanceof Error && error.message.trim()) {
    const knownError = tryMatchKnownError(error.message)
    if (knownError) return knownError
    if (isSwedishUserMessage(error.message)) return error.message
  }

  // 4. HTTP status code map
  if (statusCode && HTTP_STATUS_MAP[statusCode]) {
    return pick(HTTP_STATUS_MAP[statusCode], locale)
  }

  // 5. Context-specific fallback
  if (context && CONTEXT_FALLBACKS[context]) {
    return pick(CONTEXT_FALLBACKS[context], locale)
  }

  // 6. Generic fallback
  return pick(GENERIC_FALLBACK, locale)
}

/**
 * Helper that parses a Response body and returns a user-friendly error message.
 */
export async function getResponseErrorMessage(
  response: Response,
  context?: ErrorContext,
  locale?: ErrorLocale,
): Promise<string> {
  try {
    const body = await response.json()
    return getErrorMessage(body, { context, statusCode: response.status, locale })
  } catch {
    return getErrorMessage(null, { context, statusCode: response.status, locale })
  }
}
