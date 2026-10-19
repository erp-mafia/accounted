/**
 * Where a company's own invoice series stands.
 *
 * A löpnummer has to identify the invoice uniquely within a series that lets
 * a missing invoice be spotted (ML 17 kap 24 § p. 2, BFL 5 kap 6 §). The
 * invoices already in the books decide where the series stands (migration
 * 20261012161600): generate_invoice_number issues the first value from
 * company_settings.next_invoice_number on that no invoice uses, and refuses
 * when the series already has a higher number, because issuing then would
 * fill a hole in the series or restart it. The counter is the company's
 * choice of where its series continues, so nothing here moves it on its own:
 * after a provider migration the first issue asks the company instead.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** next_invoice_number is a Postgres integer: one past the highest must still fit. */
const MAX_SERIES_NUMBER = 2_147_483_646

/**
 * The counter value an existing invoice number occupies in the company's own
 * series, or null when it is not in that series. generate_invoice_number
 * writes invoice_prefix followed by digits, so with a prefix only
 * `<prefix><digits>` is in the series; without one, only bare digits.
 * Anything else (a credit-note prefix, a year-dashed number, letters inside,
 * bare digits under a prefixed series) is another series.
 */
export function seriesNumberOf(
  invoiceNumber: string | null | undefined,
  invoicePrefix: string | null | undefined,
): number | null {
  const raw = invoiceNumber?.trim()
  if (!raw) return null
  const prefix = invoicePrefix ?? ''
  if (prefix && !raw.startsWith(prefix)) return null
  const digits = raw.slice(prefix.length)
  if (!/^\d+$/.test(digits)) return null
  const n = Number(digits)
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_SERIES_NUMBER ? n : null
}

/** A series value as generate_invoice_number prints it: the prefix, then at least three digits. */
export function formatSeriesNumber(prefix: string, value: number): string {
  return `${prefix}${String(value).padStart(3, '0')}`
}

/** Where a series stands (invoice_number_series_status). */
export interface InvoiceSeriesState {
  /** The series prefix: invoice_prefix ('' without one), or 'PF-' for proformas. */
  prefix: string
  /** The counter the state was judged for: the stored one, or the proposed one. */
  next_invoice_number: number
  /** What generate_invoice_number would issue, or null when the series is behind. */
  next_number: string | null
  /** The highest number of the series, or null when it has none. */
  highest_number: number | null
  /** A higher number than the next one already exists: issuing is refused. */
  behind: boolean
  /** The lowest next number that continues the series. */
  first_allowed: number
}

/**
 * Read where the company's series stands, or judge a proposed prefix and next
 * number (the settings check). Null when the company has no settings row.
 * Throws the database error when the read fails, so a check fails closed.
 */
export async function readInvoiceSeries(
  supabase: SupabaseClient,
  companyId: string,
  options: { documentType?: 'invoice' | 'proforma'; prefix?: string; nextNumber?: number } = {},
): Promise<InvoiceSeriesState | null> {
  const { data, error } = await supabase.rpc('invoice_number_series_status', {
    p_company_id: companyId,
    p_document_type: options.documentType ?? 'invoice',
    p_prefix: options.prefix ?? null,
    p_next_number: options.nextNumber ?? null,
  })
  if (error) throw error
  return (data as InvoiceSeriesState | null) ?? null
}

/** The numbers a "series is behind" sentence names. */
export interface InvoiceSeriesBehind {
  prefix: string
  highest_number: number
  first_allowed: number
}

/**
 * Why a number cannot be issued or chosen under the series' highest number,
 * and what the company does about it. One wording for issuing and for the
 * settings check, in both languages.
 */
export function invoiceSeriesBehindMessages(series: InvoiceSeriesBehind): { sv: string; en: string } {
  const highest = formatSeriesNumber(series.prefix, series.highest_number)
  return {
    sv:
      `Det finns redan fakturor med nummer upp till ${highest} i nummerserien. ` +
      `Ställ in Nästa fakturanummer på ${series.first_allowed} eller högre under Inställningar > Fakturor, ` +
      'eller lägg till ett prefix för en ny nummerserie.',
    en:
      `The invoice series already has numbers up to ${highest}. ` +
      `Set next_invoice_number to ${series.first_allowed} or higher, or a new invoice_prefix for a new series.`,
  }
}
