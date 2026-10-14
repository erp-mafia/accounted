/**
 * Where the person comes back after signing payments on the bank's own page
 * (the redirect method): the Betalningar page on the app origin, with the
 * signing named. Connect hands the bank that URL as the return; the bank
 * sends the browser back to it with `state` (the same batch id), `result`
 * (ok or error) and `code` (the bank's failure code) added, and the page
 * reopens the signing dialog at its poll. The URL carries only the batch id
 * and a result flag, never the outcome itself: the truth comes from polling
 * the authorisation, exactly as for a QR signing.
 *
 * Isomorphic on purpose: the browser reads the parameters, the service builds
 * the URL. Nothing here may import a server-only module. Mirrors
 * lib/bank-feed/return-url.ts and components/bank-feed/return-link.ts for the
 * reading consents, without importing either.
 */

/** The query parameter that names the signing batch on the return. */
export const PAYMENT_SIGNING_RETURN_PARAM = 'signing'

/** The page the person comes back to: the only one that shows signings. */
export const PAYMENT_SIGNING_RETURN_PATH = '/payments'

/** Every parameter a return may carry; all are removed from the URL once read. */
export const PAYMENT_SIGNING_RETURN_QUERY_PARAMS = [PAYMENT_SIGNING_RETURN_PARAM, 'state', 'result', 'code'] as const

export type PaymentSigningReturnResult = 'ok' | 'error'

export interface PaymentSigningReturn {
  batchId: string
  /** The URL's flag, never the outcome: ok polls at once, error shows the bank's code and offers to try again. */
  result: PaymentSigningReturnResult
  /** The bank's failure code on an error return. */
  code: string | null
}

/**
 * The return URL for a signing: Betalningar on `origin` with the batch named.
 * `path` is the payment signing link's own page (/betala/<token>), built by
 * the token routes from the link and never from a request body.
 */
export function paymentSigningReturnUrl(origin: string, batchId: string, path: string = PAYMENT_SIGNING_RETURN_PATH): string {
  const url = new URL(path, origin)
  url.searchParams.set(PAYMENT_SIGNING_RETURN_PARAM, batchId)
  return url.toString()
}

/**
 * The signing to reopen, or null when the URL names none. The bank's return
 * always carries both the batch (as `signing`, mirrored in `state`) and a
 * `result`; without a result there is nothing to resume, and a bare `state`
 * could be another flow's OAuth state.
 */
export function parsePaymentSigningReturn(params: { get(name: string): string | null }): PaymentSigningReturn | null {
  const rawResult = params.get('result')
  const result: PaymentSigningReturnResult | null = rawResult === 'ok' || rawResult === 'error' ? rawResult : null
  if (!result) return null
  const batchId = params.get(PAYMENT_SIGNING_RETURN_PARAM) ?? params.get('state')
  if (!batchId) return null
  const code = result === 'error' ? (params.get('code')?.trim().toUpperCase().slice(0, 64) || null) : null
  return { batchId, result, code }
}

/** The URL without the return parameters, for history.replaceState. */
export function stripPaymentSigningReturn(href: string): string {
  const url = new URL(href)
  for (const name of PAYMENT_SIGNING_RETURN_QUERY_PARAMS) url.searchParams.delete(name)
  return url.pathname + url.search + url.hash
}
