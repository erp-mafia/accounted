/**
 * Edits that never touch a posted verifikat's bookkeeping fields, shared by
 * the dashboard routes (PATCH /api/bookkeeping/journal-entries/[id] and
 * [id]/notes) and the v1 operations in lib/operations/journal-entries.ts:
 *
 *   - editing a DRAFT in place (header and lines) through the engine's
 *     updateDraftEntry, which refuses anything but a draft (a posted entry
 *     is corrected with storno or inline rättelse, never edited);
 *   - the internal note (anteckning), annotation metadata the journal_entries
 *     immutability trigger allows on posted entries too.
 *
 * Dry runs read and validate only: no header update, no line replacement, no
 * account backfill.
 */
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { assertLinesWellFormed, updateDraftEntry, validateBalance } from '@/lib/bookkeeping/engine'
import { findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import {
  AccountsNotInChartError,
  CannotEditNonDraftError,
  EntryDateOutsideFiscalPeriodError,
  FiscalPeriodNotFoundError,
  JournalEntryNotBalancedError,
  JournalEntryNotFoundError,
  isBookkeepingError,
} from '@/lib/bookkeeping/errors'
import type { CreateJournalEntryInput, JournalEntry } from '@/types'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

function typedFailure(err: unknown): Failure {
  return { ok: false, code: (err as { code: string }).code, error: err }
}

// ---------------------------------------------------------------------------
// Draft edit
// ---------------------------------------------------------------------------

export async function updateDraftJournalEntry(
  ctx: OperationContext,
  entryId: string,
  input: CreateJournalEntryInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<JournalEntry>> {
  if (options.dryRun) return previewDraftUpdate(ctx, entryId, input)
  try {
    const entry = await updateDraftEntry(ctx.supabase, ctx.companyId, ctx.userId, entryId, input)
    return { ok: true, data: entry }
  } catch (err) {
    if (isBookkeepingError(err)) return typedFailure(err)
    // Untyped errors map to Swedish via getErrorMessage: the raw message is
    // logged and must never reach the user verbatim (issue #337).
    ctx.log.error('failed to update draft journal entry', err instanceof Error ? err : new Error(String(err)), { entryId })
    return {
      ok: false,
      code: 'JOURNAL_ENTRY_UPDATE_FAILED',
      messageSv: getErrorMessage(err, { context: 'journal_entry' }),
    }
  }
}

async function previewDraftUpdate(
  ctx: OperationContext,
  entryId: string,
  input: CreateJournalEntryInput,
): Promise<OperationOutcome<JournalEntry>> {
  const { supabase, companyId } = ctx
  const { data: existing } = await supabase
    .from('journal_entries')
    .select('id, status, voucher_series')
    .eq('id', entryId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!existing) return typedFailure(new JournalEntryNotFoundError())
  if (existing.status !== 'draft') return typedFailure(new CannotEditNonDraftError(existing.status as string))

  try {
    assertLinesWellFormed(input.lines)
  } catch (err) {
    return typedFailure(err)
  }
  const balance = validateBalance(input.lines)
  if (!balance.valid) {
    return typedFailure(new JournalEntryNotBalancedError(balance.totalDebit, balance.totalCredit, 'draft'))
  }

  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('name, period_start, period_end')
    .eq('id', input.fiscal_period_id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!period) return typedFailure(new FiscalPeriodNotFoundError())
  if (input.entry_date < period.period_start || input.entry_date > period.period_end) {
    return typedFailure(
      new EntryDateOutsideFiscalPeriodError(input.entry_date, period.name, period.period_start, period.period_end),
    )
  }

  // The header update is refused by the lock triggers in a locked/closed
  // period or behind the company lock date: same verdict here, as a code.
  const lock = await checkPeriodLock(supabase, companyId, input.entry_date)
  if (lock.locked) {
    return {
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { reason: lock.reason, fiscal_period_id: lock.fiscal_period_id, entry_date: input.entry_date },
    }
  }

  const unresolvable = await findUnresolvableAccounts(
    supabase,
    companyId,
    input.lines.map((l) => l.account_number),
  )
  if (unresolvable.length > 0) return typedFailure(new AccountsNotInChartError(unresolvable))

  return {
    ok: true,
    dryRun: true,
    preview: {
      journal_entry_id: entryId,
      status: 'draft',
      fiscal_period_id: input.fiscal_period_id,
      entry_date: input.entry_date,
      description: input.description,
      voucher_series: input.voucher_series || (existing.voucher_series as string | null) || 'A',
      notes: input.notes || null,
      total_debit: balance.totalDebit,
      total_credit: balance.totalCredit,
      lines: input.lines.map((l, i) => ({
        sort_order: i,
        account_number: l.account_number,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        line_description: l.line_description ?? null,
        dimensions: l.dimensions ?? null,
      })),
      will: 'replace the draft header and lines; the draft stays unposted and gets no voucher number until it is committed',
    },
  }
}

// ---------------------------------------------------------------------------
// Note (anteckning)
// ---------------------------------------------------------------------------

export interface JournalEntryNoteResult {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  notes: string | null
}

/** Whitespace-only clears the note, as the MCP set_voucher_note commit does. */
export function normalizeNote(notes: string | null): string | null {
  return typeof notes === 'string' && notes.trim() !== '' ? notes : null
}

export async function setJournalEntryNote(
  ctx: OperationContext,
  entryId: string,
  rawNotes: string | null,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<JournalEntryNoteResult>> {
  const notes = normalizeNote(rawNotes)
  if (options.dryRun) {
    const { data: entry, error } = await ctx.supabase
      .from('journal_entries')
      .select('id, voucher_series, voucher_number, status, notes')
      .eq('id', entryId)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (error) return { ok: false, code: 'JOURNAL_ENTRY_NOTE_FAILED', messageSv: getErrorMessage(error) }
    if (!entry) return { ok: false, code: 'JOURNAL_ENTRY_NOT_FOUND' }
    return {
      ok: true,
      dryRun: true,
      preview: {
        journal_entry_id: entry.id,
        voucher_series: entry.voucher_series ?? null,
        voucher_number: entry.voucher_number ?? null,
        status: entry.status,
        old_notes: entry.notes ?? null,
        new_notes: notes,
      },
    }
  }

  // Notes-only UPDATE: the journal_entries immutability trigger allows
  // exactly this on committed entries and raises on anything else.
  const { data, error } = await ctx.supabase
    .from('journal_entries')
    .update({ notes })
    .eq('id', entryId)
    .eq('company_id', ctx.companyId)
    .select('id, voucher_series, voucher_number')
    .maybeSingle()
  if (error) return { ok: false, code: 'JOURNAL_ENTRY_NOTE_FAILED', messageSv: getErrorMessage(error) }
  // Zero rows = the entry doesn't exist in this company: report it instead
  // of a phantom success.
  if (!data) return { ok: false, code: 'JOURNAL_ENTRY_NOT_FOUND' }
  return {
    ok: true,
    data: {
      journal_entry_id: data.id as string,
      voucher_series: (data.voucher_series as string | null) ?? null,
      voucher_number: (data.voucher_number as number | null) ?? null,
      notes,
    },
  }
}
