/**
 * Finish a migrated sales-invoice register: fetch the rows (and the VAT split)
 * for the invoices that were imported without them.
 *
 * The migration maps invoices from the provider's LIST payload and hydrates
 * the detail form inside a fixed budget (see lib/providers/provider-data-
 * fetcher.ts). Fortnox, Briox and Björn Lundén ship no rows in a list
 * response, so every invoice the budget did not reach lands as a header with
 * a total and no invoice_items behind it: Profilio (384 of 384, migrated
 * before hydration existed), Loftux (311 of 672), Damac (182 of 542),
 * Clearstoq (1 125 of 1 125). Nothing ever came back for them, and the wizard
 * had not said so.
 *
 * This pass is the follow-up. It is re-runnable and makes progress on every
 * run: it starts from OUR side (the non-draft invoices in this company that
 * have no rows), joins them to the provider's register on invoice number AND
 * date (unique on both sides, the same strictness as the registration-voucher
 * relink), hydrates only those, and writes each invoice's rows once the
 * provider's detail total agrees with the stored total to the öre. A run that
 * runs out of budget leaves the rest for the next one; nothing is guessed and
 * nothing is inserted for an invoice the provider does not know.
 *
 * What it writes, and only this:
 *   - invoice_items for an invoice that has none;
 *   - the header VAT split (subtotal, vat_amount, vat_rate, vat_treatment and
 *     their SEK twins) when the stored split is the "unknown" shape the old
 *     import left behind (no rate, or 0 kr VAT beside subtotal = total).
 * Never the total, the status, the customer, payments or any journal entry:
 * momsdeklaration and every report read the ledger, not these columns, so
 * filling them changes what the invoice page shows and nothing that was
 * filed (see the 2026-08-22 verification in DECISIONS.md).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { ISO_DATE_RE } from '@/lib/invariants'
import { createLogger } from '@/lib/logger'
import { equalOre, roundOre } from '@/lib/money'
import { chunk } from '@/lib/utils'
import type { SalesInvoiceDto } from '@/lib/providers/dto'
import type { ProviderName } from '@/lib/providers/types'
import { resolveConsent } from '@/lib/providers/resolve-consent'
import {
  fetchSalesInvoicesDirect,
  hydrateSalesInvoices,
  type HydrationReport,
} from '@/lib/providers/provider-data-fetcher'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { mapSalesInvoice } from './entity-mapper'

const log = createLogger('extensions/arcim-migration/complete-invoice-lines')

export interface CompleteInvoiceLinesOptions {
  supabase: SupabaseClient
  companyId: string
  consentId: string
  /** Report the plan without writing. */
  dryRun?: boolean
  /** Wall-clock ceiling for the provider detail fetches, in ms. */
  budgetMs?: number
}

export interface CompleteInvoiceLinesResult {
  /** Non-draft invoices in this company that carry no rows. */
  candidates: number
  /** Sales invoices the provider's register lists. */
  providerInvoices: number
  /** Candidates that joined to exactly one provider invoice (number + date). */
  matched: number
  /** Candidates with no unique provider counterpart: native rows, ambiguous keys, or gone at the provider. */
  unmatched: number
  /** Invoices whose rows were written this run (or would be, on a dry run). */
  completed: number
  /** Of `completed`, those whose header VAT split was rewritten from the detail form. */
  headersUpdated: number
  /** Matched and hydrated, but the provider's total differs from the stored one; left untouched. */
  totalMismatch: number
  /** Matched and hydrated, but the detail form itself carries no rows. */
  noLinesAtProvider: number
  /** Matched but not hydrated this run (budget, auth, or a failed fetch); the next run retries them. */
  notHydrated: number
  /** Rows written but the header left alone because the detail form established no VAT. */
  vatUnresolved: number
  /** Invoices whose write failed at the database. */
  failed: number
  /** Candidates still without rows after this run: `candidates - completed`. */
  remaining: number
  hydration: HydrationReport
  dryRun: boolean
}

interface CandidateRow {
  id: string
  user_id: string
  customer_id: string
  invoice_number: string | null
  invoice_date: string
  total: number
  subtotal: number | null
  vat_amount: number | null
  vat_rate: number | null
  currency: string | null
  exchange_rate: number | null
  invoice_items: { id: string }[] | null
}

/** Invoices per statement. Small enough that a chunk's rows stay one request. */
const WRITE_CHUNK_SIZE = 100

/**
 * "number::YYYY-MM-DD", the same key the registration-voucher relink joins
 * on. A date that does not start like an ISO date joins nothing.
 */
function joinKey(number: string | null | undefined, date: string | null | undefined): string | null {
  if (!number || !date) return null
  const day = date.slice(0, 10)
  return ISO_DATE_RE.test(day) ? `${number}::${day}` : null
}

