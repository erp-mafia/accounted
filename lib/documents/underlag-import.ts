/**
 * Underlag import: attach a folder of receipt files to already-migrated
 * verifikat, using nothing but the voucher reference in each filename.
 *
 * A SIE file carries the ledger but not the underlag, so a migrating customer
 * has to bring the receipts over separately. Systems that export both name each
 * receipt after its verifikat (`A31_<id>.pdf`), and the SIE import preserved
 * that same identity on every entry, so the pairing is a lookup rather than an
 * interpretation. No AI, no amount matching, no date windows.
 *
 * This module only PLANS. Nothing here writes: the plan goes back to the user,
 * who approves it, and each approved row is then attached one file at a time.
 * That split is deliberate: linking a document to a posted verifikat makes it
 * räkenskapsinformation, which can never be re-pointed (BFL 7 kap), so a bulk
 * write with no preview would be an unrecoverable mistake by design.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { parseVoucherRefFromFileName } from '@/lib/documents/filename-voucher-ref'
import {
  buildVoucherIndex,
  candidatesForNumber,
  candidatesForRef,
  fetchFiscalPeriods,
  fetchVouchersForNumbers,
  hasSourceRefVouchers,
  sourceVoucherLabel,
  voucherLabel,
  type FiscalPeriodRow,
  type VoucherRow,
} from '@/lib/documents/voucher-ref-resolver'

export type UnderlagPlanStatus =
  /** Exactly one open verifikat: safe to pre-select. */
  | 'matched'
  /** Resolved, but the filename gave no series: a human confirms the pick. */
  | 'needs_confirmation'
  /** The ref exists in several fiscal years: the user picks which one. */
  | 'ambiguous'
  /** The only candidate sits in a closed or locked period: the DB will refuse. */
  | 'period_locked'
  /** Parsed a ref, but no migrated verifikat carries it. */
  | 'no_match'
  /** The filename carries no readable voucher reference. */
  | 'unparsed'

export interface UnderlagPlanCandidate {
  journal_entry_id: string
  /** Our own label after renumbering, e.g. `A47`. */
  voucher_label: string | null
  /** The label the source system used, i.e. what the filename says, e.g. `A31`. */
  source_voucher_label: string | null
  entry_date: string
  description: string | null
  period_locked: boolean
}

export interface UnderlagPlanRow {
  file_name: string
  status: UnderlagPlanStatus
  parsed_ref: { series: string | null; number: number } | null
  /** The single resolved target, when there is exactly one. */
  journal_entry_id: string | null
  /** Every candidate, so an ambiguous row can be resolved by hand. */
  candidates: UnderlagPlanCandidate[]
}

export interface UnderlagPlanSummary {
  total: number
  matched: number
  needs_confirmation: number
  ambiguous: number
  period_locked: number
  no_match: number
  unparsed: number
}

export interface UnderlagPlan {
  rows: UnderlagPlanRow[]
  summary: UnderlagPlanSummary
  /**
   * True when the company has no migrated entry carrying a source voucher ref.
   * Either nothing was imported from SIE, or the import predates the columns
   * (added 2026-04-21 and never backfilled), in which case filename matching
   * cannot work at all and the UI must say so instead of showing 400 misses.
   */
  no_source_refs: boolean
}

function isPeriodLocked(period: FiscalPeriodRow | undefined): boolean {
  return period ? period.is_closed || period.locked_at !== null : false
}

function toCandidate(entry: VoucherRow, periods: Map<string, FiscalPeriodRow>): UnderlagPlanCandidate {
  return {
    journal_entry_id: entry.id,
    voucher_label: voucherLabel(entry),
    source_voucher_label: sourceVoucherLabel(entry),
    entry_date: entry.entry_date,
    description: entry.description,
    period_locked: isPeriodLocked(periods.get(entry.fiscal_period_id)),
  }
}

function emptySummary(): UnderlagPlanSummary {
  return {
    total: 0,
    matched: 0,
    needs_confirmation: 0,
    ambiguous: 0,
    period_locked: 0,
    no_match: 0,
    unparsed: 0,
  }
}

