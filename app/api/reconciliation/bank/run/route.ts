import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import {
  runReconciliation,
  DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD,
} from '@/lib/reconciliation/bank-reconciliation'
import { runUnattendedReconciliationSweep } from '@/lib/reconciliation/unattended-sweep'
import { validateBody } from '@/lib/api/validate'
import { RunReconciliationSchema } from '@/lib/api/schemas'

ensureInitialized()

export const POST = withRouteContext(
  'reconciliation.bank.run',
  async (request, { supabase, user, companyId }) => {
    const validation = await validateBody(request, RunReconciliationSchema)
    if (!validation.success) return validation.response
    const {
      date_from,
      date_to,
      account_number,
      dry_run,
      selected_matches,
      confidence_threshold,
      all_accounts,
    } = validation.data

    // "Kör matchning igen": the per-account sweep across every enabled cash
    // account, exactly what the unattended post-sync path runs. New >= 0.9
    // matches auto-link; the 0.75-0.89 band persists as suggestions.
    //
    // The sweep ALWAYS writes at its own fixed floor: there is no dry-run form
    // of it, and silently ignoring dry_run (or a client-sent floor) here would
    // turn a requested preview into applied links (the documented
    // dry-run-gotcha P0 class). Enforce the mutual exclusion instead of just
    // documenting it.
    if (
      all_accounts &&
      (dry_run !== undefined ||
        account_number ||
        selected_matches ||
        confidence_threshold !== undefined)
    ) {
      return NextResponse.json(
        {
          error:
            'all_accounts kan inte kombineras med dry_run, account_number, selected_matches eller confidence_threshold',
        },
        { status: 400 },
      )
    }
    if (all_accounts) {
      const sweep = await runUnattendedReconciliationSweep(supabase, companyId, user.id, {
        dateFrom: date_from,
        dateTo: date_to,
      })
      return NextResponse.json({
        data: {
          applied: sweep.applied,
          errors: sweep.errors,
          suggested: sweep.suggested,
          unmatched: sweep.unmatched,
          skipped_below_threshold: sweep.skippedBelowThreshold,
          accounts: sweep.accounts.map((a) => ({
            account_number: a.accountNumber,
            applied: a.applied,
            suggested: a.suggested,
          })),
        },
      })
    }

    const accountNumber = account_number ?? '1930'

    // Defense-in-depth: reject a non-default account the company hasn't
    // registered as a cash account. The default '1930' is exempt: when no
    // cash_accounts row exists it falls back to currency-only scoping
    // (cashAccountId undefined), so a company reconciling its primary SEK account
    // without a row behaves exactly as before this feature. Matches the status
    // endpoint, which is likewise lenient for '1930'.
    const { data: cashAccount } = await supabase
      .from('cash_accounts')
      .select('id, currency, is_primary')
      .eq('company_id', companyId)
      .eq('ledger_account', accountNumber)
      .maybeSingle()

    if (!cashAccount && accountNumber !== '1930') {
      return NextResponse.json(
        { error: 'Okänt kassakonto för det här företaget' },
        { status: 400 },
      )
    }
    const currency = (cashAccount?.currency as string | undefined) ?? 'SEK'

    const result = await runReconciliation(supabase, companyId, user.id, {
      dateFrom: date_from,
      dateTo: date_to,
      accountNumber,
      currency,
      cashAccountId: cashAccount?.id as string | undefined,
      // Only the primary account claims unassigned (NULL cash_account_id) rows:
      // a secondary same-currency account must scope strictly to its own id.
      includeUnassigned: Boolean(cashAccount?.is_primary),
      dryRun: dry_run ?? false,
      applyOnly: selected_matches?.map((m) => ({
        transactionId: m.transaction_id,
        journalEntryId: m.journal_entry_id,
      })),
      // Server-side floor on the apply path. A client-sent confidence_threshold
      // always wins (mirrors the v1 route: pairs the fresh re-run scores below
      // it are skipped, not applied). Without one: a no-selection apply run is
      // effectively unattended, so it floors at 0.9 and persists the 0.75-0.89
      // band as reviewable suggestions instead of auto-committing fuzzy
      // matches; applyOnly runs keep the legacy no-floor behavior (the user
      // already reviewed the pairs in the dry-run preview). Ignored on dry runs.
      confidenceThreshold:
        confidence_threshold ??
        (selected_matches ? undefined : DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD),
      ...(selected_matches ? {} : { persistSuggestions: true }),
    })

    return NextResponse.json({
      data: {
        matches: result.matches.map((m) => ({
          transaction_id: m.transaction.id,
          transaction_date: m.transaction.date,
          transaction_description: m.transaction.description,
          transaction_amount: m.transaction.amount,
          journal_entry_id: m.glLine.journal_entry_id,
          voucher_number: m.glLine.voucher_number,
          voucher_series: m.glLine.voucher_series,
          entry_date: m.glLine.entry_date,
          entry_description: m.glLine.entry_description,
          method: m.method,
          confidence: m.confidence,
        })),
        applied: result.applied,
        errors: result.errors,
        suggested: result.suggested,
        skipped_below_threshold: result.skippedBelowThreshold,
        dry_run: dry_run ?? false,
      },
    })
  },
  { requireWrite: true },
)
