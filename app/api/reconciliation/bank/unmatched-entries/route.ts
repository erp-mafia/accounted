import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import {
  fetchGLLinesForMatching,
  ledgerLineAmountIn,
  tryReconcileTransaction,
} from '@/lib/reconciliation/bank-reconciliation'
import { describeCashAccountSiblings, normalizeIban, shouldRepointToSibling } from '@/lib/cash-accounts/service'
import type { Transaction } from '@/types'

export const GET = withRouteContext(
  'reconciliation.bank.unmatched_entries',
  async (request, { supabase, companyId }) => {
    const { searchParams } = new URL(request.url)
    const dateFrom = searchParams.get('date_from') || undefined
    const dateTo = searchParams.get('date_to') || undefined
    const accountNumber = searchParams.get('account_number') || '1930'
    // Optional: when set, rank the returned candidates for this specific bank
    // transaction (used by the Transactions-page "Matcha mot befintlig
    // verifikation" dialog). Ranking happens server-side on purpose:
    // lib/reconciliation/bank-reconciliation pulls in server-only deps (event
    // bus, match-log) and must never reach the client bundle.
    const transactionId = searchParams.get('transaction_id') || undefined
    // When true, also return vouchers already matched to a bank transaction (each
    // carries linked_transaction_count) so the user can attach a second/third
    // transaction to the same verifikat, the N:1 "lägga på flera" case. Default
    // false keeps the list to unmatched candidates only.
    const includeMatched = searchParams.get('include_matched') === 'true'

    // Defense-in-depth: only allow account numbers that the company has actually
    // registered as a cash account. Without this, a curious caller could probe
    // arbitrary GL accounts for posted-but-unmatched amounts. Applies uniformly
    // including '1930': the cash_accounts backfill seeds 1930 for every company
    // that had a SEK PSD2 account, and the AccountPickerDialog seeds it for new
    // companies on first connection.
    // `currency` comes along because it, not the transaction's own currency, is
    // the unit this account is reconciled in: see the ranking block below.
    // `iban` identifies the physical bank account so the ranked (dialog) path
    // can widen the candidate set to sibling ledgers of the same account.
    const { data: cashAccount } = await supabase
      .from('cash_accounts')
      .select('id, currency, iban')
      .eq('company_id', companyId)
      .eq('ledger_account', accountNumber)
      .maybeSingle()

    if (!cashAccount) {
      return NextResponse.json(
        { error: 'Okänt kassakonto för det här företaget' },
        { status: 400 },
      )
    }

    // cash_accounts.currency is NOT NULL in the schema; the fallback only guards
    // against a legacy/hand-built row so a missing value can never silently turn
    // into "no currency" and disable ranking for a SEK company.
    const accountCurrency = (cashAccount.currency as string | null) ?? 'SEK'

    let lines = await fetchGLLinesForMatching(supabase, companyId, accountNumber, dateFrom, dateTo, includeMatched)

    if (transactionId) {
      // The "Matcha mot befintlig verifikation" dialog resolves the account
      // from the TRANSACTION's own cash_accounts row. When that row is an
      // orphan of a broken reconnect (issue #1643 problem 1), the verifikat
      // the row settles is booked on the LIVE ledger of the same physical
      // account (e.g. row stamped 1931, voucher on 1940) and could never be
      // offered. Sibling rows share the account's IBAN, so the candidate set
      // widens to every ledger carrying it in the SAME currency (the other
      // currency pockets of a multi-currency account share the IBAN but are
      // different accounts). Accounts without an IBAN (manual, CSV) have no
      // siblings and keep the exact single-ledger behavior.
      // A sibling that is NOT live (demoted or held by a revoked/expired
      // connection) is only offered when manualLink would re-point the row
      // onto it (shouldRepointToSibling: the own row's holder is gone and no
      // sibling is live): a live row, or one on a merely expired connection
      // that re-auth renews, must never be parked on a row no connection can
      // sync again.
      const ownIban = normalizeIban((cashAccount as { iban?: string | null }).iban ?? null)
      const siblingInfo = ownIban
        ? await describeCashAccountSiblings(supabase, companyId, cashAccount.id as string)
        : null
      if (siblingInfo && siblingInfo.siblings.length > 0) {
        const siblingLedgers = [
          ...new Set(
            siblingInfo.siblings
              .filter((row) => shouldRepointToSibling(siblingInfo, row))
              .map((row) => row.ledger_account),
          ),
        ]
        if (siblingLedgers.length > 0) {
          const merged = [...lines]
          const seen = new Set(lines.map((l) => l.line_id))
          for (const ledger of siblingLedgers) {
            const siblingLines = await fetchGLLinesForMatching(
              supabase, companyId, ledger, dateFrom, dateTo, includeMatched,
            )
            for (const line of siblingLines) {
              if (seen.has(line.line_id)) continue
              seen.add(line.line_id)
              merged.push(line)
            }
          }
          lines = merged
        }
      }
      // company-scoped fetch (defense-in-depth). A malformed/foreign id yields no
      // row → we fall through to the unranked list rather than erroring.
      const { data: tx } = await supabase
        .from('transactions')
        .select('id, amount, date, currency, reference')
        .eq('id', transactionId)
        .eq('company_id', companyId)
        .maybeSingle()

      if (!tx) {
        // transaction_id was supplied but doesn't resolve to a row in the
        // caller's company: the ranking context is invalid. Return no candidates
        // rather than silently falling back to the full unranked list, so a
        // fabricated or foreign id can never yield a broader result set.
        return NextResponse.json({ data: [] })
      }

      // The reconciliation currency is the CASH ACCOUNT's, never the
      // transaction's. Reading it off `tx` made tryReconcileTransaction's
      // `transaction.currency !== expectedCurrency` guard compare the
      // transaction against itself: a tautology that passed for every row, so
      // the guard never rejected anything and a foreign bank line was ranked
      // against this account's (SEK) vouchers.
      const txCurrency = (tx.currency as string | null) ?? 'SEK'
      if (txCurrency !== accountCurrency) {
        // A bank line in another currency cannot be settled on this account, so
        // there is no honest ranking to produce. Same posture as the unresolved
        // transaction above: no candidates beats plausible-looking wrong ones.
        return NextResponse.json({
          data: [],
          not_rankable_reason: 'transaction_currency_mismatch',
        })
      }

      // Withhold any candidate that cannot be expressed in the account's
      // currency. journal_entry_lines.debit_amount / credit_amount are ALWAYS
      // SEK; `currency` on the line labels the underlying DOCUMENT and
      // amount_in_currency carries the foreign figure (see ledgerLineAmountIn).
      // On a SEK account this filter is a no-op: ledgerLineAmountIn never
      // returns null there, so SEK-only companies see exactly the list they
      // always did. On a foreign account it currently drops EVERY candidate,
      // because get_account_gl_lines_for_matching projects neither currency nor
      // amount_in_currency (verified against prod), so no row carries a rate to
      // convert with. Ranking them anyway would offer a 1 150 SEK ledger leg as
      // the settlement for a 1 150 EUR bank line. Written per-line rather than
      // as an `accountCurrency !== 'SEK'` short-circuit so that ranking resumes
      // by itself the day the RPC projects those two columns.
      const rankable = lines.filter((line) => ledgerLineAmountIn(line, accountCurrency) !== null)

      const txDate = tx.date as string
      const ranked = rankable
        .map((line) => {
          // Score each line in isolation; confidence 0 means "no auto-match
          // rule fired": the line still appears so the user can pick it
          // manually (e.g. a salary or Fortnox voucher with a tweaked date).
          const match = tryReconcileTransaction(tx as unknown as Transaction, [line], accountCurrency)
          return { ...line, confidence: match?.confidence ?? 0 }
        })
        .sort((a, b) => {
          if (b.confidence !== a.confidence) return b.confidence - a.confidence
          const da = Math.abs(new Date(a.entry_date).getTime() - new Date(txDate).getTime())
          const db = Math.abs(new Date(b.entry_date).getTime() - new Date(txDate).getTime())
          return da - db
        })

      // Say so when candidates were withheld, instead of letting an empty list
      // read as "this account has no unmatched verifikationer in the period".
      if (rankable.length !== lines.length) {
        return NextResponse.json({
          data: ranked,
          not_rankable_reason: 'gl_lines_missing_currency_amount',
        })
      }
      return NextResponse.json({ data: ranked })
    }

    return NextResponse.json({ data: lines })
  },
)