/** A map that forgets keys seen more than once, so those are never joined on. */
function uniqueByKey<T>(rows: readonly T[], keyOf: (row: T) => string | null): Map<string, T> {
  const out = new Map<string, T>()
  const dupes = new Set<string>()
  for (const row of rows) {
    const key = keyOf(row)
    if (!key) continue
    if (out.has(key) || dupes.has(key)) {
      out.delete(key)
      dupes.add(key)
      continue
    }
    out.set(key, row)
  }
  return out
}


/**
 * Is the stored VAT split the shape the old import left behind?
 *
 * A null rate is the post-#1745 "the source did not say". A non-zero rate
 * label beside 0 kr of VAT and subtotal = total is what the pre-#1745 mapper
 * wrote for every Fortnox invoice (25 % on top of nothing): a contradiction,
 * not a fact. Both mean the columns hold no evidence, so the detail form may
 * overwrite them. A split that is consistent with itself, including a
 * genuinely momsfri one (rate 0, 0 kr VAT, subtotal = total), is evidence
 * and is left as it is; the rows are still written.
 */
function headerHoldsNoVatEvidence(row: CandidateRow): boolean {
  if (row.vat_rate === null) return true
  if (row.vat_rate === 0) return false
  const subtotal = row.subtotal ?? row.total
  const vat = row.vat_amount ?? 0
  return equalOre(vat, 0) && equalOre(subtotal, row.total)
}

/** SEK twin of an amount on this row, or null when the row has no rate. */
function toRowSek(amount: number, row: CandidateRow): number | null {
  if (!row.currency || row.currency.toUpperCase() === 'SEK') return roundOre(amount)
  return row.exchange_rate != null ? roundOre(amount * row.exchange_rate) : null
}

async function loadCandidates(supabase: SupabaseClient, companyId: string): Promise<CandidateRow[]> {
  const rows = await fetchAllRows<CandidateRow>(({ from, to }) =>
    supabase
      .from('invoices')
      .select(
        'id, user_id, customer_id, invoice_number, invoice_date, total, subtotal, vat_amount, vat_rate, currency, exchange_rate, invoice_items(id)',
      )
      .eq('company_id', companyId)
      .eq('document_type', 'invoice')
      // A draft without rows is a draft someone is still writing, not an
      // import shortfall (a migrated row is a draft only when the source had
      // no voucher for it anyway).
      .neq('status', 'draft')
      .order('id', { ascending: true })
      .range(from, to),
  )
  return rows.filter((row) => (row.invoice_items?.length ?? 0) === 0)
}

/** Ids among `ids` that gained rows since the candidates were loaded. */
async function alreadyFilled(supabase: SupabaseClient, ids: string[]): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('invoice_items')
    .select('invoice_id')
    .in('invoice_id', ids)
  if (error) throw new Error(`invoice_items lookup failed: ${error.message}`)
  return new Set(((data ?? []) as { invoice_id: string }[]).map((r) => r.invoice_id))
}

interface PlannedWrite {
  row: CandidateRow
  items: Record<string, unknown>[]
  header: Record<string, unknown> | null
}

