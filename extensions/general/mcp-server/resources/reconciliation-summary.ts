import type { McpResource } from './types'
import { listReconciliationAccounts } from '@/lib/reconciliation/service'
import { ISO_DATE_RE } from '@/lib/invariants'

/**
 * Accounted://reconciliation/summary
 *
 * Every account with an outside truth (bank accounts, the skattekonto) with
 * its reconciliation state, open counts and latest sign-off, in one read: the
 * rail of the Avstämning page as a resource. Optional ?date_from / ?date_to
 * scope the bank bridges (the skattekonto bridge is anchored at its saldo
 * snapshot). Same service function the page and the v1 API use, so the
 * agent sees exactly what the user sees.
 */
export const reconciliationSummaryResource: McpResource = {
  uri: 'Accounted://reconciliation/summary',
  name: 'Reconciliation Summary',
  description:
    'Per-account reconciliation state for the active company: bank accounts (bank:<cash_account_id>) and the skattekonto, each with state (reconciled / open / stale / not_configured), unexplained_difference, open counts (proposed, unmatched_external, unmatched_ledger), last outside fetch, and the latest sign-off date. Optional ?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD scope the bank bridges. Read this before gnubok_get_reconciliation_status / gnubok_list_reconciliation_items to pick the account that needs work.',
  mimeType: 'application/json',
  read: async ({ supabase, companyId, query }) => {
    const dateFrom = query?.get('date_from') ?? undefined
    const dateTo = query?.get('date_to') ?? undefined
    if ((dateFrom && !ISO_DATE_RE.test(dateFrom)) || (dateTo && !ISO_DATE_RE.test(dateTo))) {
      throw new Error('date_from / date_to must be YYYY-MM-DD')
    }
    const accounts = await listReconciliationAccounts(supabase, companyId, {
      withStatus: true,
      windowFrom: dateFrom,
      windowTo: dateTo,
    })

    const rows = accounts.map((a) => ({
      account_key: a.account_key,
      kind: a.kind,
      name: a.name,
      account_number: a.account_number,
      currency: a.currency,
      state: a.status?.state ?? 'not_configured',
      unexplained_difference: a.status?.unexplained_difference ?? null,
      open_counts: a.status?.open_counts ?? { proposed: 0, unmatched_external: 0, unmatched_ledger: 0 },
      as_of: a.status?.as_of ?? null,
      synced_at: a.source.synced_at,
      stale: a.source.stale,
      signed_off_through: a.signed_off_through ?? null,
      superseded_by: a.superseded_by,
    }))

    const live = rows.filter((r) => !r.superseded_by)
    const totals = {
      accounts: live.length,
      reconciled: live.filter((r) => r.state === 'reconciled').length,
      open: live.filter((r) => r.state === 'open' || r.state === 'stale').length,
      not_configured: live.filter((r) => r.state === 'not_configured').length,
      proposed: live.reduce((s, r) => s + r.open_counts.proposed, 0),
      unmatched_external: live.reduce((s, r) => s + r.open_counts.unmatched_external, 0),
      unmatched_ledger: live.reduce((s, r) => s + r.open_counts.unmatched_ledger, 0),
    }

    // Point at the account with the most open work; proposals first since
    // they are one staged call away from done.
    const target =
      [...live]
        .filter((r) => r.state === 'open' || r.state === 'stale')
        .sort(
          (x, y) =>
            y.open_counts.proposed - x.open_counts.proposed ||
            y.open_counts.unmatched_external +
              y.open_counts.unmatched_ledger -
              (x.open_counts.unmatched_external + x.open_counts.unmatched_ledger),
        )[0] ?? null

    return {
      generated_at: new Date().toISOString(),
      window: { from: dateFrom ?? null, to: dateTo ?? null },
      totals,
      accounts: rows,
      next: target
        ? target.open_counts.proposed > 0
          ? {
              description: `${target.name}: ${target.open_counts.proposed} föreslagna par väntar. Koppla dem, sedan bokför det som saknas.`,
              tool: 'gnubok_reconcile_match',
              args: { account_key: target.account_key, use_proposals: true, dry_run: true },
            }
          : {
              description: `${target.name}: läs raderna bakom bryggan och bokför eller koppla dem.`,
              tool: 'gnubok_list_reconciliation_items',
              args: { account_key: target.account_key },
            }
        : {
            description:
              totals.accounts === 0
                ? 'Inga konton med en sanning utanför bokföringen (koppla bank eller Skatteverket).'
                : 'Alla konton är förklarade. Signera månaden med gnubok_reconcile_signoff per konto.',
            tool: totals.accounts === 0 ? undefined : 'gnubok_reconcile_signoff',
          },
    }
  },
}
