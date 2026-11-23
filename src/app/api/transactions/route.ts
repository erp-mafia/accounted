import { NextResponse } from 'next/server'
import { scopeTransactionsToAccount } from '@/lib/reconciliation/bank-reconciliation'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateTransactionSchema } from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { transactionTextSearchFilter } from '@/lib/transactions/text-search'
import { resolveDefaultCashAccount } from '@/lib/cash-accounts/service'
import { isSaneDateString } from '@/lib/invariants'
import { isUuid } from '@/lib/invariants/uuid'

const MAX_ROWS = 500
const LIST_COLUMNS =
  'id, date, description, merchant_name, amount, currency, amount_sek, exchange_rate, reference, journal_entry_id, reconciliation_method, is_ignored, cash_account_id, document_id'

// withRouteContext enforces auth (MFA on hosted) and resolves companyId; the
// previous hand-rolled session lookup in this handler skipped the MFA gate.
export const GET = withRouteContext('transaction.list', async (request, { supabase, companyId }) => {
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
  // Free text over description and merchant: the bank-row pickers search here
  // across every row instead of filtering a capped list in the browser.
  const textFilter = transactionTextSearchFilter(searchParams.get('q') ?? '')
  // account_number selects which cash account to scope to. We resolve it to a
  // cash_accounts.id (ledger_account is unique per company) and scope
  // transactions by that id, falling back to currency for legacy rows whose
  // cash_account_id hasn't been backfilled yet. This is what stops two
  // same-currency accounts from showing each other's transactions.
  const accountNumberParam = searchParams.get('account_number') || undefined
  // The page after one that had more: the `next` of the answer before, the
  // date and id of its last row. Both are interpolated into the .or() filter
  // below, so each must be exactly a date and a uuid.
  const afterDate = searchParams.get('after_date')
  const afterId = searchParams.get('after_id')
  if ((afterDate !== null || afterId !== null) && !(afterDate && isSaneDateString(afterDate) && isUuid(afterId))) {
    return NextResponse.json({ error: 'Ogiltig fortsättning: after_date (ÅÅÅÅ-MM-DD) och after_id anges tillsammans' }, { status: 400 })
  }

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

  // The open rows are open_bank_rows, ignored and private ones left out. Every
  // other mode reads the table, with the junction so a caller can tell a row
  // split over several verifikat (journal_entry_id NULL, #1553) from an unbooked
  // one with lib/transactions/is-booked.ts getLinkedJournalEntryIds (crm#48).
  const openRows = unmatched && !onlyIgnored
  let query = supabase
    .from(openRows ? 'open_bank_rows' : 'transactions')
    .select(openRows ? LIST_COLUMNS : `${LIST_COLUMNS}, transaction_voucher_links(journal_entry_id, role)`)
    .eq('company_id', companyId)

  // unmatched and reconciled are mutually exclusive: unmatched wins if both set
  if (!unmatched && reconciled) query = query.eq('is_booked', true)
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
  if (textFilter) query = query.or(textFilter)
  // Keyset, not offset: a row booked between two pages moves no other row
  // past the caller.
  if (afterDate && afterId) query = query.or(`date.lt.${afterDate},and(date.eq.${afterDate},id.gt.${afterId})`)

  // Newest first, then id, so the order is total and a page continues exactly
  // where the one before ended. Fetch one extra row so we can tell the caller
  // whether the result was truncated.
  query = query.order('date', { ascending: false }).order('id', { ascending: true }).limit(MAX_ROWS + 1)

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
  }

  const rows = data || []
  const hasMore = rows.length > MAX_ROWS
  const truncated = hasMore ? rows.slice(0, MAX_ROWS) : rows
  // Where the next page starts, sent back as after_date and after_id. The
  // select is chosen at run time, so the client cannot type the rows.
  const last = truncated[truncated.length - 1] as unknown as { date: string; id: string } | undefined
  const next = hasMore && last ? { after_date: last.date, after_id: last.id } : null

  return NextResponse.json({ data: truncated, has_more: hasMore, limit: MAX_ROWS, next })
})

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

    // The form names no bank account: the row takes the company's default
    // account in its currency, the rule the MCP and v1 ingest doors use
    // (crm#1171). Stored unbound it dropped out of every per-account view.
    const cashAccountId = (await resolveDefaultCashAccount(supabase, companyId, currency))?.id ?? null

    const { data: transaction, error } = await supabase
      .from('transactions')
      .insert({
        company_id: companyId,
        user_id: user.id,
        cash_account_id: cashAccountId,
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
        { error: getUserErrorMessage(error), code: error.code, type: 'database_error' },
        { status: 400 },
      )
    }

    return NextResponse.json({ data: transaction }, { status: 201 })
  },
  { requireWrite: true },
)
