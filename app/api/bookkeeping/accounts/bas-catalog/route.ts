import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-reference'

/**
 * GET /api/bookkeeping/accounts/bas-catalog
 *
 * The full BAS 2026 catalogue (~1,276 accounts), projected to the fields the
 * AccountCombobox needs to search and render. This lets the manual bookkeeping
 * flow surface accounts by name even when they aren't in the company's chart
 * yet: selecting one routes through the existing activate-on-commit rail
 * (ACCOUNTS_NOT_IN_CHART → ActivateAccountsDialog → /accounts/activate).
 *
 * The payload is static reference data for the deploy and identical for every
 * company, so it's cached hard on the client. Wrapped in withRouteContext so it
 * stays behind auth (MFA on hosted) like every other bookkeeping route.
 */
export const GET = withRouteContext('bookkeeping.accounts.bas_catalog', async () => {
  const data = BAS_REFERENCE.map((a) => ({
    account_number: a.account_number,
    account_name: a.account_name,
    account_class: a.account_class,
    account_group: a.account_group,
    description: a.description,
  }))

  return NextResponse.json(
    { data },
    { headers: { 'Cache-Control': 'private, max-age=86400' } },
  )
})
