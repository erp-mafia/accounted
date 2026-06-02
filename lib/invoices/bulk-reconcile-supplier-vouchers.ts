/**
 * Bulk reconcile supplier invoices to already-posted GL payment vouchers.
 *
 * Context: when a company is migrated from another system (e.g. Fortnox via the
 * arcim-migration extension), the general ledger — including the bank-payment
 * vouchers that settle accounts payable (Dr 2440 / Cr 1930) — is imported
 * separately via SIE. Supplier invoices are imported as standalone
 * `supplier_invoices` rows with NO link to those vouchers (the entity mapper
 * never sets `payment_journal_entry_id`). Fortnox is queried with
 * `?filter=unpaid`, so an invoice whose payment was booked in the source GL but
 * never registered against the leverantörsfaktura object arrives here as an
 * open payable. Once its due date passes the nightly cron flips it to
 * `overdue` — even though the settling voucher already exists in the GL.
 *
 * This pass links each open payable to its matching posted voucher (reusing the
 * exact same matcher + RPC behind the manual "Markera som betald → Befintlig
 * verifikation" UI flow), so genuinely-settled invoices show as paid instead of
 * falsely overdue. It NEVER creates, edits, or deletes a journal entry — it only
 * inserts a `supplier_invoice_payments` row pointing at the existing voucher and
 * advances the invoice's paid/remaining/status (all via the atomic
 * `link_supplier_invoice_to_voucher` RPC).
 *
 * Safety: auto-linking is intentionally conservative. A voucher is linked
 * automatically only when the match is unambiguous (see AUTO_LINK_* constants
 * and the uniqueness rules below). Everything else is surfaced for manual review
 * rather than guessed at. The function is idempotent and order-independent — it
 * can be re-run any time after both halves of a migration exist.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  findMatchingVouchersForSupplierInvoice,
  linkSupplierInvoiceToVoucher,
  type SupplierVoucherCandidate,
} from './supplier-voucher-matching'
import type { SupplierInvoice, Supplier } from '@/types'

const log = createLogger('bulk-reconcile-supplier-vouchers')

/**
 * Minimum confidence for an UNATTENDED auto-link. 0.95 = OCR/invoice-number hit
 * (0.99) or exact-remaining-amount AND supplier-name corroboration (0.95).
 * Amount-only matches (0.80, even with the +0.05 date bump → 0.85) are
 * deliberately excluded — too many invoices share round amounts.
 */
const AUTO_LINK_MIN_CONFIDENCE = 0.95
/**
 * Required confidence gap between the top candidate and the runner-up. A near
 * tie means two vouchers look equally plausible → not safe to auto-pick. A
 * margin (not exact equality) absorbs the ±0.05 date-proximity perturbation.
 */
const AUTO_LINK_MIN_MARGIN = 0.1
/** 0.5 öre — mirrors the tolerance used across the matching/RPC paths. */
const AMOUNT_TOLERANCE = 0.005
/** Safety cap on invoices processed in a single run (Vercel 300s budget). */
const DEFAULT_MAX_INVOICES = 2000

/** Supplier-invoice statuses that represent an open payable. */
const PAYABLE_STATUSES = ['registered', 'approved', 'overdue', 'partially_paid']

type ReconcileInvoiceRow = SupplierInvoice & {
  is_credit_note?: boolean | null
  supplier?: { id: string; name: string } | null
}

export type ReconcileReviewReason =
  | 'multiple_candidates' // ≥2 candidates within the auto-link margin
  | 'low_confidence' // best candidate below AUTO_LINK_MIN_CONFIDENCE
  | 'amount_exceeds_remaining' // best candidate would overpay the invoice
  | 'voucher_contested' // one voucher is the top pick for >1 invoice, or RPC rejected

export interface ReconcileLink {
  supplier_invoice_id: string
  supplier_invoice_number: string | null
  journal_entry_id: string
  payment_amount: number
  invoice_status: 'paid' | 'partially_paid'
  confidence: number
  match_reason: string
}

export interface ReconcileReviewItem {
  supplier_invoice_id: string
  supplier_invoice_number: string | null
  reason: ReconcileReviewReason
  candidates: SupplierVoucherCandidate[]
}

export interface ReconcileResult {
  /** Open payables considered (after credit-note / zero-remaining filtering). */
  scanned: number
  /** Invoices auto-linked to a voucher (or that would be, when dryRun). */
  autoLinked: number
  /** Invoices with candidate(s) but not safe to auto-link — need manual review. */
  ambiguous: number
  /** Invoices with no eligible voucher candidate at all. */
  unmatched: number
  /** True when more payables existed than `maxInvoices` and the rest were skipped. */
  capped: boolean
  links: ReconcileLink[]
  review: ReconcileReviewItem[]
}

