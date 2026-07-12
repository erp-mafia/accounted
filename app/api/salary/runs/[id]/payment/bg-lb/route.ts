import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { generateBgLb } from '@/lib/salary/payment/bg-lb-generator'
import { effectiveNetPayout } from '@/lib/salary/payment/effective-net'
import { validateBankgiroNumber } from '@/lib/bankgiro/luhn'
import type { BgLbCompanyData, BgLbEmployee } from '@/lib/salary/payment/bg-lb-generator'

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
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.payment.bg_lb',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

    const { data: run } = await supabase
      .from('salary_runs')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (!run) {
      return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
    }

    if (!['approved', 'paid', 'booked'].includes(run.status)) {
      return NextResponse.json({ error: 'Betalfil kan bara genereras efter godkännande' }, { status: 400 })
    }

    const { data: company } = await supabase
      .from('companies')
      .select('name')
      .eq('id', companyId)
      .single()

    if (!company) {
      return NextResponse.json({ error: 'Företag hittades inte' }, { status: 404 })
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('company_name, bankgiro')
      .eq('company_id', companyId)
      .single()

    if (!settings?.bankgiro) {
      return NextResponse.json(
        { error: 'Bankgironummer saknas i företagsinställningar. Krävs för Bankgirot LB-fil.' },
        { status: 400 }
      )
    }

    if (!validateBankgiroNumber(settings.bankgiro)) {
      return NextResponse.json(
        { error: 'Bankgironumret i företagsinställningar är ogiltigt (felaktig kontrollsiffra).' },
        { status: 400 }
      )
    }

    const { data: runEmployees } = await supabase
      .from('salary_run_employees')
      .select('*, employee:employees(first_name, last_name, clearing_number, bank_account_number)')
      .eq('salary_run_id', id)

    if (!runEmployees || runEmployees.length === 0) {
      return NextResponse.json({ error: 'Inga anställda i lönekörningen' }, { status: 400 })
    }

    // Only employees with a positive payout end up in the file (see filter
    // below), so missing bank details must only block when they're actually
    // being paid: a zero-net employee needs no destination account.
    const missingBank = runEmployees.filter((sre) => {
      if (effectiveNetPayout(sre) <= 0) return false
      const emp = sre.employee as { clearing_number: string | null; bank_account_number: string | null } | null
      return !emp?.clearing_number || !emp?.bank_account_number
    })

    if (missingBank.length > 0) {
      return NextResponse.json(
        { error: `${missingBank.length} anställd(a) saknar bankkontouppgifter` },
        { status: 400 }
      )
    }

    const companyData: BgLbCompanyData = {
      // Sender name follows the current company name (company_settings.company_name),
      // not the frozen onboarding companies.name.
      name: settings.company_name || company.name,
      senderBankgiro: settings.bankgiro,
    }

    const employees: BgLbEmployee[] = runEmployees
      // Honor tax override on the bank payment file too: the net the employee
      // actually receives depends on the effective tax.
      .map((sre) => ({ sre, effectiveNet: effectiveNetPayout(sre) }))
      .filter(({ effectiveNet }) => effectiveNet > 0)
      .map(({ sre, effectiveNet }) => {
        const emp = sre.employee as {
          first_name: string
          last_name: string
          clearing_number: string
          bank_account_number: string
        }
        return {
          name: `${emp.first_name} ${emp.last_name}`,
          clearingNumber: emp.clearing_number,
          bankAccountNumber: emp.bank_account_number,
          netSalary: effectiveNet,
        }
      })

    const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`

    let result
    try {
      result = generateBgLb(companyData, employees, {
        paymentDate: run.payment_date,
        periodLabel,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Kunde inte generera Bankgirot LB-fil'
      return NextResponse.json({ error: msg }, { status: 400 })
    }

    await supabase
      .from('salary_runs')
      .update({
        payment_file_format: 'bg_lb',
        payment_file_generated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('company_id', companyId)

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
