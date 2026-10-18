/**
 * Writes one planned migrated-invoice deduction (lib/invoices/
 * migrated-deduction-plan.ts) into the books and onto the invoice.
 *
 * Per invoice, in this order:
 *   1. a dry run of apply_migrated_invoice_deduction, so an invoice the RPC
 *      would refuse (drift since the preview, a begäran made meanwhile, rows
 *      that changed) never gets a voucher first;
 *   2. the reclassification voucher through the engine, debit 1513 / credit
 *      1510 for the deduction, dated the run day (createMigratedDeductionEntry).
 *      The engine refuses a locked or closed period; the run stops there.
 *      A voucher an earlier run posted is reused, never booked twice: the
 *      partial unique index journal_entries_rot_rut_reclassification_live_unique
 *      turns a concurrent second booking into a duplicate, after which the
 *      winner's voucher is looked up and used;
 *   3. the RPC proper, which checks the voucher moved exactly the deduction,
 *      derives remaining_amount and status, and writes the invoice and its
 *      work rows in one transaction.
 * A failure after the voucher is resumable: the next run plans the invoice
 * again, finds the voucher and completes step 3. The voucher is never undone
 * here (BFL 5 kap 5 §: a storno is the user's decision).
 *
 * The status-only plan is one RPC call: a part-paid import at sent/overdue
 * becomes partially_paid.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { createMigratedDeductionEntry } from '@/lib/bookkeeping/rot-rut-entries'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import { activateAccounts } from '@/lib/bookkeeping/chart-of-accounts-service'
import { encryptPersonnummer, extractLast4 } from '@/lib/salary/personnummer'
import { linkBasisColumns } from '@/lib/links/stamp'
import { roundOre } from '@/lib/money'
import type { MigratedDeductionPlan } from './migrated-deduction-plan'

type ApplyPlan = Extract<MigratedDeductionPlan, { outcome: 'apply' }>
type StatusPlan = Extract<MigratedDeductionPlan, { outcome: 'status_only' }>

export interface MigratedDeductionTrail {
  provider: string
  consentId: string | null
  /** One id per run, so its events read as one batch. */
  correlationId: string
}

/** The codes apply_migrated_invoice_deduction answers a refusal with. */
export type MigratedDeductionRefusal =
  | 'FORBIDDEN'
  | 'INVOICE_NOT_FOUND'
  | 'NOT_AN_OPEN_INVOICE'
  | 'DRIFT'
  | 'CURRENCY'
  | 'HELD_BY_REQUEST'
  | 'ALREADY_HAS_DEDUCTION'
  | 'DEDUCTION_INVALID'
  | 'DEDUCTION_EXCEEDS_REMAINING'
  | 'PERSONNUMMER_MISSING'
  | 'PAYMENT_DATE_MISSING'
  | 'VOUCHER_INVALID'
  | 'STATUS_NOT_REPAIRABLE'

export type MigratedDeductionApplyOutcome =
  | {
      ok: true
      /** false: an earlier run (or a concurrent one) already wrote it. */
      applied: boolean
      status: string
      remainingAmount: number
      journalEntryId: string | null
    }
  | { ok: false; kind: 'refused'; code: MigratedDeductionRefusal; journalEntryId: string | null }
  | { ok: false; kind: 'error'; stage: 'check' | 'book' | 'apply'; error: unknown; journalEntryId: string | null }

interface RpcResult {
  ok: boolean
  code?: MigratedDeductionRefusal
  applied?: boolean
  status?: string
  remaining_amount?: number | string
}

const RECLASSIFICATION_INDEX = 'journal_entries_rot_rut_reclassification_live_unique'

/** 1510 and 1513 present and active, once per run, before any voucher. */
export async function ensureDeductionAccounts(ctx: {
  supabase: SupabaseClient
  companyId: string
  userId: string
  log: Logger
}): Promise<boolean> {
  const outcome = await activateAccounts(ctx, ['1510', '1513'])
  return outcome.ok
}

function isDuplicateVoucher(error: unknown): boolean {
  if (error instanceof BookkeepingDatabaseError) {
    return error.pgCode === '23505' || (error.cause ?? '').includes(RECLASSIFICATION_INDEX)
  }
  return error instanceof Error && error.message.includes(RECLASSIFICATION_INDEX)
}

/** The posted reclassification voucher of this invoice, if one stands. */
export async function findLiveReclassificationVoucher(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('company_id', companyId)
    .eq('source_type', 'rot_rut_reclassification')
    .eq('source_id', invoiceId)
    .eq('status', 'posted')
    .maybeSingle()
  if (error) throw error
  return (data as { id: string } | null)?.id ?? null
}

