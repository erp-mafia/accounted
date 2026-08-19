import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { parseInvoiceDateRange } from './date-range-parser'

export type PeriodiseringSource = 'invoice' | 'supplier_invoice'
export type PeriodiseringConfidence = 'high' | 'medium' | 'low'

/** The entity types the materiality wording distinguishes between. Mirrors
 *  `EntityType` in `@/types` without importing app types into lib/. */
export type PeriodiseringEntityType = 'enskild_firma' | 'aktiebolag'

/**
 * Materiality floor for auto-detected periodiseringar, in SEK.
 *
 * Both simplification tracks land on the same number: K1 (BFNAR 2006:1,
 * förenklat årsbokslut for enskild firma) has no requirement to accrue posts
 * below 5 000 kr, and K2 (BFNAR 2016:10) lets a company skip accruing
 * individual recurring costs below 5 000 kr. Suggestions under the floor are
 * TAGGED as low confidence rather than dropped: the relief is a MAY, never a
 * MUST, so the user can still accept them. Personnel costs (BAS 70xx-76xx)
 * must always be accrued regardless of amount, so the floor never applies
 * there. The floor is a SEK threshold: for foreign-currency invoices it is
 * compared against the subtotal_sek-derived amount, and when no SEK amount
 * can be resolved the floor is skipped entirely rather than compared against
 * a number in the wrong currency (mirrors the accrual-k2-hint decision,
 * DECISIONS.md 2026-07-26).
 */
export const PERIODISERING_MATERIALITY_FLOOR_SEK = 5000

export interface PeriodiseringSuggestion {
  /** Underlying source invoice id (invoices.id or supplier_invoices.id). */
  source_invoice_id: string
  source_type: PeriodiseringSource
  /** Net amount of the invoice (subtotal: excludes VAT, since VAT is
   *  reported in its own period and not periodiserad). */
  original_amount: number
  /** Portion of `original_amount` that falls AFTER period_end and should be
   *  reclassified to 17xx / 2970. Rounded to whole krona to match the
   *  manual prepaid/accrued helpers. */
  periodisering_amount: number
  /** Inclusive ISO start of the parsed service window. */
  parsed_start: string
  /** Inclusive ISO end of the parsed service window. */
  parsed_end: string
  confidence: PeriodiseringConfidence
  /** One-sentence Swedish explanation for the wizard card. */
  reason: string
  /** Human-readable label of the source (supplier name / customer name +
   *  invoice number) for the wizard card. */
  source_label: string
  /** Suggested BAS accounts. For supplier invoices: prepaid (1710) ← expense
   *  (the source line's account_number, fallback 5800). For customer
   *  invoices: deferred revenue (2970) ← revenue (3001 default). */
  suggested_prepaid_account: string | null
  suggested_deferred_account: string | null
}

interface InvoiceRow {
  id: string
  invoice_number: string | null
  invoice_date: string
  subtotal: number
  currency: string | null
  subtotal_sek: number | null
  notes: string | null
  customers: { name: string } | null
  invoice_items: { description: string }[] | null
}

interface SupplierInvoiceRow {
  id: string
  supplier_invoice_number: string
  invoice_date: string
  subtotal: number
  currency: string | null
  subtotal_sek: number | null
  notes: string | null
  suppliers: { name: string } | null
  supplier_invoice_items: { description: string; account_number: string }[] | null
}

/** Compute the inclusive number of days between two ISO dates. */
function daysBetweenInclusive(startIso: string, endIso: string): number {
  const start = new Date(startIso + 'T00:00:00Z').getTime()
  const end = new Date(endIso + 'T00:00:00Z').getTime()
  const days = Math.round((end - start) / 86_400_000) + 1
  return days
}

