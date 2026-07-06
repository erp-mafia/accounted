import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

// GET /api/bookkeeping/accounts/usage — per-account posting counts for the
// active company, from the get_account_usage_counts RPC. Accounts that have
// never been posted to are absent from the result; that absence is the
// "unused" signal the kontoplan UI and the prune flow key on.
//
// Response shapes are legacy `{ data }` / `{ error: string }` — consumed by
// the kontoplan UI alongside the sibling account routes.

export const GET = withRouteContext('bookkeeping.accounts.usage', async (_request, ctx) => {
  const { supabase, companyId } = ctx

  const { data, error } = await supabase.rpc('get_account_usage_counts', {
    p_company_id: companyId,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: data ?? [] })
})
