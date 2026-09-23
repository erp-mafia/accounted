import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * Gate for the "Ta bort underlag" affordance on a transaction row (#2132).
 *
 * Mirrors DELETE /api/transactions/[id]/attach-document: once the document has
 * propagated onto a verifikation the route answers 409 (BFL 5 kap 6 §), so the
 * UI only offers the action to writers, on unbooked rows that carry a pin.
 */
export function canDetachDocument(input: {
  isBooked: boolean
  canWrite: boolean
  documentId: string | null | undefined
  hasHandler: boolean
}): boolean {
  return !input.isBooked && input.canWrite && !!input.documentId && input.hasHandler
}

/**
 * Toast description for a failed detach. A 409 carries the route's own
 * Swedish explanation (the doc is already räkenskapsinformation): surface it
 * verbatim. Everything else maps through the shared error translator.
 */
export function resolveDetachErrorMessage(status: number, body: unknown): string {
  const error = (body as { error?: unknown } | null | undefined)?.error
  if (status === 409 && typeof error === 'string' && error.trim()) return error
  return getErrorMessage(body, { context: 'transaction', statusCode: status })
}