/** First ISO date strictly after `iso`. */
function nextDayIso(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Build a suggestion if the parsed window extends beyond `periodEnd`. The
 * portion AFTER period_end is the periodiseringsbelopp: pro-rated over
 * total days in the parsed window.
 *
 * Returns null when:
 *   - no parseable range in the description / line items
 *   - parsed range ends on or before period_end (nothing to periodisera)
 *   - parsed range starts on or after the day after period_end (entire
 *     window is in the next year: that's a true prepaid for the next year,
 *     but it was booked in THIS year; pro-rate is 100%)
 */
function buildSuggestion(args: {
  sourceId: string
  sourceType: PeriodiseringSource
  netAmount: number
  /** Invoice currency (ISO code). Null/undefined is treated as SEK. */
  currency: string | null
  /** SEK-converted net amount (subtotal_sek). Null when the invoice predates
   *  the SEK columns or no exchange rate was captured. */
  netAmountSek: number | null
  description: string | null
  itemDescriptions: string[]
  /** Account numbers of the source lines (supplier invoices only; customer
   *  invoices carry no expense accounts). The first entry doubles as the
   *  default expense account for a future manual-entry pre-fill; today the
   *  list only drives the personnel-cost (70xx-76xx) exemption from the
   *  materiality floor. */
  itemAccounts: string[]
  sourceLabel: string
  periodEnd: string
  /** Drives the regelverk cited in the materiality wording: K1 (BFNAR
   *  2006:1) for enskild firma, K2 (BFNAR 2016:10) otherwise. */
  entityType?: PeriodiseringEntityType | null
}): PeriodiseringSuggestion | null {
  const { sourceId, sourceType, netAmount, currency, netAmountSek, description, itemDescriptions, itemAccounts, sourceLabel, periodEnd, entityType } = args
  if (!Number.isFinite(netAmount) || netAmount <= 0) return null

  // Try the head text first, then each item: first hit wins.
  let parsed = parseInvoiceDateRange(description)
  let parsedFromItem = false
  if (!parsed) {
    for (const itemDesc of itemDescriptions) {
      const p = parseInvoiceDateRange(itemDesc)
      if (p) {
        parsed = p
        parsedFromItem = true
        break
      }
    }
  }
  if (!parsed) return null

  // If the parsed range ends within the period, nothing to periodisera.
  if (parsed.endDate <= periodEnd) return null

  const totalDays = daysBetweenInclusive(parsed.startDate, parsed.endDate)
  if (totalDays <= 0) return null

  const periodisationStart = parsed.startDate > periodEnd ? parsed.startDate : nextDayIso(periodEnd)
  const daysAfterPeriodEnd = daysBetweenInclusive(periodisationStart, parsed.endDate)
  if (daysAfterPeriodEnd <= 0) return null

  const ratio = daysAfterPeriodEnd / totalDays
  const periodisationAmount = roundOre(netAmount * ratio)

  if (periodisationAmount <= 0) return null

  // Confidence policy: parsed from the head description wins "high"; parsed
  // from a line item lands at "medium" since the head text is the canonical
  // location.
  let confidence: PeriodiseringConfidence = parsedFromItem ? 'medium' : 'high'

  const isSupplier = sourceType === 'supplier_invoice'
  let reason = isSupplier
    ? `Leverantörsfakturan löper ${parsed.startDate}: ${parsed.endDate}. ${daysAfterPeriodEnd} av ${totalDays} dagar avser nästa räkenskapsår.`
    : `Kundfakturan löper ${parsed.startDate}: ${parsed.endDate}. ${daysAfterPeriodEnd} av ${totalDays} dagar avser nästa räkenskapsår.`

  // Materiality floor: below 5 000 kr the K1/K2 simplifications say the post
  // normally need not be accrued, so downgrade to "low" (the wizard only
  // pre-ticks "high") and say why. Personnel costs (BAS 70xx-76xx) are exempt
  // from the relief and keep their confidence: they must always be accrued.
  // 78xx (avskrivningar) and 79xx (övriga rörelsekostnader) are NOT personnel
  // costs, so they get the relief like any other cost.
  //
  // The floor is a SEK threshold. For a foreign-currency invoice the
  // comparison uses the periodisation share of subtotal_sek; when no SEK
  // amount is available the floor is SKIPPED entirely, because tagging on an
  // amount in the wrong currency is strictly worse than not tagging
  // (accrual-k2-hint precedent, DECISIONS.md 2026-07-26).
  const touchesPersonnelCost = itemAccounts.some((a) => /^7[0-6]/.test(a ?? ''))
  const isSek = !currency || currency === 'SEK'
  let periodisationAmountSek: number | null = null
  if (isSek) {
    periodisationAmountSek = periodisationAmount
  } else if (netAmountSek != null && Number.isFinite(netAmountSek) && netAmountSek > 0) {
    periodisationAmountSek = roundOre(netAmountSek * ratio)
  }
  if (
    periodisationAmountSek !== null &&
    periodisationAmountSek < PERIODISERING_MATERIALITY_FLOOR_SEK &&
    !touchesPersonnelCost
  ) {
    confidence = 'low'
    const regelverk = entityType === 'enskild_firma' ? 'K1' : 'K2'
    reason = `${reason} Under 5 000 kr: behöver normalt inte periodiseras (${regelverk}).`
  }

  return {
    source_invoice_id: sourceId,
    source_type: sourceType,
    original_amount: netAmount,
    periodisering_amount: periodisationAmount,
    parsed_start: parsed.startDate,
    parsed_end: parsed.endDate,
    confidence,
    reason,
    source_label: sourceLabel,
    suggested_prepaid_account: isSupplier ? '1710' : null,
    suggested_deferred_account: isSupplier ? null : '2970',
  }
}

/**
 * Auto-detect candidate periodiseringar for a fiscal period. Scans:
 *   - customer invoices (sent / partially_paid / paid) issued within the
 *     period whose notes / line items mention a service window
 *   - supplier invoices (approved or paid) registered within the period,
 *     same parsing
 *
 * The returned suggestions are NEVER posted automatically: the wizard
 * surfaces them with a confidence badge and the user accepts/rejects each.
 */
export async function detectPeriodisering(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options?: {
    /** Company entity type: chooses the regelverk the materiality wording
     *  cites (K1 for enskild_firma, K2 otherwise). Optional so callers that
     *  cannot resolve it still get suggestions with the K2 default. */
    entityType?: PeriodiseringEntityType | null
  },
): Promise<PeriodiseringSuggestion[]> {
  const entityType = options?.entityType ?? null
  // Resolve the fiscal period window. We scope candidate invoices to those
  // dated within the period: anything outside is either an opening-balance
  // carryover (its own concern) or a future invoice (no period to detect).
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()
  if (periodError || !period) return []

  const periodStart = period.period_start as string
  const periodEnd = period.period_end as string

  // Invoices already covered by a löpande accrual schedule (periodisering
  // skapad på fakturaraden) are handled month by month and must never be
  // suggested again at year-end: that would periodisera the same belopp
  // twice. Cancelled schedules don't exclude: their invoice was credited and
  // the status filters below drop it anyway.
  const { data: scheduleRows } = await supabase
    .from('accrual_schedules')
    .select('supplier_invoice_id, invoice_id')
    .eq('company_id', companyId)
    .neq('status', 'cancelled')
  const coveredSupplierInvoices = new Set(
    ((scheduleRows ?? []) as Array<{ supplier_invoice_id: string | null }>)
      .map((row) => row.supplier_invoice_id)
      .filter(Boolean),
  )
  const coveredInvoices = new Set(
    ((scheduleRows ?? []) as Array<{ invoice_id: string | null }>)
      .map((row) => row.invoice_id)
      .filter(Boolean),
  )

  // Customer invoices: only "real" ones (sent/paid). Drafts and overdue
  // get skipped: drafts haven't moved through the engine, overdue is just a
  // status label that overlaps with sent here.
  const { data: invoiceRows } = await supabase
    .from('invoices')
    .select('id, invoice_number, invoice_date, subtotal, currency, subtotal_sek, notes, customers(name), invoice_items(description)')
    .eq('company_id', companyId)
    .gte('invoice_date', periodStart)
    .lte('invoice_date', periodEnd)
    .in('status', ['sent', 'partially_paid', 'paid', 'overdue'])

  // Supplier invoices: approved or paid (registration journal entry exists).
  const { data: supplierRows } = await supabase
    .from('supplier_invoices')
    .select(
      'id, supplier_invoice_number, invoice_date, subtotal, currency, subtotal_sek, notes, suppliers(name), supplier_invoice_items(description, account_number)',
    )
    .eq('company_id', companyId)
    .gte('invoice_date', periodStart)
    .lte('invoice_date', periodEnd)
    .in('status', ['approved', 'partially_paid', 'paid'])

  const suggestions: PeriodiseringSuggestion[] = []

  for (const row of (invoiceRows ?? []) as unknown as InvoiceRow[]) {
    if (coveredInvoices.has(row.id)) continue
    const itemDescs = (row.invoice_items ?? []).map((i) => i.description).filter(Boolean)
    const customerName = row.customers?.name ?? 'Okänd kund'
    const sourceLabel = row.invoice_number
      ? `${customerName} (faktura ${row.invoice_number})`
      : customerName
    const s = buildSuggestion({
      sourceId: row.id,
      sourceType: 'invoice',
      netAmount: Number(row.subtotal ?? 0),
      currency: row.currency ?? null,
      netAmountSek: row.subtotal_sek != null ? Number(row.subtotal_sek) : null,
      description: row.notes,
      itemDescriptions: itemDescs,
      itemAccounts: [],
      sourceLabel,
      periodEnd,
      entityType,
    })
    if (s) suggestions.push(s)
  }

  for (const row of (supplierRows ?? []) as unknown as SupplierInvoiceRow[]) {
    if (coveredSupplierInvoices.has(row.id)) continue
    const itemDescs = (row.supplier_invoice_items ?? []).map((i) => i.description).filter(Boolean)
    const itemAccounts = (row.supplier_invoice_items ?? [])
      .map((i) => i.account_number)
      .filter(Boolean)
    const supplierName = row.suppliers?.name ?? 'Okänd leverantör'
    const sourceLabel = `${supplierName} (lev.faktura ${row.supplier_invoice_number})`
    const s = buildSuggestion({
      sourceId: row.id,
      sourceType: 'supplier_invoice',
      netAmount: Number(row.subtotal ?? 0),
      currency: row.currency ?? null,
      netAmountSek: row.subtotal_sek != null ? Number(row.subtotal_sek) : null,
      description: row.notes,
      itemDescriptions: itemDescs,
      itemAccounts,
      sourceLabel,
      periodEnd,
      entityType,
    })
    if (s) suggestions.push(s)
  }

  // Sort by confidence (high first) then by amount desc so the wizard shows
  // the biggest, most-confident proposals at the top.
  suggestions.sort((a, b) => {
    const order: Record<PeriodiseringConfidence, number> = { high: 0, medium: 1, low: 2 }
    if (order[a.confidence] !== order[b.confidence]) return order[a.confidence] - order[b.confidence]
    return b.periodisering_amount - a.periodisering_amount
  })

  return suggestions
}
