/**
 * Edits that never touch a posted verifikat's bookkeeping fields, shared by
 * the dashboard routes (PATCH /api/bookkeeping/journal-entries/[id] and
 * [id]/notes) and the v1 operations in lib/operations/journal-entries.ts:
 *
 *   - editing a DRAFT in place (header and lines) through the engine's
 *     updateDraftEntry, which refuses anything but a draft (a posted entry
 *     is corrected with storno or inline rättelse, never edited);
 *   - the internal note (anteckning), annotation metadata the journal_entries
 *     immutability trigger allows on posted entries too;
 *   - cancelling a DRAFT (v1 DELETE /journal-entries/{id} and the staged
 *     gnubok_cancel_draft_entry) through the engine's cancelDraftEntry, which
 *     refuses anything but a draft.
 *
 * Dry runs read and validate only: no header update, no line replacement, no
 * account backfill, no cancel.
 */
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { isPeriodLockRefusal } from '@/lib/errors/get-structured-error'
import {
  assertLinesWellFormed,
  cancelDraftEntry,
  updateDraftEntry,
  validateBalance,
} from '@/lib/bookkeeping/engine'
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
import { toError } from '@/lib/errors/to-error'

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
    ctx.log.error('failed to update draft journal entry', toError(err), { entryId })
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
// Draft cancel
// ---------------------------------------------------------------------------

/** The header v1 GET /journal-entries/{id} answers, without the lines. */
export const CANCEL_DRAFT_HEADER_COLUMNS =
  'id, fiscal_period_id, voucher_series, voucher_number, entry_date, description, status, source_type, source_id, notes, reverses_id, reversed_by_id, correction_of_id, created_at, updated_at'

export interface JournalEntryHeader {
  id: string
  fiscal_period_id: string
  voucher_series: string
  voucher_number: number | null
  entry_date: string
  description: string
  status: string
  source_type: string
  source_id: string | null
  notes: string | null
  reverses_id: string | null
  reversed_by_id: string | null
  correction_of_id: string | null
  created_at: string
  updated_at: string
}

/**
 * Cancel an uncommitted DRAFT verifikat: status draft to cancelled through the
 * engine (a compare-and-set on status, so a concurrent commit wins). A draft
 * holds no voucher number, so nothing leaves the löpande nummerordning
 * (BFL 5 kap 7 §) and no gap needs explaining; the row and its lines stay as
 * cancelled evidence. A posted or reversed entry is refused with
 * CANNOT_CANCEL_NON_DRAFT: storno is its only way out. A draft behind a period
 * lock or the company lock date answers PERIOD_LOCKED, the verdict the lock
 * triggers would reach, before any write. A draft that holds underlag answers
 * DRAFT_HAS_DOCUMENTS and lists them: a cancelled draft's documents can never
 * be linked to another verifikat. Deleting the draft in the app (Radera
 * utkast, the delete_last_voucher RPC) releases them instead, so the refusal
 * names that way out beside booking the draft.
 *
 * Already cancelled answers the entry unchanged, on a dry run too: it is the
 * end state the caller asked for, not a conflict.
 */
/** How many of a draft's documents a DRAFT_HAS_DOCUMENTS refusal lists by id. */
const DRAFT_DOCUMENTS_LISTED = 20

