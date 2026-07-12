'use client'

/**
 * Client-side helper that turns a fetch failure into a Swedish toast with
 * remediation hint and the X-Request-Id for support reference.
 *
 * Accepts:
 *   - the `{ error: {...} }` envelope produced by the route wrapper
 *   - a Response object (the helper reads it for you)
 *   - a raw Error / string (falls back to getErrorMessage)
 *
 * Usage:
 *   const showError = useErrorToast()
 *   const res = await fetch('/api/invoices/123/send', { method: 'POST' })
 *   if (!res.ok) {
 *     await showError(res, { context: 'invoice' })
 *     return
 *   }
 */

import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { ErrorEnvelope } from '@/lib/errors/get-structured-error'

type ErrorContext =
  | 'invoice'
  | 'supplier_invoice'
  | 'customer'
  | 'supplier'
  | 'transaction'
  | 'journal_entry'
  | 'settings'
  | 'auth'
  | 'salary'

interface ShowErrorOptions {
  context?: ErrorContext
  /** Override the toast title (Swedish summary). Defaults to envelope.message. */
  title?: string
}

interface NormalizedError {
  message: string
  remediation?: string
  requestId?: string
  code?: string
}

async function normalize(input: unknown): Promise<NormalizedError> {
  // Response: try to read JSON body and X-Request-Id header
  if (input instanceof Response) {
    const requestId = input.headers.get('X-Request-Id') ?? undefined
    let body: unknown = null
    try {
      body = await input.json()
    } catch {
      // ignore: body might be empty
    }
    const fromBody = readEnvelope(body)
    return {
      message: fromBody.message ?? getErrorMessage(body, { statusCode: input.status }),
      remediation: fromBody.remediation,
      requestId: fromBody.requestId ?? requestId,
      code: fromBody.code,
    }
  }

  const fromBody = readEnvelope(input)
  if (fromBody.message) {
    return fromBody
  }
  return { message: getErrorMessage(input) }
}

function readEnvelope(input: unknown): NormalizedError {
  if (!input || typeof input !== 'object') return { message: '' }
  const obj = input as Record<string, unknown>
  const errObj = obj.error
  if (errObj && typeof errObj === 'object') {
    const e = errObj as Partial<ErrorEnvelope['error']>
    return {
      message: typeof e.message === 'string' ? e.message : '',
      remediation:
        e.remediation && typeof e.remediation === 'object'
          ? (e.remediation as { description?: string }).description
          : undefined,
      requestId: typeof e.requestId === 'string' ? e.requestId : undefined,
      code: typeof e.code === 'string' ? e.code : undefined,
    }
  }
  return { message: '' }
}

export function useErrorToast() {
  const { toast } = useToast()

  return async function showError(input: unknown, options: ShowErrorOptions = {}) {
    const norm = await normalize(input)
    const title = options.title ?? norm.message ?? getErrorMessage(input, { context: options.context })

    const descriptionParts: string[] = []
    if (norm.remediation) descriptionParts.push(norm.remediation)
    if (norm.requestId) descriptionParts.push(`Felreferens: ${norm.requestId}`)
    if (process.env.NODE_ENV !== 'production' && norm.code) {
      descriptionParts.push(`Kod: ${norm.code}`)
    }

    toast({
      variant: 'destructive',
      title,
      description: descriptionParts.length > 0 ? descriptionParts.join(' · ') : undefined,
    })
  }
}