async function callApply(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
  args: {
    expected: ApplyPlan['expected']
    deduction: Record<string, unknown> | null
    journalEntryId: string | null
    dryRun: boolean
    trail: MigratedDeductionTrail
  },
): Promise<{ result: RpcResult | null; error: unknown }> {
  const { data, error } = await supabase.rpc('apply_migrated_invoice_deduction', {
    p_company_id: companyId,
    p_invoice_id: invoiceId,
    p_expected: args.expected,
    p_deduction: args.deduction,
    p_journal_entry_id: args.journalEntryId,
    p_dry_run: args.dryRun,
    p_trail: {
      provider: args.trail.provider,
      consent_id: args.trail.consentId,
      correlation_id: args.trail.correlationId,
    },
  })
  if (error) return { result: null, error }
  return { result: (data ?? null) as RpcResult | null, error: null }
}

function settled(result: RpcResult, journalEntryId: string | null): MigratedDeductionApplyOutcome {
  if (!result.ok) {
    return { ok: false, kind: 'refused', code: result.code ?? 'DEDUCTION_INVALID', journalEntryId }
  }
  return {
    ok: true,
    applied: result.applied === true,
    status: result.status ?? '',
    remainingAmount: roundOre(Number(result.remaining_amount ?? 0)),
    journalEntryId,
  }
}

export async function applyMigratedDeduction(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  plan: ApplyPlan,
  options: { bookingDate: string; invoiceNumber: string | null; trail: MigratedDeductionTrail },
): Promise<MigratedDeductionApplyOutcome> {
  const deduction = {
    deduction_type: plan.deductionType,
    deduction_total: plan.deductionTotal,
    personnummer_encrypted: encryptPersonnummer(plan.personnummer),
    personnummer_last4: extractLast4(plan.personnummer),
    paid_on: plan.paidOn,
    items: plan.items,
  }
  const common = { expected: plan.expected, deduction, trail: options.trail }

  const check = await callApply(supabase, companyId, plan.invoiceId, {
    ...common,
    journalEntryId: null,
    dryRun: true,
  })
  if (check.error || !check.result) {
    return { ok: false, kind: 'error', stage: 'check', error: check.error, journalEntryId: null }
  }
  if (!check.result.ok) return settled(check.result, null)

  let journalEntryId = plan.reuseVoucherId
  if (!journalEntryId) {
    try {
      const entry = await createMigratedDeductionEntry(
        supabase,
        companyId,
        userId,
        {
          invoiceId: plan.invoiceId,
          invoiceNumber: options.invoiceNumber,
          deductionType: plan.deductionType,
          amount: plan.deductionTotal,
          bookingDate: options.bookingDate,
        },
        // The posting port's event, while POSTING_EVENTS is on: the deduction
        // came over from the provider's records (the run's provider).
        () => ({ linkBasis: linkBasisColumns('import_carried_over', { source_system: options.trail.provider }) }),
      )
      journalEntryId = entry.id
    } catch (bookError) {
      if (!isDuplicateVoucher(bookError)) {
        return { ok: false, kind: 'error', stage: 'book', error: bookError, journalEntryId: null }
      }
      // A concurrent run booked it first: use that voucher.
      try {
        journalEntryId = await findLiveReclassificationVoucher(supabase, companyId, plan.invoiceId)
      } catch (lookupError) {
        return { ok: false, kind: 'error', stage: 'book', error: lookupError, journalEntryId: null }
      }
      if (!journalEntryId) {
        return { ok: false, kind: 'error', stage: 'book', error: bookError, journalEntryId: null }
      }
    }
  }

  const applied = await callApply(supabase, companyId, plan.invoiceId, {
    ...common,
    journalEntryId,
    dryRun: false,
  })
  if (applied.error || !applied.result) {
    return { ok: false, kind: 'error', stage: 'apply', error: applied.error, journalEntryId }
  }
  return settled(applied.result, journalEntryId)
}

export async function repairMigratedInvoiceStatus(
  supabase: SupabaseClient,
  companyId: string,
  plan: StatusPlan,
  trail: MigratedDeductionTrail,
): Promise<MigratedDeductionApplyOutcome> {
  const { result, error } = await callApply(supabase, companyId, plan.invoiceId, {
    expected: plan.expected,
    deduction: null,
    journalEntryId: null,
    dryRun: false,
    trail,
  })
  if (error || !result) return { ok: false, kind: 'error', stage: 'apply', error, journalEntryId: null }
  return settled(result, null)
}
