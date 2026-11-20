import { NextResponse } from 'next/server'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { resolvePayslipToken, isValidPayslipTokenFormat } from '@/lib/salary/payslips/links'
import { loadPayslip, preparePayslip, renderPayslipPdf } from '@/lib/salary/payslips/load-payslip'
import { contentDisposition } from '@/lib/api/content-disposition'
import { createTokenRateLimiter } from '@/lib/api/token-rate-limit'

// 20 requests per minute per token, process-local (same limiter as /api/calendar/feed).
const rateLimiter = createTokenRateLimiter({ max: 20, windowMs: 60_000 })

/**
 * GET /api/payslip/[token]/pdf
 *
 * Public payslip PDF download. The token IS the authentication - the code
 * path is the only guard (strict hash equality, revocation/expiry checks,
 * per-token rate limit). Salary PII: masked personnummer only, no-store,
 * and the raw token is never logged.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  if (!isValidPayslipTokenFormat(token)) {
    return new NextResponse('Invalid token', { status: 400 })
  }

  if (!rateLimiter.allow(token)) {
    return new NextResponse('Too many requests', { status: 429 })
  }

  const serviceClient = createServiceClientNoCookies()
  const resolved = await resolvePayslipToken(serviceClient, token)

  if (!resolved.ok) {
    if (resolved.reason === 'expired' || resolved.reason === 'revoked') {
      return new NextResponse('Link no longer valid', { status: 410 })
    }
    return new NextResponse('Not found', { status: 404 })
  }

  const { link } = resolved

  // The one payslip render path (lib/salary/payslips/load-payslip.ts). This
  // link is what the employee receives: the employee copy, and the run's
  // sections are fixed here if the send did not fix them first, so the copy
  // renders what was issued, not today's switches.
  const loaded = await loadPayslip(serviceClient, {
    companyId: link.company_id,
    salaryRunId: link.salary_run_id,
    employeeId: link.employee_id,
  })
  if (!loaded.ok) {
    return loaded.reason === 'db_error'
      ? new NextResponse('Could not load payslip', { status: 500 })
      : new NextResponse('Not found', { status: 404 })
  }
  const prepared = await preparePayslip(serviceClient, loaded.payslip, {
    companyId: link.company_id,
    audience: 'employee',
    mayIssue: true,
  })
  // Fail closed: without the company's section switches this copy would fall
  // back to the defaults and print sections hidden from the employee.
  if (!prepared.ok) {
    return new NextResponse('Could not load payslip', { status: 500 })
  }
  const buffer = await renderPayslipPdf(prepared.data)
  const fileName = prepared.fileName

  return new Response(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      // RFC 5987 dual form: employee names with non-Latin-1 characters
      // (e.g. NFD combining marks) would otherwise make undici reject
      // the header value and crash the response.
      'Content-Disposition': contentDisposition('attachment', fileName),
      'Cache-Control': 'no-store',
    },
  })
}
