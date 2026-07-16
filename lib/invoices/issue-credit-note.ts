import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { createCreditNoteJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { cancelSchedulesForSource } from '@/lib/bookkeeping/accruals/service'
import type { Logger } from '@/lib/logger'
import type { AccountingMethod, CreditNote, EntityType } from '@/types'

export interface CreditNoteOriginalInvoice {
  id: string
  invoice_number: string | null
  status: string
  journal_entry_id?: string | null
  paid_at?: string | null
  paid_amount?: number | null
  total?: number | null
}

export interface CreditNoteIssueFailure {
  step: 'journal_entry' | 'journal_link' | 'accrual_schedules' | 'original_status'
  reason: string
}

interface IssueCreditNoteInput {
  supabase: SupabaseClient
  companyId: string
  userId: string
  creditNote: CreditNote & { customer?: { name?: string | null } | null }
  originalInvoice: CreditNoteOriginalInvoice
  entityType: EntityType
  accountingMethod: AccountingMethod
  log: Logger
}

export interface IssueCreditNoteResult {
  complete: boolean
  journalEntryId: string | null
  journalEntryRequired: boolean
  repairRequired: boolean
  failures: CreditNoteIssueFailure[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Okänt fel'
}

/**
 * Faktureringsmetoden always books the credit on issue. Kontantmetoden only
 * books it when the original sale has already reached the ledger, for example
 * through a completed payment or a year-end receivable entry.
 */
export function creditNoteNeedsJournalEntry(
  accountingMethod: AccountingMethod,
  originalInvoice: CreditNoteOriginalInvoice,
): boolean {
  return (
    accountingMethod === 'accrual' ||
    !!originalInvoice.journal_entry_id ||
    originalInvoice.status === 'paid' ||
    !!originalInvoice.paid_at ||
    Math.abs(originalInvoice.paid_amount ?? 0) > 0
  )
}

async function getOriginalVoucherRef(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string | null | undefined,
  log: Logger,
): Promise<string | undefined> {
  if (!journalEntryId) return undefined

  const { data, error } = await supabase
    .from('journal_entries')
    .select('voucher_series, voucher_number')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    log.warn('failed to load original voucher reference for credit note', error)
    return undefined
  }

  if (!data?.voucher_series || data.voucher_number == null) return undefined
  return `${data.voucher_series}-${data.voucher_number}`
}

async function findExistingCreditJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  creditNote: CreditNote,
): Promise<string | null> {
  if (creditNote.journal_entry_id) return creditNote.journal_entry_id

  const { data, error } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('company_id', companyId)
    .eq('source_type', 'credit_note')
    .eq('source_id', creditNote.id)
    .eq('status', 'posted')
    .maybeSingle()

  if (error) throw error
  return data?.id ?? null
}

/**
 * Completes the accounting side of credit-note issuance after the caller has
 * won the draft-to-sent compare-and-set. Every step is idempotent so a sent
 * credit note with incomplete bookkeeping can be repaired without creating a
 * second immutable voucher.
 */
