import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'

const FALLBACK_ACCOUNT = '1930'

/**
 * Resolve the BAS ledger account a transaction actually settles from/to.
 *
 * Never fall back to a company-wide "last used" setting (e.g.
 * last_supplier_payment_account, written by the manual mark-paid
 * private-funds flow): those reflect unrelated flows with no relationship
 * to which bank account a specific transaction is linked to.
 * cash_account_id -> cash_accounts.ledger_account is the only source of
 * truth for a real transaction's settlement account.
 *
 * When the transaction has NO cash_account_id (legacy/unresolved rows),
 * mirror the client-side resolveAccount (lib/cash-accounts/resolve-account.ts):
 * if the company has EXACTLY ONE enabled cash account in the transaction's
 * currency, that account is unambiguous and the bank leg belongs there.
 * Without this, a company whose only bank account is e.g. 1920 got its
 * booking dialogs previewing 1920 while the posted verifikat silently hit
 * the hardcoded 1930 template leg (issue #1722). Zero or several candidate
 * accounts keeps the historical 1930 fallback: guessing between real
 * accounts is worse than the known-neutral default.
 */
export async function resolveSettlementAccount(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string | null,
  log: Logger,
  currency: string = 'SEK',
): Promise<string> {
  if (!cashAccountId) {
    const { data: candidates, error: listError } = await supabase
      .from('cash_accounts')
      .select('ledger_account')
      .eq('company_id', companyId)
      .eq('enabled', true)
      .eq('currency', currency)
      .limit(2)

    if (listError) {
      // Unlike the explicit-cashAccountId branch below (which throws, #842),
      // this path historically never queried at all and always returned 1930,
      // so failing the whole request on a lookup error here would regress
      // every unbound transaction, including ambiguous companies whose answer
      // is 1930 anyway. Degrade to the historical fallback and warn.
      log.warn('settlement-account currency fallback lookup failed; defaulting to 1930', {
        companyId,
        currency,
        error: listError.message,
      })
      return FALLBACK_ACCOUNT
    }

    if (candidates?.length === 1) {
      const ledgerAccount = candidates[0]?.ledger_account as string | null
      if (ledgerAccount) return ledgerAccount
      // ledger_account is NOT NULL in the schema; a hole here is a
      // data-integrity gap that must not hide behind a plausible 1930 leg.
      log.warn('settlement-account currency fallback row has no ledger_account; defaulting to 1930', {
        companyId,
        currency,
      })
    }
    return FALLBACK_ACCOUNT
  }

  const { data, error } = await supabase
    .from('cash_accounts')
    .select('ledger_account')
    .eq('id', cashAccountId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    // An EXPLICIT cash_account_id exists: it almost certainly resolves to a
    // non-1930 account, so silently degrading to 1930 on a transient lookup
    // failure risks the exact class of misbooking this helper exists to
    // prevent, just triggered by infra flakiness instead of a stale setting.
    // Fail the request instead: the caller can retry, whereas a wrongly
    // booked verifikat needs a storno to correct (BFL 5 kap).
    throw new BookkeepingDatabaseError('resolve_settlement_account', error.message)
  }

  // A transaction with a cash_account_id that resolves to no row, or a row
  // with no ledger_account, is a data-integrity gap (not a normal "no cash
  // account linked" case): the fallback fires silently otherwise, masking a
  // bad cash_accounts row behind a plausible-looking 1930 verifikat.
  if (!data?.ledger_account) {
    log.warn('settlement-account lookup returned no ledger_account; defaulting to 1930', {
      cashAccountId,
    })
    return FALLBACK_ACCOUNT
  }

  return data.ledger_account as string
}
