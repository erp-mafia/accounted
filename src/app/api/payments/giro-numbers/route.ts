import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { companyGiroNumbersToOutput } from '@/lib/operations/bankgiro-lookup'
import { lookupCompanyGiroNumbers } from '@/lib/payments/bankgiro-lookup'

/**
 * GET /api/payments/giro-numbers: the giro numbers Bankgirot has registered
 * to the company's own organisationsnummer, for the invoice payee settings.
 * The same answer as the v1 door (payments.company-giro-numbers); switched
 * off (OPENPAYMENTS_BANKGIRO_LOOKUP), `enabled` is false and nothing is asked.
 */
export const GET = withRouteContext('payments.giro-numbers', async (_request, { supabase, companyId, user, log }) => {
  const lookup = await lookupCompanyGiroNumbers({ supabase, companyId, userId: user.id, log })
  return NextResponse.json({ data: companyGiroNumbersToOutput(lookup) })
})