export async function issueCreditNote(input: IssueCreditNoteInput): Promise<IssueCreditNoteResult> {
  const {
    supabase,
    companyId,
    userId,
    creditNote,
    originalInvoice,
    entityType,
    accountingMethod,
    log,
  } = input
  const failures: CreditNoteIssueFailure[] = []
  const journalEntryRequired = creditNoteNeedsJournalEntry(accountingMethod, originalInvoice)
  let journalEntryId: string | null = null
  const issuedCreditNote = { ...creditNote, status: 'sent' as const }

  if (journalEntryRequired) {
    try {
      journalEntryId = await findExistingCreditJournalEntry(
        supabase,
        companyId,
        issuedCreditNote,
      )

      if (!journalEntryId) {
        const originalVoucherRef = await getOriginalVoucherRef(
          supabase,
          companyId,
          originalInvoice.journal_entry_id,
          log,
        )
        const journalEntry = await createCreditNoteJournalEntry(
          supabase,
          companyId,
          userId,
          issuedCreditNote,
          entityType,
          creditNote.customer?.name ?? undefined,
          originalVoucherRef,
        )
        journalEntryId = journalEntry?.id ?? null
      }
    } catch (error) {
      // A concurrent issuer may have won the unique posted-source guard after
      // our initial lookup. Re-read and reuse that immutable voucher.
      try {
        journalEntryId = await findExistingCreditJournalEntry(
          supabase,
          companyId,
          issuedCreditNote,
        )
      } catch (recoveryError) {
        log.error('failed to recover credit note journal entry after create conflict', recoveryError, {
          creditNoteId: creditNote.id,
        })
      }
      if (!journalEntryId) {
        log.error('failed to create or recover credit note journal entry on issue', error, {
          creditNoteId: creditNote.id,
        })
        failures.push({ step: 'journal_entry', reason: errorMessage(error) })
      }
    }

    if (!journalEntryId) {
      if (failures.length === 0) {
        failures.push({
          step: 'journal_entry',
          reason: 'Ingen öppen bokföringsperiod hittades för kreditfakturans datum.',
        })
      }
      return { complete: false, journalEntryId, journalEntryRequired, repairRequired: false, failures }
    }

    if (creditNote.journal_entry_id !== journalEntryId) {
      const { data: linkedRows, error: linkError } = await supabase
        .from('invoices')
        .update({ journal_entry_id: journalEntryId })
        .eq('id', creditNote.id)
        .eq('company_id', companyId)
        .eq('status', 'sent')
        .select('id')

      if (linkError || !linkedRows || linkedRows.length === 0) {
        log.error('failed to link credit note to journal entry', linkError ?? undefined, {
          creditNoteId: creditNote.id,
          journalEntryId,
        })
        failures.push({
          step: 'journal_link',
          reason: linkError?.message ?? 'Kreditfakturan kunde inte kopplas till verifikatet.',
        })
        return { complete: false, journalEntryId, journalEntryRequired, repairRequired: true, failures }
      }
    }

    if (accountingMethod === 'accrual') {
      try {
        const cancelResult = await cancelSchedulesForSource(
          supabase,
          companyId,
          userId,
          { invoiceId: originalInvoice.id },
          { reversalDate: creditNote.invoice_date },
        )
        if (cancelResult.failedReversals > 0) {
          failures.push({
            step: 'accrual_schedules',
            reason:
              'En eller flera periodiseringsverifikat kunde inte vändas. ' +
              'Kontrollera Bokföring > Periodiseringar.',
          })
        }
      } catch (error) {
        log.warn('failed to cancel accrual schedules for credited invoice', error)
        failures.push({ step: 'accrual_schedules', reason: errorMessage(error) })
      }

      if (failures.length > 0) {
        return { complete: false, journalEntryId, journalEntryRequired, repairRequired: true, failures }
      }
    }
  }

  let originalStatusChanged = false
  if (originalInvoice.status !== 'credited') {
    const { data: updatedOriginal, error: originalStatusError } = await supabase
      .from('invoices')
      .update({ status: 'credited' })
      .eq('id', originalInvoice.id)
      .eq('company_id', companyId)
      .in('status', ['sent', 'paid', 'overdue'])
      .select('id')

    if (originalStatusError || !updatedOriginal || updatedOriginal.length === 0) {
      log.error('failed to mark original invoice as credited', originalStatusError ?? undefined, {
        originalInvoiceId: originalInvoice.id,
        creditNoteId: creditNote.id,
      })
      failures.push({
        step: 'original_status',
        reason: originalStatusError?.message ?? 'Originalfakturan kunde inte markeras som krediterad.',
      })
      return {
        complete: false,
        journalEntryId,
        journalEntryRequired,
        repairRequired: journalEntryRequired && !!journalEntryId,
        failures,
      }
    }
    originalStatusChanged = true
  }

  if (originalStatusChanged) {
    try {
      await eventBus.emit({
        type: 'credit_note.created',
        payload: { creditNote: issuedCreditNote, companyId, userId },
      })
    } catch (error) {
      log.warn('credit_note.created emit failed after completed issuance', error)
    }
  }

  return { complete: true, journalEntryId, journalEntryRequired, repairRequired: false, failures }
}
