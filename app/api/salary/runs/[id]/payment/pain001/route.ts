import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { generatePain001 } from '@/lib/salary/payment/pain001-generator'
import { effectiveNetPayout } from '@/lib/salary/payment/effective-net'
import { normalizeBankNumber, lookupBicByClearing, lookupBicByBankName } from '@/lib/salary/payment/bank-account'
import { getBranding } from '@/lib/branding/service'
import type { Pain001CompanyData, Pain001Employee } from '@/lib/salary/payment/pain001-generator'

ensureInitialized()

/**
 * Generate pain.001 (ISO 20022) payment file for a salary run.
 *
 * Per BFL: The payment file is räkenskapsinformation/underlag linked to
 * the salary journal entry. Subject to 7-year retention.
 *
 * The file is uploaded to the bank's corporate portal for batch payment.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.payment.pain001',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

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

    if (!['approved', 'paid', 'booked'].includes(run.status)) {
      return NextResponse.json({ error: 'Betalfil kan bara genereras efter godkännande' }, { status: 400 })
    }

    // Load company + settings
    const { data: company } = await supabase
      .from('companies')
      .select('name, org_number')
      .eq('id', companyId)
      .single()

    const { data: settings } = await supabase
      .from('company_settings')
      .select('company_name, iban, bic, clearing_number, bank_name')
      .eq('company_id', companyId)
      .single()

    if (!company) {
      return NextResponse.json({ error: 'Företag hittades inte' }, { status: 404 })
    }

    if (!settings) {
      return NextResponse.json({ error: 'Företagsinställningar saknas' }, { status: 400 })
    }

    // Debtor (company) account: the company's own IBAN, the canonical payer form
    // every Swedish bank accepts. Set under Inställningar → Fakturering.
    const senderIban = (settings.iban ?? '').replace(/\s/g, '').toUpperCase()
    if (!senderIban) {
      return NextResponse.json(
        { error: 'Företagets IBAN saknas i företagsinställningar. Fyll i det under Inställningar → Fakturering för att skapa betalfil (ISO 20022).' },
        { status: 400 },
      )
    }

    // Debtor bank BIC: use the saved BIC, otherwise derive it from the clearing
    // number (or bank name) the company already entered, so most users only need
    // to fill in the IBAN. Required by the receiving bank.
    const senderBic = settings.bic?.trim()
      || lookupBicByClearing(normalizeBankNumber(settings.clearing_number))
      || lookupBicByBankName(settings.bank_name)
    if (!senderBic) {
      return NextResponse.json(
        { error: 'Företagsbankens BIC saknas och kunde inte härledas. Fyll i BIC under Inställningar → Fakturering för att skapa betalfil.' },
        { status: 400 },
      )
    }

    // Load employees
    const { data: runEmployees } = await supabase
      .from('salary_run_employees')
      .select('*, employee:employees(first_name, last_name, clearing_number, bank_account_number)')
      .eq('salary_run_id', id)

    if (!runEmployees || runEmployees.length === 0) {
      return NextResponse.json({ error: 'Inga anställda i lönekörningen' }, { status: 400 })
    }

    // Validate bank accounts, but only for employees who will actually appear
    // in the file (positive payout). A zero-net employee is filtered out below,
    // so missing bank details for them must not block the file.
    const missingBank = runEmployees.filter(sre => {
      if (effectiveNetPayout(sre) <= 0) return false
      const emp = sre.employee as { clearing_number: string | null; bank_account_number: string | null } | null
      return !emp?.clearing_number || !emp?.bank_account_number
    })

    if (missingBank.length > 0) {
      return NextResponse.json({
        error: `${missingBank.length} anställd(a) saknar bankkontouppgifter`,
      }, { status: 400 })
    }

    const companyData: Pain001CompanyData = {
      // Sender name follows the current company name (company_settings.company_name),
      // not the frozen onboarding companies.name.
      name: settings.company_name || company.name,
      orgNumber: company.org_number || '',
      iban: senderIban,
      bic: senderBic,
    }

    const employees: Pain001Employee[] = runEmployees
      .map(sre => ({ sre, effectiveNet: effectiveNetPayout(sre) }))
      .filter(({ effectiveNet }) => effectiveNet > 0)
      .map(({ sre, effectiveNet }) => {
        const emp = sre.employee as { first_name: string; last_name: string; clearing_number: string; bank_account_number: string }
        return {
          name: `${emp.first_name} ${emp.last_name}`,
          clearingNumber: emp.clearing_number,
          bankAccountNumber: emp.bank_account_number,
          netSalary: effectiveNet,
        }
      })

    const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
    const messageId = `${getBranding().appName.toUpperCase()}-${company.org_number?.replace('-', '')}-${periodLabel}`

    let xml: string
    try {
      xml = generatePain001(companyData, employees, {
        messageId,
        paymentDate: run.payment_date,
        periodLabel,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Kunde inte generera betalfil'
      return NextResponse.json({ error: msg }, { status: 400 })
    }

    await supabase
      .from('salary_runs')
      .update({
        payment_file_format: 'pain001',
        payment_file_generated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('company_id', companyId)

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="pain001_lon_${periodLabel}.xml"`,
      },
    })
  },
  { requireWrite: true },
)
