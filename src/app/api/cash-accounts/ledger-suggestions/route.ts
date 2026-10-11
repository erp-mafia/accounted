import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { LedgerSuggestionsQuerySchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { loadLedgerSuggestions } from '@/lib/cash-accounts/ledger-suggestions'

/**
 * GET /api/cash-accounts/ledger-suggestions
 *
 * Which 19xx ledger account the books say a connected bank account belongs
 * on, when that is another one than it books on now (crm#1066): the rows
 * behind the notice on Transaktioner and on the bank settings, and the bank
 * picker's preselection. An empty list is the normal answer.
 *
 * Read only. Each suggestion carries `selection`, the bank picker's own save
 * request that would make the change; the client sends it to PATCH /accounts
 * of the bank extension, so the picker's save stays the one writer of a bank
 * account's ledger account.
 *
 * Query params:
 *   - connection_id: only suggestions involving that bank connection's
 *     accounts. 404 when the company has no such connection.
 */
export const GET = withRouteContext(
  'cash_accounts.ledger_suggestions',
  async (request, { supabase, companyId, log, requestId }) => {
    const query = validateQuery(request, LedgerSuggestionsQuerySchema)
    if (!query.success) return query.response

    const result = await loadLedgerSuggestions(supabase, companyId, {
      connectionId: query.data.connection_id,
    })
    if (!result.connectionFound) return errorResponseFromCode('NOT_FOUND', log, { requestId })
    return NextResponse.json({ data: { suggestions: result.suggestions } })
  },
)
