/**
 * /api/transactions/previous-system (crm#1954)
 *
 * Bank rows dated on or before the last day the company's SIE import covers,
 * which the previous system already booked: a row it booked split (one
 * payment for several invoices, a card settlement, bank fees) has no single
 * imported bank line for the relink to pair it with, so it stays among the
 * rows to book. The rule and the selection live in
 * lib/transactions/previous-system-rows.ts.
 *
 * GET answers how many there are, for the attention line on Transaktioner.
 * POST marks them with the ignore flag, given the cut-off the person saw: a
 * cut-off that has moved since (an import undone or replaced) writes nothing
 * and answers 409.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isoDateSchema } from '@/lib/invariants/zod'
import { findPreviousSystemRows, markPreviousSystemRows } from '@/lib/transactions/previous-system-rows'

const MarkPreviousSystemRowsSchema = z.object({
  /** The cut-off the attention line named: the day the person confirmed. */
  cutoff: isoDateSchema,
})

export const GET = withRouteContext('transaction.previous_system_rows', async (_request, { supabase, companyId }) => {
  const found = await findPreviousSystemRows(supabase, companyId)
  return NextResponse.json({
    data: {
      cutoff: found.cutoff,
      count: found.ids.length,
      first_date: found.first_date,
      last_date: found.last_date,
    },
  })
})

export const POST = withRouteContext(
  'transaction.previous_system_rows_mark',
  async (request, { supabase, companyId, log, requestId }) => {
    const validation = await validateBody(request, MarkPreviousSystemRowsSchema)
    if (!validation.success) return validation.response

    const outcome = await markPreviousSystemRows(supabase, companyId, validation.data.cutoff)
    if (!outcome.ok) {
      return errorResponseFromCode('CONFLICT', log, {
        requestId,
        details: { reason: outcome.reason, cutoff: outcome.cutoff },
        ...(outcome.reason === 'no_import'
          ? {
              messageSv: 'Det finns ingen slutförd SIE-import längre. Ladda om sidan.',
              messageEn: 'There is no completed SIE import any more. Reload the page.',
            }
          : {
              messageSv: 'Importen har ändrats sedan sidan laddades. Ladda om sidan och försök igen.',
              messageEn: 'The import has changed since the page loaded. Reload the page and try again.',
            }),
      })
    }

    log.info('bank rows marked as booked in the previous system', {
      cutoff: outcome.cutoff,
      count: outcome.transaction_ids.length,
    })
    return NextResponse.json({
      data: { cutoff: outcome.cutoff, transaction_ids: outcome.transaction_ids },
    })
  },
  { requireWrite: true },
)
