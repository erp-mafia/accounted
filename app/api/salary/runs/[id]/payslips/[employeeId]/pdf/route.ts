import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { renderToBuffer } from '@react-pdf/renderer'
import { PayslipPDF } from '@/lib/salary/pdf/payslip-template'
import { buildPayslipData, payslipFileName } from '@/lib/salary/payslips/build-payslip-data'

ensureInitialized()

/**
 * Generate pay slip PDF for a specific employee in a salary run.
 *
 * Per BFL: Pay slips are räkenskapsinformation/underlag linked to
 * posted journal entries. Subject to 7-year retention per BFL 7 kap.
 *
 * Data assembly is shared with the public token surface via
 * lib/salary/payslips/build-payslip-data — both must render identical PDFs.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; employeeId: string }> }
) {
  const { id, employeeId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  // Load salary run
  const { data: run } = await supabase
    .from('salary_runs')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (!run) {
    return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
  }

  // Load salary run employee
  const { data: sre } = await supabase
    .from('salary_run_employees')
    .select('*, employee:employees(first_name, last_name, personnummer, personnummer_last4, employment_type, tax_table_number, tax_column, clearing_number, bank_account_number), line_items:salary_line_items(*)')
    .eq('salary_run_id', id)
    .eq('employee_id', employeeId)
    .single()

  if (!sre) {
    return NextResponse.json({ error: 'Anställd hittades inte i lönekörningen' }, { status: 404 })
  }

  // Load company
  const { data: company } = await supabase
    .from('companies')
    .select('name, org_number')
    .eq('id', companyId)
    .single()

  if (!company) {
    return NextResponse.json({ error: 'Företag hittades inte' }, { status: 404 })
  }

  const emp = sre.employee as {
    first_name: string; last_name: string; personnummer: string; personnummer_last4: string;
    employment_type: string; tax_table_number: number | null; tax_column: number;
    clearing_number: string | null; bank_account_number: string | null;
  }

  const data = buildPayslipData({ run, sre, employee: emp, company })
  const fileName = payslipFileName(run, emp)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buffer = await renderToBuffer(PayslipPDF({ data }) as any)

  return new Response(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${fileName}"`,
    },
  })
}
