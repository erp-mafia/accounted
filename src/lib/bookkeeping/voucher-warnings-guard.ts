/**
 * The confirm-before-posting guard for typed verifikat: the plausibility
 * checks (voucher-plausibility.ts) and the duplicate checks
 * (voucher-duplicate-check.ts) as one answer every typed door gives the same
 * way.
 *
 * Without an acknowledgement covering every warning the door refuses with
 * VOUCHER_NEEDS_CONFIRMATION (409) and details.warnings. The person reads them
 * and sends the same lines again with `acknowledged_warnings` naming the
 * codes. The checks run again on every send, so a warning that appears in
 * between (a duplicate posted meanwhile) is refused until it too is
 * acknowledged. A booking past acknowledged warnings leaves a
 * behandlingshistorik record on the verifikat (BFNAR 2013:2 p. 9.16), like a
 * dismissed bank duplicate does.
 *
 * Fail-open: a duplicate lookup that errors never blocks a booking; the pure
 * checks cannot fail.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { checkVoucherPlausibility, type PlausibilityLine, type VoucherWarning } from './voucher-plausibility'
import { detectVoucherDuplicates } from './voucher-duplicate-check'

export interface VoucherWarningsGuardInput {
  entry_date: string
  description: string
  lines: readonly PlausibilityLine[]
}

export interface VoucherWarningsGuardOptions {
  /** The codes the person confirmed after seeing them (`acknowledged_warnings`). */
  acknowledged?: readonly string[] | null
  /**
   * Look for duplicates in the books. A door that books a bank row passes
   * false: its own bank duplicate guard already judges that row.
   */
  checkDuplicates?: boolean
  /** A draft being committed is never its own duplicate. */
  excludeJournalEntryId?: string
}

export type VoucherWarningsGuardResult =
  | { ok: true; acknowledged: VoucherWarning[] }
  | { ok: false; code: 'VOUCHER_NEEDS_CONFIRMATION'; details: { warnings: VoucherWarning[] } }

export async function runVoucherWarningsGuard(
  supabase: SupabaseClient,
  companyId: string,
  input: VoucherWarningsGuardInput,
  log: Logger,
  options: VoucherWarningsGuardOptions = {},
): Promise<VoucherWarningsGuardResult> {
  const warnings = checkVoucherPlausibility(input.lines)
  if (options.checkDuplicates !== false) {
    try {
      warnings.push(...(await detectVoucherDuplicates(supabase, companyId, input, { excludeJournalEntryId: options.excludeJournalEntryId })))
    } catch (err) {
      log.warn('voucher duplicate detection failed (continuing)', err as Error)
    }
  }
  if (warnings.length === 0) return { ok: true, acknowledged: [] }

  const acknowledged = new Set(options.acknowledged ?? [])
  if (warnings.some((w) => !acknowledged.has(w.code))) {
    return { ok: false, code: 'VOUCHER_NEEDS_CONFIRMATION', details: { warnings } }
  }
  return { ok: true, acknowledged: warnings }
}

/**
 * The behandlingshistorik record of a verifikat booked past acknowledged
 * warnings: the codes and the ids they pointed at, never the texts (the
 * payload is PII-checked). Best-effort: never fails the booking.
 */
export async function recordVoucherWarningsAcknowledged(params: {
  companyId: string
  userId: string
  journalEntryId: string
  warnings: readonly VoucherWarning[]
  door: string
  log: Logger
}): Promise<void> {
  const { companyId, userId, journalEntryId, warnings, door, log } = params
  if (warnings.length === 0) return
  try {
    await appendProcessingHistory({
      companyId,
      correlationId: journalEntryId,
      aggregateType: 'Verifikation',
      aggregateId: journalEntryId,
      eventType: 'VoucherWarningsAcknowledged',
      payload: {
        journal_entry_id: journalEntryId,
        door,
        codes: warnings.map((w) => w.code),
        duplicate_of_journal_entry_ids: warnings
          .map((w) => w.details.journal_entry_id)
          .filter((id): id is string => typeof id === 'string'),
        duplicate_of_transaction_ids: warnings
          .map((w) => w.details.transaction_id)
          .filter((id): id is string => typeof id === 'string'),
      },
      actor: { type: 'user', id: userId },
      occurredAt: new Date(),
    })
  } catch (err) {
    log.error('failed to append voucher-warnings behandlingshistorik', err as Error)
  }
}
