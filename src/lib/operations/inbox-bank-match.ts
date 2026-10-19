/**
 * Match on arrival, bound to the rules it reuses: the inbox block
 * (lib/documents/bank-match) decides with the bank feed's supplier-invoice
 * matcher and the giro reader, which the invoicing and transactions blocks
 * own and the inbox block may not import, so they are bound here, once, for
 * every door: the inbox's own (upload, extraction, corrections), Peppol, the
 * v1 and MCP corrections and the bank-arrival handler.
 *
 * Best effort by design: a proposal is a hint, so a failure is logged and
 * never fails the door that filed or corrected the item.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  refreshInboxBankMatchesForTransactions,
  refreshInboxItemBankMatch,
  type ArrivedBankRow,
  type BankMatchRefreshRules,
} from '@/lib/documents/bank-match/refresh'
import { findSupplierInvoiceMatch } from '@/lib/invoices/supplier-invoice-matching'
import { peppolReader } from '@/lib/invoices/peppol-reading'
import { counterpartyGiroDigits, giroKey } from '@/lib/transactions/giro-counterparty'
import { createLogger, type Logger } from '@/lib/logger'

export const INBOX_BANK_MATCH_RULES: BankMatchRefreshRules = {
  matchSupplierInvoice: findSupplierInvoiceMatch,
  counterpartyGiroDigits,
  giroKey,
  peppolReader,
}

const defaultLog = createLogger('inbox.bank-match')

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Look in the bank for an inbox item's payment and record the proposal. Never throws. */
export async function proposeBankMatchForInboxItem(
  supabase: SupabaseClient,
  companyId: string,
  inboxItemId: string,
  log: Pick<Logger, 'warn'> = defaultLog,
): Promise<void> {
  try {
    await refreshInboxItemBankMatch(supabase, companyId, inboxItemId, INBOX_BANK_MATCH_RULES)
  } catch (err) {
    log.warn('inbox bank match failed', { inboxItemId, reason: reason(err) })
  }
}

/** Bank rows arrived: look again at the open items they could pay. Never throws. */
export async function proposeBankMatchesForArrivedRows(
  supabase: SupabaseClient,
  companyId: string,
  transactions: readonly ArrivedBankRow[],
  log: Pick<Logger, 'warn'> = defaultLog,
): Promise<void> {
  try {
    const { failed } = await refreshInboxBankMatchesForTransactions(supabase, companyId, transactions, INBOX_BANK_MATCH_RULES)
    if (failed > 0) log.warn('inbox bank match: items not refreshed', { companyId, failed })
  } catch (err) {
    log.warn('inbox bank match on bank arrival failed', { companyId, reason: reason(err) })
  }
}

// ---------------------------------------------------------------------------
// Never checked: the items and bank rows from before match on arrival
// ---------------------------------------------------------------------------

/**
 * The items a list read checks, at most, newest first. Each check is a
 * handful of reads; a list read never waits for them (they run after the
 * answer), so the bound is what one read may cost the database.
 */
export const NEVER_CHECKED_PER_LIST_READ = 5

/**
 * One list batch per company per this span. A batch's writes reach the page
 * as realtime changes, and the read each change starts must not start the
 * next batch at once: without the pause a page with a hundred never-checked
 * items would read its whole list once per write until every item was done.
 */
export const NEVER_CHECKED_COOLDOWN_MS = 30_000

/** The item columns the never-checked selection reads. */
export interface NeverCheckedRow {
  id: string
  status?: string | null
  document_id?: string | null
  created_at?: string | null
  matched_transaction_id?: string | null
  created_supplier_invoice_id?: string | null
  created_journal_entry_id?: string | null
  routed_to_arkiv_at?: string | null
  bank_match_checked_at?: string | null
}

/**
 * Open, read, with a document, and never looked at: bank_match_checked_at
 * is null. Only an explicit null counts; a row read without the column says
 * nothing about it. The same open items the bank-arrival scan reads
 * (refreshInboxBankMatchesForTransactions).
 */
export function neverChecked(row: NeverCheckedRow): boolean {
  return (
    row.bank_match_checked_at === null &&
    row.status === 'received' &&
    !!row.document_id &&
    !row.matched_transaction_id &&
    !row.created_supplier_invoice_id &&
    !row.created_journal_entry_id &&
    !row.routed_to_arkiv_at
  )
}

/**
 * The never-checked items a list read checks: at most `limit`, newest
 * first, and none while a check of the company's landed within the
 * cooldown (the latest bank_match_checked_at among the rows read).
 */
export function neverCheckedToCheck(
  rows: readonly NeverCheckedRow[],
  now: Date,
  limit: number = NEVER_CHECKED_PER_LIST_READ,
): string[] {
  const since = now.getTime() - NEVER_CHECKED_COOLDOWN_MS
  const recent = rows.some((row) => {
    const at = row.bank_match_checked_at ? Date.parse(row.bank_match_checked_at) : NaN
    return Number.isFinite(at) && at > since
  })
  if (recent) return []
  return rows
    .filter(neverChecked)
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((row) => row.id)
}

/**
 * Look in the bank for items it was never checked for (bounded by the
 * caller). Each item is claimed first: bank_match_checked_at is set where it
 * is still null, in one write, so a read running at the same time never
 * checks it too, and an item whose check fails is not picked again by the
 * next read (the doors that re-check, a correction or a bank arrival, still
 * do). Then the proposal is written as on arrival. Never throws; returns the
 * ids this call checked.
 */
export async function checkNeverCheckedInboxItems(
  supabase: SupabaseClient,
  companyId: string,
  itemIds: readonly string[],
  log: Pick<Logger, 'warn'> = defaultLog,
): Promise<string[]> {
  const ids = [...new Set(itemIds)]
  if (ids.length === 0) return []
  let claimed: string[]
  try {
    const { data, error } = await supabase
      .from('invoice_inbox_items')
      .update({ bank_match_checked_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .in('id', ids)
      .is('bank_match_checked_at', null)
      .is('created_supplier_invoice_id', null)
      .is('created_journal_entry_id', null)
      .is('matched_transaction_id', null)
      .is('routed_to_arkiv_at', null)
      .select('id')
    if (error) throw new Error(error.message)
    claimed = ((data ?? []) as Array<{ id: string }>).map((row) => row.id)
  } catch (err) {
    log.warn('inbox bank match: never-checked claim failed', { companyId, reason: reason(err) })
    return []
  }
  for (const id of claimed) await proposeBankMatchForInboxItem(supabase, companyId, id, log)
  return claimed
}
