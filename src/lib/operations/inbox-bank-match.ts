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
