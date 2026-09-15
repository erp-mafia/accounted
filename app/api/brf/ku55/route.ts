import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getBranding } from '@/lib/branding/service'
import { generateKU55Xml } from '@/lib/brf/ku55'
import { assembleKU55 } from '@/lib/brf/ku55-service'
import { brfRegisterErrorResponse } from '@/lib/brf/route-helpers'
import { requireBrfForm } from '@/lib/company/brf-tax-profile'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/brf/ku55?income_year=YYYY[&format=xml]
 *
 * Kontrolluppgift KU55 for every överlåtelse of a bostadsrätt in the income
 * year (SFL 22 kap. 2 §, due 31 January the year after, SFL 24 kap. 1 §).
 * JSON lists every KU with its fields and the reasons a KU is incomplete;
 * XML (Kontrolluppgifter 12.0) contains the complete ones and is what goes
 * to Skatteverket's filöverföring.
 */
export const GET = withRouteContext('brf.ku55', async (request, ctx) => {
  const { supabase, companyId, user, log, requestId } = ctx
  const params = new URL(request.url).searchParams
  const incomeYear = Number(params.get('income_year'))
  if (!Number.isInteger(incomeYear) || incomeYear < 1990 || incomeYear > 2200) {
    return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, reason: 'income_year must be a year' })
  }
  try {
    await requireBrfForm(supabase, companyId)
    const assembly = await assembleKU55(supabase, companyId, incomeYear)
    if (params.get('format') !== 'xml') {
      return NextResponse.json({ data: assembly })
    }
    const [{ data: company }, { data: settings }, { data: profile }] = await Promise.all([
      supabase.from('companies').select('name, org_number').eq('id', companyId).single(),
      supabase
        .from('company_settings')
        .select('company_name, org_number, phone, email')
        .eq('company_id', companyId)
        .maybeSingle(),
      supabase.from('profiles').select('full_name, email').eq('id', user.id).maybeSingle(),
    ])
    const orgNumber = company?.org_number ?? settings?.org_number ?? ''
    if (!orgNumber) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        reason: 'organisationsnummer saknas på företaget',
      })
    }
    const xml = generateKU55Xml(
      {
        orgNumber,
        companyName: settings?.company_name ?? company?.name ?? '',
        incomeYear,
        contactName: profile?.full_name ?? '',
        contactPhone: settings?.phone ?? '',
        contactEmail: profile?.email ?? settings?.email ?? '',
        programName: getBranding().appName.toLowerCase(),
      },
      assembly.items,
    )
    const skipped = assembly.items.filter((item) => !item.complete).length
    return new NextResponse(xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="KU55_${incomeYear}.xml"`,
        'Cache-Control': 'private, no-store',
        'X-KU55-Incomplete': String(skipped),
      },
    })
  } catch (err) {
    return brfRegisterErrorResponse(err, log, requestId)
  }
})
