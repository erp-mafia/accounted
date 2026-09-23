import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { reconcileStatements } from '@/lib/reports/statement-reconciliation'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * Årets resultat from every surface, side by side, with any disagreement named.
 *
 * Exists so the product does the reconciliation a customer used to do for us by
 * comparing the årsredovisning against INK2 by hand.
 */
export const GET = withRouteContext(
  'report.statement_reconciliation',
  async (request, { supabase, companyId }) => {
    const { searchParams } = new URL(request.url)
    const periodId = searchParams.get('period_id')

    if (!periodId) {
      return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
    }

    try {
      const result = await reconcileStatements(supabase, companyId!, periodId)
      return NextResponse.json(result)
    } catch (err) {
      // Match on the thrown message, not the localised one: getErrorMessage maps
      // to Swedish, so testing the output for 'not found' never matches.
      const isMissingPeriod = err instanceof Error && err.message === 'Fiscal period not found'
      return NextResponse.json(
        { error: getUserErrorMessage(err, { context: 'journal_entry' }) },
        { status: isMissingPeriod ? 404 : 500 },
      )
    }
  },
)
