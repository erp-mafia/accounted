import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { calculateVatDeclaration } from '@/lib/reports/vat-declaration'
import { buildESkdFile } from '@/lib/reports/vat-eskd-file'
import type { VatPeriodType, AccountingMethod } from '@/types'

/**
 * Momsdeklaration eSKDUpload (v6.0) XML file for filing at skatteverket.se via
 * "Deklarera via fil". Unlike the PDF sibling route (a read/record copy), this
 * is a real submission artifact the user uploads, reviews, signs and sends. The
 * declaration is computed purely from the bookkeeping, so no Skatteverket
 * connection is required. See lib/reports/vat-eskd-file.ts.
 */
export const GET = withRouteContext(
  'reports.vat-declaration.eskd',
  async (request, { supabase, companyId }) => {
    const { searchParams } = new URL(request.url)
    const periodType = searchParams.get('periodType') as VatPeriodType | null
    const yearStr = searchParams.get('year')
    const periodStr = searchParams.get('period')
    // Yearly = räkenskapsår (see the main vat-declaration route); ignored for
    // monthly/quarterly.
    const fiscalPeriodId = searchParams.get('fiscal_period_id') ?? undefined

    if (!periodType || !yearStr || !periodStr) {
      return NextResponse.json(
        { error: 'periodType, year, and period are required' },
        { status: 400 },
      )
    }
    if (!['monthly', 'quarterly', 'yearly'].includes(periodType)) {
      return NextResponse.json({ error: 'Invalid periodType' }, { status: 400 })
    }
    const year = parseInt(yearStr, 10)
    const period = parseInt(periodStr, 10)
    if (isNaN(year) || isNaN(period)) {
      return NextResponse.json({ error: 'Invalid year or period' }, { status: 400 })
    }

    const { data: companyRow } = await supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', companyId)
      .single()

    if (!companyRow) {
      return NextResponse.json({ error: 'Företagsinställningar saknas' }, { status: 404 })
    }

    // The eSKD header requires a valid 10-digit OrgNr; without it the file is an
    // "avvisande fel" Skatteverket rejects, so fail honestly up front instead of
    // handing the user a file that bounces at upload. 12-digit century-prefixed
    // values are fine: the builder strips the prefix (settings rows predating
    // org-number normalization hold them, and settings PUT can no longer fix
    // org_number after onboarding, so rejecting 12 digits would be a dead end).
    const orgDigits = (companyRow.org_number ?? '').replace(/\D/g, '')
    if (orgDigits.length !== 10 && orgDigits.length !== 12) {
      return NextResponse.json(
        {
          error:
            'Organisationsnummer saknas eller är ogiltigt. Ange ett giltigt organisationsnummer i företagsinställningarna för att skapa momsdeklarationsfilen.',
        },
        { status: 400 },
      )
    }

    const accountingMethod = (companyRow.accounting_method as AccountingMethod) || 'accrual'

    const declaration = await calculateVatDeclaration(
      supabase,
      companyId,
      periodType,
      year,
      period,
      accountingMethod,
      { fiscalPeriodId },
    )

    const xml = buildESkdFile(declaration.rutor, {
      orgNumber: companyRow.org_number,
      periodEnd: declaration.period.end,
    })

    const filename = `momsdeklaration-${declaration.period.start}--${declaration.period.end}.xml`
    return new Response(new Uint8Array(Buffer.from(xml, 'latin1')), {
      headers: {
        'Content-Type': 'application/xml; charset=ISO-8859-1',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  },
)