/**
 * Build the match plan for a set of filenames. Reads only: no upload, no link.
 *
 * The same function backs the preview and the per-file attach check, so the
 * server can never link a file to a verifikat the preview would not have
 * proposed.
 */
export async function buildUnderlagPlan(
  supabase: SupabaseClient,
  companyId: string,
  fileNames: string[],
): Promise<UnderlagPlan> {
  const parsed = fileNames.map((fileName) => ({
    fileName,
    ref: parseVoucherRefFromFileName(fileName),
  }))

  const numbers = parsed.map((p) => p.ref?.number).filter((n): n is number => n != null)

  const [vouchers, periodRows] = await Promise.all([
    fetchVouchersForNumbers(supabase, companyId, numbers),
    fetchFiscalPeriods(supabase, companyId),
  ])

  const index = buildVoucherIndex(vouchers)
  const periods = new Map(periodRows.map((p) => [p.id, p]))

  const summary = emptySummary()
  summary.total = parsed.length

  const rows: UnderlagPlanRow[] = parsed.map(({ fileName, ref }) => {
    if (!ref) {
      summary.unparsed++
      return {
        file_name: fileName,
        status: 'unparsed',
        parsed_ref: null,
        journal_entry_id: null,
        candidates: [],
      }
    }

    const parsedRef = { series: ref.series, number: ref.number }
    const entries = ref.series
      ? candidatesForRef(index, { series: ref.series, number: ref.number })
      : candidatesForNumber(index, ref.number)
    const candidates = entries.map((entry) => toCandidate(entry, periods))

    if (candidates.length === 0) {
      summary.no_match++
      return {
        file_name: fileName,
        status: 'no_match',
        parsed_ref: parsedRef,
        journal_entry_id: null,
        candidates: [],
      }
    }

    if (candidates.length > 1) {
      // Source systems restart numbering every year, so one ref legitimately
      // hits several migrated years. Hand the choice back rather than pick.
      summary.ambiguous++
      return {
        file_name: fileName,
        status: 'ambiguous',
        parsed_ref: parsedRef,
        journal_entry_id: null,
        candidates,
      }
    }

    const only = candidates[0]
    if (only.period_locked) {
      summary.period_locked++
      return {
        file_name: fileName,
        status: 'period_locked',
        parsed_ref: parsedRef,
        journal_entry_id: only.journal_entry_id,
        candidates,
      }
    }

    if (!ref.autoSelectable) {
      summary.needs_confirmation++
      return {
        file_name: fileName,
        status: 'needs_confirmation',
        parsed_ref: parsedRef,
        journal_entry_id: only.journal_entry_id,
        candidates,
      }
    }

    summary.matched++
    return {
      file_name: fileName,
      status: 'matched',
      parsed_ref: parsedRef,
      journal_entry_id: only.journal_entry_id,
      candidates,
    }
  })

  // Only worth a round-trip when nothing landed: the answer distinguishes
  // "wrong filenames" from "this ledger has no source refs to match against".
  const no_source_refs =
    summary.matched + summary.needs_confirmation + summary.ambiguous + summary.period_locked === 0
      ? !(await hasSourceRefVouchers(supabase, companyId))
      : false

  return { rows, summary, no_source_refs }
}

/**
 * Whether `journalEntryId` is a target the plan for `fileName` would accept.
 *
 * Guards the attach route against a stale or wrong client: the file the browser
 * uploads must land on the verifikat the preview proposed for that name. A
 * deliberate manual assignment (an unreadable filename dragged onto a verifikat
 * by hand) bypasses this via the route's `override` flag, which is why company
 * ownership of the entry is verified separately and never inferred from here.
 */
export async function planAcceptsTarget(
  supabase: SupabaseClient,
  companyId: string,
  fileName: string,
  journalEntryId: string,
): Promise<boolean> {
  const plan = await buildUnderlagPlan(supabase, companyId, [fileName])
  const row = plan.rows[0]
  if (!row) return false
  return row.candidates.some((candidate) => candidate.journal_entry_id === journalEntryId)
}
