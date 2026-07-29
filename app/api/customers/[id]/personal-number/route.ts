/**
 * GET /api/customers/{id}/personal-number
 *
 * The deliberate drill-in behind the mask: returns the full personnummer for
 * one individual customer.
 *
 * Every other customer read surface (list, detail, export) returns
 * '********-1234'. Without this endpoint the value was write-only by
 * construction: a user could store a personnummer and then never verify what
 * had actually been stored, which is the failure this exists to close. It
 * mirrors the employee convention, where the list masks and the master GET
 * returns all 12 digits (app/api/v1/companies/[companyId]/employees/[id]).
 *
 * Gated on the write role even though it only reads. .compliance/ropa.yaml
 * listed `no_full_value_read_endpoint` among the safeguards for
 * customers.personal_number; this endpoint retires that measure, so it keeps
 * the exposure as narrow as the purpose allows. The person who needs to verify
 * a stored personnummer is the one who typed it and can correct it, which is
 * exactly the non-viewer role. A viewer (typically an external consultant with
 * read-only access) keeps seeing the mask.
 *
 * The read is logged with the actor, never with the value, so a reveal is
 * attributable. audit_log is written by DB triggers only, so this is a
 * structured application log rather than an audit row.
 */

import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { revealStoredCustomerPersonalNumber } from '@/lib/customers/protect-personal-number'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

export const GET = withRouteContext(
  'customer.personal_number.reveal',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const opLog = log.child({ customerId: id })

    const { data, error } = await supabase
      .from('customers')
      .select('id, personal_number')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return errorResponseFromCode('CUSTOMER_NOT_FOUND', opLog, { requestId })
      }
      opLog.error('customer fetch before personal number reveal failed', error)
      return errorResponseFromCode('INTERNAL_ERROR', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(error) },
      })
    }

    if (!data.personal_number) {
      return errorResponseFromCode('CUSTOMER_NO_PERSONAL_NUMBER', opLog, { requestId })
    }

    let personalNumber: string | null
    try {
      personalNumber = revealStoredCustomerPersonalNumber(data.personal_number)
    } catch (err) {
      // Same row state the mask renders as '********-????'. Answer with the
      // specific code so the UI can tell the user to retype it, rather than
      // with a 500 that reads as "try again later".
      opLog.error('customer personal_number decrypt failed on reveal', {
        reason: err instanceof Error ? err.message : String(err),
      })
      return errorResponseFromCode('CUSTOMER_PERSONAL_NUMBER_UNREADABLE', opLog, { requestId })
    }

    // Attributable without being a leak: who revealed which customer, never
    // the number itself.
    opLog.info('customer personal number revealed', { userId: user.id })

    return NextResponse.json({ data: { personal_number: personalNumber } })
  },
  { requireWrite: true },
)
