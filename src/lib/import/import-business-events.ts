import type { LinkBasisColumns } from '@/lib/links/link-basis'
import type { BusinessEventDraft } from '@/lib/posting/types'

/**
 * The business events of imports and opening balances, for the posting port
 * (step 2h). Recorded while POSTING_EVENTS is shadow or strict; the doors
 * hand them to the port as functions, so with the port off none is built.
 * Pure.
 *
 * No category, party, amount or mapping version on any of them: an IB is a
 * set of balances a person typed or a file stated, not one amount, and no
 * automatic kontering made its lines; an import carries history that was
 * booked elsewhere, so the lines are the other system's and the file's.
 */

/**
 * The IB of a year (kind ledger.opening_balance), set or corrected: one
 * event per IB verifikat. Dated the year's first day, the IB's own date;
 * the subject is the year. The link basis is the door's: a person typed or
 * uploaded the balances (user_created), resolved against the approval or the
 * credential the door ran in.
 */
export function openingBalanceBusinessEvent(
  fiscalPeriodId: string,
  periodStart: string,
  linkBasis: LinkBasisColumns,
): BusinessEventDraft {
  return {
    kind: 'ledger.opening_balance',
    occurredOn: periodStart,
    subject: { type: 'fiscal_period', id: fiscalPeriodId },
    evidence: { link_basis: linkBasis.link_basis, link_evidence: linkBasis.link_evidence ?? undefined },
    pendingOperationId: linkBasis.link_evidence?.pending_operation_id ?? null,
    jurisdiction: 'SE',
  }
}

/**
 * The storno of an IB verifikat (kind ledger.storno, role reversal): the old
 * IB a correction replaces (user_created, the person asked for the
 * correction), or the corrected IB stornoed again when the correction could
 * not be finished (system_derived: no one chose it). Dated the day it is
 * made, as every storno event is; the subject is the year. The corrected IB
 * records its own ledger.opening_balance event.
 */
export function openingBalanceStornoBusinessEvent(
  fiscalPeriodId: string,
  occurredOn: string,
  linkBasis: LinkBasisColumns,
): BusinessEventDraft {
  return {
    kind: 'ledger.storno',
    occurredOn,
    subject: { type: 'fiscal_period', id: fiscalPeriodId },
    evidence: { link_basis: linkBasis.link_basis, link_evidence: linkBasis.link_evidence ?? undefined },
    pendingOperationId: linkBasis.link_evidence?.pending_operation_id ?? null,
    jurisdiction: 'SE',
  }
}

/**
 * An SIE import job (kind ledger.history_import): ONE event for the whole
 * job, a file upload or a provider migration alike, linked to none of the
 * verifikat it wrote (design call 1: imports are about 88 % of all postings;
 * the read-side projection names the job per entry from its
 * import_batch_id). The subject is the job; dated the day the import
 * completes. The evidence holds references only: the link basis
 * import_carried_over, the file's SHA-256 (never its name, which can name a
 * person) and how many verifikat the job posted. The idempotency key is the
 * job's, so a completion retried after an interruption records no second
 * event.
 */
export function sieImportBusinessEvent(
  job: { id: string; file_hash: string },
  voucherCount: number,
  completedOn: string,
): BusinessEventDraft {
  return {
    kind: 'ledger.history_import',
    occurredOn: completedOn,
    subject: { type: 'sie_import', id: job.id },
    evidence: { link_basis: 'import_carried_over', file_hash: job.file_hash, voucher_count: voucherCount },
    jurisdiction: 'SE',
    idempotencyKey: `ledger.history_import:sie_import:${job.id}`,
  }
}
