import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import type { CashAccount } from '@/types'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import { codedRefusal } from '@/lib/errors/refusal'
import { primaryIneligibleReason } from '@/lib/cash-accounts/primary'

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
 *
 * `currency` is the transaction's own currency; omitted it reads as SEK, as
 * before. When given, an explicit cash account in another currency is refused
 * (BANK_BOOKING_CURRENCY_MISMATCH): the bank-booking guards look the account
 * up by the transaction's currency and would refuse the posting at approval
 * anyway. A caller that omits it skips that check.
 */
export async function resolveSettlementAccount(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string | null,
  log: Logger,
  currency?: string | null,
): Promise<string> {
  const transactionCurrency = currency ?? 'SEK'
  if (!cashAccountId) {
    const { data: candidates, error: listError } = await supabase
      .from('cash_accounts')
      .select('ledger_account')
      .eq('company_id', companyId)
      .eq('enabled', true)
      .eq('currency', transactionCurrency)
      .limit(2)

    if (listError) {
      // Unlike the explicit-cashAccountId branch below (which throws, #842),
      // this path historically never queried at all and always returned 1930,
      // so failing the whole request on a lookup error here would regress
      // every unbound transaction, including ambiguous companies whose answer
      // is 1930 anyway. Degrade to the historical fallback and warn.
      log.warn('settlement-account currency fallback lookup failed; defaulting to 1930', {
        companyId,
        currency: transactionCurrency,
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
        currency: transactionCurrency,
      })
    }
    return FALLBACK_ACCOUNT
  }

  const { data, error } = await supabase
    .from('cash_accounts')
    .select('ledger_account, currency')
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

  // The bank-booking guards (capture_bank_booking_context,
  // guard_bank_booking_context, bank_anchor_settlement_account) find this
  // account only in the transaction's currency and refuse every booking and
  // link otherwise. Refuse here, so no preview or staged operation promises
  // a verifikat its approval cannot post (feedback seq 753539: an 'XXX'
  // account staged a batch allocation that failed at approval).
  if (currency != null && data.currency !== currency) {
    throw codedRefusal(
      'BANK_BOOKING_CURRENCY_MISMATCH',
      `The transaction is in ${currency} but its bank account ${data.ledger_account} is in ${data.currency}: ` +
        'no booking or link of it can post on that account.',
    )
  }

  return data.ledger_account as string
}

/**
 * Resolve the BAS ledger account a SEK payment with NO bank row of its own
 * settles on: the net pay of a salary run, booked on the payment date before
 * any bank transaction exists (issue #3097).
 *
 * The company's primary cash account is the answer the product already gives
 * for "which bank account, when nothing else says" (lib/cash-accounts/primary.ts):
 * the user picks it under Inställningar → Bokföring, audit_cash_accounts_routing
 * logs every change, and reconciliation files unbound rows under it. A primary
 * counts only when it is one the user could pick today (primaryIneligibleReason:
 * enabled, SEK, a giro or bank account), so a payment never lands on a
 * disabled or foreign-currency account. Without a usable primary this is the
 * unbound-SEK-row answer above (the only enabled SEK account, else 1930), so a
 * company with no cash accounts at all (legacy) keeps booking on 1930.
 *
 * A failed primary lookup throws instead of degrading to 1930: a verifikat
 * booked on the wrong bank account needs a storno to correct (BFL 5 kap), a
 * retry does not. For that reason this does not go through cash-accounts
 * getPrimary(), which logs a failed lookup and returns null.
 */
export async function resolvePrimaryBankAccount(
  supabase: SupabaseClient,
  companyId: string,
  log: Logger,
): Promise<string> {
  // At most one row: a partial unique index keeps one primary per company.
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('ledger_account, enabled, currency')
    .eq('company_id', companyId)
    .eq('is_primary', true)
    .maybeSingle()

  if (error) {
    throw new BookkeepingDatabaseError('resolve_settlement_account', error.message)
  }

  const primary = data as Pick<CashAccount, 'ledger_account' | 'enabled' | 'currency'> | null
  if (primary?.ledger_account) {
    const reason = primaryIneligibleReason(primary)
    if (reason === null) return primary.ledger_account
    log.warn('primary cash account cannot carry a payment; resolving without it', {
      companyId,
      ledgerAccount: primary.ledger_account,
      reason,
    })
  }

  return resolveSettlementAccount(supabase, companyId, null, log, 'SEK')
}
