/**
 * The confirm-before-posting guard for typed verifikat: the plausibility
 * checks (voucher-plausibility.ts), the duplicate checks
 * (voucher-duplicate-check.ts) and the blocks' own warnings
 * (voucher-block-warnings.ts: the moms of a period already declared) as one
 * answer every typed door gives the same way.
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
 * Fail-open: a duplicate lookup or a block's check that errors never blocks
 * a booking; the pure checks cannot fail.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { VOUCHER_BLOCK_WARNINGS } from '@/lib/composition/voucher-block-warnings'
import { checkVoucherPlausibility, type PlausibilityLine, type VoucherWarning } from './voucher-plausibility'
import { detectVoucherDuplicates } from './voucher-duplicate-check'

export interface VoucherWarningsGuardInput {
  entry_date: string
  description: string
  lines: readonly PlausibilityLine[]
  /**
   * The verifikat a rättelse replaces (its date and lines as posted), so a
   * block judges the pair the rättelse posts and not the new lines alone.
   */
  replaces?: { entry_date: string; lines: readonly PlausibilityLine[] } | null
  /** The verifikat being corrected is an ingående balans. */
  opening_balance?: boolean
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
  /**
   * Warnings the door judged itself, confirmed like every other (a rättelse
   * moved out of a locked period that changes VAT, lib/vat/moved-correction-vat.ts).
   */
  extra?: readonly VoucherWarning[]
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
  for (const block of VOUCHER_BLOCK_WARNINGS) {
    try {
      const warning = await block.warn(supabase, companyId, {
        // A rättelse sent without its own date posts on its original's.
        entry_date: input.entry_date || input.replaces?.entry_date || '',
        lines: input.lines,
        replaces: input.replaces ?? null,
        ...(input.opening_balance ? { opening_balance: true } : {}),
      })
      if (warning) warnings.push(warning)
    } catch (err) {
      log.warn(`voucher block warning ${block.id} failed (continuing)`, err as Error)
    }
  }
  warnings.push(...(options.extra ?? []))
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
