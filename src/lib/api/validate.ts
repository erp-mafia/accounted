import { z } from 'zod'
import { NextResponse } from 'next/server'
import type { Logger } from '@/lib/logger'

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
    .map((issue) => (issue.field ? `${issue.field}: ${issue.message}` : issue.message))
    .filter((text) => text.trim() !== '')

  if (shown.length === 0) return 'Valideringsfel: kontrollera fälten och försök igen.'

  const hidden = errors.length - SUMMARY_ISSUE_LIMIT
  const more = hidden > 0 ? ` (+${hidden} till)` : ''
  return `Valideringsfel: ${shown.join('. ')}${more}`
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
          error: summarizeIssues(errors),
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
          error: 'Invalid query parameters',
          type: 'validation_error',
          errors,
        },
        { status: 400 },
      ),
    }
  }

  return { success: true, data: result.data }
}
