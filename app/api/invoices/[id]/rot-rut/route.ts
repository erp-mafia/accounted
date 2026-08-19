import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { maskedDeductionPersonnummer } from '@/lib/invoices/deduction-personnummer'

/**
 * GET /api/invoices/[id]/rot-rut
 *
 * The display form of the invoice's ROT/RUT personnummer, `YYYYMMDD-XXXX`.
 * The browser holds the invoice row (via RLS) but only as ciphertext plus the
 * last four digits, and it must never hold the ciphertext AND a mask that
 * would complete the number. So the mask is computed here, server-side, from
 * the ciphertext, and the last four digits are not returned. Null when the
 * invoice carries no personnummer or the stored value cannot be decrypted.
 *
 * Read-only, company members only (withRouteContext + the company_id filter).
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.rot_rut.read',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'id', message: 'Invoice id must be a UUID.' },
      })
    }

    const { data: invoice, error } = await supabase
      .from('invoices')
      .select('id, deduction_personnummer_encrypted')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (error) {
      log.error('failed to load invoice for rot-rut read', error, { invoiceId: id })
      throw error
    }
    if (!invoice) {
      return errorResponseFromCode('INVOICE_NOT_FOUND', log, { requestId })
    }

    return NextResponse.json(
      {
        data: {
          deduction_personnummer_masked: maskedDeductionPersonnummer(
            invoice as { deduction_personnummer_encrypted?: string | null },
          ),
        },
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
)
