import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { resolvePayslipToken, isValidPayslipTokenFormat } from '@/lib/salary/payslips/links'
import { buildPayslipData, payslipFileName } from '@/lib/salary/payslips/build-payslip-data'
import { PayslipPDF } from '@/lib/salary/pdf/payslip-template'

// In-memory rate limiting per token (pattern from /api/calendar/feed).
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 20

let lastCleanup = Date.now()
function cleanupRateLimitMap() {
  const now = Date.now()
  if (now - lastCleanup < 5 * 60_000) return
  lastCleanup = now
  for (const [key, value] of rateLimitMap) {
    if (now > value.resetAt) rateLimitMap.delete(key)
  }
}

/**
 * GET /api/payslip/[token]/pdf
 *
 * Public payslip PDF download. The token IS the authentication — the code
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

  cleanupRateLimitMap()
  const nowMs = Date.now()
  const rateEntry = rateLimitMap.get(token)
  if (rateEntry && nowMs < rateEntry.resetAt) {
    if (rateEntry.count >= RATE_LIMIT_MAX) {
      return new NextResponse('Too many requests', { status: 429 })
    }
    rateEntry.count++
  } else {
    rateLimitMap.set(token, { count: 1, resetAt: nowMs + RATE_LIMIT_WINDOW_MS })
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

  const [{ data: run }, { data: sre }, { data: company }] = await Promise.all([
    serviceClient
      .from('salary_runs')
      .select('*')
      .eq('id', link.salary_run_id)
      .eq('company_id', link.company_id)
      .single(),
    serviceClient
      .from('salary_run_employees')
      .select('*, employee:employees(first_name, last_name, personnummer, employment_type, tax_table_number, tax_column, clearing_number, bank_account_number), line_items:salary_line_items(*)')
      .eq('salary_run_id', link.salary_run_id)
      .eq('employee_id', link.employee_id)
      .single(),
    serviceClient
      .from('companies')
      .select('name, org_number')
      .eq('id', link.company_id)
      .single(),
  ])

  if (!run || !sre || !company) {
    return new NextResponse('Not found', { status: 404 })
  }

  const emp = sre.employee as unknown as {
    first_name: string
    last_name: string
    personnummer: string
    employment_type: string
    tax_table_number: number | null
    tax_column: number
    clearing_number: string | null
    bank_account_number: string | null
  }

  const data = buildPayslipData({ run, sre, employee: emp, company })
  const fileName = payslipFileName(run, emp)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buffer = await renderToBuffer(PayslipPDF({ data }) as any)

  return new Response(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  })
}
