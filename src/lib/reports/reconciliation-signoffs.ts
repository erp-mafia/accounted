/**
 * Reconciliation sign-offs: the ledger's question to the bank side, "who
 * signed off each account, and through which date?".
 *
 * The report data status reads how far the bank accounts are signed off;
 * the bokslutsbilagor print each account's sign-off. The sign-offs are the
 * bank transactions block's (account_reconciliations, lib/reconciliation).
 * This file is the ledger's side of the contract and imports nothing at
 * runtime; the implementation is wired in
 * lib/composition/reconciliation-signoffs.ts, which the ledger imports
 * statically (no lib/init, no event bus).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ModuleId } from '@/lib/modules/manifest'
import type { ReconciliationSignoff } from '@/lib/reconciliation/schemas'

/** One account_reconciliations row, as the sign-off reads select it. */
export interface ReconciliationSignoffRow {
  id: string
  account_key: string
  through_date: string
  external_balance: number | string | null
  ledger_balance: number | string | null
  unexplained_difference: number | string | null
  note: string | null
  signed_by: string
  signed_at: string
  reopened_at: string | null
  reopened_by: string | null
  reopen_reason: string | null
}

export interface ReconciliationSignoffs {
  /** The module that owns the code behind the answers (lib/modules/manifest.ts). */
  readonly module: ModuleId
  /** Latest active sign-off per account key, one read for the whole company. Throws on a failed read. */
  latest(supabase: SupabaseClient, companyId: string): Promise<Map<string, ReconciliationSignoff>>
  /** One row as a sign-off, amounts rounded to the öre. */
  fromRow(row: ReconciliationSignoffRow): ReconciliationSignoff
  /** The account key a cash account's sign-offs are filed under. */
  bankAccountKey(cashAccountId: string): string
}
