import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { didTaxFieldsChange, regenerateTaxDeadlinesForUser } from '@/lib/tax/deadline-generator'
import { validateBody } from '@/lib/api/validate'
import { UpdateSettingsSchema } from '@/lib/api/schemas'

export const GET = withRouteContext(
  'settings.get',
  async (_request, { supabase, companyId }) => {
    const { data, error } = await supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', companyId)
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Fall back to companies.entity_type if company_settings.entity_type is null
    let responseData = data
    if (data && !data.entity_type) {
      const { data: company } = await supabase
        .from('companies')
        .select('entity_type')
        .eq('id', companyId)
        .single()
      if (company?.entity_type) {
        responseData = { ...data, entity_type: company.entity_type }
      }
    }

    return NextResponse.json({ data: responseData })
  },
)

export const PUT = withRouteContext(
  'settings.update',
  async (request, { supabase, companyId }) => {
    // Fetch current settings to check for tax-relevant changes
    const { data: oldSettings } = await supabase
      .from('company_settings')
      .select('entity_type, moms_period, f_skatt, vat_registered, vat_number, pays_salaries, fiscal_year_start_month, onboarding_complete')
      .eq('company_id', companyId)
      .single()

    const validation = await validateBody(request, UpdateSettingsSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    // Lock org_number after onboarding is complete (legal identifier: changing it
    // would orphan vouchers, SIE history, and tax filings). company_name remains
    // editable so users can update their display/brand name (e.g. särskilt företagsnamn).
    if (oldSettings && (oldSettings as Record<string, unknown>).onboarding_complete === true) {
      delete (body as Record<string, unknown>).org_number
    }

    // Validate: enskild firma must use calendar year (BFL 3 kap.)
    const effectiveEntityType = body.entity_type || oldSettings?.entity_type
    const effectiveFYStartMonth = body.fiscal_year_start_month ?? oldSettings?.fiscal_year_start_month
    if (effectiveEntityType === 'enskild_firma' && effectiveFYStartMonth && effectiveFYStartMonth !== 1) {
      return NextResponse.json(
        { error: 'Enskild firma måste använda kalenderår (BFL 3 kap.)' },
        { status: 400 }
      )
    }

    // Validate: VAT-registered must have VAT number (ML 11 kap. 8§) and moms period (SFL 26 kap.)
    const effectiveVatRegistered = body.vat_registered ?? oldSettings?.vat_registered
    if (effectiveVatRegistered === true) {
      const effectiveVatNumber = body.vat_number ?? oldSettings?.vat_number
      if (!effectiveVatNumber) {
        return NextResponse.json(
          { error: 'Momsregistreringsnummer krävs när företaget är momsregistrerat (ML 11 kap. 8§)' },
          { status: 400 }
        )
      }
      const effectiveMomsPeriod = body.moms_period ?? oldSettings?.moms_period
      if (!effectiveMomsPeriod) {
        return NextResponse.json(
          { error: 'Momsperiod krävs när företaget är momsregistrerat (SFL 26 kap.)' },
          { status: 400 }
        )
      }
    }

    const { data, error } = await supabase
      .from('company_settings')
      .update(body)
      .eq('company_id', companyId)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Check if tax-relevant fields changed and regenerate deadlines
    if (oldSettings && didTaxFieldsChange(oldSettings, data)) {
      try {
        await regenerateTaxDeadlinesForUser(supabase, companyId, {
          entity_type: data.entity_type,
          moms_period: data.moms_period,
          f_skatt: data.f_skatt,
          vat_registered: data.vat_registered,
          pays_salaries: data.pays_salaries ?? false,
          fiscal_year_start_month: data.fiscal_year_start_month,
        })
        console.log('Tax deadlines regenerated after settings change')
      } catch (err) {
        console.error('Failed to regenerate tax deadlines:', err)
        // Don't fail the settings update if deadline generation fails
      }
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
