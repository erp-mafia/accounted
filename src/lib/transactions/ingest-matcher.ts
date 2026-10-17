/**
 * The bank-line ingest matchers: the contract between ingestTransactions
 * (lib/transactions/ingest.ts) and the passes that explain a new bank row.
 *
 * A matcher looks at one stored row and settles it, hints it, or leaves it:
 * the customer invoice match, the debit of a payment order, the supplier
 * heuristics, the ROT/RUT payout and the ROT/RUT payout set. Each lives with
 * the block that owns it; the static list ingest runs is
 * lib/composition/ingest-matchers.ts. The Bankgirot split runs before the
 * matchers and the mapping-rule auto-booking after them, both inline in
 * ingest.ts, as before.
 *
 * Imports nothing at runtime: the blocks that implement a matcher depend on
 * this file's types only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import type { ModuleId } from '@/lib/modules/manifest'
import type { InvoiceMatchPool } from '@/lib/invoices/invoice-matching'
import type { MatchAction, logMatchEvent } from '@/lib/invoices/match-log'
import type { IngestOptions, IngestResult, RawTransaction, SupplierInvoice, Transaction } from '@/types'

/**
 * What a matcher did with a row.
 * - `explained`: settled or hinted for good; the matchers after it and the
 *   mapping rule are skipped.
 * - `hinted`: a weak hint was written; the next matchers still run.
 * - `none`: nothing to say; the next matchers run.
 */
export type MatchOutcome = 'explained' | 'hinted' | 'none'

/** What a batch can claim, so no two rows are offered the same thing. */
export type IngestClaimKind = 'customer_invoice' | 'supplier_invoice' | 'payment_order' | 'rot_rut_request'

export interface IngestClaims {
  has(kind: IngestClaimKind, id: string): boolean
  add(kind: IngestClaimKind, id: string): void
}

/** The claims plus the live sets behind them, for the split (applyTransactionSplit's excludeInvoiceIds). */
export interface IngestClaimSets extends IngestClaims {
  ids(kind: IngestClaimKind): ReadonlySet<string>
}

export function createIngestClaims(): IngestClaimSets {
  const sets: Record<IngestClaimKind, Set<string>> = {
    customer_invoice: new Set(),
    supplier_invoice: new Set(),
    payment_order: new Set(),
    rot_rut_request: new Set(),
  }
  return {
    has: (kind, id) => sets[kind].has(id),
    add: (kind, id) => {
      sets[kind].add(id)
    },
    ids: (kind) => sets[kind],
  }
}

/** The pools the split and the matchers share for one batch. */
export interface IngestPools {
  /**
   * The open customer invoices, read on first use and kept for the batch. A
   * failed read throws and is not kept: the next caller reads again.
   */
  customerInvoices(): Promise<InvoiceMatchPool>
  /**
   * The open supplier invoices the batch has not settled yet. Drained (the
   * array replaced, never mutated) when a row settles or strongly hints one.
   */
  supplierInvoices: SupplierInvoice[]
}

/**
 * The module that owns each pool. A batch whose package gate skips that
 * module's matchers (lib/transactions/ingest-package-gate.ts) leaves the pool
 * empty and never reads it, for the Bankgirot split too.
 */
export const INGEST_POOL_OWNERS: Readonly<Record<keyof IngestPools, ModuleId>> = Object.freeze({
  customerInvoices: 'invoicing',
  supplierInvoices: 'supplier-invoices',
})

/** One ingestTransactions call, as the matchers see it. */
export interface IngestBatch {
  readonly supabase: SupabaseClient
  readonly companyId: string
  readonly userId: string
  readonly options: IngestOptions
  readonly log: Logger
  /** The batch's result: a matcher counts what it explains in auto_matched_invoices. */
  readonly result: IngestResult
  readonly claims: IngestClaims
  readonly pools: IngestPools
  /** Appends to the payment match audit trail (logMatchEvent) as the batch's user. Never throws. */
  logMatch(transactionId: string, action: MatchAction, opts?: Parameters<typeof logMatchEvent>[4]): Promise<void>
}

/** The row a matcher is asked about: the stored row, the bank's raw row, and whether it is a re-read. */
export interface IngestRow {
  tx: Transaction
  raw: RawTransaction
  /**
   * An Open Payments re-read of a stored, still-open row whose reference,
   * end-to-end id or counterparty changed. A hint the row carries stands
   * unless the matcher finds a stronger one.
   */
  reread: boolean
}

export interface IngestMatcher<S = unknown> {
  /** Stable, kebab-case: the per-pass log line and the order test name it. */
  readonly id: string
  /** Position in the run, ascending. */
  readonly order: number
  /** The module that owns the pass. */
  readonly module: ModuleId
  /** `income` sees rows with amount > 0, `expense` rows with amount < 0; a zero row sees none. */
  readonly direction: 'income' | 'expense'
  /** Whether a re-read row gets this pass (new rows always do). */
  readonly onReread: boolean
  /**
   * Reads what the matcher needs once per batch, before the first row. Runs
   * only when the batch is not rawInsertOnly. Never throws.
   */
  prepare?(batch: IngestBatch): Promise<S>
  /** May throw: the run counts it as failed and goes on to the next matcher. */
  match(batch: IngestBatch, state: S, row: IngestRow): Promise<MatchOutcome>
  /**
   * After the last row, for every batch (rawInsertOnly included): the ids of
   * the inserted inbound rows. `state` is undefined when prepare did not run.
   */
  finish?(batch: IngestBatch, state: S | undefined, inboundIds: string[]): void
}

/** How one pass ended for one row, as the per-pass log line counts it. */
export type PassOutcome = 'explained' | 'hinted' | 'failed'

export interface IngestMatcherRun {
  /** Every matcher's prepare, in order. */
  prepare(): Promise<void>
  /** The matchers that apply to the row, in order, until one explains it. True when one did. */
  match(row: IngestRow): Promise<boolean>
  /** Every matcher's finish, in order. */
  finish(inboundIds: string[]): void
}

/**
 * Run `matchers` (sorted by `order`) over one batch. `tally` hears every
 * outcome but `none`, by matcher id.
 */
export function startIngestMatchers(
  matchers: readonly IngestMatcher[],
  batch: IngestBatch,
  tally: (pass: string, outcome: PassOutcome) => void,
): IngestMatcherRun {
  const ordered = [...matchers].sort((a, b) => a.order - b.order)
  const states = new Map<string, unknown>()
  return {
    async prepare() {
      for (const matcher of ordered) {
        if (matcher.prepare) states.set(matcher.id, await matcher.prepare(batch))
      }
    },
    async match(row) {
      for (const matcher of ordered) {
        if (row.reread && !matcher.onReread) continue
        const applies = matcher.direction === 'income' ? row.tx.amount > 0 : row.tx.amount < 0
        if (!applies) continue
        let outcome: MatchOutcome
        try {
          outcome = await matcher.match(batch, states.get(matcher.id), row)
        } catch {
          // Non-critical: the next matcher still runs, as each pass's own
          // catch did before the list.
          tally(matcher.id, 'failed')
          continue
        }
        if (outcome === 'none') continue
        tally(matcher.id, outcome)
        if (outcome === 'explained') return true
      }
      return false
    },
    finish(inboundIds) {
      for (const matcher of ordered) matcher.finish?.(batch, states.get(matcher.id), inboundIds)
    },
  }
}
