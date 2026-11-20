/**
 * The next invoice number the confirms show before issuing (GET
 * /api/invoices/next-number), read defensively: only a value that looks like
 * an invoice number is shown, never free-form text.
 *
 * When the company's series already has a higher number than the next one
 * (typically right after a provider migration), nothing can be issued until
 * the company says where the series continues (migration 20261012161600).
 * The confirm then offers the lowest number that continues it, and
 * continueInvoiceSeries saves that as next_invoice_number through the
 * settings save, which refuses a number the series already has.
 */

const NUMBER_PATTERN = /^[A-Za-z0-9-]{1,32}$/

export interface SeriesContinuation {
  /** The number the invoice gets: the series prefix and the first allowed value. */
  number: string
  /** The series' highest number, as printed. */
  highest: string
  /** The next_invoice_number value that continues the series. */
  nextInvoiceNumber: number
}

export interface NextNumberPreview {
  /** The number the next invoice gets, or null when unknown or the series is behind. */
  preview: string | null
  /** Set when the series is behind: the number that continues it. */
  continuation: SeriesContinuation | null
}

function looksLikeNumber(value: unknown): value is string {
  return typeof value === 'string' && NUMBER_PATTERN.test(value)
}

/** Read a GET /api/invoices/next-number body. Anything unexpected reads as "no preview". */
export function readNextNumberPreview(json: unknown): NextNumberPreview {
  const data = (json as { data?: Record<string, unknown> } | null | undefined)?.data
  if (!data) return { preview: null, continuation: null }
  const firstAllowed = data.first_allowed
  if (
    data.behind === true &&
    looksLikeNumber(data.continue_number) &&
    looksLikeNumber(data.highest_number) &&
    typeof firstAllowed === 'number' &&
    Number.isSafeInteger(firstAllowed) &&
    firstAllowed > 0
  ) {
    return {
      preview: null,
      continuation: { number: data.continue_number, highest: data.highest_number, nextInvoiceNumber: firstAllowed },
    }
  }
  return { preview: looksLikeNumber(data.preview) ? data.preview : null, continuation: null }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Save where the series continues, before issuing. The answer of a refused
 * save (a member who is not owner or admin, a number the series already has)
 * comes back as the error body, for getErrorMessage.
 */
export async function continueInvoiceSeries(
  continuation: SeriesContinuation,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    const response = await fetchImpl('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ next_invoice_number: continuation.nextInvoiceNumber }),
    })
    if (response.ok) return { ok: true }
    return { ok: false, error: await response.json().catch(() => null) }
  } catch (error) {
    return { ok: false, error }
  }
}
