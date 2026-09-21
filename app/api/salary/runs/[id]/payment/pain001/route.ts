import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import {
  buildSalaryPaymentFile,
  type SalaryPaymentFileError,
} from '@/lib/salary/payment/build-payment-file'

ensureInitialized()

/**
 * Generate pain.001 (ISO 20022) payment file for a salary run.
 *
 * Per BFL: The payment file is räkenskapsinformation/underlag linked to
 * the salary journal entry. Subject to 7-year retention.
 *
 * The file is uploaded to the bank's corporate portal for batch payment.
 *
 * Loading, preconditions and the payment_file_* stamp live in
 * lib/salary/payment/build-payment-file.ts (shared with the v1 endpoint);
 * this route only keeps the dashboard's legacy `{ error }` envelope and the
 * download headers.
 */
function legacyError(result: SalaryPaymentFileError): NextResponse {
  const stage = result.code === 'DB_ERROR' ? result.stage : undefined
  switch (result.code) {
    case 'RUN_NOT_FOUND':
      return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
    case 'RUN_NOT_READY':
      return NextResponse.json({ error: 'Betalfil kan bara genereras efter godkännande' }, { status: 400 })
    case 'COMPANY_NOT_FOUND':
      return NextResponse.json({ error: 'Företag hittades inte' }, { status: 404 })
    case 'SETTINGS_MISSING':
      return NextResponse.json({ error: 'Företagsinställningar saknas' }, { status: 400 })
    case 'IBAN_MISSING':
      return NextResponse.json(
        { error: 'Företagets IBAN saknas i företagsinställningar. Fyll i det under Inställningar → Fakturering för att skapa betalfil (ISO 20022).' },
        { status: 400 },
      )
    case 'BIC_MISSING':
      return NextResponse.json(
        { error: 'Företagsbankens BIC saknas och kunde inte härledas. Fyll i BIC under Inställningar → Fakturering för att skapa betalfil.' },
        { status: 400 },
      )
    case 'NO_EMPLOYEES':
      return NextResponse.json({ error: 'Inga anställda i lönekörningen' }, { status: 400 })
    case 'EMPLOYEE_BANK_MISSING':
      return NextResponse.json({
        error: `${result.details.employee_count as number} anställd(a) saknar bankkontouppgifter`,
      }, { status: 400 })
    case 'EMPLOYEE_BANK_INVALID':
      // Names every affected employee and the fix; never an account number.
      return NextResponse.json({ error: result.details.message as string }, { status: 400 })
    case 'GENERATOR_FAILED':
      return NextResponse.json({ error: result.details.message as string }, { status: 400 })
    case 'ARCHIVE_FAILED':
      // The file is räkenskapsinformation: never handed out unarchived.
      return NextResponse.json(
        { error: 'Betalfilen kunde inte arkiveras och lämnades därför inte ut. Försök igen.' },
        { status: 500 },
      )
    case 'DB_ERROR':
      // A failed read used to look like a missing row; keep that mapping.
      if (stage === 'run') return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
      if (stage === 'company') return NextResponse.json({ error: 'Företag hittades inte' }, { status: 404 })
      if (stage === 'settings') return NextResponse.json({ error: 'Företagsinställningar saknas' }, { status: 400 })
      return NextResponse.json({ error: 'Inga anställda i lönekörningen' }, { status: 400 })
    default:
      return NextResponse.json({ error: 'Betalfilen kunde inte skapas' }, { status: 400 })
  }
}

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.payment.pain001',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, user } = ctx

    const result = await buildSalaryPaymentFile(supabase, {
      companyId,
      runId: id,
      userId: user.id,
      format: 'pain001',
    })
    if (!result.ok) return legacyError(result)

    return new Response(result.content, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
      },
    })
  },
  { requireWrite: true },
)
