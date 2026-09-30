/**
 * Refusals for the doors that report failures by throwing: the hand-written
 * MCP tools and anything else whose errors reach getStructuredError.
 *
 * The dispatch reads three things off a thrown error (get-structured-error.ts):
 * `.code` (a code wins over any message inference), the thrown text (it
 * becomes message_en verbatim) and, through getErrorMessage, the Swedish text:
 * the registry's message_sv for a registered code whose thrown text is not
 * Swedish, or "field: reason" per entry of `issues` for VALIDATION_ERROR. So a
 * refusal is thrown with ENGLISH text and takes its Swedish from the registry
 * or from `issues`; both languages then name the same cause.
 *
 * Why this exists: a bare `throw new Error('<prose>')` resolves to
 * UNKNOWN_ERROR ("Något gick fel. Försök igen."), which tells an agent to
 * retry a call that cannot succeed until it changes an argument. The payroll
 * tools answered that for field, not-found and state problems an agent could
 * fix; one agent sent the same rejected call 241 times.
 */
import type { z } from 'zod'
import { ISO_DATE_MESSAGE, ISO_DATE_MESSAGE_SV } from '@/lib/invariants/iso-date'
import { isSwedishUserMessage } from './get-error-message'
import { getErrorEntry, type StructuredErrorRemediation } from './structured-errors'

/** One field at fault, with its reason in both languages. */
export interface FieldIssue {
  /** Dotted path of the argument, e.g. `vacation_days_per_year` or `items.0`. */
  field: string
  /** The reason in English (message_en). */
  en: string
  /** The reason in Swedish (message_sv). */
  sv: string
}

/** How many issues message_en spells out before summarising the rest. */
const SHOWN_ISSUES = 3

/**
 * A refusal carrying a structured-errors code. message_en is `messageEn`, so
 * it can name what the registry cannot (which id, which period); message_sv
 * is the registry sentence. A `remediation` attached here wins over the
 * registry's, for hints that need the call's own arguments.
 */
export function codedRefusal(
  code: string,
  messageEn: string,
  remediation?: StructuredErrorRemediation,
): Error {
  return Object.assign(new Error(messageEn), { code, ...(remediation ? { remediation } : {}) })
}

/**
 * VALIDATION_ERROR naming every field at fault. message_en is
 * "<context>: <field>: <reason>; ..." and message_sv is "<field>: <skäl>",
 * composed by getErrorMessage from `issues`: the canonical validation-details
 * shape the REST envelope carries (details.issues[].field / .message).
 */
export function fieldValidationError(context: string, issues: FieldIssue[]): Error {
  const shown = issues.slice(0, SHOWN_ISSUES).map((issue) => `${issue.field}: ${issue.en}`)
  const hidden = issues.length - SHOWN_ISSUES
  const text = `${context}: ${shown.join('; ')}${hidden > 0 ? ` (+${hidden} more)` : ''}`
  return Object.assign(new Error(text), {
    code: 'VALIDATION_ERROR',
    issues: issues.map((issue) => ({ field: issue.field, message: issue.sv })),
  })
}

/**
 * Every issue of a failed Zod parse as a FieldIssue: Zod's own message in
 * English, and a Swedish reason (the schema's words where it wrote Swedish,
 * otherwise rendered from the issue). `input` is what was parsed, so a
 * missing field reads as missing rather than as a type error.
 */
export function zodFieldIssues(error: z.ZodError, input: unknown): FieldIssue[] {
  return error.issues.map((issue) => fieldIssue(issue, valueAtPath(input, issue.path)))
}

/**
 * zodFieldIssues for a ZodError whose input is gone: a `.parse()` that threw
 * past its call site and reached the dispatch on its own. Only the Swedish
 * reason for a type error needs the value, and Zod 4 names what it received
 * at the end of its own message ("expected string, received undefined").
 */
export function zodErrorFieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => {
    const received = / received (undefined|null)$/.exec(issue.message)?.[1]
    // Any other value reads as "wrong type"; which one does not matter here.
    return fieldIssue(issue, received === 'undefined' ? undefined : received === 'null' ? null : issue.message)
  })
}

