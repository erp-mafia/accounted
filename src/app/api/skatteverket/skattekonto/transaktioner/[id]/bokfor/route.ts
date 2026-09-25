import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import {
  bokforSkattekontoTransaction,
  SkattekontoBookingError,
} from '@/lib/skatteverket/skattekonto-booking'
import { getErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

/** The refusals the booking raises, and what each one is in HTTP. */
const STATUS_BY_CODE: Record<string, number> = {
  TRANSACTION_NOT_FOUND: 404,
  ALREADY_BOOKED: 409,
  ROW_IGNORED: 409,
  PERIOD_LOCKED: 423,
  NO_COUNTER_ACCOUNT: 422,
}

/**
 * Book one skattekonto row into a journal entry, from the core.
 *
 * Core for the same reason as the read route beside it: a file import fills
 * skattekonto_transactions with no Skatteverket connection, and the booking
 * reads only core things (the rule table, the chart, the fiscal periods) and
 * writes through the bookkeeping engine. The extension dispatcher refuses
 * every route of a flagged-off extension, so this one answered 503 on an
 * installation without the integration: the page listed a company's own rows
 * and then refused to book them.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'skattekonto.transactions.book',
  async (request, { supabase, companyId, user }, { params }) => {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) {
      return NextResponse.json({ error: 'Saknar giltigt transaktions-id.' }, { status: 400 })
    }

    try {
      const entry = await bokforSkattekontoTransaction(supabase, companyId, user.id, id)
      return NextResponse.json({ data: { entry } })
    } catch (err) {
      // The booking's own refusals carry a code and a status the dialog acts
      // on, so they are answered here rather than thrown; the text still goes
      // through getErrorMessage, which passes a Swedish user message and
      // replaces anything that reads like a leak. Everything else is thrown
      // on for the wrapper to map.
      if (err instanceof SkattekontoBookingError) {
        return NextResponse.json(
          { error: getErrorMessage(err), code: err.code },
          { status: STATUS_BY_CODE[err.code] ?? 400 },
        )
      }
      throw err
    }
  },
  { requireWrite: true },
)
