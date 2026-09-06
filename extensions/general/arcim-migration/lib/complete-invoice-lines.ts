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
 *
 * Both are written by one call to the complete_invoice_rows RPC per invoice
 * (migration 20260906135730), the write path the migration wizard shares: it
 * locks the invoice, inserts the rows only when the invoice still has none
 * and applies the header split in the same transaction, so an invoice's rows
 * are written at most once whichever writer gets there first, and "rows
 * landed, header did not" is not a reachable state.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { ISO_DATE_RE } from '@/lib/invariants'
import { createLogger } from '@/lib/logger'
import { equalOre, roundOre } from '@/lib/money'
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
  /**
   * Matched and hydrated, but the mapped rows do not add up to the header the
   * same payload established (net or VAT off by more than ROWS_TOLERANCE_KR);
   * left untouched rather than stored as rows that contradict their invoice.
   */
  rowsMismatch: number
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

/**
 * How far the rows may disagree with the header before the invoice is left
 * alone. Öresavrundning puts up to 0.50 kr between a Fortnox `Total` and the
 * unrounded net plus VAT, and per-row VAT rounding adds öre per row; a real
 * disagreement (rows priced with VAT inside, a header-level freight or
 * discount the rows do not carry) is kronor, not öre. A row set that fails
 * this is a mapper or payload problem to be understood, not stored: rows that
 * contradict their own header are worse than no rows.
 */
const ROWS_TOLERANCE_KR = 1

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

/**
 * The header VAT split the detail form established, as the RPC's p_header:
 * the six invoice columns it may rewrite, all present or none.
 */
interface HeaderFill {
  subtotal: number
  subtotal_sek: number | null
  vat_amount: number
  vat_amount_sek: number | null
  vat_rate: number | null
  vat_treatment: string
}

interface PlannedWrite {
  row: CandidateRow
  /** The invoice_items columns per row; the RPC stamps invoice_id itself. */
  items: Record<string, unknown>[]
  header: HeaderFill | null
}

/** What complete_invoice_rows returns (migration 20260906135730). */
interface CompleteRowsOutcome {
  ok: boolean
  code?: string
  wrote?: boolean
  rows?: number
  header_updated?: boolean
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
    rowsMismatch: 0,
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

    if (!mapped.vatUnresolved) {
      const rowsNet = mapped.items.reduce((sum, item) => sum + Number(item.line_total ?? 0), 0)
      const rowsVat = mapped.items.reduce((sum, item) => sum + Number(item.vat_amount ?? 0), 0)
      const headerNet = mapped.invoice.subtotal as number
      const headerVat = mapped.invoice.vat_amount as number
      if (Math.abs(rowsNet - headerNet) > ROWS_TOLERANCE_KR || Math.abs(rowsVat - headerVat) > ROWS_TOLERANCE_KR) {
        result.rowsMismatch++
        log.warn('mapped rows do not add up to the header; invoice left untouched', {
          companyId, invoiceId: row.id, invoiceNumber: row.invoice_number,
          headerNet, rowsNet: roundOre(rowsNet), headerVat, rowsVat: roundOre(rowsVat), rows: mapped.items.length,
        })
        continue
      }
    }

    let header: HeaderFill | null = null
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
        vat_rate: mapped.invoice.vat_rate as number | null,
        vat_treatment: mapped.invoice.vat_treatment as string,
      }
    }

    planned.push({ row, items: mapped.items, header })
  }

  if (dryRun) {
    result.completed = planned.length
    result.headersUpdated = planned.filter((p) => p.header).length
    result.remaining = candidates.length - result.completed
    return result
  }

  for (const plan of planned) {
    // One call per invoice, so a bad row set rejects its own invoice and not
    // the hundred beside it. A concurrent run (the wizard and the cron, or
    // two crons overlapping) that filled this invoice since the candidates
    // were loaded leaves this call with wrote = false: rows are appended,
    // never replaced, and the RPC's invoice lock is what keeps a second
    // writer from doubling them.
    const { data, error } = await supabase.rpc('complete_invoice_rows', {
      p_company_id: companyId,
      p_invoice_id: plan.row.id,
      p_rows: plan.items,
      p_header: plan.header,
    })
    const outcome = (data ?? null) as CompleteRowsOutcome | null
    if (error || !outcome?.ok) {
      result.failed++
      log.error('complete_invoice_rows failed', {
        companyId, invoiceId: plan.row.id, invoiceNumber: plan.row.invoice_number,
        reason: error?.message ?? outcome?.code ?? 'empty RPC response',
      })
      continue
    }
    if (!outcome.wrote) {
      log.info('invoice gained rows since the candidates were loaded; left as is', {
        companyId, invoiceId: plan.row.id,
      })
      continue
    }
    result.completed++
    if (outcome.header_updated) result.headersUpdated++
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
    rowsMismatch: result.rowsMismatch,
    failed: result.failed,
    remaining: result.remaining,
    hydration: result.hydration,
  })
  return result
}