export interface ReconcileOptions {
  supabase: SupabaseClient
  companyId: string
  /** Real user id — written onto the supplier_invoice_payments row + emitted event. */
  userId: string
  /** Compute the plan without writing. Default false. */
  dryRun?: boolean
  /** Max invoices to process in one run. Default 2000. */
  maxInvoices?: number
  onProgress?: (done: number, total: number) => void
}

const SELECT_COLUMNS =
  'id, supplier_invoice_number, arrival_number, status, currency, total, paid_amount, remaining_amount, due_date, paid_at, exchange_rate, supplier_id, is_credit_note, supplier:suppliers(id, name)'

function remainingOf(inv: ReconcileInvoiceRow): number {
  if (typeof inv.remaining_amount === 'number') return Math.max(0, inv.remaining_amount)
  return Math.max(0, Math.round((inv.total - (inv.paid_amount ?? 0)) * 100) / 100)
}

/**
 * Link open supplier-invoice payables to their matching already-posted GL
 * vouchers. See file header for the full rationale and guarantees.
 */
export async function reconcileSupplierInvoiceVouchers(
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const { supabase, companyId, userId, dryRun = false } = opts
  const maxInvoices = opts.maxInvoices ?? DEFAULT_MAX_INVOICES

  const result: ReconcileResult = {
    scanned: 0,
    autoLinked: 0,
    ambiguous: 0,
    unmatched: 0,
    capped: false,
    links: [],
    review: [],
  }

  // 1. Open payables with an outstanding balance, excluding credit notes.
  //    Deterministic order so re-runs and the cross-invoice uniqueness pass are
  //    stable. Fully-paid invoices ('paid') are excluded by the status filter,
  //    making re-runs naturally idempotent.
  const invoices = await fetchAllRows<ReconcileInvoiceRow>(
    ({ from, to }) =>
      supabase
        .from('supplier_invoices')
        .select(SELECT_COLUMNS)
        .eq('company_id', companyId)
        .in('status', PAYABLE_STATUSES)
        .order('due_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        // The `supplier:suppliers(id, name)` join makes PostgREST infer `supplier`
        // as an array; ReconcileInvoiceRow models the runtime single-object shape.
        data: ReconcileInvoiceRow[] | null
        error: { message: string } | null
      }>,
  )

  const payables = invoices.filter(
    (inv) => !inv.is_credit_note && remainingOf(inv) > AMOUNT_TOLERANCE,
  )

  const toProcess = payables.slice(0, maxInvoices)
  if (payables.length > maxInvoices) {
    result.capped = true
    log.warn('reconcile capped to maxInvoices — remaining payables left for a later run', {
      companyId,
      totalPayables: payables.length,
      cap: maxInvoices,
    })
  }

  // 2. Pre-load every voucher already consumed as a supplier payment (for ANY
  //    invoice in the company). Neither the matcher nor the RPC stop the SAME
  //    voucher being linked to a SECOND invoice, so we enforce exclusivity here.
  const existingPayments = await fetchAllRows<{ journal_entry_id: string | null }>(({ from, to }) =>
    supabase
      .from('supplier_invoice_payments')
      .select('journal_entry_id')
      .eq('company_id', companyId)
      .not('journal_entry_id', 'is', null)
      .range(from, to),
  )
  const consumedVouchers = new Set(
    existingPayments
      .map((p) => p.journal_entry_id)
      .filter((id): id is string => !!id),
  )

  // 3. Per-invoice candidate gathering (read-only). Decide auto-eligibility.
  interface Plan {
    invoice: ReconcileInvoiceRow
    candidates: SupplierVoucherCandidate[]
    top?: SupplierVoucherCandidate
  }
  const autoCandidatePlans: Plan[] = []

  for (const invoice of toProcess) {
    result.scanned++
    const candidates = await findMatchingVouchersForSupplierInvoice(
      supabase,
      companyId,
      invoice as unknown as SupplierInvoice & { supplier?: Supplier },
      { limit: 5 },
    )
    // Drop vouchers already used elsewhere in the company.
    const fresh = candidates.filter((c) => !consumedVouchers.has(c.journal_entry_id))

    if (fresh.length === 0) {
      result.unmatched++
      continue
    }

    const top = fresh[0]
    const runnerUp = fresh[1]
    const remaining = remainingOf(invoice)

    const confidentEnough = top.confidence >= AUTO_LINK_MIN_CONFIDENCE
    const clearMargin = !runnerUp || top.confidence - runnerUp.confidence >= AUTO_LINK_MIN_MARGIN
    // The RPC rejects a voucher whose AP debit exceeds the remaining amount; an
    // OCR match (which ignores amount) could trip this, so screen it out here.
    const amountFits = top.ap_debit_amount <= remaining + AMOUNT_TOLERANCE

    if (confidentEnough && clearMargin && amountFits) {
      autoCandidatePlans.push({ invoice, candidates: fresh, top })
    } else {
      result.ambiguous++
      result.review.push({
        supplier_invoice_id: invoice.id,
        supplier_invoice_number: invoice.supplier_invoice_number ?? null,
        reason: !confidentEnough
          ? 'low_confidence'
          : !amountFits
            ? 'amount_exceeds_remaining'
            : 'multiple_candidates',
        candidates: fresh,
      })
    }
  }

  // 4. Cross-invoice uniqueness: if one voucher is the top auto-pick for more
  //    than one invoice (e.g. two identical 5 000 kr invoices both grabbing the
  //    same 5 000 kr voucher), auto-link NONE of them — demote all to review.
  const claimsByVoucher = new Map<string, Plan[]>()
  for (const plan of autoCandidatePlans) {
    const key = plan.top!.journal_entry_id
    const arr = claimsByVoucher.get(key) ?? []
    arr.push(plan)
    claimsByVoucher.set(key, arr)
  }

  const safePlans: Plan[] = []
  for (const claimants of claimsByVoucher.values()) {
    if (claimants.length === 1) {
      safePlans.push(claimants[0])
    } else {
      for (const c of claimants) {
        result.ambiguous++
        result.review.push({
          supplier_invoice_id: c.invoice.id,
          supplier_invoice_number: c.invoice.supplier_invoice_number ?? null,
          reason: 'voucher_contested',
          candidates: c.candidates,
        })
      }
    }
  }

  // 5. Link the unambiguous plans. Deterministic order; respect exclusivity
  //    across the batch via consumedVouchers.
  safePlans.sort(
    (a, b) =>
      (a.invoice.due_date ?? '').localeCompare(b.invoice.due_date ?? '') ||
      a.invoice.id.localeCompare(b.invoice.id),
  )

  let done = 0
  for (const plan of safePlans) {
    const top = plan.top!
    const remaining = remainingOf(plan.invoice)

    // Defensive: a voucher consumed earlier in THIS batch is off-limits.
    if (consumedVouchers.has(top.journal_entry_id)) {
      result.ambiguous++
      result.review.push({
        supplier_invoice_id: plan.invoice.id,
        supplier_invoice_number: plan.invoice.supplier_invoice_number ?? null,
        reason: 'voucher_contested',
        candidates: plan.candidates,
      })
      continue
    }

    if (dryRun) {
      const willBeFullyPaid = top.ap_debit_amount >= remaining - AMOUNT_TOLERANCE
      result.autoLinked++
      result.links.push({
        supplier_invoice_id: plan.invoice.id,
        supplier_invoice_number: plan.invoice.supplier_invoice_number ?? null,
        journal_entry_id: top.journal_entry_id,
        payment_amount: Math.min(top.ap_debit_amount, remaining),
        invoice_status: willBeFullyPaid ? 'paid' : 'partially_paid',
        confidence: top.confidence,
        match_reason: top.match_reason,
      })
      consumedVouchers.add(top.journal_entry_id)
      done++
      opts.onProgress?.(done, safePlans.length)
      continue
    }

    const outcome = await linkSupplierInvoiceToVoucher(supabase, userId, companyId, {
      supplierInvoiceId: plan.invoice.id,
      journalEntryId: top.journal_entry_id,
      notes: `Auto-länkad vid avstämning (${Math.round(top.confidence * 100)}% säkerhet): ${top.match_reason}`,
    })

    if (outcome.ok) {
      result.autoLinked++
      consumedVouchers.add(top.journal_entry_id)
      result.links.push({
        supplier_invoice_id: plan.invoice.id,
        supplier_invoice_number: plan.invoice.supplier_invoice_number ?? null,
        journal_entry_id: top.journal_entry_id,
        payment_amount: outcome.result.paymentAmount,
        invoice_status: outcome.result.invoiceStatus,
        confidence: top.confidence,
        match_reason: top.match_reason,
      })
    } else {
      // The RPC re-validates atomically; a rejection here (race, already-linked,
      // amount drift) means it isn't a clean auto-link — surface it.
      result.ambiguous++
      result.review.push({
        supplier_invoice_id: plan.invoice.id,
        supplier_invoice_number: plan.invoice.supplier_invoice_number ?? null,
        reason: 'voucher_contested',
        candidates: plan.candidates,
      })
      log.warn('auto-link rejected by RPC', {
        companyId,
        supplierInvoiceId: plan.invoice.id,
        journalEntryId: top.journal_entry_id,
        code: outcome.code,
      })
    }

    done++
    opts.onProgress?.(done, safePlans.length)
  }

  log.info('reconcile complete', {
    companyId,
    dryRun,
    scanned: result.scanned,
    autoLinked: result.autoLinked,
    ambiguous: result.ambiguous,
    unmatched: result.unmatched,
    capped: result.capped,
  })

  return result
}
