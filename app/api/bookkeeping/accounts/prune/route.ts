import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { PruneAccountsSchema } from '@/lib/api/schemas'
import { isStandardBASAccount } from '@/lib/bookkeeping/bas-reference'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

// POST /api/bookkeeping/accounts/prune — bulk cleanup of unused accounts
// ("Rensa oanvända konton"), for charts bloated by an import from an old
// system.
//
// Two phases:
//   { dry_run: true }
//     → returns the deletable set (non-system accounts with zero journal
//       usage) plus the used remainder, without changing anything.
//   { dry_run: false, account_numbers: [...] }
//     → deletes the requested accounts, re-verifying every guard server-side.
//       The client list is a selection from the preview, not an authority:
//       anything failing re-check at execute time is skipped and reported,
//       never deleted and never an error.
//
// A used account can never be deleted through this path — its verifikat are
// immutable under BFL and their lines must keep resolving to an account.
// Deactivation (PUT is_active=false on the single-account route) remains the
// only way to hide those. Draft usage also blocks deletion: a draft line
// still references the account. Opening balances need no separate check —
// IB is booked as a verifikat (source_type 'opening_balance'), so the journal
// usage count covers it. (The account_balances cache table was dropped in
// migration 20240101000027.)
//
// Like the sibling single-account DELETE, there is a small window between
// the usage re-check and the delete where a concurrent posting could slip
// in; journal_entry_lines reference accounts by number (account_id is ON
// DELETE SET NULL), so the entry itself is never damaged — the account row
// would just need re-adding from the BAS catalog.
//
// Response shapes are legacy `{ data }` / `{ error: string }` — consumed by
// the kontoplan UI alongside the sibling account routes.

interface ChartAccountRow {
  account_number: string
  account_name: string
  account_class: number
  plan_type: string | null
  is_active: boolean
  is_system_account: boolean
}

const DELETE_CHUNK_SIZE = 200

export const POST = withRouteContext(
  'bookkeeping.accounts.prune',
  async (request, ctx) => {
    const { supabase, companyId, log } = ctx

    const validation = await validateBody(request, PruneAccountsSchema, {
      log,
      operation: 'bookkeeping.accounts.prune',
    })
    if (!validation.success) return validation.response
    const { dry_run, account_numbers } = validation.data

    try {
      // A full imported chart can exceed PostgREST's 1000-row page — paginate.
      const accounts = (await fetchAllRows(({ from, to }) =>
        supabase
          .from('chart_of_accounts')
          .select(
            'account_number, account_name, account_class, plan_type, is_active, is_system_account',
          )
          .eq('company_id', companyId)
          .order('account_number')
          .range(from, to),
      )) as ChartAccountRow[]

      const { data: usage, error: usageError } = await supabase.rpc(
        'get_account_usage_counts',
        { p_company_id: companyId },
      )
      if (usageError) {
        return NextResponse.json({ error: usageError.message }, { status: 500 })
      }

      const usageByAccount = new Map<string, number>(
        (usage ?? []).map((u: { account_number: string; usage_count: number }) => [
          u.account_number,
          Number(u.usage_count),
        ]),
      )

      const isDeletable = (a: ChartAccountRow) =>
        !a.is_system_account && !usageByAccount.has(a.account_number)

      if (dry_run) {
        const deletable = accounts.filter(isDeletable).map((a) => ({
          account_number: a.account_number,
          account_name: a.account_name,
          account_class: a.account_class,
          plan_type: a.plan_type,
          is_active: a.is_active,
          in_bas_reference: isStandardBASAccount(a.account_number),
        }))
        const used = accounts
          .filter((a) => !isDeletable(a))
          .map((a) => ({
            account_number: a.account_number,
            account_name: a.account_name,
            is_system_account: a.is_system_account,
            usage_count: usageByAccount.get(a.account_number) ?? 0,
          }))
        return NextResponse.json({ data: { deletable, used } })
      }

      // Execute: intersect the requested selection with the freshly computed
      // deletable set — guards are re-verified here, not trusted from the
      // preview the client saw.
      const requested = [...new Set(account_numbers ?? [])]
      const deletableSet = new Set(accounts.filter(isDeletable).map((a) => a.account_number))
      const existingSet = new Set(accounts.map((a) => a.account_number))

      const toDelete = requested.filter((n) => deletableSet.has(n))
      const skipped = requested.filter((n) => existingSet.has(n) && !deletableSet.has(n))
      const notFound = requested.filter((n) => !existingSet.has(n))

      for (let i = 0; i < toDelete.length; i += DELETE_CHUNK_SIZE) {
        const chunk = toDelete.slice(i, i + DELETE_CHUNK_SIZE)
        const { error: deleteError } = await supabase
          .from('chart_of_accounts')
          .delete()
          .eq('company_id', companyId)
          .eq('is_system_account', false)
          .in('account_number', chunk)
        if (deleteError) {
          // Report what was already deleted so the UI can refresh honestly.
          return NextResponse.json(
            {
              error: deleteError.message,
              data: { deleted: toDelete.slice(0, i), skipped, not_found: notFound },
            },
            { status: 500 },
          )
        }
      }

      log.info('unused accounts pruned', {
        deleted: toDelete.length,
        skipped: skipped.length,
        notFound: notFound.length,
      })

      return NextResponse.json({
        data: { deleted: toDelete, skipped, not_found: notFound },
      })
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Failed to prune accounts' },
        { status: 500 },
      )
    }
  },
  { requireWrite: true },
)