export async function completeMigratedInvoiceLines(
  options: CompleteInvoiceLinesOptions,
): Promise<CompleteInvoiceLinesResult> {
  const { supabase, companyId, consentId, dryRun = false, budgetMs } = options

  const result: CompleteInvoiceLinesResult = {
    candidates: 0,
    providerInvoices: 0,
    matched: 0,
    unmatched: 0,
    completed: 0,
    headersUpdated: 0,
    totalMismatch: 0,
    noLinesAtProvider: 0,
    notHydrated: 0,
    vatUnresolved: 0,
    failed: 0,
    remaining: 0,
    hydration: { needed: 0, hydrated: 0, failed: 0, skippedForBudget: 0 },
    dryRun,
  }

  // Our side first, and before the consent is touched: a company with nothing
  // to complete costs one query and no token refresh at the provider.
  const candidates = await loadCandidates(supabase, companyId)
  result.candidates = candidates.length
  if (candidates.length === 0) return result

  const resolved = await resolveConsent(companyId, consentId)
  const provider = resolved.consent.provider as ProviderName

  const listed = await fetchSalesInvoicesDirect(provider, resolved.accessToken, resolved.providerCompanyId)
  result.providerInvoices = listed.length

  const providerByKey = uniqueByKey(listed, (dto) => joinKey(dto.invoiceNumber, dto.issueDate))
  const oursByKey = uniqueByKey(candidates, (row) => joinKey(row.invoice_number, row.invoice_date))

  const pairs: { row: CandidateRow; dto: SalesInvoiceDto }[] = []
  for (const [key, row] of oursByKey) {
    const dto = providerByKey.get(key)
    if (dto) pairs.push({ row, dto })
  }
  result.matched = pairs.length
  result.unmatched = candidates.length - pairs.length

  if (pairs.length === 0) {
    result.remaining = candidates.length
    return result
  }

  // Only the matched subset is hydrated, so every run spends its budget on
  // invoices that are still incomplete here, never on ones already done.
  const hydrated = await hydrateSalesInvoices(
    provider,
    resolved.accessToken,
    resolved.providerCompanyId,
    pairs.map((pair) => pair.dto),
    budgetMs,
  )
  result.hydration = hydrated.hydration

  const planned: PlannedWrite[] = []
  for (let i = 0; i < pairs.length; i++) {
    const { row } = pairs[i]
    const dto = hydrated.invoices[i]

    if (hydrated.unhydratedIds.has(dto.id)) {
      result.notHydrated++
      continue
    }
    if (dto.lines.length === 0) {
      result.noLinesAtProvider++
      continue
    }

    // The same mapper the migration used, so a row written here is
    // indistinguishable from one written by a fully hydrated import. No FX
    // index: the SEK twins are derived from the rate the row already carries.
    const mapped = mapSalesInvoice(dto, row.user_id, companyId, row.customer_id)
    const mappedTotal = mapped.invoice.total as number
    if (!equalOre(mappedTotal, row.total)) {
      result.totalMismatch++
      log.warn('detail total differs from the stored total; invoice left untouched', {
        companyId, invoiceId: row.id, invoiceNumber: row.invoice_number, stored: row.total, provider: mappedTotal,
      })
      continue
    }

    let header: Record<string, unknown> | null = null
    if (mapped.vatUnresolved) {
      result.vatUnresolved++
    } else if (headerHoldsNoVatEvidence(row)) {
      const subtotal = mapped.invoice.subtotal as number
      const vatAmount = mapped.invoice.vat_amount as number
      header = {
        subtotal,
        subtotal_sek: toRowSek(subtotal, row),
        vat_amount: vatAmount,
        vat_amount_sek: toRowSek(vatAmount, row),
        vat_rate: mapped.invoice.vat_rate,
        vat_treatment: mapped.invoice.vat_treatment,
      }
    }

    planned.push({
      row,
      items: mapped.items.map((item) => ({ ...item, invoice_id: row.id })),
      header,
    })
  }

  if (dryRun) {
    result.completed = planned.length
    result.headersUpdated = planned.filter((p) => p.header).length
    result.remaining = candidates.length - result.completed
    return result
  }

  for (const batch of chunk(planned, WRITE_CHUNK_SIZE)) {
    // A concurrent run (the wizard and the cron, or two crons overlapping)
    // may have filled some of these since the candidates were loaded. Rows
    // are appended, never replaced, so a second write would double them.
    const filled = await alreadyFilled(supabase, batch.map((p) => p.row.id))
    const todo = batch.filter((p) => !filled.has(p.row.id))

    const written = await insertRows(supabase, todo)
    for (const plan of todo) {
      if (!written.has(plan.row.id)) {
        result.failed++
        continue
      }
      result.completed++
      if (!plan.header) continue
      const { error } = await supabase
        .from('invoices')
        .update(plan.header)
        .eq('id', plan.row.id)
        .eq('company_id', companyId)
      if (error) {
        // The rows landed; only the header split is still the old shape. The
        // next run will not revisit this invoice (it now has rows), so say so.
        log.error('header VAT update failed after the rows were written', {
          companyId, invoiceId: plan.row.id, reason: error.message,
        })
        continue
      }
      result.headersUpdated++
    }
  }

  result.remaining = candidates.length - result.completed
  log.info('migrated invoice rows completed', {
    companyId,
    candidates: result.candidates,
    matched: result.matched,
    completed: result.completed,
    headersUpdated: result.headersUpdated,
    notHydrated: result.notHydrated,
    totalMismatch: result.totalMismatch,
    failed: result.failed,
    remaining: result.remaining,
    hydration: result.hydration,
  })
  return result
}

/**
 * Insert every plan's rows: one statement for the batch, and on failure one
 * statement per invoice so a single bad row rejects its own invoice, not the
 * hundred beside it. An invoice's rows never split across statements: it
 * either has all of them or none.
 */
async function insertRows(supabase: SupabaseClient, plans: PlannedWrite[]): Promise<Set<string>> {
  const written = new Set<string>()
  if (plans.length === 0) return written

  const bulk = await supabase.from('invoice_items').insert(plans.flatMap((p) => p.items))
  if (!bulk.error) {
    for (const plan of plans) written.add(plan.row.id)
    return written
  }

  log.warn('bulk invoice_items insert failed; retrying per invoice', { reason: bulk.error.message })
  for (const plan of plans) {
    const { error } = await supabase.from('invoice_items').insert(plan.items)
    if (error) {
      log.error('invoice_items insert failed', {
        invoiceId: plan.row.id, invoiceNumber: plan.row.invoice_number, reason: error.message,
      })
      continue
    }
    written.add(plan.row.id)
  }
  return written
}
