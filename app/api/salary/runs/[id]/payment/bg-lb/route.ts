import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import {
  buildSalaryPaymentFile,
  type SalaryPaymentFileError,
} from '@/lib/salary/payment/build-payment-file'

ensureInitialized()

/**
 * Generate Bankgirot LB-fil for a salary run.
 *
 * Used by Swedish banks (Swedbank, SEB, Handelsbanken, Nordea) for batch
 * salary payments via the corporate portal. The file is uploaded; Bankgirot
 * routes funds from the company's BG to each employee's bank account.
 *
 * Per BFL: The payment file is räkenskapsinformation linked to the salary
 * journal entry. Subject to 7-year retention.
 *
 * Loading, preconditions and the payment_file_* stamp live in
 * lib/salary/payment/build-payment-file.ts (shared with the v1 endpoint);
 * this route only keeps the dashboard's legacy `{ error }` envelope, the
 * ISO 8859-1 re-encoding and the download headers.
 */
// The settings overview shows a bankgiro from the Bolagsverket snapshot,
// which is display data only; point at the field this route reads.
const BANKGIRO_MISSING_MESSAGE =
  'Företagets bankgironummer är inte ifyllt. Fyll i det under Inställningar → Fakturering för att skapa Bankgirot LB-fil.'

function legacyError(result: SalaryPaymentFileError): NextResponse {
  const stage = result.code === 'DB_ERROR' ? result.stage : undefined
  switch (result.code) {
    case 'RUN_NOT_FOUND':
      return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
    case 'RUN_NOT_READY':
      return NextResponse.json({ error: 'Betalfil kan bara genereras efter godkännande' }, { status: 400 })
    case 'COMPANY_NOT_FOUND':
      return NextResponse.json({ error: 'Företag hittades inte' }, { status: 404 })
    case 'BANKGIRO_MISSING':
      return NextResponse.json({ error: BANKGIRO_MISSING_MESSAGE }, { status: 400 })
    case 'BANKGIRO_INVALID':
      return NextResponse.json(
        { error: 'Bankgironumret i företagsinställningar är ogiltigt (felaktig kontrollsiffra).' },
        { status: 400 }
      )
    case 'NO_EMPLOYEES':
      return NextResponse.json({ error: 'Inga anställda i lönekörningen' }, { status: 400 })
    case 'EMPLOYEE_BANK_MISSING':
      return NextResponse.json(
        { error: `${result.details.employee_count as number} anställd(a) saknar bankkontouppgifter` },
        { status: 400 }
      )
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
      if (stage === 'settings') return NextResponse.json({ error: BANKGIRO_MISSING_MESSAGE }, { status: 400 })
      return NextResponse.json({ error: 'Inga anställda i lönekörningen' }, { status: 400 })
    default:
      return NextResponse.json({ error: 'Betalfilen kunde inte skapas' }, { status: 400 })
  }
}

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.payment.bg_lb',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, user } = ctx

    const result = await buildSalaryPaymentFile(supabase, {
      companyId,
      runId: id,
      userId: user.id,
      format: 'bg_lb',
    })
    if (!result.ok) return legacyError(result)

    // ISO 8859-1 encoding: re-encode the JS string to Latin-1 bytes.
    const buffer = Buffer.from(result.content, 'latin1')

    return new Response(buffer, {
      headers: {
        'Content-Type': 'text/plain; charset=iso-8859-1',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
      },
    })
  },
  { requireWrite: true },
)
