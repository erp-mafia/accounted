import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateQuery } from '@/lib/api/validate'
import { withRouteContext } from '@/lib/api/with-route-context'
import { creditorLookupInputSchema, creditorLookupToOutput } from '@/lib/operations/bankgiro-lookup'
import { bankgiroLookupEnabled, bankgiroLookupOpen, lookupCreditorName } from '@/lib/payments/bankgiro-lookup'

/**
 * GET /api/payments/creditor-lookup: the name Bankgirot has registered for a
 * bankgiro or plusgiro number, for the payment dialog and the supplier form.
 *
 * Without a `giro` it is a probe, `{ enabled }`: whether the premium lookups
 * are switched on for this company (the flag, a connector key, not a
 * sandbox), so a form knows whether to offer the check at all. The probe
 * asks the provider nothing.
 * With one, the same answer as the v1 door (payments.lookup-creditor).
 * Switched off, nothing is validated and nothing is asked.
 */
const probeSchema = z.object({ giro: z.string().optional() })

export const GET = withRouteContext('payments.creditor-lookup', async (request, { supabase, companyId, user, log }) => {
  if (!bankgiroLookupEnabled()) return NextResponse.json({ data: { enabled: false } })
  const probe = validateQuery(request, probeSchema)
  if (!probe.success) return probe.response
  if (!probe.data.giro) return NextResponse.json({ data: { enabled: await bankgiroLookupOpen({ supabase, companyId }) } })

  const params = validateQuery(request, creditorLookupInputSchema)
  if (!params.success) return params.response
  const { giro, type, ocr, invoice_ref } = params.data
  const lookup = await lookupCreditorName({ supabase, companyId, userId: user.id, log }, { giro, type, ocr: ocr ?? null, invoiceRef: invoice_ref ?? null })
  return NextResponse.json({ data: creditorLookupToOutput(lookup) })
})
