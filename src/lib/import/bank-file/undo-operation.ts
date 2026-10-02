/**
 * Undo a completed bank file import, as an operation outcome: the service
 * behind DELETE /api/import/bank-file/[id]/undo (dashboard), the v1
 * operation imports.bank.undo and the MCP tool gnubok_undo_bank_import
 * (lib/operations/imports.ts).
 *
 * What an undo does (the undo_bank_file_import RPC, migration
 * 20260820071500): hard-deletes the batch's UNBOOKED transactions, ignored
 * ones included, and marks the import 'undone' so the same file can be
 * imported again. It never touches:
 *   - booked rows: anchored to a verifikat directly (journal_entry_id,
 *     invoice_id, supplier_invoice_id) or through invoice_payments,
 *     supplier_invoice_payments or transaction_voucher_links. They are
 *     räkenskapsinformation; a posted verifikat is never deleted (BFL): the
 *     user unlinks or reverses (storno) it on its own;
 *   - unbooked rows with payment_match_log history (append-only, BFL 7 kap).
 * Both are reported as skipped counts. Rows stamped with no import id
 * (imports before the stamp existed) are never matched: no fuzzy fallback.
 *
 * Owner/admin only: checked here up front (so a dry run and an MCP stage
 * are refused for a member), and again authoritatively inside the RPC.
 * A dry run counts what the undo would delete and skip; it writes nothing.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { requireCompanyAdmin } from '@/lib/operations/access'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { undoBankFileImport } from './undo'

export interface BankImportUndoResult {
  bank_file_import_id: string
  deleted_transactions: number
  skipped_booked: number
  skipped_match_history: number
}

const ADMIN_MESSAGE = 'Endast ägare eller administratörer kan ångra en bankfilsimport.'

/** Rows per IN() lookup: keeps the PostgREST URL well under its limit. */
const ID_CHUNK = 200

export async function undoBankImport(
  ctx: OperationContext,
  importId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<BankImportUndoResult>> {
  const { supabase, companyId, userId, log } = ctx

  const { data: importRecord, error: lookupError } = await supabase
    .from('bank_file_imports')
    .select('id, status')
    .eq('id', importId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (lookupError) return { ok: false, code: 'BANK_FILE_UNDO_FAILED', error: lookupError }
  if (!importRecord) return { ok: false, code: 'BANK_FILE_UNDO_NOT_FOUND' }

  const denied = await requireCompanyAdmin(ctx, ADMIN_MESSAGE)
  if (denied) return { ...denied, code: 'BANK_FILE_UNDO_FORBIDDEN' }

  const status = (importRecord as { status: string }).status
  if (status !== 'completed') {
    return { ok: false, code: 'BANK_FILE_UNDO_NOT_COMPLETED', details: { status } }
  }

  if (options.dryRun) {
    try {
      const counts = await countUndoEffect(ctx, importId)
      return {
        ok: true,
        dryRun: true,
        preview: {
          bank_file_import_id: importId,
          would_delete_transactions: counts.deletable,
          skipped_booked: counts.booked,
          skipped_match_history: counts.matchHistory,
          posted_entries_touched: 0,
          note: 'Booked rows and their verifikat are never deleted: unlink or reverse (storno) them separately. The import is marked undone so the file can be imported again.',
        },
      }
    } catch (err) {
      return { ok: false, code: 'BANK_FILE_UNDO_FAILED', error: err }
    }
  }

  const result = await undoBankFileImport(supabase, companyId, importId, userId)
  if (!result.success) {
    if (result.notFound) return { ok: false, code: 'BANK_FILE_UNDO_NOT_FOUND' }
    if (result.forbidden) return { ok: false, code: 'BANK_FILE_UNDO_FORBIDDEN' }
    return { ok: false, code: 'BANK_FILE_UNDO_FAILED', details: { reason: result.error } }
  }

  log.info('bank file import undone', {
    bankFileImportId: importId,
    actor: userId,
    deletedTransactions: result.deletedTransactions,
    skippedBooked: result.skippedBooked,
    skippedMatchHistory: result.skippedMatchHistory,
  })
  return {
    ok: true,
    data: {
      bank_file_import_id: importId,
      deleted_transactions: result.deletedTransactions,
      skipped_booked: result.skippedBooked,
      skipped_match_history: result.skippedMatchHistory,
    },
  }
}

/**
 * The RPC's three counts from reads: booked (any verifikat anchor), unbooked
 * with match history, and the rest (what the DELETE would remove).
 */
async function countUndoEffect(
  ctx: OperationContext,
  importId: string,
): Promise<{ deletable: number; booked: number; matchHistory: number }> {
  const { supabase, companyId } = ctx
  const rows = await fetchAllRows<{
    id: string
    journal_entry_id: string | null
    invoice_id: string | null
    supplier_invoice_id: string | null
  }>(({ from, to }) =>
    supabase
      .from('transactions')
      .select('id, journal_entry_id, invoice_id, supplier_invoice_id')
      .eq('company_id', companyId)
      .eq('bank_file_import_id', importId)
      .order('id')
      .range(from, to),
  )

  let booked = 0
  const unanchored: string[] = []
  for (const row of rows) {
    if (row.journal_entry_id || row.invoice_id || row.supplier_invoice_id) booked++
    else unanchored.push(row.id)
  }

  const linked = new Set<string>()
  const withHistory = new Set<string>()
  for (let i = 0; i < unanchored.length; i += ID_CHUNK) {
    const chunk = unanchored.slice(i, i + ID_CHUNK)
    const [payments, supplierPayments, voucherLinks, matchLog] = await Promise.all([
      supabase.from('invoice_payments').select('transaction_id').in('transaction_id', chunk),
      supabase.from('supplier_invoice_payments').select('transaction_id').in('transaction_id', chunk),
      supabase.from('transaction_voucher_links').select('transaction_id').in('transaction_id', chunk),
      supabase.from('payment_match_log').select('transaction_id').in('transaction_id', chunk),
    ])
    for (const res of [payments, supplierPayments, voucherLinks, matchLog]) {
      if (res.error) throw res.error
    }
    for (const res of [payments, supplierPayments, voucherLinks]) {
      for (const r of (res.data ?? []) as { transaction_id: string }[]) linked.add(r.transaction_id)
    }
    for (const r of (matchLog.data ?? []) as { transaction_id: string }[]) withHistory.add(r.transaction_id)
  }

  let matchHistory = 0
  let deletable = 0
  for (const id of unanchored) {
    if (linked.has(id)) booked++
    else if (withHistory.has(id)) matchHistory++
    else deletable++
  }
  return { deletable, booked, matchHistory }
}
