import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import {
  buildSalaryPaymentFile,
  type SalaryPaymentFileError,
} from '@/lib/salary/payment/build-payment-file'
import { fileResponse } from '@/lib/api/file-response'
import { SALARY_IN_BANK_PAYMENT_FILE_SV } from '@/lib/salary/payment/in-bank-payment'
import { CORRECTION_NOTHING_TO_PAY_SV } from '@/lib/salary/payment/payable'
import { validateBody } from '@/lib/api/validate'
import { NewSalaryPaymentFileVersionSchema } from '@/lib/api/schemas'

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
    case 'BIC_MISSING':
      // Names the paying account (the one the salary is booked on) and where
      // its IBAN or BIC is entered.
      return NextResponse.json({ error: result.details.message as string }, { status: 400 })
    case 'SWEDBANK_IDS_MISSING':
      return NextResponse.json({ error: result.details.message as string }, { status: 400 })
    case 'IN_BANK_PAYMENT':
      return NextResponse.json({ error: SALARY_IN_BANK_PAYMENT_FILE_SV }, { status: 409 })
    case 'NOTHING_TO_PAY':
      return NextResponse.json({ error: CORRECTION_NOTHING_TO_PAY_SV }, { status: 400 })
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
    case 'NEW_VERSION_UNCONFIRMED':
      return NextResponse.json(
        { error: 'Bekräfta att den tidigare betalfilen inte har godkänts i banken innan du skapar en ny version.' },
        { status: 400 },
      )
    case 'NEW_VERSION_UNSUPPORTED':
      return NextResponse.json(
        { error: 'Bara en ISO 20022-fil (pain.001) kan få en ny version.' },
        { status: 400 },
      )
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
      if (stage === 'account') {
        return NextResponse.json(
          { error: 'Kunde inte läsa bankkontot som betalfilen betalar från. Försök igen.' },
          { status: 500 },
        )
      }
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

    return fileResponse(result.content, { filename: result.filename, contentType: 'application/xml; charset=utf-8' })
  },
  { requireWrite: true },
)

/**
 * POST: a new version of the run's pain.001 (crm#1219), with new message and
 * transaction ids so the bank takes it although an earlier file for the run
 * reached it. The body must carry the person's confirmation that the earlier
 * file was not approved at the bank; the builder and the archive trigger
 * refuse a new version without it. Every later GET returns this version.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.payment.pain001.new_version',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, user } = ctx

    const validation = await validateBody(request, NewSalaryPaymentFileVersionSchema)
    if (!validation.success) return validation.response

    const result = await buildSalaryPaymentFile(supabase, {
      companyId,
      runId: id,
      userId: user.id,
      format: 'pain001',
      newVersion: true,
      confirmPreviousNotApproved: validation.data.confirm_previous_not_approved,
    })
    if (!result.ok) return legacyError(result)

    return fileResponse(result.content, { filename: result.filename, contentType: 'application/xml; charset=utf-8' })
  },
  { requireWrite: true },
)
