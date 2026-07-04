import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { scopeTransactionsToAccount } from '@/lib/reconciliation/bank-reconciliation'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateTransactionSchema } from '@/lib/api/schemas'

const MAX_ROWS = 500

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const unmatched = searchParams.get('unmatched') === 'true'
  const reconciled = searchParams.get('reconciled') === 'true'
  const currency = searchParams.get('currency') || undefined
  // currency is interpolated into the PostgREST .or() filter below, so reject
  // anything that isn't a 3-letter ISO code. RLS still scopes results to the
  // company, but an unsanitized value could otherwise malform or widen the
  // filter (PostgREST filter injection).
  if (currency && !/^[A-Z]{3}$/.test(currency)) {
    return NextResponse.json({ error: 'Ogiltig valutakod' }, { status: 400 })
  }
  const dateFrom = searchParams.get('date_from') || undefined
  const dateTo = searchParams.get('date_to') || undefined
  // When set, return only ignored rows: used by the reconciliation view to
  // surface a "Visa ignorerade" undo list. The default (no param) behaviour
  // continues to exclude ignored rows from unmatched results.
  const onlyIgnored = searchParams.get('only_ignored') === 'true'
  // account_number selects which cash account to scope to. We resolve it to a
  // cash_accounts.id (ledger_account is unique per company) and scope
  // transactions by that id, falling back to currency for legacy rows whose
  // cash_account_id hasn't been backfilled yet. This is what stops two
  // same-currency accounts from showing each other's transactions.
  const accountNumberParam = searchParams.get('account_number') || undefined

  let derivedCurrency = currency
  let cashAccountId: string | undefined
  // Only the primary account claims unassigned (NULL cash_account_id) rows, so
  // a secondary same-currency account's lists match its status card instead of
  // pooling the primary's unassigned rows. See scopeTransactionsToAccount.
  let includeUnassigned = true
  if (accountNumberParam) {
    const { data: cashAccount } = await supabase
      .from('cash_accounts')
      .select('id, currency, is_primary')
      .eq('company_id', companyId)
      .eq('ledger_account', accountNumberParam)
      .maybeSingle()
    if (cashAccount) {
      cashAccountId = cashAccount.id as string
      includeUnassigned = Boolean(cashAccount.is_primary)
      if (!derivedCurrency && cashAccount.currency) derivedCurrency = cashAccount.currency as string
    }
  }

  let query = supabase
    .from('transactions')
    .select('id, date, description, amount, currency, amount_sek, exchange_rate, reference, journal_entry_id, reconciliation_method, is_ignored, cash_account_id')
    .eq('company_id', companyId)

  // unmatched and reconciled are mutually exclusive: unmatched wins if both set
  if (unmatched) {
    query = query.is('journal_entry_id', null)
    // Hide rows the user has explicitly suppressed from the reconciliation
    // view. Other callers (e.g. BookDirectlyDialog) also benefit: once
    // ignored, the row stops surfacing in the "to book" funnel everywhere.
    if (!onlyIgnored) query = query.eq('is_ignored', false)
  } else if (reconciled) {
    query = query.not('journal_entry_id', 'is', null)
  }

  if (onlyIgnored) query = query.eq('is_ignored', true)

  // Scope to the selected cash account. With a resolved id, match that account
  // OR legacy NULL rows of the same currency (so nothing disappears mid-
  // backfill). With only a currency (no account), filter by currency. With
  // neither (e.g. the company-wide only_ignored recovery list), no scope.
  // Shares one implementation with the reconciliation lib so the filter shape
  // can't drift between the status card and these lists.
  if (cashAccountId || derivedCurrency) {
    query = scopeTransactionsToAccount(query, cashAccountId, derivedCurrency ?? 'SEK', includeUnassigned)
  }
  if (dateFrom) query = query.gte('date', dateFrom)
  if (dateTo) query = query.lte('date', dateTo)

  // Fetch one extra row so we can tell the caller whether the result was truncated.
  query = query.order('date', { ascending: false }).limit(MAX_ROWS + 1)

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = data || []
  const hasMore = rows.length > MAX_ROWS
  const truncated = hasMore ? rows.slice(0, MAX_ROWS) : rows

  return NextResponse.json({ data: truncated, has_more: hasMore, limit: MAX_ROWS })
}

// Manual bank-transaction creation. This is the server-side boundary the form
// now goes through (it used to insert straight into Supabase from the browser).
// withRouteContext enforces auth/MFA + resolves companyId; validateBody runs
// the shared CreateTransactionSchema so the date rule etc. are validated
// server-side, not just client-side.
export const POST = withRouteContext(
  'transaction.create',
  async (request, { supabase, companyId, user, log }) => {
    // Pass the request-scoped logger so a rejected payload (e.g. a malformed
    // date) is recorded server-side: that's where anomaly detection belongs,
    // not in the render-path formatter.
    const validation = await validateBody(request, CreateTransactionSchema, {
      log,
      operation: 'transaction.create',
    })
    if (!validation.success) return validation.response
    const { date, description, amount, currency, category, notes } = validation.data

    const { data: transaction, error } = await supabase
      .from('transactions')
      .insert({
        company_id: companyId,
        user_id: user.id,
        date,
        description,
        amount,
        currency,
        category: category ?? 'uncategorized',
        is_business: null,
        notes: notes ?? '',
      })
      .select()
      .single()

    if (error) {
      // A DB-level rejection here (e.g. the transactions_date_sane_range CHECK)
      // is invalid input, not a server fault: surface it as 400 with the PG
      // code so the client maps it to a friendly message.
      return NextResponse.json(
        { error: error.message, code: error.code, type: 'database_error' },
        { status: 400 },
      )
    }

    return NextResponse.json({ data: transaction }, { status: 201 })
  },
  { requireWrite: true },
)