export async function cancelDraftJournalEntry(
  ctx: OperationContext,
  entryId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<JournalEntryHeader>> {
  const { supabase, companyId } = ctx
  const { data: existing, error: fetchError } = await supabase
    .from('journal_entries')
    .select(CANCEL_DRAFT_HEADER_COLUMNS)
    .eq('company_id', companyId)
    .eq('id', entryId)
    .maybeSingle()
  if (fetchError) return { ok: false, code: 'BOOKKEEPING_DATABASE_ERROR', error: fetchError }
  if (!existing) return { ok: false, code: 'JOURNAL_ENTRY_NOT_FOUND' }
  const entry = existing as unknown as JournalEntryHeader

  if (entry.status === 'cancelled') return { ok: true, data: entry }
  if (entry.status !== 'draft') {
    return { ok: false, code: 'CANNOT_CANCEL_NON_DRAFT', details: { currentStatus: entry.status } }
  }

  // A draft can hold underlag, and enforce_document_journal_entry_immutability
  // refuses re-pointing a document whose journal_entry_id is set (the
  // correction relink covers posted entries only). Cancelled, the draft would
  // keep its documents forever, and a re-upload dedups back to the stuck row.
  const { data: docs, error: docsError, count: docCount } = await supabase
    .from('document_attachments')
    .select('id, file_name', { count: 'exact' })
    .eq('company_id', companyId)
    .eq('journal_entry_id', entryId)
    .eq('is_current_version', true)
    .limit(DRAFT_DOCUMENTS_LISTED)
  if (docsError) return { ok: false, code: 'BOOKKEEPING_DATABASE_ERROR', error: docsError }
  const documents = ((docs ?? []) as Array<{ id: string; file_name: string | null }>).map((d) => ({
    document_id: d.id,
    file_name: d.file_name,
  }))
  const documentCount = Math.max(docCount ?? 0, documents.length)
  if (documentCount > 0) {
    return {
      ok: false,
      code: 'DRAFT_HAS_DOCUMENTS',
      messageSv: `Utkastet har ${documentCount} ${documentCount === 1 ? 'bilaga som inte kan flyttas' : 'bilagor som inte kan flyttas'} om utkastet makuleras. Radera utkastet i Accounted i stället (Bokföring › verifikationen › Fler alternativ › Radera utkast): ${documentCount === 1 ? 'bilagan finns kvar' : 'bilagorna finns kvar'} och kan kopplas till en annan verifikation. Eller bokför utkastet.`,
      details: { journal_entry_id: entryId, document_count: documentCount, documents },
    }
  }

  // Checked before the dry-run branch so a preview never promises a cancel
  // the lock triggers refuse.
  const lock = await checkPeriodLock(supabase, companyId, entry.entry_date)
  if (lock.locked) {
    return {
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { reason: lock.reason, fiscal_period_id: lock.fiscal_period_id, entry_date: entry.entry_date },
    }
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        // `id` is the v1 dry-run key; journal_entry_id names it for agents.
        id: entry.id,
        journal_entry_id: entry.id,
        voucher_series: entry.voucher_series,
        entry_date: entry.entry_date,
        description: entry.description,
        source_type: entry.source_type,
        status: 'cancelled',
        current_status: entry.status,
        would_release_voucher_number: false,
      },
    }
  }

  try {
    const cancelled = await cancelDraftEntry(supabase, companyId, ctx.userId, entryId)
    // Refetch the header columns so the answer has GET's shape rather than
    // every column the engine selected.
    const { data } = await supabase
      .from('journal_entries')
      .select(CANCEL_DRAFT_HEADER_COLUMNS)
      .eq('company_id', companyId)
      .eq('id', entryId)
      .maybeSingle()
    return { ok: true, data: (data ?? cancelled) as unknown as JournalEntryHeader }
  } catch (err) {
    if (isBookkeepingError(err)) return typedFailure(err)
    ctx.log.error('cancel draft journal entry failed', toError(err), { entryId })
    return { ok: false, code: 'BOOKKEEPING_DATABASE_ERROR', details: { step: 'cancel' } }
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

/** Whitespace-only clears the note: the column never stores a visually empty annotation. */
export function normalizeNote(notes: string | null): string | null {
  return typeof notes === 'string' && notes.trim() !== '' ? notes : null
}

/**
 * A closed or locked period is read-only, the note included: the note lives
 * on the verifikat row, and enforce_period_lock (migration 017) refuses every
 * write to a row whose fiscal period is closed or locked, whatever changed
 * (20260608120000 kept it that way on purpose). This is the refusal that
 * trigger reaches, as a code and a sentence about the note, never "a
 * verifikation cannot be created". The company lock date does not apply: its
 * trigger fires on entry_date only, so a note behind it is written.
 */
function notePeriodLocked(
  periodStatus: 'closed' | 'locked' | null,
  details: Record<string, unknown>,
): Failure {
  return {
    ok: false,
    code: 'JOURNAL_ENTRY_NOTE_PERIOD_LOCKED',
    messageSv:
      periodStatus === 'closed'
        ? 'Perioden är stängd, anteckningen kan inte ändras.'
        : periodStatus === 'locked'
          ? 'Perioden är låst, anteckningen kan inte ändras.'
          : 'Perioden är stängd eller låst, anteckningen kan inte ändras.',
    // period_status, not reason: v1 carries the Swedish sentence in details.reason.
    details: { ...(periodStatus ? { period_status: periodStatus } : {}), ...details },
  }
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
      .select('id, voucher_series, voucher_number, entry_date, description, status, notes, fiscal_period_id')
      .eq('id', entryId)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (error) return { ok: false, code: 'JOURNAL_ENTRY_NOTE_FAILED', messageSv: getErrorMessage(error) }
    if (!entry) return { ok: false, code: 'JOURNAL_ENTRY_NOT_FOUND' }
    // The same verdict enforce_period_lock reaches at commit, read off the
    // entry's own period (not the date's), so a staged note is one that can
    // be approved.
    const { data: period, error: periodError } = await ctx.supabase
      .from('fiscal_periods')
      .select('id, is_closed, locked_at')
      .eq('id', entry.fiscal_period_id)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (periodError) {
      return { ok: false, code: 'JOURNAL_ENTRY_NOTE_FAILED', messageSv: getErrorMessage(periodError) }
    }
    if (period?.is_closed || period?.locked_at) {
      return notePeriodLocked(period.is_closed ? 'closed' : 'locked', {
        fiscal_period_id: period.id,
        entry_date: entry.entry_date,
      })
    }
    return {
      ok: true,
      dryRun: true,
      preview: {
        journal_entry_id: entry.id,
        voucher_series: entry.voucher_series ?? null,
        voucher_number: entry.voucher_number ?? null,
        entry_date: entry.entry_date ?? null,
        description: entry.description ?? null,
        status: entry.status,
        old_notes: entry.notes ?? null,
        new_notes: notes,
      },
    }
  }

  // Notes-only UPDATE: the journal_entries immutability trigger allows
  // exactly this on committed entries and raises on anything else. The
  // period lock trigger stays the authority here (a period can be closed
  // between staging and approval); its refusal is put in the note's words.
  const { data, error } = await ctx.supabase
    .from('journal_entries')
    .update({ notes })
    .eq('id', entryId)
    .eq('company_id', ctx.companyId)
    .select('id, voucher_series, voucher_number')
    .maybeSingle()
  if (error && isPeriodLockRefusal(error)) return notePeriodLocked(null, { journal_entry_id: entryId })
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