function fieldIssue(issue: z.core.$ZodIssue, value: unknown): FieldIssue {
  return {
    field: issue.path.map(String).join('.') || 'arguments',
    en: issue.message,
    sv: swedishReason(issue, value),
  }
}

/**
 * A service's `{ ok: false, code, details }` as a refusal. A VALIDATION_ERROR
 * whose details name a field becomes a field refusal. Any other code keeps
 * itself, and message_en adds the registry's English sentence, the run's
 * current_status when the service names it (which way out depends on it),
 * and the database message a service passes along in details.message, so a
 * statement timeout behind an INTERNAL_ERROR still reads as transient.
 */
export function serviceRefusal(
  context: string,
  failure: { code: string; details?: Record<string, unknown> },
): Error {
  const field = failure.details?.field
  const detail = failure.details?.message
  if (failure.code === 'VALIDATION_ERROR' && typeof field === 'string' && typeof detail === 'string') {
    return fieldValidationError(context, [{ field, en: detail, sv: detail }])
  }
  const status = failure.details?.current_status
  const text = [
    `${context}: ${failure.code}.`,
    getErrorEntry(failure.code)?.message_en,
    typeof status === 'string' ? `Current status: ${status}.` : undefined,
    typeof detail === 'string' ? detail : undefined,
  ]
    .filter(Boolean)
    .join(' ')
  return codedRefusal(failure.code, text)
}

const SWEDISH_TYPE: Record<string, string> = {
  string: 'text',
  number: 'ett tal',
  int: 'ett heltal',
  boolean: 'true eller false',
  object: 'ett objekt',
  array: 'en lista',
  date: 'ett datum',
}

function swedishReason(issue: z.core.$ZodIssue, value: unknown): string {
  // The schema's own words: refinements and explicit messages are written in
  // Swedish there ("Månadslön krävs ...", the personnummer pattern).
  if (issue.code === 'custom' || isSwedishUserMessage(issue.message)) return issue.message
  if (issue.message === ISO_DATE_MESSAGE) return ISO_DATE_MESSAGE_SV
  switch (issue.code) {
    case 'invalid_type':
      if (value === undefined) return 'Obligatoriskt fält saknas.'
      if (value === null) return 'Fältet kan inte tömmas (null är inte tillåtet).'
      return `Fel typ: ska vara ${SWEDISH_TYPE[issue.expected] ?? issue.expected}.`
    case 'too_small': {
      const limit = String(issue.minimum)
      if (issue.origin === 'string') return issue.minimum === 1 ? 'Får inte vara tomt.' : `Minst ${limit} tecken.`
      if (issue.origin === 'array' || issue.origin === 'set') return issue.minimum === 1 ? 'Minst en rad.' : `Minst ${limit} rader.`
      return issue.inclusive === false ? `Måste vara större än ${limit}.` : `Måste vara minst ${limit}.`
    }
    case 'too_big': {
      const limit = String(issue.maximum)
      if (issue.origin === 'string') return `Högst ${limit} tecken.`
      if (issue.origin === 'array' || issue.origin === 'set') return `Högst ${limit} rader.`
      return issue.inclusive === false ? `Måste vara mindre än ${limit}.` : `Får vara högst ${limit}.`
    }
    case 'invalid_value':
      return `Måste vara ett av: ${issue.values.map((v) => String(v)).join(', ')}.`
    case 'invalid_format':
      if (issue.format === 'email') return 'Ogiltig e-postadress.'
      if (issue.format === 'uuid') return 'Ogiltigt id: förväntade ett UUID.'
      return 'Ogiltigt format.'
    case 'unrecognized_keys':
      return `Okända fält: ${issue.keys.join(', ')}.`
    default:
      return 'Ogiltigt värde.'
  }
}

function valueAtPath(input: unknown, path: readonly PropertyKey[]): unknown {
  let node = input
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<PropertyKey, unknown>)[key]
  }
  return node
}
