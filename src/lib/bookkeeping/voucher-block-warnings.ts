/**
 * Booking-time warnings a block adds to a typed verifikat: what only the
 * block can tell about it (the moms of a period already declared), asked by
 * the confirm-before-posting guard (./voucher-warnings-guard.ts) beside its
 * own plausibility and duplicate checks, and confirmed the same way.
 *
 * The rules are the blocks' own and the ledger sits below them, so this file
 * is the ledger's side of the contract and imports nothing at runtime: the
 * list itself is wired in lib/composition/voucher-block-warnings.ts, which
 * the guard imports statically.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ModuleId } from '@/lib/modules/manifest'
import type { PlausibilityLine, VoucherWarning } from './voucher-plausibility'

export interface VoucherBlockWarningInput {
  /** The date the verifikat posts on; '' when a rättelse takes its original's. */
  entry_date: string
  lines: readonly PlausibilityLine[]
  /**
   * The verifikat a rättelse replaces: its storno posts these lines reversed
   * on this date. Absent for a new verifikat.
   */
  replaces?: { entry_date: string; lines: readonly PlausibilityLine[] } | null
  /**
   * The verifikat is an ingående balans, or the rättelse of one: a block
   * that reads opening balances by a rule of their own is told.
   */
  opening_balance?: boolean
}

export interface VoucherBlockWarning {
  /** Stable, kebab-case. */
  readonly id: string
  /** The module that owns the rule (lib/modules/manifest.ts). */
  readonly module: ModuleId
  /**
   * The block's warning for the verifikat, or null when it has none. Throws
   * when it cannot tell; the guard never lets that stop a booking.
   */
  warn(supabase: SupabaseClient, companyId: string, input: VoucherBlockWarningInput): Promise<VoucherWarning | null>
}
